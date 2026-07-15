/**
 * Live read state for a connected wallet's Comato vault.
 *
 * Given the connected account (and whether it's enabled — connected + on Celo),
 * this resolves the caller's vault, polls its `position()` + terms, and derives
 * the UI shape the subscribe flow renders. It also detects a rescue in flight:
 * when HF dips below the vault's threshold and then climbs back, the flow shows
 * "Comato deleveraged — Health Factor recovering".
 *
 * Reads go through the injected-wallet public client, so they hit the same node
 * the wallet transacts on (the Celo fork during a demo). Never throws; a failed
 * read keeps the last-good view and records the error.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, type Address, type PublicClient } from "viem";
import { subscribeConfig } from "../lib/env";
import { getWalletPublicClient } from "../lib/wallet";
import {
  fundingStageOf,
  readVaultOf,
  readVaultPosition,
  readVaultTerms,
  type FundingStage,
} from "../lib/vault";
import { AAVE_BASE_DECIMALS, tokenSymbol } from "../lib/constants";
import { riskLevel, type RiskLevel } from "../lib/format";

const WAD_DECIMALS = 18;
const HF_INFINITE = 999;
const POLL_MS = 12_000;

function hfToNumber(hf: bigint): number {
  const v = Number(formatUnits(hf, WAD_DECIMALS));
  return !Number.isFinite(v) || v > 1e6 ? HF_INFINITE : v;
}

export interface VaultView {
  /** Configured (factory present) AND enabled (wallet connected on Celo). */
  ready: boolean;
  loading: boolean;
  error: string | null;
  vault: Address | null;
  hasVault: boolean;
  fundingStage: FundingStage;
  collateralUsd: number;
  debtUsd: number;
  hf: number;
  rescueHf: number;
  targetHf: number;
  liquidationHf: number;
  collateralAsset: string;
  debtAsset: string;
  risk: RiskLevel;
  /** HF is below the rescue threshold right now. */
  breached: boolean;
  /** HF breached, then recovered — a deleverage just happened. */
  rescued: boolean;
  /** Direction of the last HF change (positive = climbing). */
  hfTrend: number;
  refresh: () => void;
}

interface Snapshot {
  vault: Address | null;
  fundingStage: FundingStage;
  collateralUsd: number;
  debtUsd: number;
  hf: number;
  rescueHf: number;
  targetHf: number;
  collateralAsset: string;
  debtAsset: string;
}

const EMPTY: Snapshot = {
  vault: null,
  fundingStage: "none",
  collateralUsd: 0,
  debtUsd: 0,
  hf: HF_INFINITE,
  rescueHf: 1.3,
  targetHf: 1.6,
  collateralAsset: "USDT",
  debtAsset: "USDC",
};

export function useVault(
  account: Address | null,
  enabled: boolean,
): VaultView {
  const factory = subscribeConfig.factoryAddr ?? null;
  const ready = enabled && account !== null && factory !== null;

  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescued, setRescued] = useState(false);
  const [hfTrend, setHfTrend] = useState(0);

  const clientRef = useRef<PublicClient | null>(null);
  const prevHfRef = useRef<number | null>(null);
  const sawBreachRef = useRef(false);

  const load = useCallback(async () => {
    if (!ready || !account || !factory) return;
    if (!clientRef.current) clientRef.current = getWalletPublicClient();
    const client = clientRef.current;
    setLoading(true);
    try {
      const vault = await readVaultOf(client, factory, account);
      if (!vault) {
        setSnap({ ...EMPTY });
        setError(null);
        return;
      }
      const [pos, terms] = await Promise.all([
        readVaultPosition(client, vault),
        readVaultTerms(client, vault),
      ]);
      const hf = hfToNumber(pos.hf);
      const rescueHf = hfToNumber(terms.hfThreshold);

      // Rescue detection: remember a breach; clear it once HF recovers past it.
      const prev = prevHfRef.current;
      if (prev !== null) setHfTrend(hf - prev);
      const debtUsd = Number(formatUnits(pos.debtBase, AAVE_BASE_DECIMALS));
      const isBreached = debtUsd > 0 && hf < rescueHf;
      if (isBreached) {
        sawBreachRef.current = true;
        setRescued(false);
      } else if (sawBreachRef.current) {
        sawBreachRef.current = false;
        setRescued(true);
      }
      prevHfRef.current = hf;

      setSnap({
        vault,
        fundingStage: fundingStageOf(true, pos.collateralBase, pos.debtBase),
        collateralUsd: Number(formatUnits(pos.collateralBase, AAVE_BASE_DECIMALS)),
        debtUsd,
        hf,
        rescueHf,
        targetHf: hfToNumber(terms.targetHf),
        collateralAsset: tokenSymbol(terms.collateralAsset),
        debtAsset: tokenSymbol(terms.debtAsset),
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ready, account, factory]);

  // Reset per-account state + kick off polling when enabled.
  useEffect(() => {
    if (!ready) {
      setSnap({ ...EMPTY });
      prevHfRef.current = null;
      sawBreachRef.current = false;
      setRescued(false);
      return;
    }
    let alive = true;
    void load();
    const id = setInterval(() => {
      if (alive) void load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ready, load]);

  const hasVault = snap.vault !== null;
  const breached = snap.debtUsd > 0 && snap.hf < snap.rescueHf;

  return {
    ready,
    loading,
    error,
    vault: snap.vault,
    hasVault,
    fundingStage: snap.fundingStage,
    collateralUsd: snap.collateralUsd,
    debtUsd: snap.debtUsd,
    hf: snap.hf,
    rescueHf: snap.rescueHf,
    targetHf: snap.targetHf,
    liquidationHf: 1.0,
    collateralAsset: snap.collateralAsset,
    debtAsset: snap.debtAsset,
    risk: riskLevel(snap.hf, snap.rescueHf, 1.0),
    breached,
    rescued,
    hfTrend,
    refresh: () => void load(),
  };
}
