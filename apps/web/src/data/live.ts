/**
 * Live-data reads for the Comato UI.
 *
 * Maps real on-chain state to the exact shapes the screens already consume:
 *   - Position   ← Aave V3 `Pool.getUserAccountData(subscriber)` (+ policy threshold)
 *   - RescueStep ← policy threshold / monitor interval (the explainer timeline)
 *   - Activity   ← ComatoExecutor `RescueExecuted` events
 *
 * The screens are agnostic to the source; when live reads fail or aren't
 * configured the app falls back to `./fixtures` (see the data context).
 */

import { formatUnits, type Address, type PublicClient } from "viem";
import type { LiveConfig } from "../lib/env";
import { aavePoolAbi, comatoPolicyAbi, comatoExecutorAbi } from "../lib/abis";
import {
  AAVE_V3_POOL,
  AAVE_BASE_DECIMALS,
  AAVE_BPS,
  tokenSymbol,
} from "../lib/constants";
import {
  position as mockPosition,
  activitySummary as mockSummary,
  user as mockUser,
  type Position,
  type RescueStep,
  type ActivityItem,
  type User,
} from "./fixtures";

export interface LiveData {
  user: User;
  position: Position;
  rescuePlan: RescueStep[];
  activity: ActivityItem[];
  activitySummary: typeof mockSummary;
}

const WAD_DECIMALS = 18;
/** viem returns ~MaxUint256 for HF when a position carries no debt. */
const HF_INFINITE = 999;

function hfToNumber(hf: bigint): number {
  const v = Number(formatUnits(hf, WAD_DECIMALS));
  return !Number.isFinite(v) || v > 1e6 ? HF_INFINITE : v;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

interface PolicyRecord {
  subscriber: Address;
  collateralAsset: Address;
  debtAsset: Address;
  hfThreshold: bigint;
  rescueCap: bigint;
  premiumRatePerInterval: bigint;
  active: boolean;
}

/** The four steps of the rescue explainer, keyed off the live threshold. */
export function buildRescuePlan(
  rescueHf: number,
  monitorIntervalSec: number,
): RescueStep[] {
  return [
    {
      title: "Monitor Health Factor",
      detail: `Checks every ${monitorIntervalSec}s via Aave`,
      state: "active",
    },
    {
      title: `Alert threshold ${rescueHf.toFixed(2)}`,
      detail: "Comato wakes before liquidation hits 1.00",
      state: "armed",
    },
    {
      title: "Pull the gasless voucher",
      detail: "EIP-3009 via the x402 facilitator — you pay no gas",
      state: "ready",
    },
    {
      title: "Repay debt, EOA-direct",
      detail: "Repays straight to Aave, Health Factor climbs back",
      state: "ready",
    },
  ];
}

function relativeTime(tsSec: number, nowSec: number): string {
  const diff = Math.max(0, nowSec - tsSec);
  if (diff < 90) return "Just now";
  const mins = Math.round(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(diff / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86400);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}

function dayBucket(tsSec: number, nowSec: number): ActivityItem["day"] {
  const diff = nowSec - tsSec;
  if (diff < 86400) return "Today";
  if (diff < 2 * 86400) return "Yesterday";
  return "This week";
}

async function readPolicy(
  client: PublicClient,
  cfg: LiveConfig,
): Promise<PolicyRecord | null> {
  if (!cfg.policyAddr || cfg.policyId === undefined) return null;
  try {
    const p = (await client.readContract({
      address: cfg.policyAddr,
      abi: comatoPolicyAbi,
      functionName: "getPolicy",
      args: [cfg.policyId],
    })) as PolicyRecord;
    return p;
  } catch {
    return null; // policy id not found / not deployed — degrade gracefully
  }
}

async function readPosition(
  client: PublicClient,
  cfg: LiveConfig,
  policy: PolicyRecord | null,
): Promise<Position> {
  const [
    totalCollateralBase,
    totalDebtBase,
    ,
    currentLiquidationThreshold,
    ,
    healthFactor,
  ] = await client.readContract({
    address: AAVE_V3_POOL,
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [cfg.subscriber],
  });

  const collateralUsd = Number(formatUnits(totalCollateralBase, AAVE_BASE_DECIMALS));
  const debtUsd = Number(formatUnits(totalDebtBase, AAVE_BASE_DECIMALS));
  const rescueHf = policy ? hfToNumber(policy.hfThreshold) : mockPosition.rescueHf;

  return {
    ...mockPosition, // UI-only fields (monitor cadence, uptime, premium copy) kept sane
    healthFactor: hfToNumber(healthFactor),
    liquidationHf: 1.0,
    rescueHf,
    collateralUsd,
    debtUsd,
    currentLtv: collateralUsd > 0 ? debtUsd / collateralUsd : 0,
    liquidationLtv: Number(currentLiquidationThreshold) / AAVE_BPS,
    collateralAsset: policy ? tokenSymbol(policy.collateralAsset) : mockPosition.collateralAsset,
    debtAsset: policy ? tokenSymbol(policy.debtAsset) : mockPosition.debtAsset,
  };
}

async function readRescues(
  client: PublicClient,
  cfg: LiveConfig,
): Promise<ActivityItem[]> {
  if (!cfg.executorAddr) return [];

  const logs = await client.getContractEvents({
    address: cfg.executorAddr,
    abi: comatoExecutorAbi,
    eventName: "RescueExecuted",
    args: { subscriber: cfg.subscriber },
    fromBlock: cfg.fromBlock,
    toBlock: "latest",
  });

  // Resolve block timestamps once per unique block.
  const blockNums = [...new Set(logs.map((l) => l.blockNumber).filter((n): n is bigint => n != null))];
  const blocks = await Promise.all(
    blockNums.map((n) => client.getBlock({ blockNumber: n })),
  );
  const tsByBlock = new Map<bigint, number>(
    blocks.map((b) => [b.number as bigint, Number(b.timestamp)]),
  );
  const nowSec = Math.floor(Date.now() / 1000);

  const items = logs.map((log, i): ActivityItem => {
    const { amountRepaid, hfBefore, hfAfter } = log.args as {
      amountRepaid: bigint;
      hfBefore: bigint;
      hfAfter: bigint;
    };
    const repaidUsd = Number(formatUnits(amountRepaid, 6));
    const before = hfToNumber(hfBefore);
    const after = hfToNumber(hfAfter);
    const tsSec = log.blockNumber != null ? tsByBlock.get(log.blockNumber) ?? nowSec : nowSec;

    return {
      id: `${log.transactionHash ?? "rescue"}-${log.logIndex ?? i}`,
      kind: "rescue",
      title: "Position rescued",
      subtitle: `HF ${before.toFixed(2)} → ${after.toFixed(2)} · repaid ${money(repaidUsd)} to Aave`,
      amountUsd: Math.round(repaidUsd),
      timeAgo: relativeTime(tsSec, nowSec),
      day: dayBucket(tsSec, nowSec),
      hfBefore: before,
      hfAfter: after,
    };
  });

  // Newest first (by block, then log index).
  return items.reverse();
}

/** Local, compact USD for event subtitles (kept independent of format.ts locale). */
function money(usd: number): string {
  return `$${usd.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`;
}

/** Fetch and shape all live data. Throws on the primary read failing. */
export async function fetchLiveData(
  client: PublicClient,
  cfg: LiveConfig,
): Promise<LiveData> {
  const policy = await readPolicy(client, cfg);
  const [position, rescues] = await Promise.all([
    readPosition(client, cfg, policy),
    readRescues(client, cfg),
  ]);

  const totalSavedUsd = rescues.reduce((s, r) => s + r.amountUsd, 0);
  const rescueCount = rescues.length;

  const user: User = {
    ...mockUser,
    walletShort: shortAddr(cfg.subscriber),
    contextLabel: "Aave V3 position · Celo",
  };

  return {
    user,
    position,
    rescuePlan: buildRescuePlan(position.rescueHf, position.monitorIntervalSec),
    activity: rescues,
    activitySummary: {
      totalSavedUsd,
      rescueCount,
      // Premium heartbeats aren't sourced on-chain in the local demo; keep the
      // illustrative aggregate from fixtures so the summary tile stays populated.
      premiumPaidUsd: mockSummary.premiumPaidUsd,
    },
  };
}
