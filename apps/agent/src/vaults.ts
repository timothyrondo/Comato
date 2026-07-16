/**
 * Vault auto-discovery (Model C) — closes the last manual step in the loop.
 *
 * Vaults used to be a hand-maintained `VAULTS` env list: a subscriber created a
 * vault on the website, and it stayed invisible to the agent until someone edited
 * the env and restarted the process. An "agentic" product can't have a human in
 * the middle of its own loop.
 *
 * The factory appends every `createVault` to a public `allVaults` array, so the
 * agent reads it directly: enumerate the factory, keep only the vaults THIS agent
 * operates (`vault.operator == our EOA`), and monitor those. A subscriber who
 * subscribes on the website is picked up on the next cycle — no env edit, no
 * restart.
 *
 * SAFETY:
 *   - `createVault` is permissionless, so `allVaults` is attacker-appendable. The
 *     operator filter means junk vaults (operator != us) are ignored, and
 *     `maxVaults` bounds the read budget against a spammed factory (logged, never
 *     silently truncated).
 *   - Discovery is cached for `ttlMs` so a fast deleverage loop doesn't re-scan
 *     the factory every tick.
 *   - Fail-safe: a discovery read error reuses the last-known set instead of
 *     dropping every vault (which would silently stop all protection).
 *   - An explicit `VAULTS` env pins the set (ops override) and skips the factory.
 */

import type { Address, PublicClient } from "viem";
import { MAINNET } from "@comato/shared/addresses";
import { comatoVaultAbi, comatoVaultFactoryAbi } from "./abis.ts";
import { withRetry } from "./retry.ts";
import type { Logger } from "./logger.ts";
import type { UnderwritablePosition } from "./quotes.ts";

const eqAddr = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase();

/** Known Celo token symbols for the underwriter's collateral description. */
const TOKEN_SYMBOLS: Record<string, string> = {
  [MAINNET.tokens.USDC.toLowerCase()]: "USDC",
  [MAINNET.tokens.USDT.toLowerCase()]: "USDT",
  [MAINNET.tokens.CELO.toLowerCase()]: "CELO",
  "0xd221812de1bd094f35587ee8e174b07b6167d9af": "WETH", // WETH on Celo (not in shared tokens)
};

function symbolOf(addr: Address): string {
  return TOKEN_SYMBOLS[addr.toLowerCase()] ?? `token ${addr.slice(0, 6)}…`;
}

/**
 * Read a discovered vault as an {@link UnderwritablePosition}, keyed by its OWNER
 * (the subscriber who pays the streaming premium). This is the bridge that lets
 * the x402 premium be risk-priced from the real Model C vault: the agent already
 * monitors the vault to deleverage it, and now it also underwrites it so the
 * server can charge a premium that reflects the vault's actual position.
 *
 * Returns null when the vault has no debt (nothing to insure) or a read fails
 * (the caller simply omits it from this cycle's quote store — fail-soft).
 */
export async function readVaultUnderwrite(
  client: PublicClient,
  vault: Address,
  log: Logger,
): Promise<UnderwritablePosition | null> {
  try {
    const opts = (label: string) => ({ label: `underwrite.${label}.${vault}`, logger: log, retries: 2 });
    const [position, owner, collateralAsset, debtAsset] = await Promise.all([
      withRetry(
        () => client.readContract({ address: vault, abi: comatoVaultAbi, functionName: "position" }),
        opts("position"),
      ),
      withRetry(
        () => client.readContract({ address: vault, abi: comatoVaultAbi, functionName: "subscriber" }),
        opts("subscriber"),
      ),
      withRetry(
        () => client.readContract({ address: vault, abi: comatoVaultAbi, functionName: "collateralAsset" }),
        opts("collateralAsset"),
      ),
      withRetry(
        () => client.readContract({ address: vault, abi: comatoVaultAbi, functionName: "debtAsset" }),
        opts("debtAsset"),
      ),
    ]);
    const [collateralBase, debtBase, hf] = position as readonly [bigint, bigint, bigint];
    if (debtBase <= 0n) return null; // no debt → nothing to underwrite

    return {
      subscriber: owner as Address,
      healthFactor: hf,
      collateralBase,
      debtBase,
      // Unlike the aggregate Aave read, a vault knows its exact assets — give the
      // underwriter the precise pair instead of "composition unknown".
      collateralMix: `${symbolOf(collateralAsset as Address)} collateral → ${symbolOf(debtAsset as Address)} debt (non-custodial vault)`,
    };
  } catch (err) {
    log.warn("vault underwrite read failed (skipped this cycle)", {
      event: "underwrite.vault_read_failed",
      vault,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface VaultRegistryOptions {
  /** Explicit VAULTS override; when non-empty, the factory is never read. */
  explicit: Address[];
  /** Cache TTL for factory discovery (ms) — a fast loop reuses the set between scans. */
  ttlMs: number;
  /** Safety cap on how many vaults to enumerate (grief bound against a spammed factory). */
  maxVaults: number;
  /** Injected clock for deterministic tests (defaults to Date.now). */
  nowMs?: () => number;
}

export class VaultRegistry {
  private cache: Address[] = [];
  private lastFetchMs = 0;
  private primed = false;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly factory: Address,
    /** The agent's operator EOA; only vaults it operates are monitored. null = read-only → discovery off. */
    private readonly operator: Address | null,
    private readonly opts: VaultRegistryOptions,
    private readonly log: Logger,
  ) {}

  private now(): number {
    return (this.opts.nowMs ?? Date.now)();
  }

  /**
   * The current set of vaults to monitor. An explicit `VAULTS` env wins; otherwise
   * cached factory discovery (refreshed at most once per `ttlMs`).
   */
  async list(): Promise<Address[]> {
    if (this.opts.explicit.length > 0) return this.opts.explicit;
    // Factory discovery needs to know whose vaults to watch. Read-only (no key) can
    // still monitor a pinned set via VAULTS, but can't discover by operator.
    if (!this.operator) return [];

    const now = this.now();
    if (this.primed && now - this.lastFetchMs < this.opts.ttlMs) return this.cache;

    try {
      this.cache = await this.discover(this.operator);
      this.lastFetchMs = now;
      this.primed = true;
    } catch (err) {
      this.log.error("vault discovery failed; reusing last-known set", {
        event: "vaults.discovery_failed",
        error: err instanceof Error ? err.message : String(err),
        cached: this.cache.length,
      });
    }
    return this.cache;
  }

  /** Enumerate the factory (capped) and keep only vaults `operator` operates. */
  private async discover(operator: Address): Promise<Address[]> {
    const count = await withRetry(
      () =>
        this.publicClient.readContract({
          address: this.factory,
          abi: comatoVaultFactoryAbi,
          functionName: "vaultCount",
        }),
      { label: "vaults.count", logger: this.log, retries: 3 },
    );

    const total = Number(count);
    const capped = Math.min(total, this.opts.maxVaults);
    if (total > capped) {
      this.log.warn("factory vault count exceeds cap; monitoring the first N only", {
        event: "vaults.capped",
        total,
        cap: capped,
      });
    }

    const addrs = await Promise.all(
      Array.from({ length: capped }, (_, i) =>
        withRetry(
          () =>
            this.publicClient.readContract({
              address: this.factory,
              abi: comatoVaultFactoryAbi,
              functionName: "allVaults",
              args: [BigInt(i)],
            }),
          { label: `vaults.at.${i}`, logger: this.log, retries: 3 },
        ),
      ),
    );

    const owned = (
      await Promise.all(
        addrs.map(async (v) => {
          const vault = v as Address;
          const op = (await withRetry(
            () =>
              this.publicClient.readContract({
                address: vault,
                abi: comatoVaultAbi,
                functionName: "operator",
              }),
            { label: `vaults.operator.${vault}`, logger: this.log, retries: 3 },
          )) as Address;
          return eqAddr(op, operator) ? vault : null;
        }),
      )
    ).filter((v): v is Address => v !== null);

    this.log.info("vault discovery", {
      event: "vaults.discovered",
      total,
      monitored: owned.length,
      operator,
    });
    return owned;
  }
}
