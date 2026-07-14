import { test, expect, describe } from "bun:test";
import {
  AAVE_V3_POOL,
  TOKENS,
  AAVE_BASE_DECIMALS,
  AAVE_BPS,
  tokenSymbol,
} from "../../src/lib/constants";

describe("verified Celo addresses (checksummed)", () => {
  test("Aave V3 pool", () => {
    expect(AAVE_V3_POOL).toBe("0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402");
  });
  test("token map", () => {
    expect(TOKENS.USDC).toBe("0xcebA9300f2b948710d2653dD7B07f33A8B32118C");
    expect(TOKENS.USDT).toBe("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e");
    expect(TOKENS.CELO).toBe("0x471EcE3750Da237f93B8E339c536989b8978a438");
  });
  test("Aave scaling constants", () => {
    expect(AAVE_BASE_DECIMALS).toBe(8);
    expect(AAVE_BPS).toBe(10_000);
  });
});

describe("tokenSymbol", () => {
  test("resolves a known token regardless of case", () => {
    expect(tokenSymbol(TOKENS.USDC)).toBe("USDC");
    expect(tokenSymbol(TOKENS.USDC.toLowerCase())).toBe("USDC");
    expect(tokenSymbol(TOKENS.CELO)).toBe("CELO");
  });

  test("undefined → em dash", () => {
    expect(tokenSymbol(undefined)).toBe("—");
    expect(tokenSymbol()).toBe("—");
  });

  test("unknown address → shortened 0x…", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    expect(tokenSymbol(addr)).toBe("0x1234…5678");
  });
});
