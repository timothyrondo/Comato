import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readSubscribeConfig, subscribeConfig } from "../../src/lib/env";

/**
 * `readSubscribeConfig()` reads `import.meta.env` (mirrored to `process.env`
 * under bun) at call time. We toggle the vars around each call. The module-level
 * `subscribeConfig` was resolved from the harness preload env (factory +
 * operator set) → both present.
 */

const KEYS = [
  "VITE_CHAIN_ID",
  "VITE_VAULT_FACTORY_ADDR",
  "VITE_OPERATOR_ADDR",
  "VITE_FEE_RECIPIENT_ADDR",
] as const;

const FACTORY = "0x3e59a31363e2ad014dcbc521c4a0d5757d9f3402";
const OPERATOR = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
const FEE = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";

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

describe("readSubscribeConfig", () => {
  test("empty env → no factory/operator, chainId defaults to 42220", () => {
    const cfg = readSubscribeConfig();
    expect(cfg.factoryAddr).toBeUndefined();
    expect(cfg.operatorAddr).toBeUndefined();
    expect(cfg.feeRecipient).toBeUndefined();
    expect(cfg.chainId).toBe(42220);
  });

  test("factory + operator resolve checksummed; feeRecipient defaults to operator", () => {
    process.env.VITE_VAULT_FACTORY_ADDR = FACTORY;
    process.env.VITE_OPERATOR_ADDR = OPERATOR;
    const cfg = readSubscribeConfig();
    expect(cfg.factoryAddr).toBe("0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402");
    expect(cfg.operatorAddr).toBe("0x71C7656EC7ab88b098defB751B7401B5f6d8976F");
    // no explicit fee recipient → falls back to the operator
    expect(cfg.feeRecipient).toBe(cfg.operatorAddr);
  });

  test("explicit fee recipient overrides the operator default", () => {
    process.env.VITE_OPERATOR_ADDR = OPERATOR;
    process.env.VITE_FEE_RECIPIENT_ADDR = FEE;
    const cfg = readSubscribeConfig();
    expect(cfg.feeRecipient).toBe("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e");
  });

  test("malformed factory address → undefined (graceful)", () => {
    process.env.VITE_VAULT_FACTORY_ADDR = "not-an-address";
    expect(readSubscribeConfig().factoryAddr).toBeUndefined();
  });

  test("non-numeric chainId falls back to 42220", () => {
    process.env.VITE_CHAIN_ID = "abc";
    expect(readSubscribeConfig().chainId).toBe(42220);
  });
});

describe("module-level subscribeConfig (preload env)", () => {
  test("factory + operator are present from the harness env", () => {
    expect(subscribeConfig.factoryAddr).toBeDefined();
    expect(subscribeConfig.operatorAddr).toBeDefined();
    expect(subscribeConfig.chainId).toBe(42220);
  });
});
