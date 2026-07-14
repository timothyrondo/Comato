import { useReducedMotion } from "framer-motion";
import { riskLevel, riskCopy, type RiskLevel } from "../lib/format";
import { motion, useCountUp, EASE_OUT } from "../lib/motion";

/**
 * Health-factor gauge — the app's signature element. A 270° dial split into
 * discrete risk zones (danger / warn / safe), a liquidation-threshold tick, and
 * a knob at the current value. On mount the gauge *sweeps*: the centre number
 * counts up from 0 and the knob glides along the arc to the live value — a small
 * "revival" nod to what Comato does. Colours come straight from the risk tokens.
 */

const START = -135; // lower-left
const SWEEP = 270; // clockwise, gap at the bottom

const RISK_HEX: Record<RiskLevel, string> = {
  safe: "#2a9d6f",
  warn: "#e0912f",
  danger: "#e0524e",
};

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

interface HealthRingProps {
  value: number;
  min?: number;
  max?: number;
  liquidationHf?: number;
  /** Boundary between the danger and warn zones (Comato's rescue trigger). */
  rescueHf?: number;
  /** Boundary between the warn and safe zones. */
  warnHf?: number;
  size?: number;
}

export default function HealthRing({
  value,
  min = 0.9,
  max = 2.5,
  liquidationHf = 1.0,
  rescueHf = 1.2,
  warnHf = 1.5,
  size = 264,
}: HealthRingProps) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 30;
  const stroke = 18;
  const gap = 3;

  const angleAt = (v: number) => START + clamp01((v - min) / (max - min)) * SWEEP;

  const arc = (v0: number, v1: number, padStart: number, padEnd: number) => {
    const a = angleAt(v0) + padStart;
    const b = angleAt(v1) - padEnd;
    const s = polar(cx, cy, r, a);
    const e = polar(cx, cy, r, b);
    const largeArc = b - a > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y}`;
  };

  const level = riskLevel(value, rescueHf, liquidationHf);
  const reduce = useReducedMotion();
  // Draw-in for the coloured risk arcs (clockwise, danger → safe).
  const drawArc = (order: number) =>
    reduce
      ? {}
      : {
          initial: { pathLength: 0 },
          animate: { pathLength: 1 },
          transition: { duration: 0.9, delay: 0.1 + order * 0.12, ease: EASE_OUT },
        };

  // Gauge sweep + count-up: the number counts 0 → value while the knob glides
  // along the arc to match (shared motion hook; snaps under reduced motion).
  const display = useCountUp(value, { duration: 1.15 });
  const knob = polar(cx, cy, r, angleAt(display));

  // Liquidation tick
  const liqInner = polar(cx, cy, r - stroke / 2 - 3, angleAt(liquidationHf));
  const liqOuter = polar(cx, cy, r + stroke / 2 + 3, angleAt(liquidationHf));
  const liqLabel = polar(cx, cy, r + 20, angleAt(liquidationHf));

  return (
    <div className="relative mx-auto" style={{ width: size, maxWidth: "100%" }}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="w-full"
        role="img"
        aria-label={`Health factor ${value.toFixed(2)}, status ${riskCopy[level]}`}
      >
        <defs>
          <filter id="hr-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* Base track */}
        <path
          d={arc(min, max, 0, 0)}
          fill="none"
          stroke="rgba(74,48,30,0.1)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        {/* Risk zones (glowing) — draw in clockwise on mount */}
        <g filter="url(#hr-glow)">
          <motion.path
            d={arc(min, rescueHf, 0, gap / 2)}
            fill="none"
            stroke={RISK_HEX.danger}
            strokeWidth={stroke}
            strokeLinecap="round"
            opacity={0.95}
            {...drawArc(0)}
          />
          <motion.path
            d={arc(rescueHf, warnHf, gap / 2, gap / 2)}
            fill="none"
            stroke={RISK_HEX.warn}
            strokeWidth={stroke}
            strokeLinecap="round"
            opacity={0.95}
            {...drawArc(1)}
          />
          <motion.path
            d={arc(warnHf, max, gap / 2, 0)}
            fill="none"
            stroke={RISK_HEX.safe}
            strokeWidth={stroke}
            strokeLinecap="round"
            opacity={0.95}
            {...drawArc(2)}
          />
        </g>

        {/* Liquidation tick */}
        <line
          x1={liqInner.x}
          y1={liqInner.y}
          x2={liqOuter.x}
          y2={liqOuter.y}
          stroke="rgba(74,48,30,0.42)"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        <text
          x={liqLabel.x}
          y={liqLabel.y}
          textAnchor="middle"
          dominantBaseline="middle"
          className="tnum"
          fontSize="10"
          fontWeight="700"
          fill="var(--color-ink-muted)"
        >
          1.00
        </text>

        {/* Knob at current value — fades in as the sweep settles */}
        <motion.g
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: reduce ? 0 : 0.35 }}
        >
          <circle cx={knob.x} cy={knob.y} r={13} fill="#fdf5ec" />
          <circle
            cx={knob.x}
            cy={knob.y}
            r={13}
            fill="none"
            stroke={RISK_HEX[level]}
            strokeWidth={4}
            filter="url(#hr-glow)"
          />
          <circle cx={knob.x} cy={knob.y} r={4.5} fill={RISK_HEX[level]} />
        </motion.g>
      </svg>

      {/* Centre readout */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          Health Factor
        </span>
        <span className="tnum mt-1 font-display text-[3.4rem] font-extrabold leading-none tracking-tight text-ink">
          {display.toFixed(2)}
        </span>
        <span
          className={
            "mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold " +
            (level === "safe"
              ? "bg-accent-soft text-accent-ink"
              : level === "warn"
                ? "bg-warn/15 text-warn"
                : "bg-danger/15 text-danger")
          }
        >
          <span
            className="pulse-dot h-2 w-2 rounded-full"
            style={{ background: RISK_HEX[level] }}
          />
          {riskCopy[level]}
        </span>
      </div>
    </div>
  );
}
