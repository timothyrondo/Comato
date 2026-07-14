/**
 * Heartbeat client — the Track 2 count engine.
 *
 * Drives paid `GET /heartbeat` calls from one or more self-operated test
 * subscriber wallets (`SUBSCRIBER_PRIVATE_KEYS`). Each subscriber signs an
 * EIP-3009 authorization per request via thirdweb's `wrapFetchWithPayment`; the
 * server settles it through the Celo facilitator. One settlement == one Track 2
 * count. Runs a configurable interval/concurrency loop with graceful shutdown.
 *
 *   bun run heartbeat
 */

import { createThirdwebClient } from "thirdweb";
import { createWalletAdapter, privateKeyToAccount } from "thirdweb/wallets";
import { celo } from "thirdweb/chains";
import { wrapFetchWithPayment } from "thirdweb/x402";
import { loadClientConfig, type ClientConfig } from "./config.ts";
import { logger } from "./logger.ts";

type PayFetch = ReturnType<typeof wrapFetchWithPayment>;

interface Subscriber {
  address: string;
  url: string;
  fetchWithPay: PayFetch;
}

/**
 * In-memory storage for the permit cache thirdweb's x402 client expects. Avoids any
 * `localStorage` dependency in a server/CLI runtime (the "exact" scheme does not use it).
 */
const memoryStorage = (() => {
  const store = new Map<string, string>();
  return {
    getItem: async (key: string): Promise<string | null> => store.get(key) ?? null,
    setItem: async (key: string, value: string): Promise<void> => {
      store.set(key, value);
    },
    removeItem: async (key: string): Promise<void> => {
      store.delete(key);
    },
  };
})();

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
function decodeSettlementTx(headers: Headers): string | undefined {
  const raw = headers.get("payment-response") ?? headers.get("x-payment-response");
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { transaction?: string };
    return decoded.transaction;
  } catch {
    return undefined;
  }
}

async function heartbeatOnce(sub: Subscriber): Promise<void> {
  try {
    const res = await sub.fetchWithPay(sub.url, { method: "GET" });
    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      logger.warn("heartbeat.non200", { subscriber: sub.address, status: res.status, body: body.slice(0, 200) });
      return;
    }
    const tx = decodeSettlementTx(res.headers);
    logger.info("heartbeat.paid", { subscriber: sub.address, tx });
  } catch (err) {
    logger.error("heartbeat.error", { subscriber: sub.address, error: String(err) });
  }
}

export async function runHeartbeats(cfg: ClientConfig = loadClientConfig()): Promise<void> {
  const client = createThirdwebClient({ secretKey: cfg.thirdwebSecretKey });

  const subscribers: Subscriber[] = cfg.subscriberKeys.map((privateKey) => {
    const account = privateKeyToAccount({ client, privateKey });
    const wallet = createWalletAdapter({
      client,
      adaptedAccount: account,
      chain: celo,
      onDisconnect: () => {},
      // Fail-closed: this client only ever pays the Celo heartbeat. A chain-switch
      // request means the server offered payment requirements for a different
      // chain/asset; refuse rather than sign against an unintended domain. (A no-op
      // here would let wrapFetchWithPayment proceed to sign the off-chain
      // requirement even though the wallet never switched.)
      switchChain: () => {
        throw new Error("heartbeat: chain switch not supported (Celo only)");
      },
    });
    const fetchWithPay = wrapFetchWithPayment(fetch, client, wallet, {
      maxValue: cfg.maxValueAtomic,
      storage: memoryStorage,
    });
    return { address: account.address, url: cfg.heartbeatUrl, fetchWithPay };
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
