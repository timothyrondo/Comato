import type { ActivityItem } from "../data/fixtures";
import { money } from "../lib/format";
import { Bolt, Coins, Refresh, ChevronRight } from "./icons";

/**
 * One activity row. Rescues render as prominent dark cards ("Rescued $X");
 * premiums and treasury swaps render as quieter light cards.
 */
export default function ActivityCard({ item }: { item: ActivityItem }) {
  const isRescue = item.kind === "rescue";
  const Icon = isRescue ? Bolt : item.kind === "premium" ? Coins : Refresh;

  const amountLabel =
    item.kind === "rescue"
      ? `+${money(item.amountUsd)}`
      : item.kind === "premium"
        ? `−${money(item.amountUsd)}`
        : money(item.amountUsd);

  if (isRescue) {
    return (
      <article className="flex items-center gap-3.5 rounded-tile bg-dark p-4 text-on-dark shadow-dark">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/18 text-accent-bright">
          <Icon size={21} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[15px] font-semibold">
              {item.title}
            </span>
            <span className="tnum shrink-0 text-[15px] font-bold text-accent-bright">
              {amountLabel}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="truncate text-[12.5px] text-on-dark-muted">
              {item.subtitle}
            </span>
            <span className="shrink-0 text-[11.5px] text-on-dark-muted">
              {item.timeAgo}
            </span>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="flex items-center gap-3.5 rounded-tile border border-line bg-surface p-4 shadow-tile">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
        <Icon size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-ink">
            {item.title}
          </span>
          <span className="tnum shrink-0 text-[14px] font-semibold text-ink-soft">
            {amountLabel}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="truncate text-[12.5px] text-ink-muted">
            {item.subtitle}
          </span>
          <span className="shrink-0 text-[11.5px] text-ink-muted">
            {item.timeAgo}
          </span>
        </div>
      </div>
      <ChevronRight size={18} className="shrink-0 text-ink-muted" />
    </article>
  );
}
