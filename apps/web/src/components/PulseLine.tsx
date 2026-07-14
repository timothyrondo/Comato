/**
 * The Comato brand motif: an ECG / heartbeat line. Comato ("coma" → revival)
 * pulls a position back from the brink, so the vital-sign line recurs quietly
 * across the app. Purely decorative.
 */
export default function PulseLine({
  className = "",
  color = "currentColor",
  animate = false,
  strokeWidth = 2,
}: {
  className?: string;
  color?: string;
  animate?: boolean;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 240 40"
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M0 20 H70 L78 20 84 8 92 32 100 20 H128 L136 20 142 12 150 27 158 20 H240"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animate ? "ecg-draw" : undefined}
      />
    </svg>
  );
}
