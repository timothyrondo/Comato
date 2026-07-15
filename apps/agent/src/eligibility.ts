/**
 * Rescue eligibility — the OFF-CHAIN trust gate.
 *
 * The contracts (see ComatoExecutor.sol "SECURITY / TRUST MODEL") deliberately
 * do NOT enforce eligibility on-chain: `createPolicy` is permissionless and
 * `premiumRatePerInterval` is informational, so the on-chain `active && HF<thr`
 * gate alone can be farmed (self-register `hfThreshold=10e18`, get free debt
 * paydowns). The agent is the gate. Before ANY rescue we verify, fail-closed:
 *
 *   1. PREMIUM PAID  — the subscriber has an unexpired paid-through time
 *      (in production: matched x402 premium settlements to COMATO_WALLET).
 *   2. GENUINE DISTRESS — HF is below an ABSOLUTE distress ceiling, not merely
 *      below the subscriber's own (attacker-chosen) threshold.
 *   3. RATE LIMIT — per-subscriber cooldown + max rescues per rolling window,
 *      so a re-breaching position can't drain the float across calls.
 *   4. CORRECT DEBT ASSET — the subscriber actually holds VARIABLE-rate debt in
 *      `debtAsset` (else live Aave reverts NO_DEBT_OF_SELECTED_TYPE).
 */

import { formatUnits, type Address, type PublicClient } from "viem";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { aavePoolAbi, erc20Abi } from "./abis.ts";
import { MAINNET } from "@comato/shared/addresses";
import { withRetry } from "./retry.ts";
import type { Config, SubscriberConfig } from "./config.ts";
import type { HealthSnapshot } from "./monitor.ts";
import type { Logger } from "./logger.ts";

const POOL = MAINNET.aaveV3.pool as Address;

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
  /** Subscriber's outstanding variable debt in `debtAsset` (base units). */
  variableDebt: bigint;
}

export interface RateLimiterOptions {
  /**
   * Path to a small JSON file that persists the per-subscriber rescue history
   * (O3). Loaded on construction, rewritten on every `record`. Omit for a purely
   * in-memory limiter (tests). A crash/restart during the 6-day run reloads this
   * file so cooldowns/windows survive — a fresh process must NOT clear them.
   */
  persistPath?: string;
  log?: Logger;
}

/**
 * Per-subscriber rescue rate limiter. In-memory by default; when `persistPath` is
 * given (O3), state is loaded on startup and durably written after each rescue so
 * a restart does not reset cooldowns and re-open the float to draining.
 */
export class RateLimiter {
  private readonly history = new Map<string, number[]>();
  private readonly persistPath?: string;
  private readonly log?: Logger;

  constructor(
    private readonly cooldownMs: number,
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    opts: RateLimiterOptions = {},
  ) {
    this.persistPath = opts.persistPath;
    this.log = opts.log;
    if (this.persistPath) {
      try {
        mkdirSync(dirname(this.persistPath), { recursive: true });
      } catch {
        // Best-effort; a write failure is handled (and logged) in persist().
      }
      this.load();
    }
  }

  /** Load persisted history (O3). Missing/corrupt file → start empty, never crash. */
  private load(): void {
    if (!this.persistPath) return;
    let raw: string;
    try {
      raw = readFileSync(this.persistPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log?.warn("rate-limiter state unreadable; starting empty", {
          event: "ratelimit.load_failed",
          path: this.persistPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) {
          this.history.set(k.toLowerCase(), v.filter((t): t is number => typeof t === "number"));
        }
      }
      this.log?.info("rate-limiter state loaded", {
        event: "ratelimit.loaded",
        path: this.persistPath,
        subscribers: this.history.size,
      });
    } catch (err) {
      this.log?.warn("rate-limiter state corrupt; starting empty", {
        event: "ratelimit.parse_failed",
        path: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Atomically persist history (O3): write a temp file, then rename over it. */
  private persist(): void {
    if (!this.persistPath) return;
    const obj: Record<string, number[]> = {};
    for (const [k, v] of this.history.entries()) obj[k] = v;
    const tmp = `${this.persistPath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, this.persistPath);
    } catch (err) {
      // Never let a persistence failure abort a rescue — log and carry on.
      this.log?.warn("rate-limiter state persist failed", {
        event: "ratelimit.persist_failed",
        path: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Reason string if blocked, or null if a rescue is allowed right now. */
  check(subscriber: Address, now = Date.now()): string | null {
    const key = subscriber.toLowerCase();
    const times = (this.history.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.history.set(key, times);

    if (times.length > 0) {
      const last = times[times.length - 1]!;
      if (now - last < this.cooldownMs) {
        return `cooldown active (${Math.round((this.cooldownMs - (now - last)) / 1000)}s left)`;
      }
    }
    if (times.length >= this.maxPerWindow) {
      return `rate limit: ${times.length}/${this.maxPerWindow} rescues in window`;
    }
    return null;
  }

  record(subscriber: Address, now = Date.now()): void {
    const key = subscriber.toLowerCase();
    // Prune out-of-window entries while we hold the array so the persisted file
    // (and memory) stay bounded over a 6-day run.
    const times = (this.history.get(key) ?? []).filter((t) => now - t < this.windowMs);
    times.push(now);
    this.history.set(key, times);
    this.persist();
  }

  /**
   * Undo the most recent `record` for a subscriber (rate-limit rollback). Called
   * only when a rescue tx is CONFIRMED to have done nothing (receipt `reverted`) —
   * the budget was consumed on broadcast (O1), but a reverted repay changed no
   * state, so the subscriber must not be locked out of a real rescue for a full
   * cooldown/window over a tx that did not spend. Ambiguous failures (no receipt)
   * deliberately keep the record: there we cannot prove the repay didn't land.
   */
  unrecord(subscriber: Address): void {
    const key = subscriber.toLowerCase();
    const times = this.history.get(key);
    if (!times || times.length === 0) return;
    times.pop();
    this.history.set(key, times);
    this.persist();
  }
}

/** A fresh `Pool.getUserAccountData` read: aggregate HF (WAD) + debt presence. */
export interface FreshAccountData {
  healthFactor: bigint; // WAD (1e18); MaxUint256 when the user has no debt.
  totalDebtBase: bigint; // USD, 8 dec.
  hasDebt: boolean;
}

/**
 * Read HF + debt FRESH from Aave, right before the rescue decision (O2 — TOCTOU).
 * The monitor snapshot can be up to one poll old; a position may have been repaid
 * or topped up in the interim. Deciding a rescue on a fresh read prevents paying
 * down an already-healthy position (and wasting the rate-limit budget / float).
 */
export async function readAccountData(
  publicClient: PublicClient,
  subscriber: Address,
  log: Logger,
): Promise<FreshAccountData> {
  const [, totalDebtBase, , , , healthFactor] = await withRetry(
    () =>
      publicClient.readContract({
        address: POOL,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [subscriber],
      }),
    { label: `eligibility.account.${subscriber}`, logger: log, retries: 3 },
  );
  return { healthFactor, totalDebtBase, hasDebt: totalDebtBase > 0n };
}

/** Read the subscriber's outstanding VARIABLE debt in `debtAsset` (base units). */
export async function readVariableDebt(
  publicClient: PublicClient,
  subscriber: Address,
  debtAsset: Address,
  log: Logger,
): Promise<bigint> {
  const reserve = await withRetry(
    () =>
      publicClient.readContract({
        address: POOL,
        abi: aavePoolAbi,
        functionName: "getReserveData",
        args: [debtAsset],
      }),
    { label: `eligibility.reserve.${debtAsset}`, logger: log, retries: 3 },
  );
  const variableDebtToken = reserve.variableDebtTokenAddress as Address;
  if (!variableDebtToken || variableDebtToken === "0x0000000000000000000000000000000000000000") {
    return 0n;
  }
  return withRetry(
    () =>
      publicClient.readContract({
        address: variableDebtToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [subscriber],
      }),
    { label: `eligibility.debt.${subscriber}`, logger: log, retries: 3 },
  );
}

export async function checkEligibility(args: {
  publicClient: PublicClient;
  snapshot: HealthSnapshot;
  sub: SubscriberConfig;
  config: Config;
  rateLimiter: RateLimiter;
  log: Logger;
  now?: number;
}): Promise<EligibilityResult> {
  const { snapshot, sub, config, rateLimiter, publicClient, log } = args;
  const now = args.now ?? Date.now();
  const reasons: string[] = [];

  // 1. PREMIUM PAID (fail-closed when required).
  if (config.rescue.requirePremium) {
    const paidUntil = sub.premiumPaidUntilMs;
    if (paidUntil === undefined) {
      reasons.push("premium unverified (no paid-through configured)");
    } else if (paidUntil < now) {
      reasons.push(`premium expired at ${new Date(paidUntil).toISOString()}`);
    }
  }

  // 2. GENUINE DISTRESS — below the subscriber threshold AND the absolute ceiling.
  // Read HF FRESH here (O2 — TOCTOU): the snapshot may be up to one poll old, and
  // the position could have recovered in between. Fail-closed: if the fresh read
  // fails, we cannot confirm distress, so the rescue is blocked.
  let hf = snapshot.healthFactor;
  let hasDebt = snapshot.hasDebt;
  try {
    const fresh = await readAccountData(publicClient, sub.address, log);
    hf = fresh.healthFactor;
    hasDebt = fresh.hasDebt;
    if (fresh.healthFactor !== snapshot.healthFactor) {
      log.debug("HF drifted since snapshot", {
        event: "eligibility.hf_drift",
        subscriber: sub.address,
        snapshotHf: formatUnits(snapshot.healthFactor, 18),
        freshHf: formatUnits(fresh.healthFactor, 18),
      });
    }
  } catch (err) {
    reasons.push(`failed to read fresh account data: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!hasDebt) {
    reasons.push("no debt (position healthy)");
  }
  if (hf >= sub.hfThreshold) {
    reasons.push("HF at/above subscriber threshold");
  }
  if (hf >= config.rescue.distressHf) {
    reasons.push(
      `HF ${formatUnits(hf, 18)} >= distress ceiling ${formatUnits(config.rescue.distressHf, 18)}`,
    );
  }

  // 3. RATE LIMIT.
  const rlReason = rateLimiter.check(sub.address, now);
  if (rlReason) reasons.push(rlReason);

  // 4. CORRECT DEBT ASSET — must have variable debt in the configured asset.
  let variableDebt = 0n;
  try {
    variableDebt = await readVariableDebt(publicClient, sub.address, sub.debtAsset, log);
    if (variableDebt === 0n) {
      reasons.push(`no variable debt in configured debtAsset ${sub.debtAsset}`);
    }
  } catch (err) {
    reasons.push(`failed to read variable debt: ${err instanceof Error ? err.message : String(err)}`);
  }

  const eligible = reasons.length === 0;
  log.info("eligibility check", {
    event: "eligibility.result",
    subscriber: sub.address,
    eligible,
    reasons,
    variableDebt,
  });

  return { eligible, reasons, variableDebt };
}
