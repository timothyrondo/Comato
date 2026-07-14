/**
 * config.ts tests — loadConfig() env validation + safe-by-default posture, and
 * redactConfig() secret-hiding. Each test mutates process.env for a whitelisted
 * set of keys and restores it afterward. Two branches (slippage bound, stable-pair
 * guard) are driven purely from DEFAULTS, so those tests temporarily mutate DEFAULTS
 * (a runtime-mutable object despite `as const`) and restore it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseUnits } from "viem";
import { loadConfig, redactConfig } from "../src/config.ts";
import { DEFAULTS } from "../src/defaults.ts";

const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const CELO = "0x471EcE3750Da237f93B8E339c536989b8978a438";
const KEY64 = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Env keys loadConfig() reads. Cleared before each test, restored after.
const KEYS = [
  "ATTRIBUTION_CODE",
  "COMATO_PRIVATE_KEY",
  "DRY_RUN",
  "SUBSCRIBERS",
  "CELO_RPC",
  "LOG_LEVEL",
  "TREASURY_ENABLED",
  "RESCUE_ENABLED",
  "X402_ENABLED",
  "X402_DATA_URL",
  "EXECUTOR_ADDRESS",
  "POLICY_ADDRESS",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // A valid baseline; individual tests override / delete as needed.
  process.env.ATTRIBUTION_CODE = "timo_comato";
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig — identity / defaults", () => {
  test("valid minimal config: read-only + dryRun forced when no key", () => {
    const c = loadConfig();
    expect(c.chainId).toBe(42220);
    expect(c.attributionCode).toBe("timo_comato");
    expect(c.privateKey).toBeUndefined();
    expect(c.dryRun).toBe(true);
    expect(c.subscribers).toEqual([]);
    expect(c.treasury.enabled).toBe(false);
    expect(c.rescue.enabled).toBe(false);
    expect(c.x402.enabled).toBe(false);
    expect(c.rpcUrl).toBe("https://forno.celo.org");
  });

  test("CELO_RPC and LOG_LEVEL overrides are honored", () => {
    process.env.CELO_RPC = "https://custom.rpc";
    process.env.LOG_LEVEL = "debug";
    const c = loadConfig();
    expect(c.rpcUrl).toBe("https://custom.rpc");
    expect(c.logLevel).toBe("debug");
  });

  test("missing ATTRIBUTION_CODE throws", () => {
    delete process.env.ATTRIBUTION_CODE;
    expect(() => loadConfig()).toThrow(/Missing required env var: ATTRIBUTION_CODE/);
  });

  test("malformed ATTRIBUTION_CODE (uppercase/symbols) throws", () => {
    process.env.ATTRIBUTION_CODE = "Bad-Code!";
    expect(() => loadConfig()).toThrow(/must match/);
  });
});

describe("loadConfig — private key + dry-run", () => {
  test("bad COMATO_PRIVATE_KEY throws", () => {
    process.env.COMATO_PRIVATE_KEY = "0x1234";
    expect(() => loadConfig()).toThrow(/32-byte hex/);
  });

  test("valid key without 0x prefix is normalized; dryRun defaults true", () => {
    process.env.COMATO_PRIVATE_KEY = KEY64; // no 0x
    const c = loadConfig();
    expect(c.privateKey).toBe(`0x${KEY64}`);
    expect(c.dryRun).toBe(true);
  });

  test("DRY_RUN=false with a key => live sending", () => {
    process.env.COMATO_PRIVATE_KEY = `0x${KEY64}`;
    process.env.DRY_RUN = "false";
    expect(loadConfig().dryRun).toBe(false);
  });

  test("DRY_RUN=false WITHOUT a key is overridden back to true (read-only)", () => {
    process.env.DRY_RUN = "false";
    const c = loadConfig();
    expect(c.privateKey).toBeUndefined();
    expect(c.dryRun).toBe(true);
  });
});

describe("loadConfig — subscribers", () => {
  test("malformed SUBSCRIBERS JSON throws", () => {
    process.env.SUBSCRIBERS = "not json";
    expect(() => loadConfig()).toThrow(/must be valid JSON/);
  });

  test("SUBSCRIBERS that is not an array throws", () => {
    process.env.SUBSCRIBERS = "{}";
    expect(() => loadConfig()).toThrow(/must be a JSON array/);
  });

  test("subscriber missing address throws", () => {
    process.env.SUBSCRIBERS = "[{}]";
    expect(() => loadConfig()).toThrow(/address is required/);
  });

  test("subscriber with a bad address throws", () => {
    process.env.SUBSCRIBERS = JSON.stringify([{ address: "0xnotanaddress" }]);
    expect(() => loadConfig()).toThrow(/Invalid address/);
  });

  test("fully specified subscriber is parsed and typed", () => {
    process.env.SUBSCRIBERS = JSON.stringify([
      {
        address: USDC, // any valid address; used as the borrower address here
        hfThreshold: "1.1",
        debtAsset: USDT,
        collateralAsset: CELO,
        policyId: 3,
        premiumPaidUntilMs: 123456,
      },
    ]);
    const c = loadConfig();
    expect(c.subscribers.length).toBe(1);
    const s = c.subscribers[0]!;
    expect(s.hfThreshold).toBe(parseUnits("1.1", 18));
    expect(s.collateralAsset).toBeDefined();
    expect(s.policyId).toBe(3n);
    expect(s.premiumPaidUntilMs).toBe(123456);
  });

  test("subscriber defaults: hfThreshold 1.05 and USDC debt asset", () => {
    process.env.SUBSCRIBERS = JSON.stringify([{ address: USDC }]);
    const s = loadConfig().subscribers[0]!;
    expect(s.hfThreshold).toBe(parseUnits("1.05", 18));
    expect(s.debtAsset.toLowerCase()).toBe(USDC.toLowerCase());
    expect(s.collateralAsset).toBeUndefined();
    expect(s.policyId).toBeUndefined();
  });
});

describe("loadConfig — executor / policy addresses", () => {
  test("valid EXECUTOR_ADDRESS and POLICY_ADDRESS are set", () => {
    process.env.EXECUTOR_ADDRESS = USDC;
    process.env.POLICY_ADDRESS = USDT;
    const c = loadConfig();
    expect(c.rescue.executorAddress).toBeDefined();
    expect(c.rescue.policyAddress).toBeDefined();
  });

  test("bad EXECUTOR_ADDRESS throws", () => {
    process.env.EXECUTOR_ADDRESS = "0xbroken";
    expect(() => loadConfig()).toThrow(/Invalid address in EXECUTOR_ADDRESS/);
  });
});

describe("loadConfig — x402 toggle", () => {
  test("X402_DATA_URL alone enables x402", () => {
    process.env.X402_DATA_URL = "https://data.example/price";
    const c = loadConfig();
    expect(c.x402.enabled).toBe(true);
    expect(c.x402.dataUrl).toBe("https://data.example/price");
  });

  test("X402_ENABLED=false overrides even with a data URL present", () => {
    process.env.X402_DATA_URL = "https://data.example/price";
    process.env.X402_ENABLED = "false";
    expect(loadConfig().x402.enabled).toBe(false);
  });
});

describe("loadConfig — treasury guards (DEFAULTS-driven)", () => {
  test("slippage >= 10000 bps is rejected", () => {
    const orig = DEFAULTS.treasury.slippageBps;
    try {
      (DEFAULTS as unknown as { treasury: { slippageBps: number } }).treasury.slippageBps = 10_000;
      expect(() => loadConfig()).toThrow(/TREASURY_SLIPPAGE_BPS must be in \[0, 10000\)/);
    } finally {
      (DEFAULTS as unknown as { treasury: { slippageBps: number } }).treasury.slippageBps = orig;
    }
  });

  test("assertStablePair fires when treasury enabled with a non-stable pair", () => {
    const orig = DEFAULTS.treasury.tokenB;
    process.env.TREASURY_ENABLED = "true";
    try {
      // Default USDC/USDT passes...
      expect(() => loadConfig()).not.toThrow();
      // ...a non-stable tokenB trips the O7 guard.
      (DEFAULTS as unknown as { treasury: { tokenB: string } }).treasury.tokenB = CELO;
      expect(() => loadConfig()).toThrow(/1:1-stable guard/);
    } finally {
      (DEFAULTS as unknown as { treasury: { tokenB: string } }).treasury.tokenB = orig;
    }
  });

  test("treasury guard is NOT enforced when the engine is disabled", () => {
    const orig = DEFAULTS.treasury.tokenB;
    try {
      (DEFAULTS as unknown as { treasury: { tokenB: string } }).treasury.tokenB = CELO;
      // TREASURY_ENABLED unset (false) => assertStablePair skipped => no throw.
      expect(() => loadConfig()).not.toThrow();
    } finally {
      (DEFAULTS as unknown as { treasury: { tokenB: string } }).treasury.tokenB = orig;
    }
  });
});

describe("redactConfig", () => {
  test("never exposes the private key; reports presence as a boolean", () => {
    process.env.COMATO_PRIVATE_KEY = `0x${KEY64}`;
    const c = loadConfig();
    const red = redactConfig(c);
    expect("privateKey" in red).toBe(false);
    expect(red.hasPrivateKey).toBe(true);
    expect(JSON.stringify(red)).not.toContain(KEY64);
    expect(red.chainId).toBe(42220);
    expect(red.dryRun).toBe(true);
  });

  test("hasPrivateKey is false in read-only mode", () => {
    expect(redactConfig(loadConfig()).hasPrivateKey).toBe(false);
  });
});
