/**
 * Unit tests for `src/config.ts` — env-driven config loading + validation.
 *
 * Both loaders accept an `env` argument, so every case passes a plain object and
 * NEVER mutates `process.env` (no global state, fully deterministic/offline).
 * Keys used are the well-known Anvil dev keys (public test vectors — not real funds).
 */

import { describe, expect, it } from "bun:test";
import { parseUnits } from "viem";
import { loadClientConfig, loadServerConfig } from "../src/config.ts";
import {
  CELO_NETWORK,
  DEFAULT_CELO_RPC,
  DEFAULTS,
  USDC,
  X402_FACILITATOR_URL,
} from "../src/constants.ts";

// Well-known Anvil dev keys (public test vectors). NOT real / never funded on mainnet.
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDR0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // account(KEY0)
const WALLET = "0x1111111111111111111111111111111111111111";

describe("loadServerConfig", () => {
  it("loads a valid config and applies DEFAULTS + fixed constants", () => {
    const cfg = loadServerConfig({
      COMATO_WALLET: WALLET,
      X402_API_KEY: "x402_test_abc",
      CELO_RPC: "https://my.rpc.example/celo",
      PREMIUM_USDC: "0.5",
    });

    expect(cfg.payTo).toBe(WALLET);
    expect(cfg.apiKey).toBe("x402_test_abc");
    expect(cfg.rpcUrl).toBe("https://my.rpc.example/celo");
    expect(cfg.premiumUsdc).toBe("0.5");
    // 0.5 USDC (6 dec) -> 500000 atomic units.
    expect(cfg.premiumAtomic).toBe("500000");

    // Fixed constants — not env-overridable.
    expect(cfg.facilitatorUrl).toBe(X402_FACILITATOR_URL);
    expect(cfg.network).toBe(CELO_NETWORK);
    // DEFAULTS applied.
    expect(cfg.port).toBe(DEFAULTS.port);
    expect(cfg.syncFacilitatorOnStart).toBe(DEFAULTS.syncFacilitatorOnStart);
    expect(cfg.assertRelayer).toBe(DEFAULTS.assertRelayer);
  });

  it("applies CELO_RPC + PREMIUM_USDC defaults when absent (0.001 -> 1000 atomic)", () => {
    const cfg = loadServerConfig({ COMATO_WALLET: WALLET, X402_API_KEY: "x402_test_abc" });
    expect(cfg.rpcUrl).toBe(DEFAULT_CELO_RPC);
    expect(cfg.premiumUsdc).toBe("0.001");
    expect(cfg.premiumAtomic).toBe("1000");
  });

  it("throws when X402_API_KEY is missing (facilitator /settle 401s without it)", () => {
    expect(() => loadServerConfig({ COMATO_WALLET: WALLET })).toThrow(/X402_API_KEY/);
  });

  it("throws when X402_API_KEY is empty string", () => {
    expect(() => loadServerConfig({ COMATO_WALLET: WALLET, X402_API_KEY: "" })).toThrow(/X402_API_KEY/);
  });

  it("throws when COMATO_WALLET is missing", () => {
    expect(() => loadServerConfig({ X402_API_KEY: "x402_test_abc" })).toThrow();
  });

  it("throws when COMATO_WALLET is not a valid 0x EVM address", () => {
    expect(() =>
      loadServerConfig({ COMATO_WALLET: "not-an-address", X402_API_KEY: "x402_test_abc" }),
    ).toThrow(/0x EVM address/);
  });

  it("throws when CELO_RPC is not a valid URL", () => {
    expect(() =>
      loadServerConfig({ COMATO_WALLET: WALLET, X402_API_KEY: "x402_test_abc", CELO_RPC: "definitely not a url" }),
    ).toThrow();
  });

  it("throws with a clear message when PREMIUM_USDC is not a valid decimal amount", () => {
    expect(() =>
      loadServerConfig({ COMATO_WALLET: WALLET, X402_API_KEY: "x402_test_abc", PREMIUM_USDC: "abc" }),
    ).toThrow(/PREMIUM_USDC="abc" is not a valid USDC decimal amount/);
  });
});

describe("loadClientConfig", () => {
  it("loads a valid single-key config with DEFAULTS + HEARTBEAT_URL default", () => {
    const cfg = loadClientConfig({ SUBSCRIBER_PRIVATE_KEYS: KEY0 });
    expect(cfg.subscriberKeys).toEqual([KEY0]);
    expect(cfg.heartbeatUrl).toBe("http://localhost:4021/heartbeat");
    expect(cfg.intervalMs).toBe(DEFAULTS.heartbeatIntervalMs);
    expect(cfg.maxHeartbeats).toBe(DEFAULTS.heartbeatMax);
    expect(cfg.maxValueAtomic).toBe(parseUnits(DEFAULTS.maxPaymentUsdc, USDC.decimals));
    // No fixed constant — concurrency defaults to the subscriber count.
    expect(cfg.concurrency).toBe(1);
  });

  it("honors a provided HEARTBEAT_URL", () => {
    const cfg = loadClientConfig({
      SUBSCRIBER_PRIVATE_KEYS: KEY0,
      HEARTBEAT_URL: "http://example.test:9/heartbeat",
    });
    expect(cfg.heartbeatUrl).toBe("http://example.test:9/heartbeat");
  });

  it("defaults concurrency to the number of subscriber keys", () => {
    const cfg = loadClientConfig({ SUBSCRIBER_PRIVATE_KEYS: `${KEY0},${KEY1}` });
    expect(cfg.subscriberKeys).toEqual([KEY0, KEY1]);
    expect(cfg.concurrency).toBe(2);
  });

  it("trims + filters empty/whitespace entries before parsing", () => {
    const cfg = loadClientConfig({ SUBSCRIBER_PRIVATE_KEYS: `  ${KEY0} , , ${KEY1} ,  ` });
    expect(cfg.subscriberKeys).toEqual([KEY0, KEY1]);
    expect(cfg.concurrency).toBe(2);
  });

  it("throws when SUBSCRIBER_PRIVATE_KEYS is missing entirely", () => {
    expect(() => loadClientConfig({})).toThrow(/SUBSCRIBER_PRIVATE_KEYS/);
  });

  it("throws the 'is required' message when SUBSCRIBER_PRIVATE_KEYS is an empty string", () => {
    expect(() => loadClientConfig({ SUBSCRIBER_PRIVATE_KEYS: "" })).toThrow(
      /SUBSCRIBER_PRIVATE_KEYS is required/,
    );
  });

  it("throws 'at least one' when every entry is empty/whitespace", () => {
    expect(() => loadClientConfig({ SUBSCRIBER_PRIVATE_KEYS: "  , ,   " })).toThrow(
      /at least one private key/,
    );
  });

  it("throws a per-index message for an invalid key (reports the offending index)", () => {
    // index 0 valid, index 1 invalid -> message must cite [1].
    expect(() =>
      loadClientConfig({ SUBSCRIBER_PRIVATE_KEYS: `${KEY0},0xnothex` }),
    ).toThrow(/SUBSCRIBER_PRIVATE_KEYS\[1\] invalid/);
  });

  it("rejects a key that is not 0x-prefixed 32-byte hex (index 0)", () => {
    expect(() =>
      loadClientConfig({ SUBSCRIBER_PRIVATE_KEYS: "0xabc" }),
    ).toThrow(/SUBSCRIBER_PRIVATE_KEYS\[0\] invalid: must be a 0x-prefixed 32-byte hex private key/);
  });

  it("sanity: the Anvil key really parses to its known address (offline signer)", async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    expect(privateKeyToAccount(KEY0).address.toLowerCase()).toBe(ADDR0.toLowerCase());
  });
});
