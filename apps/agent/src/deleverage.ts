/**
 * Deleverage executor (Model C — non-custodial rescue).
 *
 * For each monitored {ComatoVault}, read the position's health factor via
 * `position()`; on a genuine breach (HF < the vault's own `hfThreshold`), withdraw
 * part of the SUBSCRIBER'S own collateral, swap it to the debt asset, and repay the
 * debt — lifting HF toward `targetHf` — by calling the vault's operator-only
 * `deleverage(collateralIn, minDebtOut)` EOA-direct through {TxSender}. COMATO_WALLET
 * is the vault operator; the vault holds the Aave position, so this works on the
 * subscriber's funds, NOT Comato's float (the whole point of the vault model).
 *
 * ATTRIBUTION: `deleverage`'s token legs are contract-internal (Aave + the swap
 * router pull from the VAULT), so they do NOT count for Track 1 (C1) — same trade-off
 * as ComatoExecutor. This is the SAFETY path; volume stays EOA-direct elsewhere.
 *
 * SIZING (conservative — never withdraw more than needed):
 *   1. `r` = the USD debt value to repay to reach ~`targetHf`. Under an equal-value
 *      withdraw/repay (value out of collateral ≈ value repaid), with HF = LT·C/D:
 *        targetHf = LT·(C−r)/(D−r)  ⇒  r = C·D·(targetHf−hf) / (targetHf·C − hf·D).
 *   2. `collateralIn` = T · r / C, where T is the vault's collateral-token balance
 *      (its aToken). We withdraw collateral worth ~r USD; the swap yields slightly
 *      LESS debt-asset (pool fee + spread + the vault's service fee), so HF lands
 *      just BELOW targetHf — an undershoot the vault's `Overshoot` guard never trips.
 *   3. `minDebtOut` = quotedOut · (1 − slippageBps/1e4), quotedOut from QuoterV2.
 *   `collateralIn` is additionally capped at the vault's holdings and a config cap.
 *
 * SAFETY PATTERNS (mirror rescue.ts):
 *   - fail-closed on any read error (never act on partial/uncertain state);
 *   - `withRetry` on READS only, never the send (a retried send double-broadcasts);
 *   - a mined-but-REVERTED receipt is a FAILURE, not a success;
 *   - per-vault {RateLimiter} cooldown, recorded on BROADCAST (O1) so a failed
 *     receipt read cannot lead to a re-deleverage; rolled back on an on-chain revert;
 *   - an in-flight set prevents two overlapping deleverages for the same vault;
 *   - DRY_RUN-aware via `TxSender.sendTagged` (builds + tags calldata, no broadcast).
 */

import { formatUnits, type Address, type PublicClient } from "viem";
import { MAINNET } from "@comato/shared/addresses";
import {
  aavePoolAbi,
  comatoVaultAbi,
  erc20Abi,
  protocolDataProviderAbi,
  quoterV2Abi,
} from "./abis.ts";
import { deliberate, type RescueDecision } from "./deliberate.ts";
import { RateLimiter } from "./eligibility.ts";
import { HF_NO_DEBT } from "./monitor.ts";
import { withRetry } from "./retry.ts";
import type { TxSender, SendResult } from "./tx.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

const POOL = MAINNET.aaveV3.pool as Address;
const DATA_PROVIDER = MAINNET.aaveV3.protocolDataProvider as Address;
const NO_PRICE_LIMIT = 0n;
const BPS = 10_000n;
const USD_BASE_DECIMALS = 8; // Aave base-currency (USD) decimals
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const fmtHf = (hf: bigint): string => (hf === HF_NO_DEBT ? "inf" : formatUnits(hf, 18));

export type DeleverageStatus =
  | "skipped_disabled"
  | "skipped_no_breach"
  | "skipped_in_flight"
  | "skipped_cooldown"
  | "skipped_no_size"
  | "skipped_deferred"
  | "skipped_no_key"
  | "executed"
  | "failed";

/** Immutable-ish vault parameters + current position, read fresh each cycle. */
export interface VaultState {
  collateralBase: bigint; // USD, 8 dec
  debtBase: bigint; // USD, 8 dec
  hf: bigint; // WAD
  hfThreshold: bigint; // WAD
  targetHf: bigint; // WAD
  feeBps: number; // vault service fee (bps of swap output)
  collateralAsset: Address;
  debtAsset: Address;
  poolFee: number; // Uniswap V3 fee tier
}

/** Per-asset risk params for the deliberation (static per asset; read on demand). */
export interface AssetRisk {
  liquidationBonusBps: number; // Aave collateral liquidationBonus (e.g. 10750)
  debtDecimals: number; // debt-asset ERC-20 decimals (for USD scaling)
}

export interface DeleverageOutcome {
  status: DeleverageStatus;
  vault: Address;
  reasons?: string[];
  collateralIn?: bigint;
  quotedOut?: bigint;
  minDebtOut?: bigint;
  decision?: RescueDecision;
  result?: SendResult;
}

export class Deleverager {
  /** Vaults with a deleverage currently between breach detection and confirmation. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly publicClient: PublicClient,
    private readonly tx: TxSender,
    private readonly config: Config,
    private readonly rateLimiter: RateLimiter,
    private readonly log: Logger,
  ) {}

  /* ----------------------------- pure sizing ----------------------------- */

  /**
   * USD debt value (Aave base units, 8-dec) to repay to lift HF from `hf` to
   * `targetHf`, assuming equal-value collateral-out / debt-repaid:
   *   r = C·D·(targetHf − hf) / (targetHf·C − hf·D)
   * Returns 0 when the move is not a sane breach→target deleverage (no debt/
   * collateral, hf already at/above target, or a non-positive denominator — a
   * degenerate/underwater position a deleverage cannot fix). Never exceeds D.
   */
  computeDebtReductionBase(collateralBase: bigint, debtBase: bigint, hf: bigint, targetHf: bigint): bigint {
    if (collateralBase <= 0n || debtBase <= 0n) return 0n;
    if (hf >= targetHf) return 0n;
    const numerator = collateralBase * debtBase * (targetHf - hf);
    const denominator = targetHf * collateralBase - hf * debtBase;
    if (denominator <= 0n) return 0n;
    const r = numerator / denominator;
    return r > debtBase ? debtBase : r;
  }

  /**
   * Collateral-token units to withdraw: the fraction (r / C) of the vault's actual
   * collateral holdings `collateralHeld` (its aToken balance). Capped at the holdings
   * (cannot withdraw more than held) and at `cap` (an absolute config backstop; 0 = off).
   */
  computeCollateralIn(collateralHeld: bigint, debtReductionBase: bigint, collateralBase: bigint, cap: bigint): bigint {
    if (collateralHeld <= 0n || debtReductionBase <= 0n || collateralBase <= 0n) return 0n;
    let collateralIn = (collateralHeld * debtReductionBase) / collateralBase;
    if (collateralIn > collateralHeld) collateralIn = collateralHeld;
    if (cap > 0n && collateralIn > cap) collateralIn = cap;
    return collateralIn;
  }

  /** Slippage-guarded minimum debt-asset out from a quoted amount. */
  computeMinDebtOut(quotedOut: bigint, slippageBps: number): bigint {
    return (quotedOut * (BPS - BigInt(slippageBps))) / BPS;
  }

  /* ------------------------------- reads --------------------------------- */

  /** Read the vault's params + current position. Fail-closed: throws propagate. */
  private async readVaultState(vault: Address): Promise<VaultState> {
    const opts = (label: string) => ({ label: `deleverage.read.${label}.${vault}`, logger: this.log, retries: 3 });
    const [position, hfThreshold, targetHf, feeBps, collateralAsset, debtAsset, poolFee] = await Promise.all([
      withRetry(
        () => this.publicClient.readContract({ address: vault, abi: comatoVaultAbi, functionName: "position" }),
        opts("position"),
      ),
      withRetry(
        () => this.publicClient.readContract({ address: vault, abi: comatoVaultAbi, functionName: "hfThreshold" }),
        opts("hfThreshold"),
      ),
      withRetry(
        () => this.publicClient.readContract({ address: vault, abi: comatoVaultAbi, functionName: "targetHf" }),
        opts("targetHf"),
      ),
      withRetry(
        () => this.publicClient.readContract({ address: vault, abi: comatoVaultAbi, functionName: "feeBps" }),
        opts("feeBps"),
      ),
      withRetry(
        () => this.publicClient.readContract({ address: vault, abi: comatoVaultAbi, functionName: "collateralAsset" }),
        opts("collateralAsset"),
      ),
      withRetry(
        () => this.publicClient.readContract({ address: vault, abi: comatoVaultAbi, functionName: "debtAsset" }),
        opts("debtAsset"),
      ),
      withRetry(
        () => this.publicClient.readContract({ address: vault, abi: comatoVaultAbi, functionName: "poolFee" }),
        opts("poolFee"),
      ),
    ]);
    return {
      collateralBase: position[0],
      debtBase: position[1],
      hf: position[2],
      hfThreshold,
      targetHf,
      feeBps: Number(feeBps),
      collateralAsset,
      debtAsset,
      poolFee: Number(poolFee),
    };
  }

  /**
   * Per-asset risk parameters for the deliberation: the collateral's Aave
   * `liquidationBonus` (the penalty a liquidation would impose) and the debt
   * asset's decimals (to value the quoted swap output in USD). Static per asset;
   * read fresh each cycle (cheap eth_calls) rather than cached, so a reserve
   * re-parameterization is picked up. Fail-closed: read errors propagate.
   */
  private async readAssetRisk(collateralAsset: Address, debtAsset: Address): Promise<AssetRisk> {
    const [config, debtDecimals] = await Promise.all([
      withRetry(
        () =>
          this.publicClient.readContract({
            address: DATA_PROVIDER,
            abi: protocolDataProviderAbi,
            functionName: "getReserveConfigurationData",
            args: [collateralAsset],
          }),
        { label: `deleverage.reserveconfig.${collateralAsset}`, logger: this.log, retries: 3 },
      ),
      withRetry(
        () => this.publicClient.readContract({ address: debtAsset, abi: erc20Abi, functionName: "decimals" }),
        { label: `deleverage.debtdecimals.${debtAsset}`, logger: this.log, retries: 3 },
      ),
    ]);
    return {
      liquidationBonusBps: Number(config[3]), // getReserveConfigurationData()[3] = liquidationBonus
      debtDecimals: Number(debtDecimals),
    };
  }

  /** Value `amount` (in `decimals`-unit token) as Aave base USD (8-dec), treating the
   *  debt asset as a ~$1 stable — every supported debt asset is a 6-dec EIP-3009 stable. */
  private toUsdBase(amount: bigint, decimals: number): bigint {
    const exp = USD_BASE_DECIMALS - decimals;
    return exp >= 0 ? amount * 10n ** BigInt(exp) : amount / 10n ** BigInt(-exp);
  }

  /** The vault's collateral-token holdings (its aToken balance), in token units. */
  private async readCollateralHeld(vault: Address, collateralAsset: Address): Promise<bigint> {
    const reserve = await withRetry(
      () =>
        this.publicClient.readContract({
          address: POOL,
          abi: aavePoolAbi,
          functionName: "getReserveData",
          args: [collateralAsset],
        }),
      { label: `deleverage.reserve.${collateralAsset}`, logger: this.log, retries: 3 },
    );
    const aToken = reserve.aTokenAddress as Address;
    if (!aToken || aToken === ZERO_ADDRESS) return 0n;
    return withRetry(
      () => this.publicClient.readContract({ address: aToken, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
      { label: `deleverage.collateral.${vault}`, logger: this.log, retries: 3 },
    );
  }

  /** Quote the debt-asset out for swapping `collateralIn` of collateral (QuoterV2). */
  private async quoteDebtOut(state: VaultState, collateralIn: bigint): Promise<bigint> {
    const result = await withRetry(
      () =>
        this.publicClient.readContract({
          address: this.config.deleverage.quoterAddress,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: state.collateralAsset,
              tokenOut: state.debtAsset,
              amountIn: collateralIn,
              fee: state.poolFee,
              sqrtPriceLimitX96: NO_PRICE_LIMIT,
            },
          ],
        }),
      {
        label: `deleverage.quote.${state.collateralAsset}->${state.debtAsset}`,
        logger: this.log,
        retries: 3,
      },
    );
    return result[0]; // amountOut
  }

  /* ------------------------------- driver -------------------------------- */

  async maybeDeleverage(vaultAddr: Address): Promise<DeleverageOutcome> {
    const vault = vaultAddr;

    if (!this.config.deleverage.enabled) {
      return { status: "skipped_disabled", vault };
    }

    // Idempotency: never let two deleverages for the same vault overlap. Combined
    // with recording the rate limiter on broadcast, this closes the double-action
    // window (broadcast landed, receipt read failed → re-attempt). Check-and-add is
    // atomic here (no await between them).
    const key = vault.toLowerCase();
    if (this.inFlight.has(key)) {
      this.log.warn("deleverage already in-flight; skipping", { event: "deleverage.in_flight", vault });
      return { status: "skipped_in_flight", vault, reasons: ["deleverage already in-flight for vault"] };
    }
    this.inFlight.add(key);

    try {
      // Fail-closed: any read failure aborts (we never act on partial state).
      let state: VaultState;
      try {
        state = await this.readVaultState(vault);
      } catch (err) {
        this.log.error("failed to read vault state (fail-closed)", {
          event: "deleverage.read_failed",
          vault,
          error: msg(err),
        });
        return { status: "failed", vault, reasons: [`vault state read failed: ${msg(err)}`] };
      }

      this.log.info("vault snapshot", {
        event: "deleverage.snapshot",
        vault,
        hf: fmtHf(state.hf),
        threshold: fmtHf(state.hfThreshold),
        target: fmtHf(state.targetHf),
        collateralUsd: formatUnits(state.collateralBase, 8),
        debtUsd: formatUnits(state.debtBase, 8),
      });

      // Breach gate: only when there is debt AND HF is below the vault's own threshold.
      if (state.debtBase <= 0n || state.hf >= state.hfThreshold) {
        return { status: "skipped_no_breach", vault };
      }

      // Per-vault rate limit (reuse RateLimiter). Checked before the heavier reads.
      const rl = this.rateLimiter.check(vault);
      if (rl) {
        this.log.info("deleverage rate-limited; skipping", { event: "deleverage.rate_limited", vault, reason: rl });
        return { status: "skipped_cooldown", vault, reasons: [rl] };
      }

      // Size the deleverage: the USD debt reduction to reach ~targetHf.
      const debtReductionBase = this.computeDebtReductionBase(
        state.collateralBase,
        state.debtBase,
        state.hf,
        state.targetHf,
      );
      if (debtReductionBase <= 0n) {
        return {
          status: "skipped_no_size",
          vault,
          reasons: ["position not deleverageable toward target (degenerate sizing)"],
        };
      }

      // Convert the USD target into collateral-token units via the vault's holdings.
      let collateralHeld: bigint;
      try {
        collateralHeld = await this.readCollateralHeld(vault, state.collateralAsset);
      } catch (err) {
        this.log.error("failed to read collateral holdings (fail-closed)", {
          event: "deleverage.collateral_read_failed",
          vault,
          error: msg(err),
        });
        return { status: "failed", vault, reasons: [`collateral balance read failed: ${msg(err)}`] };
      }

      const collateralIn = this.computeCollateralIn(
        collateralHeld,
        debtReductionBase,
        state.collateralBase,
        this.config.deleverage.maxCollateralIn,
      );
      if (collateralIn <= 0n) {
        return { status: "skipped_no_size", vault, reasons: ["computed collateralIn is zero"] };
      }

      // Quote the swap for the slippage guard.
      let quotedOut: bigint;
      try {
        quotedOut = await this.quoteDebtOut(state, collateralIn);
      } catch (err) {
        this.log.error("quote failed (fail-closed)", { event: "deleverage.quote_failed", vault, error: msg(err) });
        return { status: "failed", vault, collateralIn, reasons: [`quote failed: ${msg(err)}`] };
      }
      const minDebtOut = this.computeMinDebtOut(quotedOut, this.config.deleverage.slippageBps);
      if (minDebtOut <= 0n) {
        return { status: "skipped_no_size", vault, collateralIn, quotedOut, reasons: ["quoted debt-out is zero"] };
      }

      // DECISION LAYER — is rescuing now economically worth it, or should we wait?
      // Read the per-asset risk (liquidation penalty + debt decimals), price both
      // legs of the swap in USD, and let `deliberate` weigh cost vs penalty. Fail-
      // closed: if we can't read the penalty we can't judge, so we don't act.
      let risk: AssetRisk;
      try {
        risk = await this.readAssetRisk(state.collateralAsset, state.debtAsset);
      } catch (err) {
        this.log.error("failed to read asset risk (fail-closed)", {
          event: "deleverage.risk_read_failed",
          vault,
          error: msg(err),
        });
        return { status: "failed", vault, collateralIn, quotedOut, minDebtOut, reasons: [`asset risk read failed: ${msg(err)}`] };
      }

      const collateralInUsd = (state.collateralBase * collateralIn) / collateralHeld;
      const debtOutUsd = this.toUsdBase(quotedOut, risk.debtDecimals);
      const decision = deliberate({
        hf: state.hf,
        criticalHf: this.config.deleverage.criticalHf,
        collateralInUsd,
        debtOutUsd,
        liquidationBonusBps: risk.liquidationBonusBps,
        feeBps: state.feeBps,
        costGateK: this.config.deleverage.costGateK,
      });

      this.log.info("deleverage deliberation", {
        event: "deleverage.deliberation",
        vault,
        act: decision.act,
        urgency: decision.urgency,
        hf: fmtHf(state.hf),
        critical: fmtHf(this.config.deleverage.criticalHf),
        penaltyBps: decision.penaltyBps,
        swapLossBps: decision.swapLossBps,
        feeBps: state.feeBps,
        costBps: decision.costBps,
        rationale: decision.rationale,
      });

      if (!decision.act) {
        return { status: "skipped_deferred", vault, collateralIn, quotedOut, minDebtOut, decision, reasons: [decision.rationale] };
      }

      if (!this.tx.canSend) {
        return { status: "skipped_no_key", vault, collateralIn, quotedOut, minDebtOut, decision };
      }

      this.log.info("executing vault deleverage", {
        event: "deleverage.start",
        vault,
        collateralAsset: state.collateralAsset,
        debtAsset: state.debtAsset,
        collateralIn,
        quotedOut,
        minDebtOut,
        hf: fmtHf(state.hf),
        target: fmtHf(state.targetHf),
      });

      try {
        const result = await this.tx.sendTagged({
          to: vault,
          abi: comatoVaultAbi,
          functionName: "deleverage",
          args: [collateralIn, minDebtOut],
          label: "deleverage.execute",
          // O1: consume the rate limit the moment the tx is BROADCAST, so a failed
          // receipt read cannot lead to a re-deleverage. DRY_RUN never fires this.
          onBroadcast: () => this.rateLimiter.record(vault),
        });

        // A mined-but-REVERTED deleverage changed no state (breach cleared mid-flight,
        // quote drifted past minDebtOut, HF would overshoot, etc.) yet the rate limit
        // was consumed on broadcast. Report failed and roll the budget back so the
        // vault can be deleveraged again this window instead of sitting behind a
        // cooldown for a no-op tx.
        if (result.status === "reverted") {
          this.rateLimiter.unrecord(vault);
          this.log.error("deleverage reverted on-chain", {
            event: "deleverage.reverted",
            vault,
            collateralIn,
            minDebtOut,
            hash: result.hash,
          });
          return {
            status: "failed",
            vault,
            collateralIn,
            quotedOut,
            minDebtOut,
            decision,
            reasons: ["deleverage tx reverted"],
            result,
          };
        }

        this.log.info("deleverage executed", {
          event: "deleverage.executed",
          vault,
          collateralIn,
          minDebtOut,
          hash: result.hash,
          dryRun: result.dryRun,
        });
        return { status: "executed", vault, collateralIn, quotedOut, minDebtOut, decision, result };
      } catch (err) {
        this.log.error("deleverage failed", { event: "deleverage.failed", vault, error: msg(err) });
        return { status: "failed", vault, collateralIn, quotedOut, minDebtOut, decision, reasons: [msg(err)] };
      }
    } finally {
      this.inFlight.delete(key);
    }
  }
}
