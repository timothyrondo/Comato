/**
 * e2e constants. Addresses of the Celo protocol come from the verified shared
 * source (`@comato/shared/addresses`); anvil test keys are the well-known,
 * publicly-documented anvil dev mnemonic ("test test ... junk") accounts — NOT
 * real keys, funded only on the local fork.
 */
import { type Address, type Hex } from "viem";
import { MAINNET } from "@comato/shared/addresses";

export const RPC_PORT = 8546;
export const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
export const FORK_URL = process.env.CELO_FORK_URL ?? "https://forno.celo.org";
export const CHAIN_ID = 42220;

/**
 * Pin the fork to a fixed recent Celo block so the run is DETERMINISTIC and
 * anvil can serve most reads from its on-disk cache (far fewer forno calls →
 * no "latest"-block drift or transient-state flakiness). Override with
 * FORK_BLOCK=<n>, or FORK_BLOCK=latest to always fork the chain tip.
 */
export const DEFAULT_FORK_BLOCK = "72081000";
export const FORK_BLOCK =
  process.env.FORK_BLOCK === "latest" ? undefined : process.env.FORK_BLOCK ?? DEFAULT_FORK_BLOCK;

// Verified Celo mainnet protocol addresses (source of truth: packages/shared).
export const POOL = MAINNET.aaveV3.pool as Address;
export const USDC = MAINNET.tokens.USDC as Address; // 6 dec — debt asset
export const USDT = MAINNET.tokens.USDT as Address; // 6 dec — collateral

// Aave V3 aTokens that custody the underlying reserves on Celo. Read live from
// the pool via `getReserveData(asset).aTokenAddress` (verified 2026-07). We
// impersonate these to fund test accounts (they hold plenty of underlying), so
// no storage-slot guessing and no real whale keys are needed.
export const aUSDC = "0xFF8309b9e99bfd2D4021bc71a362aBD93dBd4785" as Address;
export const aUSDT = "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df" as Address;

// Well-known anvil dev accounts (mnemonic "test test test test test test test
// test test test test junk"). Public, deterministic, funded only on the fork.
export const COMATO = {
  // account[0] — the registered EOA "COMATO_WALLET": deployer, Policy/Executor
  // owner, rescue sender, USDC float holder.
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
  key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
};
export const SUB_A = {
  // account[1] — subscriber rescued via the EOA-direct counting path.
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
  key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
};
export const SUB_B = {
  // account[2] — subscriber rescued via the ComatoExecutor safety path.
  address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address,
  key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
};

export const USDC_UNIT = 10n ** 6n;
export const WAD = 10n ** 18n;

// Generous transport timeout: the FIRST heavy tx on a cold fork makes anvil
// lazily fetch a lot of storage from forno; the default 10s can be too short.
export const TX_TIMEOUT_MS = 120_000;
