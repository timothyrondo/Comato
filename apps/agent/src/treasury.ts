/**
 * Treasury manager — the primary Track 1 volume engine.
 *
 * The insurance fund is actively managed via EOA-direct, tagged stablecoin swaps
 * on Uniswap V3 SwapRouter02. When COMATO_WALLET calls `exactInputSingle`
 * directly, the router pulls `tokenIn` via `transferFrom(COMATO_WALLET, pool,
 * amountIn)` — `transfer.from == tx_from == COMATO_WALLET` — so the input leg's
 * `amountIn` counts for Track 1 (C1). A round trip (A->B then B->A) recycles the
 * fund (cost = spread + sub-cent gas) while generating real, tagged DeFi volume.
 *
 * Sizing note: for a 1:1-ish stable pair we derive `amountOutMinimum` from the
 * input rescaled by decimals and a slippage tolerance. A production build would
 * quote via QuoterV2; this bound is intentionally conservative to avoid bleeding
 * the fund on a bad tick. The 1:1 assumption is only valid for a genuine
 * USD-stable pair, so `assertStablePair` (O7) fail-fasts a misconfigured pair at
 * config load before any swap can rely on it.
 */

import { formatUnits, type Address } from "viem";
import { MAINNET } from "@comato/shared/addresses";
import { swapRouter02Abi } from "./abis.ts";
import type { TxSender, SendResult } from "./tx.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

const NO_PRICE_LIMIT = 0n;
const BPS = 10_000n;

/**
 * The verified USD-stable set (addresses.ts). `computeAmountOutMin` derives
 * `amountOutMinimum` from a ~1:1 rescale — valid ONLY across genuine USD stables.
 */
const VERIFIED_STABLES = new Set([MAINNET.tokens.USDC, MAINNET.tokens.USDT].map((a) => a.toLowerCase()));

/**
 * Guard the ~1:1 stable assumption behind `computeAmountOutMin` (O7). On a
 * misconfigured pair (e.g. USDC/CELO, or a non-6-dec token) the 1:1-derived
 * `amountOutMinimum` is a footgun: it is computed from a fictitious 1:1 rate, so
 * the swap either reverts every cycle or — worse — permits a value-losing fill
 * that bleeds the fund. addresses.ts verified only the USDC/USDT fee-100 pool as
 * liquid (other pairs/tiers are dead/thin). We therefore refuse to run the
 * treasury engine unless BOTH legs are verified USD stables at 6 decimals; for
 * anything else, wire QuoterV2 for a real min-out instead of assuming 1:1.
 * Throws with an actionable message; callers enforce it fail-fast at config load.
 */
export function assertStablePair(t: Config["treasury"]): void {
  const a = t.tokenA.toLowerCase();
  const b = t.tokenB.toLowerCase();
  const problems: string[] = [];
  if (!VERIFIED_STABLES.has(a)) problems.push(`TREASURY_TOKEN_A ${t.tokenA} is not a verified USD stable (USDC/USDT)`);
  if (!VERIFIED_STABLES.has(b)) problems.push(`TREASURY_TOKEN_B ${t.tokenB} is not a verified USD stable (USDC/USDT)`);
  if (a === b) problems.push("TREASURY_TOKEN_A and TREASURY_TOKEN_B must differ");
  if (t.decimalsA !== 6 || t.decimalsB !== 6) {
    problems.push(`stable decimals must be 6/6 (got ${t.decimalsA}/${t.decimalsB})`);
  }
  if (problems.length > 0) {
    throw new Error(
      `Treasury pair failed the 1:1-stable guard (O7): ${problems.join("; ")}. ` +
        `computeAmountOutMin assumes a ~1:1 USD-stable pair — configure the verified USDC/USDT ` +
        `pool, or wire QuoterV2 for a real amountOutMinimum before enabling a non-stable pair.`,
    );
  }
}

/** Rescale a base-unit amount from `fromDec` to `toDec` decimals. */
export function rescaleAmount(amount: bigint, fromDec: number, toDec: number): bigint {
  if (toDec === fromDec) return amount;
  if (toDec > fromDec) return amount * 10n ** BigInt(toDec - fromDec);
  return amount / 10n ** BigInt(fromDec - toDec);
}

/**
 * Conservative `amountOutMinimum` for a ~1:1 stable swap:
 * expectedOut (input rescaled to output decimals) minus `slippageBps`.
 */
export function computeAmountOutMin(
  amountIn: bigint,
  decIn: number,
  decOut: number,
  slippageBps: number,
): bigint {
  const expectedOut = rescaleAmount(amountIn, decIn, decOut);
  return (expectedOut * (BPS - BigInt(slippageBps))) / BPS;
}

export interface SwapLeg {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  decIn: number;
  decOut: number;
  label: string;
}

export type LegStatus = "swapped" | "skipped_low_balance" | "skipped_reserve" | "skipped_no_key" | "failed";

export interface LegOutcome {
  status: LegStatus;
  leg: SwapLeg;
  amountOutMin?: bigint;
  result?: SendResult;
  reason?: string;
}

export class Treasury {
  constructor(
    private readonly tx: TxSender,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  /** Build the two legs of a round-trip (or a single leg if roundTrip=false). */
  buildCycle(): SwapLeg[] {
    const t = this.config.treasury;
    const legA: SwapLeg = {
      tokenIn: t.tokenA,
      tokenOut: t.tokenB,
      amountIn: t.swapAmount,
      decIn: t.decimalsA,
      decOut: t.decimalsB,
      label: "treasury.swap.AtoB",
    };
    if (!t.roundTrip) return [legA];
    const legB: SwapLeg = {
      tokenIn: t.tokenB,
      tokenOut: t.tokenA,
      amountIn: rescaleAmount(t.swapAmount, t.decimalsA, t.decimalsB),
      decIn: t.decimalsB,
      decOut: t.decimalsA,
      label: "treasury.swap.BtoA",
    };
    return [legA, legB];
  }

  private minReserveFor(leg: SwapLeg): bigint {
    // minReserve is configured in tokenA units; rescale to the leg's input token.
    return rescaleAmount(this.config.treasury.minReserve, this.config.treasury.decimalsA, leg.decIn);
  }

  async runLeg(leg: SwapLeg): Promise<LegOutcome> {
    if (!this.tx.canSend) return { status: "skipped_no_key", leg };

    // Balance + reserve guards keep the fund from being over-swapped.
    const balance = await this.tx.balanceOf(leg.tokenIn);
    if (balance < leg.amountIn) {
      this.log.warn("treasury: insufficient balance for leg", {
        event: "treasury.skip_balance",
        label: leg.label,
        tokenIn: leg.tokenIn,
        balance,
        amountIn: leg.amountIn,
      });
      return { status: "skipped_low_balance", leg, reason: "balance < amountIn" };
    }
    const minReserve = this.minReserveFor(leg);
    if (balance - leg.amountIn < minReserve) {
      this.log.warn("treasury: swap would breach min reserve", {
        event: "treasury.skip_reserve",
        label: leg.label,
        balance,
        amountIn: leg.amountIn,
        minReserve,
      });
      return { status: "skipped_reserve", leg, reason: "would breach min reserve" };
    }

    const amountOutMin = computeAmountOutMin(leg.amountIn, leg.decIn, leg.decOut, this.config.treasury.slippageBps);
    const recipient = this.tx.senderAddress!;
    const router = this.config.treasury.routerAddress;

    this.log.info("treasury swap", {
      event: "treasury.swap",
      label: leg.label,
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      amountIn: formatUnits(leg.amountIn, leg.decIn),
      amountOutMin: formatUnits(amountOutMin, leg.decOut),
      fee: this.config.treasury.poolFee,
    });

    try {
      await this.tx.ensureApproval(leg.tokenIn, router, leg.amountIn, leg.label);

      const params = {
        tokenIn: leg.tokenIn,
        tokenOut: leg.tokenOut,
        fee: this.config.treasury.poolFee,
        recipient,
        amountIn: leg.amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: NO_PRICE_LIMIT,
      };

      const result = await this.tx.sendTagged({
        to: router,
        abi: swapRouter02Abi,
        functionName: "exactInputSingle",
        args: [params],
        label: leg.label,
      });

      return { status: "swapped", leg, amountOutMin, result };
    } catch (err) {
      this.log.error("treasury swap failed", {
        event: "treasury.failed",
        label: leg.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: "failed", leg, reason: String(err) };
    }
  }

  async runCycle(): Promise<LegOutcome[]> {
    const outcomes: LegOutcome[] = [];
    for (const leg of this.buildCycle()) {
      outcomes.push(await this.runLeg(leg));
    }
    return outcomes;
  }
}
