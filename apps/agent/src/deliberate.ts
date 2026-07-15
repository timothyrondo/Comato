/**
 * Rescue deliberation — the DECISION layer that turns a mechanical breach trigger
 * into an economic choice.
 *
 * A thermostat fires whenever HF < threshold. An agent asks a harder question
 * first: is rescuing RIGHT NOW actually worth it to the subscriber? Deleveraging
 * is not free — it realizes collateral at a swap loss (pool fee + slippage) and
 * pays Comato's capped service fee. What it PREVENTS is an Aave liquidation, which
 * costs the subscriber the collateral's `liquidationBonus` (a per-asset penalty,
 * read on-chain: WETH 7.5%, USDT 5%). So the economically correct move depends on
 * how those two numbers compare, and on how close the position is to the edge:
 *
 *   - IMMINENT (HF <= criticalHf): liquidation is one bad tick away → ACT
 *     regardless of cost. Even an expensive rescue beats a near-certain penalty.
 *   - DELIBERATE (criticalHf < HF < hfThreshold): act only when the rescue is
 *     meaningfully cheaper than the penalty it avoids (on a rate basis, with a
 *     safety margin `costGateK`). If the swap is currently too expensive — thin
 *     liquidity, market stress, or a service fee that rivals the penalty — DEFER.
 *     Burning more of the subscriber's value to rescue than a liquidation would
 *     cost is a bad trade. Re-evaluated on fresh state every cycle; if it
 *     deteriorates into the imminent band, the next cycle acts.
 *
 * Every branch reports its numbers (penaltyBps, costBps, swapLossBps, urgency) so
 * the decision is auditable — economic agency you can read, not a black box.
 *
 * PURE: no I/O, no clock. The driver (`deleverage.ts`) feeds it already-read
 * on-chain values and acts on the verdict.
 */

const BPS = 10_000;

/** How close the position is to liquidation, which sets the decision mode. */
export type Urgency = "imminent" | "deliberate";

export interface DeliberationInput {
  /** Current health factor (WAD). */
  hf: bigint;
  /** HF at/below which liquidation is treated as imminent → act unconditionally (WAD). */
  criticalHf: bigint;
  /** USD value (Aave base, 8-dec) of the collateral slice being withdrawn. */
  collateralInUsd: bigint;
  /** USD value (Aave base, 8-dec) the swap yields toward repayment (quoted). */
  debtOutUsd: bigint;
  /** Aave `liquidationBonus` for the collateral asset (bps offset, e.g. 10750). */
  liquidationBonusBps: number;
  /** Vault service fee taken from the swap output (bps). */
  feeBps: number;
  /** In the deliberate band, require `penaltyBps >= costGateK * costBps` to act. */
  costGateK: number;
}

export interface RescueDecision {
  act: boolean;
  urgency: Urgency;
  /** Liquidation penalty the rescue avoids = liquidationBonus - 1e4 (bps). */
  penaltyBps: number;
  /** Realized round-trip swap loss: collateral value in vs debt value out (bps). */
  swapLossBps: number;
  /** Total cost to the subscriber of rescuing now = swapLoss + feeBps (bps). */
  costBps: number;
  /** Human-readable justification, logged with the numbers behind it. */
  rationale: string;
}

/** Imminent when HF has fallen to/through the critical line; else deliberate. */
export function classifyUrgency(hf: bigint, criticalHf: bigint): Urgency {
  return hf <= criticalHf ? "imminent" : "deliberate";
}

/**
 * The realized round-trip cost rate of the swap, in bps: how much value is lost
 * turning `collateralInUsd` of collateral into `debtOutUsd` of debt-repayment
 * (pool fee + slippage + any stable spread). Clamped to >= 0 (a quote that yields
 * slightly MORE than the oracle collateral value is treated as zero loss, not a
 * negative cost).
 */
export function swapLossBps(collateralInUsd: bigint, debtOutUsd: bigint): number {
  if (collateralInUsd <= 0n) return 0;
  const lossBps = ((collateralInUsd - debtOutUsd) * BigInt(BPS)) / collateralInUsd;
  return lossBps > 0n ? Number(lossBps) : 0;
}

/**
 * Weigh the rescue's cost against the liquidation penalty it prevents and decide
 * whether to act now. See the module header for the full rationale.
 */
export function deliberate(input: DeliberationInput): RescueDecision {
  const penaltyBps = Math.max(0, input.liquidationBonusBps - BPS);
  const loss = swapLossBps(input.collateralInUsd, input.debtOutUsd);
  const costBps = loss + Math.max(0, input.feeBps);
  const urgency = classifyUrgency(input.hf, input.criticalHf);

  if (urgency === "imminent") {
    return {
      act: true,
      urgency,
      penaltyBps,
      swapLossBps: loss,
      costBps,
      rationale:
        `imminent: HF at the critical line → rescue now regardless of cost ` +
        `(${costBps}bps) vs a near-certain ${penaltyBps}bps liquidation penalty`,
    };
  }

  // Deliberate band: only pay to rescue when the penalty clearly outweighs the cost.
  const worthIt = penaltyBps >= input.costGateK * costBps;
  return {
    act: worthIt,
    urgency,
    penaltyBps,
    swapLossBps: loss,
    costBps,
    rationale: worthIt
      ? `worth it: ${penaltyBps}bps penalty >= ${input.costGateK}x the ${costBps}bps ` +
        `rescue cost → deleverage`
      : `defer: ${costBps}bps rescue cost too close to the ${penaltyBps}bps penalty ` +
        `(margin ${input.costGateK}x) — cheaper to let it ride than to over-pay; ` +
        `will act if HF reaches the critical line`,
  };
}
