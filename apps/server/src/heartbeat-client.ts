/**
 * Heartbeat client — the Track 2 count engine.
 *
 * Drives paid `GET /heartbeat` calls from one or more self-operated test
 * subscriber wallets (`SUBSCRIBER_PRIVATE_KEYS`). Each subscriber signs an
 * EIP-3009 authorization per request with the official `@x402/*` SDK (viem-based,
 * the same client family x402.celo.org runs); the server settles it through the
 * Celo facilitator. One settlement == one Track 2 count. Runs a configurable
 * interval/concurrency loop with graceful shutdown.
 *
 *   bun run heartbeat
 */

import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { CELO_NETWORK } from "./constants.ts";
import { loadClientConfig, type ClientConfig } from "./config.ts";
import { logger } from "./logger.ts";

interface Subscriber {
  address: string;
  url: string;
  client: x402HTTPClient;
}

/**
 * Build a per-subscriber x402 HTTP client bound to that wallet's key. The exact
 * EVM scheme signs an EIP-3009 authorization; a maxValue policy refuses any
 * requirement above the per-payment ceiling (guards a mispriced/hostile route).
 */
function buildSubscriberClient(
  privateKey: `0x${string}`,
  maxValueAtomic: bigint,
): { address: string; client: x402HTTPClient } {
  const account = privateKeyToAccount(privateKey);
  const signer = toClientEvmSigner(account);
  const core = new x402Client()
    .register(CELO_NETWORK, new ExactEvmScheme(signer))
    .registerPolicy((_version, requirements) =>
      requirements.filter((r) => BigInt(r.amount) <= maxValueAtomic),
    );
  return { address: account.address, client: new x402HTTPClient(core) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `worker` over `items` with at most `concurrency` in flight. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) break;
      const item = items[i];
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** Pulls the settlement tx hash out of the x402 payment-response header, if present. */
function decodeSettlementTx(client: x402HTTPClient, headers: Headers): string | undefined {
  try {
    const settle = client.getPaymentSettleResponse((n) => headers.get(n));
    return settle.transaction || undefined;
  } catch {
    return undefined;
  }
}

async function heartbeatOnce(sub: Subscriber): Promise<void> {
  try {
    let res = await fetch(sub.url, { method: "GET" });

    // x402 handshake: on 402, sign an EIP-3009 authorization and retry with the
    // PAYMENT-SIGNATURE header. The server verifies + settles via the Celo facilitator.
    if (res.status === 402) {
      let body: unknown;
      try {
        body = await res.clone().json();
      } catch {
        body = undefined;
      }
      const required = sub.client.getPaymentRequiredResponse((n) => res.headers.get(n), body);
      let payload;
      try {
        payload = await sub.client.createPaymentPayload(required);
      } catch (err) {
        // No affordable/supported requirement (e.g. price above MAX_PAYMENT_USDC).
        logger.warn("heartbeat.declined", { subscriber: sub.address, error: String(err) });
        return;
      }
      res = await fetch(sub.url, {
        method: "GET",
        headers: { ...sub.client.encodePaymentSignatureHeader(payload) },
      });
    }

    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      logger.warn("heartbeat.non200", { subscriber: sub.address, status: res.status, body: body.slice(0, 200) });
      return;
    }
    const tx = decodeSettlementTx(sub.client, res.headers);
    logger.info("heartbeat.paid", { subscriber: sub.address, tx });
  } catch (err) {
    logger.error("heartbeat.error", { subscriber: sub.address, error: String(err) });
  }
}

export async function runHeartbeats(cfg: ClientConfig = loadClientConfig()): Promise<void> {
  const subscribers: Subscriber[] = cfg.subscriberKeys.map((privateKey) => {
    const { address, client } = buildSubscriberClient(privateKey, cfg.maxValueAtomic);
    return { address, url: cfg.heartbeatUrl, client };
  });

  logger.info("heartbeat.start", {
    subscribers: subscribers.map((s) => s.address),
    url: cfg.heartbeatUrl,
    intervalMs: cfg.intervalMs,
    concurrency: cfg.concurrency,
    maxHeartbeats: cfg.maxHeartbeats || "infinite",
    maxValueAtomic: cfg.maxValueAtomic,
  });

  let stop = false;
  let sent = 0;
  const onSignal = (signal: string) => {
    stop = true;
    logger.info("heartbeat.stopping", { signal });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  while (!stop && (cfg.maxHeartbeats === 0 || sent < cfg.maxHeartbeats)) {
    const batch: Subscriber[] = [];
    for (const sub of subscribers) {
      if (cfg.maxHeartbeats > 0 && sent >= cfg.maxHeartbeats) break;
      batch.push(sub);
      sent++;
    }
    await runPool(batch, cfg.concurrency, heartbeatOnce);
    if (stop || (cfg.maxHeartbeats > 0 && sent >= cfg.maxHeartbeats)) break;
    await sleep(cfg.intervalMs);
  }

  logger.info("heartbeat.done", { sent });
}

if (import.meta.main) {
  runHeartbeats().catch((err: unknown) => {
    logger.error("heartbeat.fatal", { error: String(err) });
    process.exit(1);
  });
}
