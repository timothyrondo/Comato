/**
 * Comato agent (brain) — entrypoint. Wires the modules and runs the loops:
 *   - monitor + rescue loop  (every MONITOR_INTERVAL_MS)
 *       optionally buys x402 price/risk data first (Track 2 payer side, C2/C3)
 *   - treasury loop          (every TREASURY_INTERVAL_MS) — Track 1 volume (C1)
 *
 * Safe by default: DRY_RUN=true and rescue/treasury/x402 off unless configured.
 * Graceful shutdown on SIGINT/SIGTERM: stop scheduling, drain in-flight, exit.
 */

import { loadConfig, redactConfig, type Config } from "./config.ts";
import { createLogger, setLogLevel } from "./logger.ts";
import { createChain } from "./chain.ts";
import { TxSender } from "./tx.ts";
import { Monitor } from "./monitor.ts";
import { RateLimiter } from "./eligibility.ts";
import { Rescuer } from "./rescue.ts";
import { Treasury } from "./treasury.ts";
import { X402Client } from "./x402.ts";
import { Pricer } from "./pricer.ts";
import { QuoteWriter } from "./quotes.ts";

const log = createLogger("agent");

/** Runs `fn` immediately, then every `intervalMs`, never overlapping iterations. */
function startLoop(name: string, intervalMs: number, fn: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();

  const tick = async () => {
    if (stopped) return;
    running = (async () => {
      try {
        await fn();
      } catch (err) {
        log.error("loop iteration failed", {
          event: "loop.error",
          loop: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    await running;
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  void tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running; // drain the in-flight iteration
    },
  };
}

async function main() {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error("invalid configuration", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  setLogLevel(config.logLevel);
  log.info("starting Comato agent", { event: "agent.start", config: redactConfig(config) });

  if (config.dryRun) {
    log.warn("DRY_RUN is ON — no transactions will be broadcast", { event: "agent.dryrun" });
  }

  const chain = createChain(config);
  const tx = new TxSender(chain, config, createLogger("tx"));
  const monitor = new Monitor(chain.publicClient, config, createLogger("monitor"));
  const rateLimiter = new RateLimiter(
    config.rescue.cooldownMs,
    config.rescue.maxPerWindow,
    config.rescue.windowMs,
    {
      // Persist cooldowns across restarts (O3). "" disables persistence.
      persistPath: config.rescue.rateLimitStatePath || undefined,
      log: createLogger("ratelimit"),
    },
  );
  const rescuer = new Rescuer(chain.publicClient, tx, config, rateLimiter, createLogger("rescue"));
  const treasury = new Treasury(tx, config, createLogger("treasury"));
  const x402 = new X402Client(chain.publicClient, config, createLogger("x402"));

  if (chain.account) {
    log.info("COMATO_WALLET loaded", { event: "agent.wallet", address: chain.account.address });
  } else {
    log.warn("no COMATO_PRIVATE_KEY — read-only monitor mode (no rescues/swaps)", {
      event: "agent.readonly",
    });
  }

  const loops: Array<{ stop: () => Promise<void> }> = [];

  // --- monitor + rescue loop ---
  if (config.subscribers.length > 0) {
    loops.push(
      startLoop("monitor", config.monitorIntervalMs, async () => {
        // Buy price/risk data per poll (C2 payer side, + C3 volume) when enabled.
        if (x402.isEnabled) {
          try {
            await x402.buyData();
          } catch (err) {
            log.warn("x402 data purchase failed", {
              event: "x402.buy_error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const snapshots = await monitor.pollAll();
        for (const snap of snapshots) {
          if (!snap.breached) continue;
          const sub = config.subscribers.find((s) => s.address === snap.subscriber);
          if (sub) await rescuer.maybeRescue(snap, sub);
        }
      }),
    );
  } else {
    log.warn("no subscribers configured — monitor loop idle", { event: "agent.no_subscribers" });
  }

  // --- underwriting loop (slow loop, arch §0): reprice every subscriber's premium ---
  // Separate from the monitor loop on purpose: a model call is seconds, a rescue is a
  // race. The quote store is how the x402 server (another process) gets the prices.
  if (config.pricer.enabled && config.subscribers.length > 0) {
    const pricer = new Pricer(config.pricer, createLogger("pricer"));
    const quoteWriter = new QuoteWriter(
      pricer,
      config.pricer.storePath,
      config.pricer.billingWindowMs,
      createLogger("quotes"),
    );
    loops.push(
      startLoop("underwrite", config.pricer.repriceIntervalMs, async () => {
        await quoteWriter.repriceAll(await monitor.pollAll());
      }),
    );
  }

  // --- treasury loop (Track 1 volume engine) ---
  if (config.treasury.enabled) {
    if (!tx.canSend) {
      log.warn("treasury enabled but no key/DRY_RUN prevents sending", { event: "treasury.no_send" });
    }
    loops.push(
      startLoop("treasury", config.treasury.intervalMs, async () => {
        await treasury.runCycle();
      }),
    );
  }

  // --- graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { event: "agent.shutdown", signal });
    await Promise.all(loops.map((l) => l.stop()));
    log.info("shutdown complete", { event: "agent.stopped" });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info("agent running", {
    event: "agent.running",
    loops: loops.length,
    monitorIntervalMs: config.monitorIntervalMs,
  });
}

void main();
