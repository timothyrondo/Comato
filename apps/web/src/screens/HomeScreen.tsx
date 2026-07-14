import type { Screen } from "../types";
import { useComatoData } from "../data/context";
import { money, riskLevel, riskCopy } from "../lib/format";
import Avatar from "../components/Avatar";
import PulseLine from "../components/PulseLine";
import StatTile from "../components/StatTile";
import PillButton from "../components/PillButton";
import SectionHeader from "../components/SectionHeader";
import ActivityCard from "../components/ActivityCard";
import { ShieldCheck, ArrowRight, MapPin } from "../components/icons";

export default function HomeScreen({
  onNavigate,
}: {
  onNavigate: (s: Screen) => void;
}) {
  const { user, position, activity, isLive } = useComatoData();
  const level = riskLevel(
    position.healthFactor,
    position.rescueHf,
    position.liquidationHf,
  );

  return (
    <div className="px-5 pb-4">
      {/* Header */}
      <header className="flex items-center justify-between pt-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-ink">
            Hi, {user.name}
          </h1>
          <div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-muted">
            <MapPin size={15} className="text-ink-muted" />
            <span className="truncate">{user.contextLabel}</span>
          </div>
        </div>
        <Avatar name={user.name} online size={46} />
      </header>

      {/* Hero status card */}
      <section
        className="glass-accent rise relative mt-5 overflow-hidden rounded-card p-6"
        style={{ animationDelay: "40ms" }}
        aria-labelledby="hero-status"
      >
        <PulseLine
          className="pointer-events-none absolute inset-x-0 bottom-4 h-14 w-full text-accent-bright/40"
          animate
          strokeWidth={2}
        />
        <div className="relative">
          <span className="glass-chip inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-semibold text-accent-ink">
            <span className="pulse-dot h-2 w-2 rounded-full bg-accent-bright" />
            Protection active
          </span>

          <div className="mt-4 flex items-center gap-3">
            <h2
              id="hero-status"
              className="font-display text-[2.5rem] font-extrabold leading-none tracking-tight text-ink"
            >
              Protected
            </h2>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-b from-accent-bright to-accent text-[#052015] shadow-[0_0_22px_-4px_rgba(35,209,138,0.9)]">
              <ShieldCheck size={20} />
            </span>
          </div>

          <p className="mt-2.5 max-w-[16rem] text-[13.5px] leading-relaxed text-ink-soft">
            Your position is safe from liquidation. The Comato agent watches it
            every {position.monitorIntervalSec} seconds, non-stop.
          </p>

          <div className="mt-5 flex items-center gap-4 text-[12px] text-ink-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Checked {position.lastCheckSec}s ago
            </span>
            <span className="h-3 w-px bg-line" />
            <span className="tnum">Uptime {position.uptimePct}%</span>
          </div>
        </div>
      </section>

      {/* Stat tiles */}
      <section
        className="rise mt-4 grid grid-cols-2 gap-3"
        style={{ animationDelay: "100ms" }}
        aria-label="Position summary"
      >
        <StatTile
          className="col-span-2"
          tone="dark"
          size="lg"
          label="Health Factor"
          value={position.healthFactor.toFixed(2)}
          sub={`${riskCopy[level]} · above liquidation threshold ${position.liquidationHf.toFixed(2)}`}
          badge={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/18 px-2.5 py-1 text-[11px] font-semibold text-accent-bright">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent-bright" />
              {isLive ? "Live" : "Demo"}
            </span>
          }
        />
        <StatTile
          label="Premium / hr"
          value={money(position.premiumPerHourUsd)}
          sub="Gasless via x402"
        />
        <StatTile
          label="Value protected"
          value={money(position.collateralUsd)}
          sub={`${position.collateralAsset} collateral`}
        />
      </section>

      {/* Primary CTA */}
      <div className="rise mt-4" style={{ animationDelay: "160ms" }}>
        <PillButton
          onClick={() => onNavigate("position")}
          leading={<ShieldCheck size={19} />}
          trailing={<ArrowRight size={19} />}
        >
          Protect Position
        </PillButton>
      </div>

      {/* Recent activity teaser */}
      <section className="rise mt-7" style={{ animationDelay: "220ms" }}>
        <SectionHeader
          title="Recent activity"
          action={
            <button
              type="button"
              onClick={() => onNavigate("activity")}
              className="text-[13px] font-semibold text-accent-ink"
            >
              See all
            </button>
          }
        />
        {activity[0] ? (
          <ActivityCard item={activity[0]} />
        ) : (
          <p className="glass-soft rounded-tile border-dashed px-4 py-6 text-center text-[13px] text-ink-muted">
            No rescues yet — your position is safe.
          </p>
        )}
      </section>
    </div>
  );
}
