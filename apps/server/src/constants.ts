/**
 * Celo mainnet x402 constants.
 *
 * Source of truth: `packages/shared/src/addresses.ts` (verified from
 * celo-org/celopedia-skills / official Celo docs). Mirrored here so `apps/server`
 * stays self-contained and does not import across workspace packages.
 *
 * The USDC EIP-712 domain (`name`, `version`) was read directly from the token
 * contract on Celo mainnet (`name()` -> "USDC", `version()` -> "2"). These feed the
 * `AssetAmount.extra` field the exact scheme uses to build the EIP-3009
 * `transferWithAuthorization` domain — Celo (eip155:42220) is NOT in the SDK's
 * default stablecoin table, so this must be supplied explicitly.
 */

export const CELO_CHAIN_ID = 42220;

/** CAIP-2 network id used for scheme registration + payment requirements. */
export const CELO_NETWORK = "eip155:42220" as const;
export type CeloNetwork = typeof CELO_NETWORK;

/**
 * Celo's x402 facilitator API base URL.
 *
 * NOTE (verified against the live endpoint): the machine API is at the `api.`
 * host — `https://api.x402.celo.org/supported` returns JSON, whereas
 * `https://x402.celo.org/supported` returns the landing-page HTML and crashes the
 * SDK. The architecture doc's "facilitator https://x402.celo.org" refers to the
 * human-facing site; the settle/verify/supported API lives at `api.x402.celo.org`
 * (its `/supported` `signers` map lists the eip155:42220 relayer as X402_RELAYER
 * below — confirming this is the Celo facilitator, not thirdweb's default).
 *
 * MUST stay Celo's facilitator — thirdweb's default submits from a different
 * relayer, which settles fine but does NOT count for Track 2.
 */
export const X402_FACILITATOR_URL = "https://api.x402.celo.org";

/**
 * Celo x402 relayer address — the `tx_from` the Dune Track-2 query keys on.
 * Stored lowercased for direct string comparison against `getTransaction().from`.
 */
export const X402_RELAYER = "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48".toLowerCase();

/** Native USDC on Celo (6 decimals, EIP-3009). */
export const USDC = {
  address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  decimals: 6,
  name: "USDC", // token.name(), read on-chain
  version: "2", // token.version(), read on-chain
} as const;

export const DEFAULT_CELO_RPC = "https://forno.celo.org";
