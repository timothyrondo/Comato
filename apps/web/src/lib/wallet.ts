/**
 * Injected-wallet primitives for the browser subscribe + position flow.
 *
 * Read-only monitoring uses `chain.ts` (a public HTTP client). This module is
 * the WRITE side: it talks to an EIP-1193 injected wallet (`window.ethereum`)
 * via viem's `custom` transport so a real user can sign the vault txns
 * (createVault / approve / supply / borrow) from the page.
 *
 * Everything degrades gracefully when no wallet is present — `getInjectedProvider`
 * returns `null` and the UI shows a "no wallet detected" state rather than
 * throwing. Pure viem/provider helpers only; the React state lives in
 * `data/wallet.tsx`.
 */

import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  getAddress,
  numberToHex,
  type Address,
  type EIP1193Provider,
  type WalletClient,
  type PublicClient,
} from "viem";
import { celo } from "viem/chains";

/** Celo mainnet (and the demo fork share this id). */
export const CELO_CHAIN_ID = 42220;

/** The chain object writes are pinned to (id/currency/rpc for viem fee logic). */
export const walletChain = celo;

/** Narrow window typing without polluting the global scope. */
type EthWindow = { ethereum?: EIP1193Provider };

/** The injected EIP-1193 provider, or `null` when no browser wallet is present. */
export function getInjectedProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as EthWindow).ethereum ?? null;
}

/** True when a browser wallet is available to connect. */
export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

/** A wallet client bound to the injected provider (signs + sends txns). */
export function getWalletClient(): WalletClient {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("No browser wallet detected");
  return createWalletClient({ chain: walletChain, transport: custom(provider) });
}

/**
 * A public client that reads the SAME node the wallet is pointed at (the injected
 * provider), so reads and writes agree — during a demo both hit the Celo fork.
 * Falls back to an HTTP transport if no provider (only reached in tests, where
 * `createPublicClient` is mocked anyway).
 */
export function getWalletPublicClient(): PublicClient {
  const provider = getInjectedProvider();
  return createPublicClient({
    chain: walletChain,
    transport: provider ? custom(provider) : http(),
  }) as PublicClient;
}

/** Raw EIP-1193 request helper (throws if no provider). */
async function request<T>(method: string, params?: unknown[]): Promise<T> {
  const provider = getInjectedProvider() as unknown as {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  } | null;
  if (!provider) throw new Error("No browser wallet detected");
  return provider.request({ method, params }) as Promise<T>;
}

/** Prompt the wallet to connect; returns the checksummed accounts it exposes. */
export async function requestAccounts(): Promise<Address[]> {
  const accounts = await request<string[]>("eth_requestAccounts");
  return accounts.map((a) => getAddress(a));
}

/** Silently read already-authorized accounts (no prompt) to restore a session. */
export async function getAuthorizedAccounts(): Promise<Address[]> {
  try {
    const accounts = await request<string[]>("eth_accounts");
    return accounts.map((a) => getAddress(a));
  } catch {
    return [];
  }
}

/** The wallet's current chain id. */
export async function getChainId(): Promise<number> {
  const hex = await request<string>("eth_chainId");
  return Number.parseInt(hex, 16);
}

/**
 * Switch the wallet to Celo (adding the network if the wallet doesn't know it).
 * Resolves once the wallet reports the target chain.
 */
export async function switchToCelo(): Promise<void> {
  const hexId = numberToHex(CELO_CHAIN_ID);
  try {
    await request("wallet_switchEthereumChain", [{ chainId: hexId }]);
  } catch (err) {
    // 4902 = chain unknown to the wallet → add it, then it becomes current.
    if (isChainNotAddedError(err)) {
      await request("wallet_addEthereumChain", [
        {
          chainId: hexId,
          chainName: "Celo",
          nativeCurrency: { name: "Celo", symbol: "CELO", decimals: 18 },
          rpcUrls: ["https://forno.celo.org"],
          blockExplorerUrls: ["https://celoscan.io"],
        },
      ]);
    } else {
      throw err;
    }
  }
}

function isChainNotAddedError(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === 4902 || code === -32603;
}

/**
 * Subscribe to wallet account/chain changes. Returns an unsubscribe fn (a no-op
 * when the provider doesn't support events).
 */
export function onWalletEvent(
  onAccountsChanged: (accounts: string[]) => void,
  onChainChanged: (chainIdHex: string) => void,
): () => void {
  const provider = getInjectedProvider() as
    | (EIP1193Provider & {
        on?: (e: string, h: (...a: never[]) => void) => void;
        removeListener?: (e: string, h: (...a: never[]) => void) => void;
      })
    | null;
  if (!provider?.on) return () => {};
  const accHandler = (accounts: string[]) => onAccountsChanged(accounts);
  const chainHandler = (chainIdHex: string) => onChainChanged(chainIdHex);
  provider.on("accountsChanged", accHandler as never);
  provider.on("chainChanged", chainHandler as never);
  return () => {
    provider.removeListener?.("accountsChanged", accHandler as never);
    provider.removeListener?.("chainChanged", chainHandler as never);
  };
}
