/**
 * Rescue executor. On a genuine, eligible breach it repays part of the
 * subscriber's Aave debt to lift their health factor.
 *
 * COUNTING PATH (default, earns Track 1 via C1):
 *   EOA-direct `Pool.repay(asset, amount, 2, onBehalfOf=subscriber)`, tagged.
 *   Aave pulls via `transferFrom(COMATO_WALLET, ...)`, so `transfer.from ==
 *   tx_from == COMATO_WALLET` and the repaid `amount` counts.
 *
 * SAFETY PATH (RESCUE_VIA_EXECUTOR=true, does NOT earn Track 1):
 *   `ComatoExecutor.rescue(policyId)`. Atomic + bounded, but Aave pulls from the
 *   *contract*, so the transfer's `from` is the executor, invisible to C1.
 *
 * Repay amount is bounded by `min(RESCUE_MAX_AMOUNT, variableDebt, EOA float)`
 * (R13 — never over-pull). Eligibility (premium/distress/rate-limit/debt asset)
 * is checked BEFORE we act.
 *
 * DOUBLE-RESCUE SAFETY (O1). The rate limiter is recorded on BROADCAST (via the
 * TxSender `onBroadcast` hook), not on receipt confirmation. If the repay tx is
 * broadcast but the receipt read later fails, the position is already (likely)
 * repaid — recording on broadcast means the next cycle's rate-limit gate blocks a
 * re-rescue instead of draining the float. An in-flight set additionally prevents
 * two overlapping rescues for the same subscriber. DRY_RUN never records.
 */

import { formatUnits, type Address } from "viem";
import { MAINNET } from "@comato/shared/addresses";
import { aavePoolAbi, comatoExecutorAbi } from "./abis.ts";
import { checkEligibility, RateLimiter } from "./eligibility.ts";
import type { TxSender, SendResult } from "./tx.ts";
import type { Config, SubscriberConfig } from "./config.ts";
import type { HealthSnapshot } from "./monitor.ts";
import type { Logger } from "./logger.ts";
import type { PublicClient } from "viem";

const POOL = MAINNET.aaveV3.pool as Address;
const VARIABLE_RATE_MODE = 2n;

export type RescueStatus =
  | "skipped_disabled"
  | "skipped_ineligible"
  | "skipped_in_flight"
  | "skipped_no_float"
  | "skipped_no_key"
  | "executed"
  | "failed";

export interface RescueOutcome {
  status: RescueStatus;
  subscriber: Address;
  reasons?: string[];
  repayAmount?: bigint;
  result?: SendResult;
}

export class Rescuer {
  /** Subscribers with a rescue currently between eligibility and confirmation. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly publicClient: PublicClient,
    private readonly tx: TxSender,
    private readonly config: Config,
    private readonly rateLimiter: RateLimiter,
    private readonly log: Logger,
  ) {}

  /** Compute the bounded repay amount for a rescue: min(cap, debt, float). */
  computeRepayAmount(variableDebt: bigint, floatBalance: bigint): bigint {
    let amount = this.config.rescue.maxAmount;
    if (variableDebt < amount) amount = variableDebt;
    if (floatBalance < amount) amount = floatBalance;
    return amount;
  }

  async maybeRescue(snapshot: HealthSnapshot, sub: SubscriberConfig): Promise<RescueOutcome> {
    const subscriber = sub.address;

    if (!this.config.rescue.enabled) {
      return { status: "skipped_disabled", subscriber };
    }

    // Idempotency (O1): never let two rescues for the same subscriber overlap.
    // Combined with recording the rate limiter on broadcast, this closes the
    // double-rescue window (broadcast landed, receipt read failed → re-attempt).
    // Check-and-add is atomic here (no await between them).
    const key = subscriber.toLowerCase();
    if (this.inFlight.has(key)) {
      this.log.warn("rescue already in-flight; skipping", {
        event: "rescue.in_flight",
        subscriber,
      });
      return { status: "skipped_in_flight", subscriber, reasons: ["rescue already in-flight for subscriber"] };
    }
    this.inFlight.add(key);

    try {
      // Eligibility gate (trust model). Fail-closed. Reads HF FRESH (O2).
      const elig = await checkEligibility({
        publicClient: this.publicClient,
        snapshot,
        sub,
        config: this.config,
        rateLimiter: this.rateLimiter,
        log: this.log,
      });
      if (!elig.eligible) {
        return { status: "skipped_ineligible", subscriber, reasons: elig.reasons };
      }

      // ----- Safety path: route through the Executor (loses C1 attribution) -----
      if (this.config.rescue.viaExecutor) {
        return await this.rescueViaExecutor(sub);
      }

      // ----- Counting path: EOA-direct repay, tagged (C1) -----
      if (!this.tx.canSend) {
        return { status: "skipped_no_key", subscriber };
      }

      const floatBalance = await this.tx.balanceOf(sub.debtAsset);
      const repayAmount = this.computeRepayAmount(elig.variableDebt, floatBalance);
      if (repayAmount <= 0n) {
        this.log.warn("no float to rescue with", {
          event: "rescue.no_float",
          subscriber,
          debtAsset: sub.debtAsset,
          floatBalance,
          variableDebt: elig.variableDebt,
        });
        return { status: "skipped_no_float", subscriber, reasons: ["no debt-asset float in COMATO_WALLET"] };
      }

      this.log.info("executing EOA-direct rescue", {
        event: "rescue.start",
        subscriber,
        debtAsset: sub.debtAsset,
        // Exact base units: the debt asset's decimals are not tracked per-subscriber,
        // so formatting here (previously with treasury.decimalsA) could misreport by
        // orders of magnitude for a non-6-dec debt asset. Base units are unambiguous.
        repayAmountBase: repayAmount,
        hf: formatUnits(snapshot.healthFactor, 18),
      });

      try {
        // Allow the Aave pool to pull the repay from COMATO_WALLET.
        await this.tx.ensureApproval(sub.debtAsset, POOL, repayAmount, "rescue");

        const result = await this.tx.sendTagged({
          to: POOL,
          abi: aavePoolAbi,
          functionName: "repay",
          args: [sub.debtAsset, repayAmount, VARIABLE_RATE_MODE, subscriber],
          label: "rescue.repay",
          // O1: consume the rate limit the moment the repay is BROADCAST, so a
          // failed receipt read cannot lead to a re-rescue. DRY_RUN never fires this.
          onBroadcast: () => this.rateLimiter.record(subscriber),
        });

        this.log.info("rescue executed", {
          event: "rescue.executed",
          subscriber,
          repayAmount,
          hash: result.hash,
          dryRun: result.dryRun,
        });
        return { status: "executed", subscriber, repayAmount, result };
      } catch (err) {
        this.log.error("rescue failed", {
          event: "rescue.failed",
          subscriber,
          error: err instanceof Error ? err.message : String(err),
        });
        return { status: "failed", subscriber, reasons: [String(err)] };
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async rescueViaExecutor(sub: SubscriberConfig): Promise<RescueOutcome> {
    const subscriber = sub.address;
    const executor = this.config.rescue.executorAddress;
    if (!executor || sub.policyId === undefined) {
      this.log.error("executor path misconfigured", {
        event: "rescue.executor_misconfig",
        subscriber,
        hasExecutor: Boolean(executor),
        hasPolicyId: sub.policyId !== undefined,
      });
      return { status: "failed", subscriber, reasons: ["EXECUTOR_ADDRESS and policyId required for viaExecutor"] };
    }
    if (!this.tx.canSend) return { status: "skipped_no_key", subscriber };

    this.log.warn("rescuing via ComatoExecutor (does NOT count for Track 1)", {
      event: "rescue.executor",
      subscriber,
      policyId: sub.policyId,
    });

    try {
      const result = await this.tx.sendTagged({
        to: executor,
        abi: comatoExecutorAbi,
        functionName: "rescue",
        args: [sub.policyId],
        label: "rescue.executor",
        // O1: record on broadcast, not confirmation (see the EOA-direct path).
        onBroadcast: () => this.rateLimiter.record(subscriber),
      });
      return { status: "executed", subscriber, result };
    } catch (err) {
      return { status: "failed", subscriber, reasons: [String(err)] };
    }
  }
}
