/**
 * Server entrypoint. Boots the x402 heartbeat server with graceful shutdown.
 *
 *   bun run start   (or)   bun run dev
 */

import { createApp } from "./app.ts";
import { loadServerConfig } from "./config.ts";
import { logger } from "./logger.ts";

function main(): void {
  const cfg = loadServerConfig();
  const app = createApp(cfg);

  const server = Bun.serve({ port: cfg.port, fetch: app.fetch });

  logger.info("server.started", {
    url: `http://localhost:${server.port}`,
    payTo: cfg.payTo,
    facilitator: cfg.facilitatorUrl,
    network: cfg.network,
    premiumUsdc: cfg.premiumUsdc,
    assertRelayer: cfg.assertRelayer,
    routes: ["GET /heartbeat (paid)", "GET /health"],
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info("server.shutdown", { signal });
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  main();
}
