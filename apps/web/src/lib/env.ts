/**
 * Live-data configuration read from Vite env (`import.meta.env.VITE_*`).
 *
 * Every field is optional. When the minimum set (RPC + subscriber + a policy or
 * executor address) is missing, {@link liveConfig} is `null` and the UI serves
 * the built-in mock fixtures — so `bun run dev` works with zero setup. The demo
 * runner (`bun run demo`) fills these in `apps/web/.env.local` after it deploys
 * the contracts to a local Celo fork.
 */

import { isAddress, getAddress, type Address } from "viem";

export interface LiveConfig {
  rpcUrl: string;
  chainId: number;
  /**
   * Model C: the ComatoVault holding the Aave position. When set, the live path
   * reads the vault (position + `Deleveraged` rescue events) instead of the old
   * Policy/Executor model, and `subscriber` becomes optional (the vault IS the
   * displayed account). This is the current architecture; policy/executor below
   * are the legacy demo path, kept for the fork demo.
   */
  vaultAddr?: Address;
  subscriber?: Address;
  policyAddr?: Address;
  executorAddr?: Address;
  policyId?: bigint;
  /** Block to start scanning rescue logs from (deploy block by default). */
  fromBlock: bigint;
}

function optAddr(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  return isAddress(value) ? getAddress(value) : undefined;
}

/**
 * Resolve the live-data config, or `null` when the app should stay on mock data.
 * Never throws: a malformed env simply degrades to the mock fallback.
 */
export function readLiveConfig(): LiveConfig | null {
  const env = import.meta.env;
  const rpcUrl = env.VITE_RPC_URL?.trim();
  const vaultAddr = optAddr(env.VITE_VAULT_ADDR);
  const subscriber = optAddr(env.VITE_SUBSCRIBER_ADDR);
  const policyAddr = optAddr(env.VITE_POLICY_ADDR);
  const executorAddr = optAddr(env.VITE_EXECUTOR_ADDR);

  // Minimum viable live config: an RPC plus EITHER a Model C vault (current
  // architecture) OR the legacy subscriber + policy/executor demo path.
  const hasVault = Boolean(vaultAddr);
  const hasLegacy = Boolean(subscriber && (policyAddr || executorAddr));
  if (!rpcUrl || (!hasVault && !hasLegacy)) return null;

  const chainId = Number.parseInt(env.VITE_CHAIN_ID ?? "42220", 10);
  const policyIdRaw = env.VITE_POLICY_ID?.trim();
  const fromBlockRaw = env.VITE_FROM_BLOCK?.trim();

  return {
    rpcUrl,
    chainId: Number.isFinite(chainId) ? chainId : 42220,
    vaultAddr,
    subscriber,
    policyAddr,
    executorAddr,
    policyId: policyIdRaw ? BigInt(policyIdRaw) : undefined,
    fromBlock: fromBlockRaw ? BigInt(fromBlockRaw) : 0n,
  };
}

export const liveConfig = readLiveConfig();
export const isLiveConfigured = liveConfig !== null;

/*//////////////////////////////////////////////////////////////
              SUBSCRIBE FLOW — wallet-driven config
//////////////////////////////////////////////////////////////*/

/**
 * Config for the browser subscribe + position flow (create a vault, supply, and
 * borrow with a connected wallet). Independent of {@link LiveConfig}: it does not
 * need an RPC or a fixed subscriber — the connected wallet supplies both. Every
 * field is optional; the flow degrades gracefully (connect still works; the
 * "Protect a position" wizard is disabled until a factory + operator are set).
 */
export interface SubscribeConfig {
  /** Chain the wallet must be on (Celo mainnet / fork = 42220). */
  chainId: number;
  /** ComatoVaultFactory — deploys the caller's vault; absent ⇒ create disabled. */
  factoryAddr?: Address;
  /** Comato operator the new vault authorizes to `deleverage`. */
  operatorAddr?: Address;
  /** Where the vault sends its capped service fee (defaults to the operator). */
  feeRecipient?: Address;
}

/** Resolve the subscribe-flow config from env. Never throws. */
export function readSubscribeConfig(): SubscribeConfig {
  const env = import.meta.env;
  const chainId = Number.parseInt(env.VITE_CHAIN_ID ?? "42220", 10);
  const operatorAddr = optAddr(env.VITE_OPERATOR_ADDR);
  return {
    chainId: Number.isFinite(chainId) ? chainId : 42220,
    factoryAddr: optAddr(env.VITE_VAULT_FACTORY_ADDR),
    operatorAddr,
    feeRecipient: optAddr(env.VITE_FEE_RECIPIENT_ADDR) ?? operatorAddr,
  };
}

export const subscribeConfig = readSubscribeConfig();
