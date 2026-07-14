import { useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import type { Screen } from "../types";
import { useComatoData } from "../data/context";
import { type ActivityItem } from "../data/fixtures";
import { money, percent, riskLevel, riskCopy, type RiskLevel } from "../lib/format";
import HealthRing from "../components/HealthRing";
import HealthChart, { buildHealthSeries } from "../components/HealthChart";
import StatTile from "../components/StatTile";
import ActivityCard from "../components/ActivityCard";
import RescueTimeline from "../components/RescueTimeline";
import PulseLine from "../components/PulseLine";
import Avatar from "../components/Avatar";
import {
  ShieldCheck,
  Grid,
  Activity as ActivityIcon,
  Clock,
  Settings,
  Refresh,
  ChevronRight,
  Coins,
  Lock,
  Wallet,
  AlertTriangle,
  Bell,
} from "../components/icons";

type IconType = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/* ── Shared bits ─────────────────────────────────────────── */

function Panel({
  children,
  className = "",
  delay,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <section
      className={"glass rise rounded-panel " + className}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </section>
  );
}

function LiveBadge({ isLive }: { isLive: boolean }) {
  return (
    <span className="glass-chip inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold text-accent-ink">
      <span className="pulse-dot h-2 w-2 rounded-full bg-accent-bright" />
      {isLive ? "Live · on-chain" : "Demo"}
    </span>
  );
}

const STATUS: Record<RiskLevel, string> = {
  safe: "bg-accent-soft text-accent-ink",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/15 text-danger",
};
function StatusPill({ level }: { level: RiskLevel }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold " +
        STATUS[level]
      }
    >
      <span
        className="pulse-dot h-1.5 w-1.5 rounded-full"
        style={{
          background:
            level === "safe" ? "#2a9d6f" : level === "warn" ? "#e0912f" : "#e0524e",
        }}
      />
      {riskCopy[level]}
    </span>
  );
}

/* ── Sidebar ─────────────────────────────────────────────── */

const NAV: { id: Screen; label: string; Icon: IconType }[] = [
  { id: "home", label: "Overview", Icon: Grid },
  { id: "position", label: "Positions", Icon: ActivityIcon },
  { id: "activity", label: "Activity", Icon: Clock },
  { id: "account", label: "Settings", Icon: Settings },
];

function Sidebar({
  screen,
  onNavigate,
}: {
  screen: Screen;
  onNavigate: (s: Screen) => void;
}) {
  const { user, isLive } = useComatoData();
  return (
    <aside className="glass sticky top-6 hidden h-[calc(100dvh-3rem)] w-[248px] shrink-0 flex-col rounded-panel p-5 lg:flex">
      {/* Brand */}
      <div className="flex items-center gap-3 px-1">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-b from-accent-bright to-accent text-[#fff7ef] shadow-[0_0_26px_-6px_rgba(241,137,60,0.9)]">
          <ShieldCheck size={22} />
        </span>
        <div className="leading-tight">
          <div className="font-display text-[18px] font-extrabold tracking-tight text-ink">
            Comato
          </div>
          <div className="text-[11px] text-ink-muted">Rescue insurance</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="mt-8 flex flex-col gap-1.5" aria-label="Dashboard">
        {NAV.map(({ id, label, Icon }) => {
          const active = screen === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={active ? "page" : undefined}
              className={
                "group relative flex items-center gap-3 rounded-2xl px-3.5 py-3 text-[14.5px] font-semibold transition-all " +
                (active
                  ? "glass-accent text-ink"
                  : "text-ink-muted hover:bg-ink/5 hover:text-ink")
              }
            >
              <Icon
                size={20}
                className={active ? "text-accent-ink" : ""}
                strokeWidth={active ? 2 : 1.75}
              />
              {label}
              {active && (
                <span className="absolute right-3 h-1.5 w-1.5 rounded-full bg-accent-bright shadow-[0_0_10px_2px_rgba(255,168,90,0.8)]" />
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto space-y-3">
        <div className="glass-accent flex items-center gap-2.5 rounded-2xl px-3.5 py-3">
          <PulseLine className="h-6 w-10 shrink-0 text-accent-bright/70" strokeWidth={2} />
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold text-ink">Protection active</div>
            <div className="text-[11px] text-ink-soft">Monitored non-stop</div>
          </div>
        </div>

        {/* User */}
        <div className="glass-chip flex items-center gap-3 rounded-2xl p-2.5">
          <Avatar name={user.name} size={40} ring={false} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-bold text-ink">{user.name}</div>
            <div className="truncate text-[11px] text-ink-muted">@{user.handle}</div>
          </div>
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-accent-bright shadow-[0_0_8px_2px_rgba(255,168,90,0.7)]"
            title={isLive ? "Live" : "Demo"}
          />
        </div>
      </div>
    </aside>
  );
}

/* ── Top bar ─────────────────────────────────────────────── */

const TITLES: Record<Screen, { title: string; sub: string }> = {
  home: { title: "Overview", sub: "Your position's protection at a glance." },
  position: { title: "Positions", sub: "Health factor, thresholds & the rescue playbook." },
  activity: { title: "Activity", sub: "Protection & rescue history." },
  account: { title: "Settings", sub: "Account, premium method & security." },
};

function TopBar({
  screen,
  onNavigate,
}: {
  screen: Screen;
  onNavigate: (s: Screen) => void;
}) {
  const { isLive, refresh } = useComatoData();
  const { title, sub } = TITLES[screen];
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="font-display text-[30px] font-extrabold tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-1 text-[13.5px] text-ink-soft">{sub}</p>
      </div>
      <div className="flex items-center gap-2.5">
        <LiveBadge isLive={isLive} />
        <button
          type="button"
          onClick={refresh}
          aria-label="Refresh data"
          className="glass-soft flex h-11 w-11 items-center justify-center rounded-full text-ink-soft transition-colors hover:text-ink active:scale-95"
        >
          <Refresh size={19} />
        </button>
        <button
          type="button"
          aria-label="Notifications"
          className="glass-soft flex h-11 w-11 items-center justify-center rounded-full text-ink-soft transition-colors hover:text-ink active:scale-95"
        >
          <Bell size={19} />
        </button>
        {screen === "home" && (
          <button
            type="button"
            onClick={() => onNavigate("position")}
            className="btn-primary inline-flex items-center gap-2 rounded-full px-5 py-3 text-[14px] font-semibold transition-all active:scale-[0.98]"
          >
            <ShieldCheck size={18} />
            Protect position
          </button>
        )}
      </div>
    </header>
  );
}

/* ── Ring + stats block (shared by Overview & Positions) ── */

function RingStats({ compact = false }: { compact?: boolean }) {
  const { position } = useComatoData();
  return (
    <Panel className="p-6" delay={40}>
      <div className="flex flex-col items-center gap-6 lg:flex-row lg:items-center lg:gap-8">
        <div className="shrink-0">
          <HealthRing
            value={position.healthFactor}
            liquidationHf={position.liquidationHf}
            rescueHf={position.rescueHf}
            size={244}
          />
        </div>
        <div className="grid w-full grid-cols-2 gap-3">
          <StatTile
            label="Collateral"
            value={money(position.collateralUsd)}
            sub={position.collateralAsset}
          />
          <StatTile label="Debt" value={money(position.debtUsd)} sub={position.debtAsset} />
          <StatTile
            tone="accent"
            label="Value protected"
            value={money(position.collateralUsd)}
            sub="Shielded from liquidation"
          />
          <StatTile
            tone="dark"
            label="Premium / hr"
            value={money(position.premiumPerHourUsd)}
            sub="Gasless via x402"
          />
          {!compact && (
            <>
              <StatTile
                label="Current LTV"
                value={percent(position.currentLtv)}
                sub={`Liquidation at ${percent(position.liquidationLtv)}`}
              />
              <StatTile
                label="Rescue trigger"
                value={position.rescueHf.toFixed(2)}
                sub={`Before liquidation ${position.liquidationHf.toFixed(2)}`}
              />
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* ── Overview ────────────────────────────────────────────── */

function HeroBanner() {
  const { position } = useComatoData();
  return (
    <section
      className="glass-accent rise relative overflow-hidden rounded-panel p-7"
      style={{ animationDelay: "20ms" }}
    >
      <PulseLine
        className="pointer-events-none absolute inset-x-0 bottom-5 h-16 w-full text-accent-bright/30"
        animate
        strokeWidth={2}
      />
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <span className="glass-chip inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-semibold text-accent-ink">
            <span className="pulse-dot h-2 w-2 rounded-full bg-accent-bright" />
            Protection active
          </span>
          <div className="mt-4 flex items-center gap-3.5">
            <h2 className="font-display text-[3.4rem] font-extrabold leading-none tracking-tight text-ink">
              Protected
            </h2>
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-b from-accent-bright to-accent text-[#fff7ef] shadow-[0_0_26px_-4px_rgba(241,137,60,0.95)]">
              <ShieldCheck size={24} />
            </span>
          </div>
          <p className="mt-3 max-w-[34rem] text-[14px] leading-relaxed text-ink-soft">
            Your Aave V3 position is safe from liquidation. The Comato agent
            watches it every {position.monitorIntervalSec} seconds and steps in
            with a gasless rescue before your Health Factor ever reaches the line.
          </p>
        </div>
        <div className="flex items-center gap-6 text-[12.5px] text-ink-soft">
          <div>
            <div className="tnum font-display text-[22px] font-bold text-ink">
              {position.lastCheckSec}s
            </div>
            <div className="text-ink-muted">Since last check</div>
          </div>
          <span className="h-9 w-px bg-ink/10" />
          <div>
            <div className="tnum font-display text-[22px] font-bold text-ink">
              {position.uptimePct}%
            </div>
            <div className="text-ink-muted">Monitor uptime</div>
          </div>
          <span className="h-9 w-px bg-ink/10" />
          <div>
            <div className="tnum font-display text-[22px] font-bold text-ink">
              {position.protectedSinceDays}d
            </div>
            <div className="text-ink-muted">Protected</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function PositionRow({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const { position } = useComatoData();
  const level = riskLevel(position.healthFactor, position.rescueHf, position.liquidationHf);
  return (
    <Panel className="p-6" delay={140}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[16px] font-bold tracking-tight text-ink">Your position</h3>
        <button
          type="button"
          onClick={() => onNavigate("position")}
          className="inline-flex items-center gap-1 text-[13px] font-semibold text-accent-ink hover:brightness-125"
        >
          Open <ChevronRight size={16} />
        </button>
      </div>
      <div className="overflow-x-auto no-scrollbar">
        <div className="grid min-w-[560px] grid-cols-[1.4fr_1fr_1fr_0.9fr_0.9fr] items-center gap-4 border-b border-line pb-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-muted">
          <span>Market</span>
          <span className="text-right">Collateral</span>
          <span className="text-right">Debt</span>
          <span className="text-right">LTV</span>
          <span className="text-right">Health</span>
        </div>
        <div className="grid min-w-[560px] grid-cols-[1.4fr_1fr_1fr_0.9fr_0.9fr] items-center gap-4 pt-3.5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
              <ActivityIcon size={19} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold text-ink">
                {position.collateralAsset} → {position.debtAsset}
              </div>
              <div className="text-[11.5px] text-ink-muted">Aave V3 · Celo</div>
            </div>
          </div>
          <div className="tnum text-right text-[14px] font-semibold text-ink">
            {money(position.collateralUsd)}
          </div>
          <div className="tnum text-right text-[14px] font-semibold text-ink">
            {money(position.debtUsd)}
          </div>
          <div className="tnum text-right text-[14px] font-semibold text-ink-soft">
            {percent(position.currentLtv)}
          </div>
          <div className="flex items-center justify-end gap-2">
            <span className="tnum text-[14px] font-bold text-ink">
              {position.healthFactor.toFixed(2)}
            </span>
            <StatusPill level={level} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

function ChartCard() {
  const { position, activity } = useComatoData();
  const series = buildHealthSeries(activity, position.healthFactor);
  return (
    <Panel className="p-6" delay={90}>
      <div className="mb-1 flex items-start justify-between">
        <div>
          <h3 className="text-[16px] font-bold tracking-tight text-ink">
            Health Factor trace
          </h3>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            Dips mark real rescues · now at{" "}
            <span className="font-semibold text-accent-ink">
              {position.healthFactor.toFixed(2)}
            </span>
          </p>
        </div>
        <span className="tnum font-display text-[28px] font-extrabold leading-none text-ink">
          {position.healthFactor.toFixed(2)}
        </span>
      </div>
      <HealthChart
        series={series}
        rescueHf={position.rescueHf}
        liquidationHf={position.liquidationHf}
        height={220}
      />
    </Panel>
  );
}

function ActivityRail({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const { activity } = useComatoData();
  return (
    <Panel className="p-5" delay={120}>
      <div className="mb-3.5 flex items-center justify-between">
        <h3 className="text-[16px] font-bold tracking-tight text-ink">Activity</h3>
        <button
          type="button"
          onClick={() => onNavigate("activity")}
          className="text-[13px] font-semibold text-accent-ink hover:brightness-125"
        >
          See all
        </button>
      </div>
      <div className="space-y-2.5">
        {activity.slice(0, 4).map((item) => (
          <ActivityCard key={item.id} item={item} />
        ))}
        {activity.length === 0 && (
          <p className="glass-soft rounded-tile border-dashed px-4 py-6 text-center text-[13px] text-ink-muted">
            No rescues yet — your position is safe.
          </p>
        )}
      </div>
    </Panel>
  );
}

function PremiumRail() {
  const { position, activitySummary } = useComatoData();
  const rows: { label: string; value: string; accent?: boolean }[] = [
    { label: "Premium / hr", value: money(position.premiumPerHourUsd) },
    { label: "Premiums paid", value: money(activitySummary.premiumPaidUsd) },
    { label: "Rescues", value: String(activitySummary.rescueCount) },
  ];
  return (
    <Panel className="p-5" delay={160}>
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
          <Coins size={18} />
        </span>
        <h3 className="text-[16px] font-bold tracking-tight text-ink">Protection premium</h3>
      </div>
      <div className="glass-deep mb-4 rounded-tile p-4 text-on-dark">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-dark-muted">
          Total saved
        </div>
        <div className="tnum mt-1 font-display text-[2rem] font-extrabold leading-none text-accent-ink">
          {money(activitySummary.totalSavedUsd)}
        </div>
        <div className="mt-1.5 text-[12px] text-on-dark-muted">
          Liquidation penalties avoided
        </div>
      </div>
      <dl className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between">
            <dt className="text-[13px] text-ink-soft">{r.label}</dt>
            <dd
              className={
                "tnum text-[13.5px] font-semibold " +
                (r.accent ? "text-accent-ink" : "text-ink")
              }
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-ink-muted">
        Paid as a gasless x402 heartbeat to COMATO_WALLET. No gas, no signatures
        from you.
      </p>
    </Panel>
  );
}

function AlertRail() {
  const { position } = useComatoData();
  const level = riskLevel(position.healthFactor, position.rescueHf, position.liquidationHf);
  const margin = Math.max(0, position.healthFactor - position.rescueHf);
  // Buffer bar: liquidation(1.0) → a comfortable ceiling (2.5).
  const lo = position.liquidationHf;
  const hi = 2.5;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const cur = clamp((position.healthFactor - lo) / (hi - lo)) * 100;
  const trig = clamp((position.rescueHf - lo) / (hi - lo)) * 100;
  const safe = level === "safe";
  return (
    <Panel className="p-5" delay={200}>
      <div className="mb-4 flex items-center gap-2.5">
        <span
          className={
            "flex h-9 w-9 items-center justify-center rounded-xl " +
            (safe ? "bg-accent-soft text-accent-ink" : "bg-warn/15 text-warn")
          }
        >
          {safe ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />}
        </span>
        <h3 className="text-[16px] font-bold tracking-tight text-ink">
          {safe ? "All clear" : "Watch closely"}
        </h3>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Health Factor is{" "}
        <span className="font-semibold text-ink">{margin.toFixed(2)}</span> above
        the {position.rescueHf.toFixed(2)} rescue line. Comato arms automatically
        before it's reached.
      </p>
      {/* Buffer meter */}
      <div className="relative mt-5 h-2.5 rounded-full bg-ink/10">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-accent-bright shadow-[0_0_16px_-2px_rgba(241,137,60,0.8)]"
          style={{ width: `${cur}%` }}
        />
        <span
          className="absolute -top-1 w-0.5 -translate-x-1/2 rounded bg-warn"
          style={{ left: `${trig}%`, height: "1.1rem" }}
          aria-hidden
        />
      </div>
      <div className="mt-2 flex justify-between text-[10.5px] font-medium text-ink-muted">
        <span>Liq {position.liquidationHf.toFixed(2)}</span>
        <span className="text-warn">Rescue {position.rescueHf.toFixed(2)}</span>
        <span>Safe 2.50</span>
      </div>
    </Panel>
  );
}

function OverviewView({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  return (
    <div className="space-y-5">
      <HeroBanner />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_350px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <RingStats compact />
          <ChartCard />
          <PositionRow onNavigate={onNavigate} />
        </div>
        <div className="space-y-5">
          <ActivityRail onNavigate={onNavigate} />
          <PremiumRail />
          <AlertRail />
        </div>
      </div>
    </div>
  );
}

/* ── Positions view ─────────────────────────────────────── */

function PositionsView() {
  const { position, rescuePlan } = useComatoData();
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-5">
        <RingStats />
        <Panel className="p-6" delay={120}>
          <div className="mb-4 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
              <ShieldCheck size={18} />
            </span>
            <h3 className="text-[16px] font-bold tracking-tight text-ink">Rescue plan</h3>
          </div>
          <div className="glass-accent mb-5 flex gap-3 rounded-tile p-4">
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-accent-ink" />
            <p className="text-[13px] leading-relaxed text-ink-soft">
              If your Health Factor drops to {position.rescueHf.toFixed(2)}, Comato
              pulls a gasless voucher and repays part of your debt to Aave —
              lifting it back up before liquidation at{" "}
              {position.liquidationHf.toFixed(2)}.
            </p>
          </div>
          <RescueTimeline steps={rescuePlan} />
        </Panel>
      </div>
      <div className="space-y-5">
        <Panel className="p-6" delay={90}>
          <h3 className="mb-4 text-[16px] font-bold tracking-tight text-ink">Thresholds</h3>
          <div className="space-y-3">
            <StatTile
              tone="dark"
              size="lg"
              label="Health Factor"
              value={position.healthFactor.toFixed(2)}
              sub={`Above liquidation ${position.liquidationHf.toFixed(2)}`}
            />
            <div className="grid grid-cols-2 gap-3">
              <StatTile
                label="Current LTV"
                value={percent(position.currentLtv)}
                sub={`Liq ${percent(position.liquidationLtv)}`}
              />
              <StatTile
                tone="accent"
                label="Rescue at"
                value={position.rescueHf.toFixed(2)}
                sub="Comato steps in"
              />
            </div>
          </div>
        </Panel>
        <Panel className="glass-deep p-5 text-on-dark" delay={140}>
          <div className="flex items-center gap-3.5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/20 text-accent-ink shadow-[0_0_24px_-6px_rgba(241,137,60,0.7)]">
              <ShieldCheck size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold">Comato agent</div>
              <div className="text-[12.5px] text-on-dark-muted">
                Guarding your position around the clock
              </div>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="glass-chip rounded-tile p-3">
              <div className="tnum text-[18px] font-bold">
                {position.monitorIntervalSec}s
              </div>
              <div className="text-[10.5px] uppercase tracking-wide text-on-dark-muted">
                Check interval
              </div>
            </div>
            <div className="glass-chip rounded-tile p-3">
              <div className="tnum text-[18px] font-bold">
                {position.protectedSinceDays}d
              </div>
              <div className="text-[10.5px] uppercase tracking-wide text-on-dark-muted">
                Protected
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ── Activity view ───────────────────────────────────────── */

type Filter = "all" | "rescue" | "flow";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "rescue", label: "Rescues" },
  { id: "flow", label: "Premiums & swaps" },
];
function matches(item: ActivityItem, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "rescue") return item.kind === "rescue";
  return item.kind === "premium" || item.kind === "swap";
}

function ActivityView() {
  const { activity, activitySummary } = useComatoData();
  const [filter, setFilter] = useState<Filter>("all");
  const visible = activity.filter((a) => matches(a, filter));
  const avgRescueUsd =
    activitySummary.rescueCount > 0
      ? Math.round(activitySummary.totalSavedUsd / activitySummary.rescueCount)
      : 0;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          tone="dark"
          size="lg"
          label="Total saved"
          value={money(activitySummary.totalSavedUsd)}
          sub={`From ${activitySummary.rescueCount} rescues`}
        />
        <StatTile
          label="Premiums paid"
          value={money(activitySummary.premiumPaidUsd)}
          sub="Heartbeat x402"
        />
        <StatTile tone="accent" label="Average rescue" value={money(avgRescueUsd)} sub="Per event" />
      </div>

      <div className="flex gap-2" role="tablist" aria-label="Filter activity">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(f.id)}
              className={
                "rounded-full px-4 py-2 text-[13px] font-semibold transition-all " +
                (active
                  ? "bg-gradient-to-b from-accent-bright to-accent text-[#fff7ef] shadow-[0_0_22px_-6px_rgba(241,137,60,0.85)]"
                  : "glass-soft text-ink-soft")
              }
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <Panel className="p-5" delay={60}>
        {(["Today", "Yesterday", "This week"] as ActivityItem["day"][]).map((day) => {
          const items = visible.filter((a) => a.day === day);
          if (items.length === 0) return null;
          return (
            <div key={day} className="mb-5 last:mb-0">
              <h2 className="mb-2.5 px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-ink-muted">
                {day}
              </h2>
              <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
                {items.map((item) => (
                  <ActivityCard key={item.id} item={item} />
                ))}
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="glass-soft rounded-tile border-dashed px-4 py-8 text-center text-[13px] text-ink-muted">
            No activity for this filter.
          </p>
        )}
      </Panel>
    </div>
  );
}

/* ── Settings view ───────────────────────────────────────── */

function SettingsView() {
  const { user, position } = useComatoData();
  const ROWS: { Icon: IconType; label: string; value: string }[] = [
    { Icon: ShieldCheck, label: "Protection", value: "Active" },
    {
      Icon: Coins,
      label: "Premium method",
      value: `x402 · ${money(position.premiumPerHourUsd)}/hr`,
    },
    { Icon: Lock, label: "Security & vouchers", value: "EIP-3009" },
    { Icon: Settings, label: "Preferences", value: "" },
  ];
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
      <Panel className="glass-deep p-6 text-on-dark" delay={40}>
        <div className="flex items-center gap-4">
          <Avatar name={user.name} size={60} ring={false} />
          <div className="min-w-0">
            <div className="text-[20px] font-bold">{user.name}</div>
            <div className="text-[13px] text-on-dark-muted">@{user.handle}</div>
          </div>
        </div>
        <div className="glass-chip mt-5 flex items-center gap-3 rounded-tile px-4 py-3.5">
          <Wallet size={18} className="text-accent-ink" />
          <span className="text-[12px] text-on-dark-muted">Wallet</span>
          <span className="tnum ml-auto text-[13px] font-semibold">{user.walletShort}</span>
        </div>
        <p className="mt-5 text-[12px] leading-relaxed text-on-dark-muted">
          Comato · gasless anti-liquidation insurance on Celo.
        </p>
      </Panel>

      <Panel className="overflow-hidden" delay={100}>
        {ROWS.map(({ Icon, label, value }, i) => (
          <button
            key={label}
            type="button"
            className={
              "flex w-full items-center gap-3.5 px-6 py-4 text-left transition-colors hover:bg-ink/5 " +
              (i > 0 ? "border-t border-line" : "")
            }
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
              <Icon size={19} />
            </span>
            <span className="flex-1 text-[15px] font-semibold text-ink">{label}</span>
            {value && <span className="text-[13px] text-ink-muted">{value}</span>}
            <ChevronRight size={18} className="text-ink-muted" />
          </button>
        ))}
      </Panel>
    </div>
  );
}

/* ── Shell ───────────────────────────────────────────────── */

export default function DesktopApp({
  screen,
  onNavigate,
}: {
  screen: Screen;
  onNavigate: (s: Screen) => void;
}) {
  return (
    <div className="relative min-h-dvh w-full">
      <div className="mx-auto flex w-full max-w-[1640px] gap-6 p-6">
        <Sidebar screen={screen} onNavigate={onNavigate} />
        <main key={screen} className="min-w-0 flex-1 space-y-6 pb-6">
          <TopBar screen={screen} onNavigate={onNavigate} />
          {screen === "home" && <OverviewView onNavigate={onNavigate} />}
          {screen === "position" && <PositionsView />}
          {screen === "activity" && <ActivityView />}
          {screen === "account" && <SettingsView />}
        </main>
      </div>
    </div>
  );
}
