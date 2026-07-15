/**
 * Mock / fixture data for the Comato UI.
 *
 * Everything here is placeholder content shaped like the real product so the
 * screens read realistically. Swap these modules for live reads later:
 *   - `position`   → Aave V3 `Pool.getUserAccountData(user)` on Celo
 *   - `activity`   → agent rescue log + x402 facilitator settlements
 *   - `user`       → connected wallet / profile
 * See apps/web/CLAUDE.md → "Live-data wiring" for the mapping.
 */

export interface User {
  name: string;
  handle: string;
  walletShort: string;
  contextLabel: string;
}

export const user: User = {
  name: "Timo",
  handle: "timothyrondo",
  walletShort: "0x71C2…9a2E",
  contextLabel: "Aave V3 position · Celo",
};

export interface Position {
  healthFactor: number;
  /** Health factor at which Aave liquidates. */
  liquidationHf: number;
  /** Comato steps in here — before liquidation. */
  rescueHf: number;
  collateralUsd: number;
  debtUsd: number;
  currentLtv: number;
  liquidationLtv: number;
  collateralAsset: string;
  debtAsset: string;
  premiumPerHourUsd: number;
  monitorIntervalSec: number;
  lastCheckSec: number;
  protectedSinceDays: number;
  uptimePct: number;
}

export const position: Position = {
  healthFactor: 1.82,
  liquidationHf: 1.0,
  rescueHf: 1.2,
  collateralUsd: 12480,
  debtUsd: 6850,
  currentLtv: 0.55,
  liquidationLtv: 0.83,
  collateralAsset: "USDC + CELO",
  debtAsset: "USDT",
  premiumPerHourUsd: 0.02,
  monitorIntervalSec: 30,
  lastCheckSec: 12,
  protectedSinceDays: 3,
  uptimePct: 99.9,
};

/** The rescue playbook shown as a timeline on the Position screen. */
export type RescueStepState = "active" | "armed" | "ready";

export interface RescueStep {
  title: string;
  detail: string;
  state: RescueStepState;
}

export const rescuePlan: RescueStep[] = [
  {
    title: "Monitor Health Factor",
    detail: `Checks every ${position.monitorIntervalSec}s via Aave`,
    state: "active",
  },
  {
    title: `Alert threshold ${position.rescueHf.toFixed(2)}`,
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

/** Activity feed: rescues (dark cards) + premium heartbeats (light cards). */
export type ActivityKind = "rescue" | "premium" | "swap";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  subtitle: string;
  /** USD amount, signed by kind (rescue = saved, premium = paid). */
  amountUsd: number;
  timeAgo: string;
  day: "Today" | "Yesterday" | "This week";
  hfBefore?: number;
  hfAfter?: number;
}

export const activity: ActivityItem[] = [
  {
    id: "r-04",
    kind: "rescue",
    title: "Position rescued",
    subtitle: "HF 1.14 → 1.66 · repaid $312 to Aave",
    amountUsd: 312,
    timeAgo: "2h ago",
    day: "Today",
    hfBefore: 1.14,
    hfAfter: 1.66,
  },
  {
    id: "p-19",
    kind: "premium",
    title: "Protection premium",
    subtitle: "Heartbeat x402 · payee Comato wallet",
    amountUsd: 0.02,
    timeAgo: "3h ago",
    day: "Today",
  },
  {
    id: "s-08",
    kind: "swap",
    title: "Collateral rebalanced",
    subtitle: "Tagged USDC→USDT swap · Uniswap V3",
    amountUsd: 420,
    timeAgo: "5h ago",
    day: "Today",
  },
  {
    id: "r-03",
    kind: "rescue",
    title: "Position rescued",
    subtitle: "HF 1.09 → 1.58 · repaid $486 to Aave",
    amountUsd: 486,
    timeAgo: "Yesterday, 21:40",
    day: "Yesterday",
    hfBefore: 1.09,
    hfAfter: 1.58,
  },
  {
    id: "p-18",
    kind: "premium",
    title: "Protection premium",
    subtitle: "Heartbeat x402 · payee Comato wallet",
    amountUsd: 0.02,
    timeAgo: "Yesterday, 20:10",
    day: "Yesterday",
  },
  {
    id: "r-02",
    kind: "rescue",
    title: "Position rescued",
    subtitle: "HF 1.18 → 1.71 · repaid $274 to Aave",
    amountUsd: 274,
    timeAgo: "Yesterday, 08:02",
    day: "Yesterday",
    hfBefore: 1.18,
    hfAfter: 1.71,
  },
  {
    id: "r-01",
    kind: "rescue",
    title: "Position rescued",
    subtitle: "HF 1.12 → 1.61 · repaid $212 to Aave",
    amountUsd: 212,
    timeAgo: "3d ago",
    day: "This week",
    hfBefore: 1.12,
    hfAfter: 1.61,
  },
];

export const activitySummary = {
  totalSavedUsd: activity
    .filter((a) => a.kind === "rescue")
    .reduce((sum, a) => sum + a.amountUsd, 0),
  rescueCount: activity.filter((a) => a.kind === "rescue").length,
  premiumPaidUsd: 2.4,
};
