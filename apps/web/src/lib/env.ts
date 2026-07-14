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
  subscriber: Address;
  policyAddr?: Address;
  executorAddr?: Address;
  policyId?: bigint;
  /** Block to start scanning RescueExecuted logs from (fork block by default). */
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
  const subscriber = optAddr(env.VITE_SUBSCRIBER_ADDR);
  const policyAddr = optAddr(env.VITE_POLICY_ADDR);
  const executorAddr = optAddr(env.VITE_EXECUTOR_ADDR);

  // Minimum viable live config: an RPC, a subscriber to display, and at least
  // one Comato contract to read policy/rescue data from.
  if (!rpcUrl || !subscriber || (!policyAddr && !executorAddr)) return null;

  const chainId = Number.parseInt(env.VITE_CHAIN_ID ?? "42220", 10);
  const policyIdRaw = env.VITE_POLICY_ID?.trim();
  const fromBlockRaw = env.VITE_FROM_BLOCK?.trim();

  return {
    rpcUrl,
    chainId: Number.isFinite(chainId) ? chainId : 42220,
    subscriber,
    policyAddr,
    executorAddr,
    policyId: policyIdRaw ? BigInt(policyIdRaw) : undefined,
    fromBlock: fromBlockRaw ? BigInt(fromBlockRaw) : 0n,
  };
}

export const liveConfig = readLiveConfig();
export const isLiveConfigured = liveConfig !== null;
