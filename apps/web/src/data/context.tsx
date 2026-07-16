/**
 * Comato data context — the single source screens read from.
 *
 * Resolves to LIVE on-chain data (viem reads against the configured RPC) when
 * `apps/web/.env.local` is populated by the demo runner, and gracefully falls
 * back to the built-in mock fixtures otherwise (or when a read fails). The UI is
 * identical in both modes — only `isLive` and the numbers change.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Address, PublicClient } from "viem";
import { liveConfig, subscribeConfig } from "../lib/env";
import { createReadClient } from "../lib/chain";
import { readVaultOf } from "../lib/vault";
import { fetchLiveData, type LiveData } from "./live";
import { useWallet } from "./wallet";
import {
  user as mockUser,
  position as mockPosition,
  rescuePlan as mockRescuePlan,
  activity as mockActivity,
  activitySummary as mockSummary,
} from "./fixtures";

export interface ComatoData extends LiveData {
  /** True when the numbers come from the chain; false on the mock fallback. */
  isLive: boolean;
  /** True during the first live fetch (mock is shown meanwhile — never blank). */
  loading: boolean;
  /** Last live-read error message, if any (UI keeps showing last-good/mock). */
  error: string | null;
  /** Force an immediate re-read (wired to the Position screen refresh button). */
  refresh: () => void;
}

const MOCK: LiveData = {
  user: mockUser,
  position: mockPosition,
  rescuePlan: mockRescuePlan,
  activity: mockActivity,
  activitySummary: mockSummary,
};

const POLL_MS = 12_000;

const ComatoDataContext = createContext<ComatoData>({
  ...MOCK,
  isLive: false,
  loading: false,
  error: null,
  refresh: () => {},
});

export function ComatoDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<LiveData>(MOCK);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(liveConfig !== null);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(0);

  const clientRef = useRef<PublicClient | null>(null);
  const lastFetchAtRef = useRef<number>(Date.now());

  // The dashboard follows the CONNECTED WALLET's vault when it has one, so a real
  // user sees their own position — not a hardcoded demo vault. `VITE_VAULT_ADDR`
  // is only the fallback shown to visitors who haven't connected (a judge sees a
  // live example instead of mock). null until resolved / when the wallet has none.
  const { account } = useWallet();
  const [walletVault, setWalletVault] = useState<Address | null>(null);

  useEffect(() => {
    const factory = subscribeConfig.factoryAddr;
    if (!liveConfig || !account || !factory) {
      setWalletVault(null);
      return;
    }
    let alive = true;
    if (!clientRef.current) clientRef.current = createReadClient(liveConfig);
    void readVaultOf(clientRef.current, factory, account)
      .then((v) => {
        if (alive) setWalletVault(v);
      })
      .catch(() => {
        if (alive) setWalletVault(null); // read failed → fall back to the demo vault
      });
    return () => {
      alive = false;
    };
  }, [account]);

  /** The vault the dashboard reads: the connected wallet's, else the env demo vault. */
  const effectiveVault = walletVault ?? liveConfig?.vaultAddr;

  const load = useCallback(async () => {
    if (!liveConfig) return;
    if (!clientRef.current) clientRef.current = createReadClient(liveConfig);
    try {
      const cfg = effectiveVault ? { ...liveConfig, vaultAddr: effectiveVault } : liveConfig;
      const live = await fetchLiveData(clientRef.current, cfg);
      setData(live);
      setIsLive(true);
      setError(null);
      lastFetchAtRef.current = Date.now();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Keep whatever we last had (mock on first failure) — never blank the UI.
    } finally {
      setLoading(false);
    }
  }, [effectiveVault]);

  // Initial fetch + polling. Re-subscribes when `load` changes (i.e. the
  // effective vault switched between the demo vault and the wallet's own).
  useEffect(() => {
    if (!liveConfig) return;
    let alive = true;
    void load();
    const id = setInterval(() => {
      if (alive) void load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [load]);

  // 1s ticker so "Checked Ns ago" reflects real time since the last read.
  useEffect(() => {
    if (!liveConfig) return;
    const id = setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const value = useMemo<ComatoData>(() => {
    // In live mode, surface a real "checked N seconds ago" counter.
    const lastCheckSec = isLive
      ? Math.max(0, Math.floor((Date.now() - lastFetchAtRef.current) / 1000))
      : data.position.lastCheckSec;
    return {
      ...data,
      position: { ...data.position, lastCheckSec },
      isLive,
      loading,
      error,
      refresh: () => void load(),
    };
    // nowTick is intentionally a dep so the counter re-renders each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isLive, loading, error, load, nowTick]);

  return (
    <ComatoDataContext.Provider value={value}>
      {children}
    </ComatoDataContext.Provider>
  );
}

/** Read the resolved Comato data (live or mock). */
export function useComatoData(): ComatoData {
  return useContext(ComatoDataContext);
}
