/**
 * Verified Celo contract addresses (source: celo-org/celopedia-skills, official Celo docs).
 * Do NOT guess addresses not listed here.
 */

export const CELO_MAINNET_CHAIN_ID = 42220;
export const CELO_SEPOLIA_CHAIN_ID = 11142220;

/**
 * x402 facilitator API host — MUST use Celo's (not thirdweb's default) or Track 2 won't count.
 * Use the `api.` host: the bare `x402.celo.org` is a landing page (HTML) that crashes the SDK.
 * Verified: `api.x402.celo.org/supported` returns JSON listing the eip155:42220 relayer below.
 */
export const X402_FACILITATOR_URL = "https://api.x402.celo.org";
export const X402_RELAYER = "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48" as const;

/** ERC-8021 attribution tag marker (matches Dune leaderboard filter). */
export const ERC_8021_MARKER = "0x80218021802180218021802180218021" as const;

export const MAINNET = {
  rpc: "https://forno.celo.org",
  tokens: {
    // x402 + swaps — use USDC/USDT (6 dec, EIP-3009). Avoid cUSD/USDm for x402.
    USDC: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", // 6 dec
    USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", // 6 dec
    CELO: "0x471EcE3750Da237f93B8E339c536989b8978a438",
    USDC_FEE_ADAPTER: "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B",
  },
  aaveV3: {
    pool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
    poolAddressesProvider: "0x9F7Cf9417D5251C59fE94fB9147feEe1aAd9Cea5",
    oracle: "0x1e693D088ceFD1E95ba4c4a5F7EeA41a1Ec37e8b",
    uiPoolDataProvider: "0xe48424542b30b0b8D1Dc09099aceE407f40b4491",
    protocolDataProvider: "0x2e0f8D3B1631296cC7c56538D6Eb6032601E15ED",
  },
  uniswapV3: {
    swapRouter02: "0x5615CDAb10dc425a742d643d949a7F474C01abc4",
    quoterV2: "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8",
    // Treasury volume engine (Track 1): verified liquid stable pair on-chain 2026-07-14.
    // USDC/USDT fee 100 (0.01%) — pool below, ~$113k liquidity. Lowest fee = min spread erosion.
    // Other tiers (3000) and USDC/CELO pools are dead/thin — do NOT use for treasury swaps.
    treasuryPoolFee: 100,
    usdcUsdtPool: "0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846",
  },
  erc8004: {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  },
} as const;

export const SEPOLIA = {
  rpc: "https://forno.celo-sepolia.celo-testnet.org/",
  tokens: {
    USDC: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
    USDT: "0xd077A400968890Eacc75cdc901F0356c943e4fDb",
  },
} as const;
