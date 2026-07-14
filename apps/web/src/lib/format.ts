/** Small formatting + risk helpers shared across screens. */

/** USD money with id-ID grouping, e.g. 12480 → "$12.480", 0.02 → "$0,02". */
export function money(usd: number, opts: { compact?: boolean } = {}): string {
  const { compact = false } = opts;
  const fractionDigits = Number.isInteger(usd) ? 0 : 2;
  const value = new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: compact ? 1 : fractionDigits,
    notation: compact && Math.abs(usd) >= 1000 ? "compact" : "standard",
  }).format(usd);
  return `$${value}`;
}

export function percent(fraction: number, digits = 0): string {
  return `${new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(fraction * 100)}%`;
}

export type RiskLevel = "safe" | "warn" | "danger";

/** Classify a health factor. Mirrors the gauge zones. */
export function riskLevel(
  hf: number,
  rescueHf: number,
  liquidationHf: number,
): RiskLevel {
  if (hf <= liquidationHf) return "danger";
  if (hf <= rescueHf) return "warn";
  return "safe";
}

export const riskCopy: Record<RiskLevel, string> = {
  safe: "Safe",
  warn: "Caution",
  danger: "Critical",
};

/** Tailwind text color token per risk level. */
export const riskTextClass: Record<RiskLevel, string> = {
  safe: "text-safe",
  warn: "text-warn",
  danger: "text-danger",
};
