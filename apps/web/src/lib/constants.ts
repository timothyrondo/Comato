/**
 * Verified Celo mainnet addresses used by the live-data layer.
 *
 * Source of truth: `packages/shared/src/addresses.ts` (verified against Celo
 * docs). Copied here as plain constants because `apps/web` is a standalone Vite
 * app with no build step wired to the shared package. The anvil demo forks Celo
 * mainnet, so these same addresses resolve on the local fork.
 */

import { getAddress } from "viem";

export const AAVE_V3_POOL = getAddress(
  "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
);

export const TOKENS = {
  USDC: getAddress("0xcebA9300f2b948710d2653dD7B07f33A8B32118C"),
  USDT: getAddress("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"),
  USDm: getAddress("0x765DE816845861e75A25fCA122bb6898B8B1282a"),
  WETH: getAddress("0xD221812de1BD094f35587EE8E174B07B6167D9Af"),
  CELO: getAddress("0x471EcE3750Da237f93B8E339c536989b8978a438"),
} as const;

/** Aave base currency (USD) is quoted with 8 decimals. */
export const AAVE_BASE_DECIMALS = 8;
/** Aave LTV / liquidation-threshold params are basis points (1e4 = 100%). */
export const AAVE_BPS = 10_000;

const SYMBOL_BY_ADDRESS = new Map<string, string>(
  Object.entries(TOKENS).map(([symbol, address]) => [
    address.toLowerCase(),
    symbol,
  ]),
);

/** Resolve a known Celo token symbol, falling back to a short address. */
export function tokenSymbol(address?: string): string {
  if (!address) return "—";
  return (
    SYMBOL_BY_ADDRESS.get(address.toLowerCase()) ??
    `${address.slice(0, 6)}…${address.slice(-4)}`
  );
}
