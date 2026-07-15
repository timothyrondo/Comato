/**
 * Wallet connection state for the subscribe flow.
 *
 * Wraps the injected-wallet primitives in `lib/wallet.ts` with React state:
 * connection status, the active account, the current chain id, and helpers to
 * connect / disconnect / switch to Celo. Subscribes to the wallet's
 * accountsChanged / chainChanged events so the UI stays in sync.
 *
 * The context ships a safe default (unsupported / disconnected, no-op actions),
 * so components that read `useWallet()` render fine even without a provider —
 * mirroring how `useComatoData()` degrades to mock data.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getAddress, type Address } from "viem";
import {
  CELO_CHAIN_ID,
  getAuthorizedAccounts,
  getChainId,
  hasInjectedWallet,
  onWalletEvent,
  requestAccounts,
  switchToCelo,
} from "../lib/wallet";

export type WalletStatus =
  | "unsupported" // no injected wallet in this browser
  | "disconnected"
  | "connecting"
  | "connected";

export interface WalletState {
  status: WalletStatus;
  /** True once a browser wallet is detected (regardless of connection). */
  isSupported: boolean;
  account: Address | null;
  chainId: number | null;
  /** Connected AND on Celo — the only state that can transact. */
  isCelo: boolean;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  switchChain: () => void;
}

const DEFAULT: WalletState = {
  status: "unsupported",
  isSupported: false,
  account: null,
  chainId: null,
  isCelo: false,
  error: null,
  connect: () => {},
  disconnect: () => {},
  switchChain: () => {},
};

const WalletContext = createContext<WalletState>(DEFAULT);

export function WalletProvider({ children }: { children: ReactNode }) {
  const supported = hasInjectedWallet();
  const [status, setStatus] = useState<WalletStatus>(
    supported ? "disconnected" : "unsupported",
  );
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshChain = useCallback(async () => {
    try {
      setChainId(await getChainId());
    } catch {
      setChainId(null);
    }
  }, []);

  const connect = useCallback(async () => {
    if (!supported) return;
    setStatus("connecting");
    setError(null);
    try {
      const accounts = await requestAccounts();
      if (accounts.length === 0) throw new Error("No account authorized");
      setAccount(accounts[0]);
      await refreshChain();
      setStatus("connected");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("disconnected");
    }
  }, [supported, refreshChain]);

  const disconnect = useCallback(() => {
    // Injected wallets can't be force-disconnected from a dapp; drop local state.
    setAccount(null);
    setStatus(supported ? "disconnected" : "unsupported");
    setError(null);
  }, [supported]);

  const switchChain = useCallback(async () => {
    setError(null);
    try {
      await switchToCelo();
      await refreshChain();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshChain]);

  // Restore an already-authorized session + subscribe to wallet events.
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void (async () => {
      const accounts = await getAuthorizedAccounts();
      if (!alive) return;
      if (accounts.length > 0) {
        setAccount(accounts[0]);
        await refreshChain();
        if (alive) setStatus("connected");
      }
    })();

    const unsubscribe = onWalletEvent(
      (accounts) => {
        if (accounts.length === 0) {
          setAccount(null);
          setStatus("disconnected");
        } else {
          setAccount(getAddress(accounts[0]));
          setStatus("connected");
        }
      },
      (chainIdHex) => setChainId(Number.parseInt(chainIdHex, 16)),
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [supported, refreshChain]);

  const value = useMemo<WalletState>(
    () => ({
      status,
      isSupported: supported,
      account,
      chainId,
      isCelo: status === "connected" && chainId === CELO_CHAIN_ID,
      error,
      connect: () => void connect(),
      disconnect,
      switchChain: () => void switchChain(),
    }),
    [status, supported, account, chainId, error, connect, disconnect, switchChain],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

/** Read the wallet connection state (safe default when no provider present). */
export function useWallet(): WalletState {
  return useContext(WalletContext);
}
