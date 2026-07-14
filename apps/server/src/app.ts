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
import { CELO_NETWORK, USDC } from "./constants.ts";
import { buildResourceServer, type BuildServerDeps } from "./x402-server.ts";
import type { ServerConfig } from "./config.ts";

export function createApp(cfg: ServerConfig, deps: BuildServerDeps = {}): Hono {
  const app = new Hono();
  const resourceServer = buildResourceServer(cfg, deps);

  const routes: RoutesConfig = {
    "GET /heartbeat": {
      accepts: {
        scheme: "exact",
        network: CELO_NETWORK,
        payTo: cfg.payTo,
        // Explicit AssetAmount: Celo is not in the SDK's default stablecoin table,
        // so asset + EIP-712 domain (name/version) must be supplied here.
        price: {
          asset: USDC.address,
          amount: cfg.premiumAtomic,
          extra: { name: USDC.name, version: USDC.version },
        },
        maxTimeoutSeconds: 120,
      },
      description: "Comato streaming liquidation-protection heartbeat (premium settled via x402).",
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
