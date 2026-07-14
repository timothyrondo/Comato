/**
 * Browser viem public client for the live-data layer. Reads only — the UI never
 * signs or sends transactions. The chain is Celo (id from env, defaults 42220);
 * the transport points at the configured RPC (the anvil fork during a demo).
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { celo } from "viem/chains";
import type { LiveConfig } from "./env";

export function createReadClient(cfg: LiveConfig): PublicClient {
  const chain = { ...celo, id: cfg.chainId };
  return createPublicClient({
    chain,
    // Batch multicalls keep the position + policy reads to a single round-trip.
    transport: http(cfg.rpcUrl, { batch: true, retryCount: 2 }),
  }) as PublicClient;
}
