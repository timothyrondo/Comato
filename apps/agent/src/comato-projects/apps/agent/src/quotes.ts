/**
 * Quote writer — publishes the slow loop's underwriting output (arch §0).
 *
 * The pricer runs here, in the agent; the x402 server (a different process) charges
 * the premium. This file is the seam between them: a JSON quote store the agent
 * writes and the server reads when it builds a 402 challenge. Same pattern as
 * `premiumPaidUntilMs` (arch §7.1 Path A) — share state through a store, never by
 * putting a model call in the request path.
 *
 * Writes are atomic (temp file + rename) so the server can never read a torn file.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatUnits } from "viem";
import type { Logger } from "./logger.ts";
import type { HealthSnapshot } from "./monitor.ts";
import type { Pricer, PricedQuote } from "./pricer.ts";

/** Shape of the store file. The server re-validates on read — never trusts this blindly. */
export interface QuoteStoreFile {
  version: 1;
  updatedAt: string;
  quotes: Record<
    string,
    { premiumUsdc: string; riskTier: string; rationale: string; fallback: boolean; quotedAt: string }
  >;
}

export class QuoteWriter {
  constructor(
    private readonly pricer: Pricer,
    private readonly storePath: string,
    private readonly billingWindowMs: number,
    private readonly log: Logger,
  ) {}

  /**
   * Underwrite every monitored position and publish the store. Positions with no
   * debt are skipped (nothing to insure); a failed quote falls back inside the
   * pricer, so this always publishes something for every debtor.
   */
  async repriceAll(snapshots: HealthSnapshot[]): Promise<void> {
    const quotes: QuoteStoreFile["quotes"] = {};

    for (const snap of snapshots) {
      if (snap.totalDebtBase <= 0n) continue;
      const quote: PricedQuote = await this.pricer.quote(
        {
          subscriber: snap.subscriber,
          healthFactor: snap.healthFactor,
          // Aave base currency is USD with 8 decimals.
          debtUsd: Number(formatUnits(snap.totalDebtBase, 8)),
          collateralUsd: Number(formatUnits(snap.totalCollateralBase, 8)),
          // getUserAccountData is an aggregate; per-reserve composition needs the
          // data provider. The model is told it is unknown rather than guessed.
          collateralMix: "composition unknown (aggregate position)",
        },
        this.billingWindowMs,
      );
      quotes[snap.subscriber.toLowerCase()] = {
        premiumUsdc: quote.premiumUsdc,
        riskTier: quote.riskTier,
        rationale: quote.rationale,
        fallback: quote.fallback,
        quotedAt: new Date().toISOString(),
      };
    }

    const file: QuoteStoreFile = { version: 1, updatedAt: new Date().toISOString(), quotes };
    const tmp = `${this.storePath}.tmp`;
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(file, null, 2));
    renameSync(tmp, this.storePath);

    this.log.info("quote store published", {
      event: "quotes.published",
      path: this.storePath,
      count: Object.keys(quotes).length,
    });
  }
}
