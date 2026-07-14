import type { ReactNode } from "react";
import { motion, hoverLift } from "../lib/motion";

type Tone = "light" | "dark" | "accent";

const TONES: Record<Tone, { wrap: string; label: string; sub: string }> = {
  light: {
    wrap: "glass-soft",
    label: "text-ink-muted",
    sub: "text-ink-soft",
  },
  dark: {
    wrap: "glass-deep text-on-dark",
    label: "text-on-dark-muted",
    sub: "text-on-dark-muted",
  },
  accent: {
    wrap: "glass-accent",
    label: "text-accent-ink/80",
    sub: "text-accent-ink/90",
  },
};

interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Small caption under the value (optional). */
  sub?: ReactNode;
  /** Icon or badge floated top-right (optional). */
  badge?: ReactNode;
  tone?: Tone;
  /** Renders a larger value type — use for the hero stat. */
  size?: "md" | "lg";
  className?: string;
}

/** Small rounded stat block: tiny label + big number, dark or light. */
export default function StatTile({
  label,
  value,
  sub,
  badge,
  tone = "light",
  size = "md",
  className = "",
}: StatTileProps) {
  const t = TONES[tone];
  return (
    <motion.div
      whileHover={hoverLift}
      className={
        "flex flex-col justify-between rounded-tile p-4 will-change-transform " +
        t.wrap +
        (className ? " " + className : "")
      }
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={
            "text-[11px] font-medium uppercase tracking-[0.08em] " + t.label
          }
        >
          {label}
        </span>
        {badge}
      </div>
      <div className="mt-3">
        <div
          className={
            "tnum font-display font-extrabold leading-none tracking-tight " +
            (size === "lg" ? "text-4xl" : "text-2xl")
          }
        >
          {value}
        </div>
        {sub && <div className={"mt-1.5 text-[12px] " + t.sub}>{sub}</div>}
      </div>
    </motion.div>
  );
}
