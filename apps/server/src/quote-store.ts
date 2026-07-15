/**
 * Quote store reader — how the agent's underwriting reaches the 402 challenge.
 *
 * The agent (a different process) writes per-subscriber premiums to a JSON file;
 * this reader feeds them to the route's DynamicPrice. The file is a TRUST BOUNDARY:
 * it may be absent, torn, stale, or wrong, and none of those may ever break billing
 * or smuggle an out-of-band price to a payer. Every failure returns `null`, which
 * means "charge the flat default premium".
 *
 * Bounds are enforced HERE, not just in the agent's pricer: the store is only as
 * trustworthy as whatever last wrote the file.
 */

import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { parseUnits } from "viem";
import { USDC } from "./constants.ts";
import { logger } from "./logger.ts";

const quoteSchema = z.object({
  premiumUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/, "decimal USDC, max 6dp"),
  riskTier: z.string(),
  rationale: z.string(),
  fallback: z.boolean(),
  quotedAt: z.string(),
});

const storeSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  quotes: z.record(z.string(), quoteSchema),
});

export interface StoredQuote {
  /** Premium in atomic USDC units, ready for an AssetAmount. */
  amountAtomic: string;
  riskTier: string;
}

export interface QuoteStoreOptions {
  /** Reject quotes above this (decimal USDC) — the absolute per-window ceiling. */
  maxPremiumUsdc: string;
  /** Reject quotes older than this. A quote from last week prices last week's risk. */
  maxAgeMs: number;
}

export class QuoteStore {
  private cache: { mtimeMs: number; quotes: Map<string, { premiumUsdc: string; riskTier: string; quotedAt: number }> } | null =
    null;

  constructor(
    private readonly path: string,
    private readonly opts: QuoteStoreOptions,
  ) {}

  /** Look up the quoted premium for a subscriber. Null on ANY doubt -> flat default. */
  lookup(subscriber: string | undefined, nowMs = Date.now()): StoredQuote | null {
    if (!subscriber || !/^0x[0-9a-fA-F]{40}$/.test(subscriber)) return null;

    const quotes = this.load();
    if (!quotes) return null;

    const q = quotes.get(subscriber.toLowerCase());
    if (!q) return null;

    if (nowMs - q.quotedAt > this.opts.maxAgeMs) {
      logger.warn("quote.stale", { subscriber, quotedAt: new Date(q.quotedAt).toISOString() });
      return null;
    }

    let atomic: bigint;
    try {
      atomic = parseUnits(q.premiumUsdc, USDC.decimals);
    } catch {
      return null;
    }
    const ceiling = parseUnits(this.opts.maxPremiumUsdc, USDC.decimals);
    if (atomic <= 0n || atomic > ceiling) {
      logger.warn("quote.out_of_bounds", { subscriber, premiumUsdc: q.premiumUsdc, ceiling: this.opts.maxPremiumUsdc });
      return null;
    }

    return { amountAtomic: atomic.toString(), riskTier: q.riskTier };
  }

  /** Read + validate the file, cached by mtime so the request path stays cheap. */
  private load(): Map<string, { premiumUsdc: string; riskTier: string; quotedAt: number }> | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      return null; // no store yet — the agent hasn't published
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.quotes;

    try {
      const parsed = storeSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed.success) {
        logger.warn("quote.store_invalid", { path: this.path, error: parsed.error.issues[0]?.message });
        return null;
      }
      const quotes = new Map(
        Object.entries(parsed.data.quotes).map(([addr, q]) => [
          addr.toLowerCase(),
          { premiumUsdc: q.premiumUsdc, riskTier: q.riskTier, quotedAt: Date.parse(q.quotedAt) || 0 },
        ]),
      );
      this.cache = { mtimeMs, quotes };
      return quotes;
    } catch (err) {
      logger.warn("quote.store_unreadable", { path: this.path, error: String(err) });
      return null;
    }
  }
}
