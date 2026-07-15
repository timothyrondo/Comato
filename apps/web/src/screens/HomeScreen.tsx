import type { Screen } from "../types";
import { useComatoData } from "../data/context";
import { riskLevel, riskCopy } from "../lib/format";
import {
  motion,
  fadeRise,
  staggerContainer,
  HfCount,
  MoneyCount,
} from "../lib/motion";
import PulseLine from "../components/PulseLine";
import StatTile from "../components/StatTile";
import PillButton from "../components/PillButton";
import SectionHeader from "../components/SectionHeader";
import ActivityCard from "../components/ActivityCard";
import SubscribeFlow from "../components/SubscribeFlow";
import { ShieldCheck, ArrowRight, MapPin } from "../components/icons";

export default function HomeScreen({
  onNavigate,
}: {
  onNavigate: (s: Screen) => void;
}) {
  const { user, position, activity } = useComatoData();
  const level = riskLevel(
    position.healthFactor,
    position.rescueHf,
    position.liquidationHf,
  );

  return (
    <motion.div
      className="px-5 pb-4"
      variants={staggerContainer()}
      initial="hidden"
      animate="visible"
    >
      {/* Header */}
      <motion.header
        variants={fadeRise}
        className="flex items-center justify-between pt-3"
      >
        <div className="min-w-0">
          <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-ink">
            Overview
          </h1>
          <div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-muted">
            <MapPin size={15} className="text-ink-muted" />
            <span className="truncate">{user.contextLabel}</span>
          </div>
        </div>
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-b from-accent-bright to-accent text-[#fff7ef] shadow-[0_0_20px_-6px_rgba(241,137,60,0.9)]">
          <ShieldCheck size={22} />
        </span>
      </motion.header>

      {/* Go live: connect wallet → create vault → supply CELO → borrow USDC */}
      <motion.div variants={fadeRise} className="mt-5">
        <SubscribeFlow />
      </motion.div>

      {/* Hero status card */}
      <motion.section
        variants={fadeRise}
        className="glass-accent relative mt-5 overflow-hidden rounded-card p-6"
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
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-b from-accent-bright to-accent text-[#fff7ef] shadow-[0_0_22px_-4px_rgba(241,137,60,0.9)]">
              <ShieldCheck size={20} />
            </span>
          </div>

          <p className="mt-2.5 max-w-[16rem] text-[13.5px] leading-relaxed text-ink-soft">
            Your position is safe from liquidation. The Comato agent watches it
            every {position.monitorIntervalSec} seconds, non-stop.
          </p>
        </div>
      </motion.section>

      {/* Stat tiles */}
      <motion.section
        variants={fadeRise}
        className="mt-4 grid grid-cols-2 gap-3"
        aria-label="Position summary"
      >
        <StatTile
          className="col-span-2"
          tone="dark"
          size="lg"
          label="Health Factor"
          value={<HfCount value={position.healthFactor} />}
          sub={`${riskCopy[level]} · above liquidation threshold ${position.liquidationHf.toFixed(2)}`}
        />
        <StatTile
          label="Premium / hr"
          value={<MoneyCount value={position.premiumPerHourUsd} />}
          sub="Gasless via x402"
        />
        <StatTile
          label="Value protected"
          value={<MoneyCount value={position.collateralUsd} />}
          sub={`${position.collateralAsset} collateral`}
        />
      </motion.section>

      {/* Primary CTA */}
      <motion.div variants={fadeRise} className="mt-4">
        <PillButton
          onClick={() => onNavigate("position")}
          leading={<ShieldCheck size={19} />}
          trailing={<ArrowRight size={19} />}
        >
          Protect Position
        </PillButton>
      </motion.div>

      {/* Recent activity teaser */}
      <motion.section variants={fadeRise} className="mt-7">
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
      </motion.section>
    </motion.div>
  );
}
