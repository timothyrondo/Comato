import type { ActivityItem } from "../data/fixtures";

/**
 * Health-Factor trace — the desktop hero chart. It reads as a vital-sign
 * monitor: the line dips at each real rescue (from the event's `hfBefore`) and
 * is pulled back up (`hfAfter`), ending at the live Health Factor. Every point
 * is grounded in data the app already has — rescue events + the current HF — so
 * nothing here is invented. Threshold guides mark liquidation (1.00) and the
 * rescue trigger.
 */

export interface HealthSeries {
  points: number[];
  /** Indices in `points` that correspond to a rescue dip (drawn as markers). */
  dips: number[];
}

/** Build the HF trace from real rescue history (oldest→newest) + current HF. */
export function buildHealthSeries(
  activity: ActivityItem[],
  currentHf: number,
): HealthSeries {
  const rescues = activity
    .filter((a): a is ActivityItem & { hfBefore: number; hfAfter: number } =>
      a.kind === "rescue" && a.hfBefore != null && a.hfAfter != null,
    )
    .slice()
    .reverse(); // oldest first

  if (rescues.length === 0) {
    // No rescues yet — a calm, steady trace easing up to the current HF.
    const base = currentHf;
    return {
      points: [base - 0.14, base - 0.06, base - 0.1, base - 0.03, base],
      dips: [],
    };
  }

  const points: number[] = [];
  const dips: number[] = [];
  // Lead-in from the first recovery level so the line doesn't open on a dip.
  points.push(Math.max(rescues[0].hfAfter, currentHf * 0.92));
  for (const r of rescues) {
    dips.push(points.length);
    points.push(r.hfBefore);
    points.push(r.hfAfter);
  }
  points.push(currentHf);
  return { points, dips };
}

interface HealthChartProps {
  series: HealthSeries;
  rescueHf: number;
  liquidationHf?: number;
  height?: number;
}

/** Catmull-Rom → cubic bezier for a smooth, premium curve. */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}

export default function HealthChart({
  series,
  rescueHf,
  liquidationHf = 1.0,
  height = 220,
}: HealthChartProps) {
  const W = 720;
  const H = height;
  const padX = 8;
  const padTop = 18;
  const padBottom = 26;

  const { points, dips } = series;
  const lo = Math.min(liquidationHf, ...points) - 0.12;
  const hi = Math.max(rescueHf, ...points) + 0.16;
  const span = Math.max(0.001, hi - lo);

  const x = (i: number) =>
    padX + (i / Math.max(1, points.length - 1)) * (W - padX * 2);
  const y = (v: number) =>
    padTop + (1 - (v - lo) / span) * (H - padTop - padBottom);

  const coords = points.map((v, i) => ({ x: x(i), y: y(v) }));
  const line = smoothPath(coords);
  const area =
    line +
    ` L ${coords[coords.length - 1].x} ${H - padBottom}` +
    ` L ${coords[0].x} ${H - padBottom} Z`;

  const last = coords[coords.length - 1];
  const liqY = y(liquidationHf);
  const rescueY = y(rescueHf);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Health factor over the recent rescue history, now at ${points[points.length - 1].toFixed(2)}`}
    >
      <defs>
        <linearGradient id="hc-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f1893c" stopOpacity="0.34" />
          <stop offset="55%" stopColor="#f1893c" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#f1893c" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="hc-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ff9a4a" />
          <stop offset="100%" stopColor="#e26985" />
        </linearGradient>
        <filter id="hc-glow" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Threshold guides */}
      <line
        x1={padX}
        y1={rescueY}
        x2={W - padX}
        y2={rescueY}
        stroke="#e0912f"
        strokeOpacity="0.6"
        strokeWidth="1.25"
        strokeDasharray="2 6"
      />
      <text
        x={padX + 2}
        y={rescueY - 6}
        fontSize="11"
        fontWeight="600"
        fill="#c67a1e"
        fillOpacity="0.9"
      >
        Rescue {rescueHf.toFixed(2)}
      </text>
      <line
        x1={padX}
        y1={liqY}
        x2={W - padX}
        y2={liqY}
        stroke="#e0524e"
        strokeOpacity="0.55"
        strokeWidth="1.25"
        strokeDasharray="2 6"
      />
      <text
        x={padX + 2}
        y={liqY - 6}
        fontSize="11"
        fontWeight="600"
        fill="#d0433f"
        fillOpacity="0.9"
      >
        Liquidation {liquidationHf.toFixed(2)}
      </text>

      {/* Area + line */}
      <path d={area} fill="url(#hc-area)" />
      <path
        d={line}
        fill="none"
        stroke="url(#hc-line)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#hc-glow)"
      />

      {/* Rescue-dip markers */}
      {dips.map((i) => (
        <circle
          key={i}
          cx={coords[i].x}
          cy={coords[i].y}
          r="3.5"
          fill="#e0524e"
          stroke="#fdf5ec"
          strokeWidth="2"
        />
      ))}

      {/* Current value dot */}
      <circle cx={last.x} cy={last.y} r="9" fill="#f1893c" fillOpacity="0.25" />
      <circle
        cx={last.x}
        cy={last.y}
        r="4.5"
        fill="#ff9a4a"
        stroke="#fdf5ec"
        strokeWidth="2"
        filter="url(#hc-glow)"
      />
    </svg>
  );
}
