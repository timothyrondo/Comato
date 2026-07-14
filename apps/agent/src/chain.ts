/**
 * viem clients for Celo. A public client (reads) is always created; a wallet
 * client (writes, EOA-direct + tagged) is created only when a private key is
 * configured. The wallet's account IS `COMATO_WALLET` — the single registered
 * EOA that must be `tx_from` on every counted transfer (C1/C2/C3).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import type { Config } from "./config.ts";

export interface Chain {
  publicClient: PublicClient;
  /** Present only when COMATO_PRIVATE_KEY is set. */
  walletClient?: WalletClient;
  /** The COMATO_WALLET account (present only with a key). */
  account?: Account;
}

export function createChain(config: Config): Chain {
  const transport = http(config.rpcUrl, {
    // Batching keeps the monitor's multi-subscriber polls cheap on forno.
    batch: true,
    retryCount: 0, // we manage retries/backoff ourselves (retry.ts)
  });

  const publicClient = createPublicClient({
    chain: celo,
    transport,
  }) as PublicClient;

  if (!config.privateKey) {
    return { publicClient };
  }

  const account = privateKeyToAccount(config.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport,
  });

  return { publicClient, walletClient, account };
}
