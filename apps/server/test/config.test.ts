/**
 * Unit tests for `src/config.ts` — env-driven config loading + validation.
 *
 * Both loaders accept an `env` argument, so every case passes a plain object and
 * NEVER mutates `process.env` (no global state, fully deterministic/offline).
 * Keys used are the well-known Anvil dev keys (public test vectors — not real funds).
 */

import { describe, expect, it } from "bun:test";
import { loadServerConfig } from "../src/config.ts";
import { CELO_NETWORK, DEFAULT_CELO_RPC, DEFAULTS, X402_FACILITATOR_URL } from "../src/constants.ts";

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
