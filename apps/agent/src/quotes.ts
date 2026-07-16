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
import { formatUnits, type Address } from "viem";
import type { Logger } from "./logger.ts";
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

/**
 * A position the pricer can underwrite, from EITHER source that the premium
 * covers: a legacy Aave-EOA subscriber (aggregate position) or a Model C vault
 * (keyed by its owner). Unifying them here is the seam that lets the x402 premium
 * be priced from the real vault's risk, not just the old subscriber path.
 */
export interface UnderwritablePosition {
  /** The quote key — the vault owner or the Aave-EOA subscriber. */
  subscriber: Address;
  healthFactor: bigint; // WAD
  collateralBase: bigint; // USD, 8 dec
  debtBase: bigint; // USD, 8 dec
  /** Human description of the collateral for the underwriter (precise for vaults). */
  collateralMix: string;
}

export class QuoteWriter {
  constructor(
    private readonly pricer: Pricer,
    private readonly storePath: string,
    private readonly billingWindowMs: number,
    private readonly log: Logger,
  ) {}

  /**
   * Underwrite every position and publish the store. Positions with no debt are
   * skipped (nothing to insure); a failed quote falls back inside the pricer, so
   * this always publishes something for every debtor. The input is the unified
   * {@link UnderwritablePosition} so both the legacy subscriber path and the
   * Model C vaults feed one store, keyed by subscriber/owner address.
   */
  async repriceAll(positions: UnderwritablePosition[]): Promise<void> {
    const quotes: QuoteStoreFile["quotes"] = {};

    for (const pos of positions) {
      if (pos.debtBase <= 0n) continue;
      const quote: PricedQuote = await this.pricer.quote(
        {
          subscriber: pos.subscriber,
          healthFactor: pos.healthFactor,
          // Aave base currency is USD with 8 decimals.
          debtUsd: Number(formatUnits(pos.debtBase, 8)),
          collateralUsd: Number(formatUnits(pos.collateralBase, 8)),
          collateralMix: pos.collateralMix,
        },
        this.billingWindowMs,
      );
      quotes[pos.subscriber.toLowerCase()] = {
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
