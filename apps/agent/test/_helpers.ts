/** Test helpers: a full default Config and a silent logger. */

import { parseUnits, type Address } from "viem";
import { MAINNET, X402_FACILITATOR_URL, X402_RELAYER } from "@comato/shared/addresses";
import type { Config } from "../src/config.ts";
import type { Logger } from "../src/logger.ts";

export const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const EOA = "0x00000000000000000000000000000000000000a1" as Address;

export function makeConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    chainId: 42220,
    rpcUrl: MAINNET.rpc,
    attributionCode: "timo_comato",
    privateKey: undefined,
    dryRun: true,
    logLevel: "error",
    monitorIntervalMs: 30_000,
    subscribers: [],
    vaults: [],
    deleverage: {
      enabled: true,
      slippageBps: 100,
      maxCollateralIn: parseUnits("100000", 18),
      quoterAddress: MAINNET.uniswapV3.quoterV2 as Address,
      cooldownMs: 3_600_000,
      maxPerWindow: 3,
      windowMs: 86_400_000,
      // In-memory only for tests (RateLimiter constructed without a persist path).
      rateLimitStatePath: "",
    },
    rescue: {
      enabled: true,
      distressHf: parseUnits("1.05", 18),
      maxAmount: parseUnits("50", 6),
      cooldownMs: 3_600_000,
      maxPerWindow: 3,
      windowMs: 86_400_000,
      viaExecutor: false,
      executorAddress: undefined,
      policyAddress: undefined,
      requirePremium: true,
      // In-memory only for tests: RateLimiter is constructed with 3 args (no persist).
      rateLimitStatePath: "",
    },
    treasury: {
      enabled: true,
      intervalMs: 60_000,
      tokenA: MAINNET.tokens.USDC as Address,
      tokenB: MAINNET.tokens.USDT as Address,
      swapAmount: parseUnits("1", 6),
      decimalsA: 6,
      decimalsB: 6,
      poolFee: 100,
      slippageBps: 50,
      roundTrip: true,
      routerAddress: MAINNET.uniswapV3.swapRouter02 as Address,
      minReserve: 0n,
    },
    x402: {
      enabled: false,
      dataUrl: undefined,
      maxValue: 100_000n,
      requestTimeoutMs: 15_000,
      facilitatorUrl: X402_FACILITATOR_URL,
      relayer: X402_RELAYER as Address,
    },
    pricer: {
      // Disabled in tests: pricing must never be a hidden dependency of other paths.
      enabled: false,
      apiKey: "",
      baseUrl: "https://example.invalid/v1",
      model: "test/model",
      timeoutMs: 5_000,
      storePath: "/nonexistent/quotes.json",
      repriceIntervalMs: 21_600_000,
      billingWindowMs: 3_600_000,
    },
  };
  return {
    ...base,
    ...overrides,
    deleverage: { ...base.deleverage, ...(overrides.deleverage ?? {}) },
    rescue: { ...base.rescue, ...(overrides.rescue ?? {}) },
    treasury: { ...base.treasury, ...(overrides.treasury ?? {}) },
    x402: { ...base.x402, ...(overrides.x402 ?? {}) },
    pricer: { ...base.pricer, ...(overrides.pricer ?? {}) },
  };
}
