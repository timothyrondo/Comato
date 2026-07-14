import { useEffect, useState } from "react";
import { riskLevel, riskCopy, type RiskLevel } from "../lib/format";

/**
 * Health-factor gauge — the app's signature element. A 270° dial split into
 * discrete risk zones (danger / warn / safe), a liquidation-threshold tick, and
 * a knob at the current value. The centre number counts up on mount, a small
 * "revival" nod to what Comato does. Colours come straight from the risk tokens.
 */

const START = -135; // lower-left
const SWEEP = 270; // clockwise, gap at the bottom

const RISK_HEX: Record<RiskLevel, string> = {
  safe: "#23d18a",
  warn: "#f2b750",
  danger: "#ff5f66",
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
  const knob = polar(cx, cy, r, angleAt(value));

  // Liquidation tick
  const liqInner = polar(cx, cy, r - stroke / 2 - 3, angleAt(liquidationHf));
  const liqOuter = polar(cx, cy, r + stroke / 2 + 3, angleAt(liquidationHf));
  const liqLabel = polar(cx, cy, r + 20, angleAt(liquidationHf));

  // Count-up animation (from liquidation → current)
  const [display, setDisplay] = useState(value);
  const [knobIn, setKnobIn] = useState(false);
  useEffect(() => {
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (prefersReduced) {
      setDisplay(value);
      setKnobIn(true);
      return;
    }
    const from = liquidationHf;
    const dur = 1100;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = clamp01((now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (value - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setKnobIn(true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, liquidationHf]);

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
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        {/* Risk zones (glowing) */}
        <g filter="url(#hr-glow)">
          <path
            d={arc(min, rescueHf, 0, gap / 2)}
            fill="none"
            stroke={RISK_HEX.danger}
            strokeWidth={stroke}
            strokeLinecap="round"
            opacity={0.95}
          />
          <path
            d={arc(rescueHf, warnHf, gap / 2, gap / 2)}
            fill="none"
            stroke={RISK_HEX.warn}
            strokeWidth={stroke}
            strokeLinecap="round"
            opacity={0.95}
          />
          <path
            d={arc(warnHf, max, gap / 2, 0)}
            fill="none"
            stroke={RISK_HEX.safe}
            strokeWidth={stroke}
            strokeLinecap="round"
            opacity={0.95}
          />
        </g>

        {/* Liquidation tick */}
        <line
          x1={liqInner.x}
          y1={liqInner.y}
          x2={liqOuter.x}
          y2={liqOuter.y}
          stroke="rgba(255,255,255,0.55)"
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

        {/* Knob at current value */}
        <g
          style={{
            opacity: knobIn ? 1 : 0,
            transition: "opacity 260ms ease 120ms",
          }}
        >
          <circle cx={knob.x} cy={knob.y} r={13} fill="#0a1310" />
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
        </g>
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
