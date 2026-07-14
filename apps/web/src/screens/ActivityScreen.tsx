import { useState } from "react";
import { useComatoData } from "../data/context";
import { type ActivityItem } from "../data/fixtures";
import { money } from "../lib/format";
import {
  motion,
  fadeRise,
  staggerContainer,
  MoneyCount,
  tapPress,
} from "../lib/motion";
import StatTile from "../components/StatTile";
import ActivityCard from "../components/ActivityCard";

type Filter = "all" | "rescue" | "flow";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "rescue", label: "Rescues" },
  { id: "flow", label: "Premiums & swaps" },
];

const DAYS: ActivityItem["day"][] = ["Today", "Yesterday", "This week"];

function matches(item: ActivityItem, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "rescue") return item.kind === "rescue";
  return item.kind === "premium" || item.kind === "swap";
}

export default function ActivityScreen() {
  const { activity, activitySummary } = useComatoData();
  const [filter, setFilter] = useState<Filter>("all");
  const visible = activity.filter((a) => matches(a, filter));
  const avgRescueUsd =
    activitySummary.rescueCount > 0
      ? Math.round(activitySummary.totalSavedUsd / activitySummary.rescueCount)
      : 0;

  return (
    <motion.div
      className="px-5 pb-4"
      variants={staggerContainer()}
      initial="hidden"
      animate="visible"
    >
      {/* Header */}
      <motion.header variants={fadeRise} className="pt-3">
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-ink">
          Activity
        </h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          Your position's protection &amp; rescue history.
        </p>
      </motion.header>

      {/* Summary */}
      <motion.section
        variants={fadeRise}
        className="mt-4 grid grid-cols-2 gap-3"
        aria-label="Activity summary"
      >
        <StatTile
          className="col-span-2"
          tone="dark"
          size="lg"
          label="Total saved"
          value={<MoneyCount value={activitySummary.totalSavedUsd} />}
          sub={`From ${activitySummary.rescueCount} rescues · liquidation penalty avoided`}
          badge={
            <span className="rounded-full bg-accent/18 px-2.5 py-1 text-[11px] font-semibold text-accent-ink">
              +{money(activitySummary.totalSavedUsd, { compact: true })}
            </span>
          }
        />
        <StatTile
          label="Premiums paid"
          value={<MoneyCount value={activitySummary.premiumPaidUsd} />}
          sub="Heartbeat x402"
        />
        <StatTile
          label="Average rescue"
          value={<MoneyCount value={avgRescueUsd} />}
          sub="Per event"
        />
      </motion.section>

      {/* Filter chips */}
      <motion.div
        variants={fadeRise}
        className="no-scrollbar mt-5 flex gap-2 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Filter activity"
      >
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <motion.button
              key={f.id}
              type="button"
              role="tab"
              whileTap={tapPress}
              aria-selected={active}
              onClick={() => setFilter(f.id)}
              className={
                "shrink-0 rounded-full px-4 py-2 text-[13px] font-semibold transition-all " +
                (active
                  ? "bg-gradient-to-b from-accent-bright to-accent text-[#fff7ef] shadow-[0_0_22px_-6px_rgba(241,137,60,0.85)]"
                  : "glass-soft text-ink-soft")
              }
            >
              {f.label}
            </motion.button>
          );
        })}
      </motion.div>

      {/* Grouped list — cards stagger in per day (keyed by filter so a filter
          change replays the stagger). */}
      <section className="mt-4 space-y-6" aria-label="Activity list">
        {DAYS.map((day) => {
          const items = visible.filter((a) => a.day === day);
          if (items.length === 0) return null;
          return (
            <div key={day}>
              <h2 className="mb-2.5 px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-ink-muted">
                {day}
              </h2>
              <motion.div
                key={filter}
                className="space-y-2.5"
                variants={staggerContainer(0.05, 0.02)}
                initial="hidden"
                animate="visible"
              >
                {items.map((item) => (
                  <ActivityCard key={item.id} item={item} />
                ))}
              </motion.div>
            </div>
          );
        })}

        {visible.length === 0 && (
          <p className="glass-soft rounded-tile border-dashed px-4 py-8 text-center text-[13px] text-ink-muted">
            No activity for this filter.
          </p>
        )}
      </section>
    </motion.div>
  );
}
