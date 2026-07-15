/**
 * Hono app: one x402-gated route (`GET /heartbeat`) plus an ungated liveness probe.
 *
 * The payment middleware runs before the handler. On an unpaid request it returns
 * 402 with the payment requirements (price, payTo, asset). On a paid+verified
 * request it runs the handler, then settles via the Celo facilitator — each
 * settlement is one Track 2 count with `COMATO_WALLET` as payee.
 */

import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import type { RoutesConfig } from "@x402/core/server";
import type { Price } from "@x402/core/types";
import { CELO_NETWORK, USDC, SUBSCRIBER_HEADER } from "./constants.ts";
import { buildResourceServer, type BuildServerDeps } from "./x402-server.ts";
import { QuoteStore } from "./quote-store.ts";
import type { ServerConfig } from "./config.ts";
import { logger } from "./logger.ts";

export function createApp(cfg: ServerConfig, deps: BuildServerDeps = {}): Hono {
  const app = new Hono();
  const resourceServer = buildResourceServer(cfg, deps);
  const quoteStore = new QuoteStore(cfg.quoteStorePath, {
    maxPremiumUsdc: cfg.quoteMaxPremiumUsdc,
    maxAgeMs: cfg.quoteMaxAgeMs,
  });

  // Explicit AssetAmount: Celo is not in the SDK's default stablecoin table,
  // so asset + EIP-712 domain (name/version) must be supplied here.
  const assetAmount = (amount: string) => ({
    asset: USDC.address,
    amount,
    extra: { name: USDC.name, version: USDC.version },
  });

  /**
   * Risk-priced 402: the subscriber self-identifies via header, and the premium
   * comes from the agent's quote store. No header, no quote, or a quote that fails
   * the store's bounds -> the flat default. The model is never in this code path —
   * the store read is a cached file stat.
   *
   * Known MVP limitation: the claimed address is not yet bound to the payment's
   * actual payer (needs a verify hook comparing authorization.from). A payer
   * claiming another's address only changes which pre-bounded quote they pay.
   */
  const dynamicPrice = (ctx: { adapter: { getHeader(name: string): string | undefined } }): Price => {
    const claimed = ctx.adapter.getHeader(SUBSCRIBER_HEADER);
    const quote = quoteStore.lookup(claimed);
    if (!quote) return assetAmount(cfg.premiumAtomic);
    logger.info("price.quoted", { subscriber: claimed, riskTier: quote.riskTier, amountAtomic: quote.amountAtomic });
    return assetAmount(quote.amountAtomic);
  };

  const routes: RoutesConfig = {
    "GET /heartbeat": {
      accepts: {
        scheme: "exact",
        network: CELO_NETWORK,
        payTo: cfg.payTo,
        price: dynamicPrice,
        maxTimeoutSeconds: 120,
      },
      description: "Comato streaming liquidation-protection heartbeat (risk-priced premium settled via x402).",
      mimeType: "application/json",
    },
  };

  // Gate matching routes; everything else falls through to `next()`.
  app.use(paymentMiddleware(routes, resourceServer, undefined, undefined, cfg.syncFacilitatorOnStart));

  // Ungated liveness probe (never charged).
  app.get("/health", (c) => c.json({ status: "ok", service: "comato-heartbeat" }));

  // Gated resource: only reached after payment verification. The body is the
  // "protection receipt" returned to the paying subscriber.
  app.get("/heartbeat", (c) =>
    c.json({
      ok: true,
      service: "comato",
      protection: "active",
      network: CELO_NETWORK,
      payTo: cfg.payTo,
      premiumUsdc: cfg.premiumUsdc,
      ts: new Date().toISOString(),
    }),
  );

  return app;
}
