/**
 * Risk-based premium underwriter — the SLOW loop (arch §0).
 *
 * Comato without this is a subscription: one flat premium for every position,
 * regardless of collateral, debt, or how close to liquidation it sits. Pricing risk
 * is what makes it insurance, and it is the one place in this agent where a model
 * genuinely beats a constant.
 *
 * ## The split: the model RANKS, arithmetic SCALES
 *
 * An LLM asked to price directly returns a defensible ordering and an indefensible
 * magnitude. Measured 2026-07-14 on this exact prompt: it correctly rated a volatile
 * CELO-collateral position above a stable one, then priced it at **157% APR** — 18x
 * outside the band a subscriber would accept (`sim-economics.md §4.2`: 4.4–8.8%).
 * Good at relative judgement, unreliable on absolute numbers — the classic failure.
 *
 * So the model only emits a TIER. `premiumFor()` maps tier -> APR -> USDC, and the
 * arithmetic makes an out-of-band premium unrepresentable rather than merely unlikely.
 * A hallucinated tier costs at most the low->high spread; it can never invent a price.
 *
 * ## Fail-OPEN, unlike the rescue gate
 *
 * `eligibility.ts` fails CLOSED: unsure -> do not spend. Pricing is the inverse —
 * an unreachable model must never stop the agent from billing, so every failure path
 * returns `DEFAULT_TIER`. The agent keeps earning at the median price and logs why.
 *
 * ## Cadence
 *
 * Price on subscribe and re-price periodically — never per heartbeat. At a 1h billing
 * cadence a 17-day run is ~4,080 heartbeats; pricing each one would be ~4,080 inference
 * calls for a number that moves on the timescale of a position, not a payment.
 */

import { z } from "zod";
import type { Logger } from "./logger.ts";

export type RiskTier = "low" | "medium" | "high";

/**
 * Annualised premium per tier, as a fraction of debt. Bounds come from
 * `sim-economics.md §4.2`: 4.4% is credible against comparable cover (Nexus Mutual
 * charges ~2-5% for smart-contract cover; liquidation protection reasonably sits
 * above it), and 8.8% is the ceiling that still needs no explaining. Anything above
 * has to be defended, and every defence is attack surface.
 */
export const TIER_APR: Record<RiskTier, number> = {
  low: 0.044,
  medium: 0.066,
  high: 0.088,
};

/** Used whenever the model is unavailable, malformed, or slow. Median, not cheapest. */
export const DEFAULT_TIER: RiskTier = "medium";

const HOURS_PER_YEAR = 8760;

export const quoteSchema = z.object({
  riskTier: z.enum(["low", "medium", "high"]),
  rationale: z.string().min(1).max(280),
});

export type Quote = z.infer<typeof quoteSchema>;

export interface PricerConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface PositionRisk {
  subscriber: string;
  /** Health factor, WAD (1e18). */
  healthFactor: bigint;
  /** Total debt in USD. */
  debtUsd: number;
  /** Total collateral in USD. */
  collateralUsd: number;
  /** Collateral composition, e.g. "80% CELO, 20% USDC". */
  collateralMix: string;
}

export interface PricedQuote extends Quote {
  /** Premium per billing window, decimal USDC. */
  premiumUsdc: string;
  /** Effective APR against debt — the number a subscriber (and a judge) checks. */
  aprPct: number;
  /** True when the model was not consulted or its answer was rejected. */
  fallback: boolean;
}

/**
 * Premium for one billing window, from tier + debt. Deterministic and total: the
 * result is always inside TIER_APR by construction.
 */
export function premiumFor(tier: RiskTier, debtUsd: number, windowMs: number): { premiumUsdc: string; aprPct: number } {
  const apr = TIER_APR[tier];
  const windowsPerYear = (HOURS_PER_YEAR * 3_600_000) / windowMs;
  const premium = (apr * debtUsd) / windowsPerYear;
  return {
    // 6dp: USDC's own precision. Anything finer cannot be settled.
    premiumUsdc: premium.toFixed(6),
    // Rounded: this is a reported figure, and `0.044 * 100` is 4.3999999999999995.
    aprPct: Number((apr * 100).toFixed(4)),
  };
}

const SYSTEM_PROMPT = `You are an underwriter for liquidation-rescue insurance on Aave V3 (Celo).
Given a borrower's position, classify its liquidation risk over the next protection window.

Weigh: how close the health factor is to 1.0; collateral volatility (CELO is volatile,
stablecoins are not); whether debt is stable or volatile; and how much headroom the
position has.

Respond with ONLY a JSON object, no markdown fence:
{"riskTier":"low"|"medium"|"high","rationale":"<one sentence, max 200 chars>"}

Do NOT output a price. Pricing is not your job — only the tier.`;

function describe(p: PositionRisk): string {
  const hf = Number(p.healthFactor) / 1e18;
  return [
    `Health factor: ${hf.toFixed(4)}`,
    `Collateral: $${p.collateralUsd.toFixed(2)} (${p.collateralMix})`,
    `Debt: $${p.debtUsd.toFixed(2)}`,
    `Headroom to liquidation (HF 1.0): ${((hf - 1) * 100).toFixed(1)}%`,
  ].join("\n");
}

export class Pricer {
  constructor(
    private readonly config: PricerConfig,
    private readonly log: Logger,
  ) {}

  /**
   * Underwrite one position. Never throws and never blocks billing — every failure
   * returns the default tier with `fallback: true`.
   */
  async quote(position: PositionRisk, windowMs: number): Promise<PricedQuote> {
    const fallback = (reason: string, detail?: unknown): PricedQuote => {
      this.log.warn("pricer fell back to default tier", {
        event: "pricer.fallback",
        subscriber: position.subscriber,
        reason,
        detail: detail instanceof Error ? detail.message : detail,
      });
      return {
        riskTier: DEFAULT_TIER,
        rationale: `Default tier (${reason}).`,
        ...premiumFor(DEFAULT_TIER, position.debtUsd, windowMs),
        fallback: true,
      };
    };

    if (!this.config.enabled) return fallback("pricer disabled");

    let raw: string;
    try {
      raw = await this.complete(describe(position));
    } catch (err) {
      return fallback("model unreachable", err);
    }

    const parsed = quoteSchema.safeParse(extractJson(raw));
    if (!parsed.success) return fallback("malformed model output", parsed.error.issues[0]?.message);

    const priced = premiumFor(parsed.data.riskTier, position.debtUsd, windowMs);
    this.log.info("position underwritten", {
      event: "pricer.quote",
      subscriber: position.subscriber,
      riskTier: parsed.data.riskTier,
      ...priced,
    });
    return { ...parsed.data, ...priced, fallback: false };
  }

  private async complete(user: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("no content in response");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Models fence JSON despite instructions; take the first object rather than fail on it. */
function extractJson(raw: string): unknown {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
