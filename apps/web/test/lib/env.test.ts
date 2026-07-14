import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readLiveConfig, liveConfig, isLiveConfigured } from "../../src/lib/env";

/**
 * `readLiveConfig()` reads `import.meta.env` (which mirrors `process.env` under
 * bun) at call time, so we can exercise both the populated and absent paths by
 * mutating env vars around each call. The module-level `liveConfig` const was
 * resolved from the harness preload env (see test/setup.ts) → non-null.
 */

const KEYS = [
  "VITE_RPC_URL",
  "VITE_CHAIN_ID",
  "VITE_SUBSCRIBER_ADDR",
  "VITE_POLICY_ADDR",
  "VITE_EXECUTOR_ADDR",
  "VITE_POLICY_ID",
  "VITE_FROM_BLOCK",
] as const;

const SUB = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
const POLICY = "0x3e59a31363e2ad014dcbc521c4a0d5757d9f3402";

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("readLiveConfig — absent / incomplete env → null (mock fallback)", () => {
  test("completely empty env → null", () => {
    expect(readLiveConfig()).toBeNull();
  });

  test("rpc + subscriber but NO policy/executor → null", () => {
    process.env.VITE_RPC_URL = "http://localhost:8545";
    process.env.VITE_SUBSCRIBER_ADDR = SUB;
    expect(readLiveConfig()).toBeNull();
  });

  test("missing subscriber → null", () => {
    process.env.VITE_RPC_URL = "http://localhost:8545";
    process.env.VITE_POLICY_ADDR = POLICY;
    expect(readLiveConfig()).toBeNull();
  });

  test("malformed subscriber address → treated as absent → null", () => {
    process.env.VITE_RPC_URL = "http://localhost:8545";
    process.env.VITE_SUBSCRIBER_ADDR = "not-an-address";
    process.env.VITE_POLICY_ADDR = POLICY;
    expect(readLiveConfig()).toBeNull();
  });
});

describe("readLiveConfig — minimum viable config", () => {
  test("rpc + subscriber + policy → live config with checksummed addr", () => {
    process.env.VITE_RPC_URL = "http://localhost:8545";
    process.env.VITE_SUBSCRIBER_ADDR = SUB;
    process.env.VITE_POLICY_ADDR = POLICY;
    const cfg = readLiveConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.rpcUrl).toBe("http://localhost:8545");
    // getAddress checksums the input.
    expect(cfg!.subscriber).toBe("0x71C7656EC7ab88b098defB751B7401B5f6d8976F");
    expect(cfg!.policyAddr).toBe("0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402");
    expect(cfg!.executorAddr).toBeUndefined();
  });

  test("executor alone (no policy) also satisfies the minimum", () => {
    process.env.VITE_RPC_URL = "http://localhost:8545";
    process.env.VITE_SUBSCRIBER_ADDR = SUB;
    process.env.VITE_EXECUTOR_ADDR = POLICY;
    const cfg = readLiveConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.executorAddr).toBe("0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402");
    expect(cfg!.policyAddr).toBeUndefined();
  });
});

describe("readLiveConfig — optional field parsing + defaults", () => {
  beforeEach(() => {
    process.env.VITE_RPC_URL = "http://localhost:8545";
    process.env.VITE_SUBSCRIBER_ADDR = SUB;
    process.env.VITE_POLICY_ADDR = POLICY;
  });

  test("defaults: chainId 42220, no policyId, fromBlock 0n", () => {
    const cfg = readLiveConfig()!;
    expect(cfg.chainId).toBe(42220);
    expect(cfg.policyId).toBeUndefined();
    expect(cfg.fromBlock).toBe(0n);
  });

  test("parses chainId, policyId (bigint), fromBlock (bigint)", () => {
    process.env.VITE_CHAIN_ID = "44787";
    process.env.VITE_POLICY_ID = "7";
    process.env.VITE_FROM_BLOCK = "72081000";
    const cfg = readLiveConfig()!;
    expect(cfg.chainId).toBe(44787);
    expect(cfg.policyId).toBe(7n);
    expect(cfg.fromBlock).toBe(72081000n);
  });

  test("non-numeric chainId falls back to 42220", () => {
    process.env.VITE_CHAIN_ID = "abc";
    // parseInt("abc") → NaN → Number.isFinite(NaN) false → 42220.
    expect(readLiveConfig()!.chainId).toBe(42220);
  });

  test("whitespace-only rpc → null (trimmed empty)", () => {
    process.env.VITE_RPC_URL = "   ";
    expect(readLiveConfig()).toBeNull();
  });
});

describe("module-level constants (from preload env)", () => {
  test("liveConfig is non-null and isLiveConfigured is true", () => {
    expect(liveConfig).not.toBeNull();
    expect(isLiveConfigured).toBe(true);
    expect(liveConfig!.chainId).toBe(42220);
    expect(liveConfig!.fromBlock).toBe(100n);
  });
});
