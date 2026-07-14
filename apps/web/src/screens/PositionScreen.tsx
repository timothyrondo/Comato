import type { Screen } from "../types";
import { useComatoData } from "../data/context";
import { money, percent } from "../lib/format";
import HealthRing from "../components/HealthRing";
import StatTile from "../components/StatTile";
import RescueTimeline from "../components/RescueTimeline";
import SectionHeader from "../components/SectionHeader";
import { ChevronLeft, Refresh, ShieldCheck } from "../components/icons";

function LegendDot({
  color,
  label,
  range,
}: {
  color: string;
  label: string;
  range: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <span className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        {label}
      </span>
      <span className="tnum text-[11px] text-ink-muted">{range}</span>
    </div>
  );
}

export default function PositionScreen({
  onNavigate,
}: {
  onNavigate: (s: Screen) => void;
}) {
  const { position, rescuePlan, refresh } = useComatoData();
  return (
    <div className="px-5 pb-4">
      {/* Header */}
      <header className="flex items-center justify-between pt-3">
        <button
          type="button"
          onClick={() => onNavigate("home")}
          aria-label="Back to home"
          className="glass-soft flex h-10 w-10 items-center justify-center rounded-full text-ink"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="text-center">
          <h1 className="text-[17px] font-bold tracking-tight text-ink">
            Position
          </h1>
          <p className="text-[12px] text-ink-muted">
            {position.collateralAsset} → {position.debtAsset} · Aave V3
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          aria-label="Refresh data"
          className="glass-soft flex h-10 w-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:text-ink active:scale-95"
        >
          <Refresh size={18} />
        </button>
      </header>

      {/* Gauge centerpiece */}
      <section
        className="glass rise mt-4 rounded-card px-4 pb-5 pt-6"
        style={{ animationDelay: "40ms" }}
        aria-label="Health factor gauge"
      >
        <HealthRing
          value={position.healthFactor}
          liquidationHf={position.liquidationHf}
          rescueHf={position.rescueHf}
        />
        <div className="mt-2 flex items-start justify-around border-t border-line pt-4">
          <LegendDot color="#e5484d" label="Critical" range="< 1.20" />
          <LegendDot color="#e3a03a" label="Caution" range="1.20–1.50" />
          <LegendDot color="#17a672" label="Safe" range="> 1.50" />
        </div>
        <p className="mt-3 text-center text-[12px] leading-snug text-ink-muted">
          The dark line marks{" "}
          <span className="font-semibold text-ink">liquidation at 1.00</span>.
          Comato steps in at {position.rescueHf.toFixed(2)} — before it ever
          reaches you.
        </p>
      </section>

      {/* Position stats */}
      <section
        className="rise mt-4 grid grid-cols-2 gap-3"
        style={{ animationDelay: "100ms" }}
        aria-label="Position details"
      >
        <StatTile
          label="Collateral"
          value={money(position.collateralUsd)}
          sub={position.collateralAsset}
        />
        <StatTile
          label="Debt"
          value={money(position.debtUsd)}
          sub={position.debtAsset}
        />
        <StatTile
          tone="dark"
          label="Current LTV"
          value={percent(position.currentLtv)}
          sub={`Liquidation at ${percent(position.liquidationLtv)}`}
        />
        <StatTile
          tone="accent"
          label="Liquidation threshold"
          value={position.liquidationHf.toFixed(2)}
          sub={`Rescue at ${position.rescueHf.toFixed(2)}`}
        />
      </section>

      {/* Rescue plan + timeline */}
      <section className="rise mt-7" style={{ animationDelay: "160ms" }}>
        <SectionHeader title="Rescue plan" />
        <div className="glass rounded-card p-5">
          <div className="glass-accent flex gap-3 rounded-tile p-3.5">
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-accent-ink" />
            <p className="text-[13px] leading-relaxed text-accent-ink">
              If your Health Factor drops to {position.rescueHf.toFixed(2)},
              Comato pulls a gasless voucher and repays part of your debt to
              Aave — lifting it back up before liquidation at{" "}
              {position.liquidationHf.toFixed(2)}.
            </p>
          </div>
          <div className="mt-5">
            <RescueTimeline steps={rescuePlan} />
          </div>
        </div>
      </section>

      {/* Agent card (mirrors the reference's bottom summary card) */}
      <section className="rise mt-4" style={{ animationDelay: "220ms" }}>
        <div className="glass-deep flex items-center gap-3.5 rounded-card p-4 text-on-dark">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/20 text-accent-bright shadow-[0_0_24px_-6px_rgba(35,209,138,0.7)]">
            <ShieldCheck size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">Comato agent</div>
            <div className="text-[12.5px] text-on-dark-muted">
              Guarding your position around the clock
            </div>
          </div>
          <div className="flex items-center gap-4 pr-1 text-right">
            <div>
              <div className="tnum text-[15px] font-bold">
                {position.monitorIntervalSec}s
              </div>
              <div className="text-[10.5px] uppercase tracking-wide text-on-dark-muted">
                Interval
              </div>
            </div>
            <div className="h-8 w-px bg-white/10" />
            <div>
              <div className="tnum text-[15px] font-bold">
                {position.protectedSinceDays}d
              </div>
              <div className="text-[10.5px] uppercase tracking-wide text-on-dark-muted">
                Protected
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
