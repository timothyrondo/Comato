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
import { Deleverager } from "./deleverage.ts";
import { VaultRegistry, readVaultUnderwrite } from "./vaults.ts";
import { Treasury } from "./treasury.ts";
import { X402Client } from "./x402.ts";
import { Pricer } from "./pricer.ts";
import { QuoteWriter, type UnderwritablePosition } from "./quotes.ts";

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
  // Model C — vault deleverage (separate rate limiter + state file from the rescue path).
  const deleverageRateLimiter = new RateLimiter(
    config.deleverage.cooldownMs,
    config.deleverage.maxPerWindow,
    config.deleverage.windowMs,
    { persistPath: config.deleverage.rateLimitStatePath || undefined, log: createLogger("ratelimit") },
  );
  const deleverager = new Deleverager(
    chain.publicClient,
    tx,
    config,
    deleverageRateLimiter,
    createLogger("deleverage"),
  );
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

  // --- vault registry (shared by the underwrite + deleverage loops) ---
  // Both the premium pricer (below) and the deleverage loop need the set of
  // Model C vaults this agent operates, so discover them once. Read-only with no
  // explicit VAULTS can't discover by operator, so there's nothing to share.
  const vaultRegistry =
    (config.deleverage.enabled || config.pricer.enabled) && (chain.account || config.vaults.length > 0)
      ? new VaultRegistry(
          chain.publicClient,
          config.deleverage.factoryAddress,
          chain.account?.address ?? null,
          { explicit: config.vaults, ttlMs: config.deleverage.discoveryTtlMs, maxVaults: config.deleverage.maxVaults },
          createLogger("vaults"),
        )
      : null;

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

  // --- underwriting loop (slow loop, arch §0): reprice every premium ---
  // Separate from the monitor loop on purpose: a model call is seconds, a rescue is a
  // race. The quote store is how the x402 server (another process) gets the prices.
  // Prices BOTH sources the premium covers: legacy Aave-EOA subscribers AND the
  // Model C vaults (keyed by owner) — so an x402 heartbeat is a genuine, risk-priced
  // payment for monitoring a real vault, not a flat fee for nothing. This is the
  // bridge that makes "the premium IS the Track 2 engine" true for Model C.
  if (config.pricer.enabled && (config.subscribers.length > 0 || vaultRegistry)) {
    const pricer = new Pricer(config.pricer, createLogger("pricer"));
    const quoteWriter = new QuoteWriter(
      pricer,
      config.pricer.storePath,
      config.pricer.billingWindowMs,
      createLogger("quotes"),
    );
    const underwriteLog = createLogger("underwrite");
    loops.push(
      startLoop("underwrite", config.pricer.repriceIntervalMs, async () => {
        // Legacy Aave-EOA subscribers → aggregate positions.
        const positions: UnderwritablePosition[] = (await monitor.pollAll())
          .filter((s) => s.totalDebtBase > 0n)
          .map((s) => ({
            subscriber: s.subscriber,
            healthFactor: s.healthFactor,
            collateralBase: s.totalCollateralBase,
            debtBase: s.totalDebtBase,
            collateralMix: "composition unknown (aggregate position)",
          }));
        // Model C vaults → precise per-vault underwriting, keyed by owner.
        if (vaultRegistry) {
          const vaults = await vaultRegistry.list();
          const underwrites = await Promise.all(
            vaults.map((v) => readVaultUnderwrite(chain.publicClient, v, underwriteLog)),
          );
          for (const u of underwrites) if (u) positions.push(u);
        }
        await quoteWriter.repriceAll(positions);
      }),
    );
  }

  // --- vault deleverage loop (Model C: non-custodial position management) ---
  // Vaults are auto-discovered from the factory (VaultRegistry): a subscriber who
  // subscribes on the website is picked up on the next cycle — no env edit needed.
  // An explicit VAULTS env still pins the set. Read-only + no VAULTS has nothing to
  // do (can't discover by operator, can't send), so the loop is skipped.
  if (config.deleverage.enabled && vaultRegistry) {
    if (!tx.canSend) {
      log.warn("deleverage enabled but no key/DRY_RUN prevents sending", { event: "deleverage.no_send" });
    }
    log.info("deleverage loop armed", {
      event: "deleverage.armed",
      source: config.vaults.length > 0 ? "env" : "factory",
      factory: config.deleverage.factoryAddress,
    });
    loops.push(
      startLoop("deleverage", config.monitorIntervalMs, async () => {
        const vaults = await vaultRegistry.list();
        for (const vault of vaults) {
          await deleverager.maybeDeleverage(vault);
        }
      }),
    );
  } else if (config.deleverage.enabled) {
    log.warn("deleverage enabled but read-only with no VAULTS — loop idle", { event: "agent.no_vaults" });
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
