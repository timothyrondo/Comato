/**
 * Tuning defaults — the single source of truth for every pure tuning knob.
 *
 * These used to be read from env (with an inline fallback), but they are neither
 * secrets nor genuinely per-deployment values — they are constants you adjust in
 * code. `config.ts` imports `DEFAULTS` and uses it directly; env now carries only
 * secrets, per-deployment values, and operational toggles.
 *
 * Token / router / facilitator / relayer literals are NOT duplicated here — they
 * come from `@comato/shared/addresses` (the verified source of truth).
 *
 * Adjust a value here and it changes everywhere. To change it per run without a code
 * edit, re-introduce an env read for that one field in `config.ts`.
 */

import {
  MAINNET,
  CELO_MAINNET_CHAIN_ID,
  X402_FACILITATOR_URL,
  X402_RELAYER,
} from "@comato/shared/addresses";

export const DEFAULTS = {
  /** Celo mainnet chain id (verified, from shared). */
  chainId: CELO_MAINNET_CHAIN_ID,
  /** Health-factor poll cadence. */
  monitorIntervalMs: 30_000,

  rescue: {
    /** Absolute genuine-distress ceiling, WAD-decimal string (parsed at 1e18). */
    distressHf: "1.05",
    /** Max debt-asset units repaid per rescue (human decimal, scaled by assetDecimals). */
    maxAmount: "50",
    /** Decimals of the rescue debt asset (USDC/USDT = 6). */
    assetDecimals: 6,
    /** Per-subscriber cooldown between rescues (rate limit). */
    cooldownMs: 3_600_000,
    /** Max rescues per subscriber within `windowMs`. */
    maxPerWindow: 3,
    windowMs: 86_400_000,
    /** Route via ComatoExecutor.rescue() instead of EOA-direct (safety path; loses C1). */
    viaExecutor: false,
    /** Fail-closed: never rescue a subscriber with no paid-through premium. */
    requirePremium: true,
    /** Rate-limiter state file (reloaded on boot so a restart keeps cooldowns). "" disables. */
    stateFile: ".comato/rate-limiter-state.json",
  },

  treasury: {
    intervalMs: 60_000,
    /** Verified USDC/USDT stable pair (from shared). */
    tokenA: MAINNET.tokens.USDC,
    tokenB: MAINNET.tokens.USDT,
    decimalsA: 6,
    decimalsB: 6,
    /** Input per swap, in tokenA units (human decimal, scaled by decimalsA). */
    swapAmount: "1",
    /** Uniswap V3 fee tier (100 = 0.01%). */
    poolFee: 100,
    /** amountOutMinimum tolerance, in basis points. */
    slippageBps: 50,
    /** A->B then B->A each cycle (keeps the fund whole). */
    roundTrip: true,
    /** Uniswap SwapRouter02 (from shared). */
    router: MAINNET.uniswapV3.swapRouter02,
    /** Skip a swap if source balance would fall below this (human decimal, scaled by decimalsA). */
    minReserve: "0",
  },

  x402: {
    /** Max payment per request, in token base units (safety cap). */
    maxValue: "100000",
    /** Hard timeout for a single paid data request. */
    requestTimeoutMs: 15_000,
    /** Celo facilitator URL (from shared). */
    facilitatorUrl: X402_FACILITATOR_URL,
    /** Celo relayer address the settlement must originate from (from shared). */
    relayer: X402_RELAYER,
  },

  pricer: {
    /** Reasoning-capable and cheap; measured ~6.5-9s per quote — slow-loop only. */
    model: "openai/gpt-5-mini",
    /** Generous: the pricer is fail-open, a timeout just means the default tier. */
    timeoutMs: 30_000,
    /** Shared with apps/server (both run from their app dir, so ../../ = repo root). */
    storePath: "../../.comato/quotes.json",
    /** Re-underwrite every 6h — position risk moves in hours, not per heartbeat. */
    repriceIntervalMs: 21_600_000,
    /** Must match the server's billing cadence (heartbeatIntervalMs, 1h). */
    billingWindowMs: 3_600_000,
  },
} as const;
