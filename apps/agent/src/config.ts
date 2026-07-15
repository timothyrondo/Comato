/**
 * Configuration. Env carries only secrets, genuinely per-deployment values, and
 * operational toggles. Every pure *tuning* value lives in `./defaults.ts`
 * (`DEFAULTS`) — the single source of truth — and is used here directly.
 *
 * Safe-by-default posture:
 *   - DRY_RUN defaults to TRUE: `bun run dev` never sends a real tx unless you
 *     explicitly set DRY_RUN=false. A demo can run with no funds at risk.
 *   - Rescue / treasury / x402 are each OFF unless their toggle is set.
 *   - If COMATO_PRIVATE_KEY is absent, the agent runs read-only (monitor only)
 *     and forces DRY_RUN — it can observe health factors but cannot send txs.
 */

import { parseUnits, isAddress, getAddress, type Address, type Hex } from "viem";
import { MAINNET } from "@comato/shared/addresses";
import { DEFAULTS } from "./defaults.ts";
import { assertStablePair } from "./treasury.ts";
import type { LogLevel } from "./logger.ts";

const CODE_RE = /^[a-z0-9_]{1,32}$/;

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function optRaw(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function addr(value: string, ctx: string): Address {
  if (!isAddress(value)) throw new Error(`Invalid address in ${ctx}: "${value}"`);
  return getAddress(value);
}

/** A monitored borrower + how to protect them. hfThreshold stored as WAD (1e18). */
export interface SubscriberConfig {
  address: Address;
  /** WAD health-factor threshold; rescue considered when HF < this. */
  hfThreshold: bigint;
  /** Debt asset a rescue repays (must be the subscriber's actual variable-debt asset). */
  debtAsset: Address;
  /** Collateral asset (informational / future deleverage). */
  collateralAsset?: Address;
  /** On-chain policy id, for the optional ComatoExecutor safety path. */
  policyId?: bigint;
  /**
   * Premium paid-through timestamp (ms epoch). The trust model requires premium
   * verification before a rescue; for the MVP this is provided per-subscriber
   * (in production it is derived from matched x402 settlements to COMATO_WALLET).
   */
  premiumPaidUntilMs?: number;
}

export interface Config {
  // --- identity / chain ---
  chainId: number;
  rpcUrl: string;
  /** ERC-8021 attribution code appended to every EOA-direct tx (C1). */
  attributionCode: string;
  /** COMATO_WALLET private key (optional -> read-only mode). */
  privateKey?: Hex;
  dryRun: boolean;
  logLevel: LogLevel;

  // --- monitor ---
  monitorIntervalMs: number;
  subscribers: SubscriberConfig[];

  // --- rescue (EOA-direct repay, tagged -> Track 1 via C1) ---
  rescue: {
    enabled: boolean;
    /** Absolute genuine-distress ceiling (WAD). Rescue only if HF < this too. */
    distressHf: bigint;
    /** Max debt-asset units repaid per rescue (base units, 6-dec stables). */
    maxAmount: bigint;
    /** Per-subscriber cooldown between rescues (rate limit). */
    cooldownMs: number;
    /** Max rescues per subscriber within `windowMs` (rate limit). */
    maxPerWindow: number;
    windowMs: number;
    /** Route via ComatoExecutor.rescue() instead of EOA-direct (safety path; loses C1). */
    viaExecutor: boolean;
    executorAddress?: Address;
    policyAddress?: Address;
    /**
     * If true, a subscriber with no `premiumPaidUntilMs` is treated as UNPAID and
     * skipped (fail-closed). Default true — never rescue an unfunded policy.
     */
    requirePremium: boolean;
    /**
     * File where the rate-limiter persists per-subscriber cooldown/window state
     * (O3). Loaded on startup so a crash/restart during the run does NOT clear
     * cooldowns. Empty string disables persistence (in-memory only).
     */
    rateLimitStatePath?: string;
  };

  // --- treasury (EOA-direct tagged swaps -> Track 1 volume engine via C1) ---
  treasury: {
    enabled: boolean;
    intervalMs: number;
    tokenA: Address;
    tokenB: Address;
    /** Input amount per swap, in tokenA base units. */
    swapAmount: bigint;
    decimalsA: number;
    decimalsB: number;
    /** Uniswap V3 fee tier (e.g. 100 = 0.01%). */
    poolFee: number;
    /** Slippage tolerance for amountOutMinimum, in basis points. */
    slippageBps: number;
    /** Do A->B then B->A each cycle (keeps the fund whole). */
    roundTrip: boolean;
    routerAddress: Address;
    /** Skip a swap if the source balance would fall below this (base units). */
    minReserve: bigint;
  };

  // --- x402 client (pay per data query -> Track 2 payer side via C2, C3) ---
  x402: {
    enabled: boolean;
    /** The priced data endpoint the agent buys risk/price data from. */
    dataUrl?: string;
    /** Max payment per request, in token base units (safety cap). */
    maxValue: bigint;
    /**
     * Hard timeout (ms) for a single paid data request. A hostile or hung data
     * endpoint must NOT be able to stall the monitor->rescue loop (the loop never
     * overlaps iterations, so a hang would silently suspend all protection and
     * block graceful shutdown). Enforced via an AbortSignal on the fetch.
     */
    requestTimeoutMs: number;
    /**
     * Celo facilitator URL. NOTE: the facilitator is chosen by the *resource
     * server*, not the client; this is surfaced for documentation and so the
     * client can verify settlements were relayed by the Celo relayer (C2).
     */
    facilitatorUrl: string;
    relayer: Address;
  };

  // --- pricer (slow-loop underwriting -> per-subscriber premiums, arch §0) ---
  pricer: {
    /** Off by default: the agent must keep billing at the flat premium without it. */
    enabled: boolean;
    /** OpenAI-compatible gateway key (DGRID). Required only when enabled. */
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    /** Where the quote store is written; the x402 server reads the same file. */
    storePath: string;
    /** Re-underwrite cadence. Positions move in hours, not per heartbeat. */
    repriceIntervalMs: number;
    /** Billing window the premium is quoted for (must match the server cadence). */
    billingWindowMs: number;
  };
}

interface RawSubscriber {
  address: string;
  hfThreshold?: string | number;
  debtAsset?: string;
  collateralAsset?: string;
  policyId?: string | number;
  /** Validated at load (parsePaidUntil); typed `unknown` because it comes from raw JSON. */
  premiumPaidUntilMs?: unknown;
}

/**
 * Validate `premiumPaidUntilMs` at load. It MUST be a finite number (ms epoch).
 * The eligibility gate does `paidUntil < now`; if a human writes an ISO string
 * ("2026-08-01") the comparison becomes `NaN < now` = false → no "expired" reason
 * → the premium gate silently reports PAID FOREVER (fail-OPEN, the exact inverse
 * of the fail-closed trust model). Reject non-numbers at boot, loudly.
 */
function parsePaidUntil(v: unknown, ctx: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(
      `${ctx}.premiumPaidUntilMs must be a finite number (ms epoch); got ${JSON.stringify(v)}. ` +
        `A string/NaN silently disables the premium gate (fail-open) — rejected at load.`,
    );
  }
  return v;
}

function parseSubscribers(json: string | undefined): RawSubscriber[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`SUBSCRIBERS must be valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("SUBSCRIBERS must be a JSON array");
  return parsed as RawSubscriber[];
}

export function loadConfig(): Config {
  const attributionCode = req("ATTRIBUTION_CODE").trim();
  if (!CODE_RE.test(attributionCode)) {
    throw new Error(
      `ATTRIBUTION_CODE "${attributionCode}" must match /^[a-z0-9_]{1,32}$/ (lowercase, digits, underscore).`,
    );
  }

  const rawKey = optRaw("COMATO_PRIVATE_KEY");
  let privateKey: Hex | undefined;
  if (rawKey) {
    const k = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
      throw new Error("COMATO_PRIVATE_KEY must be a 32-byte hex string (64 hex chars).");
    }
    privateKey = k as Hex;
  }

  // No key => cannot send txs => force read-only + dry-run.
  const dryRun = privateKey ? bool("DRY_RUN", true) : true;

  // Validate LOG_LEVEL: an invalid value (e.g. "warning") sets the threshold to
  // undefined, and `level < undefined` is always false → EVERY level logs, the
  // opposite of intent. Reject unknown levels at boot.
  const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
  const logLevel = opt("LOG_LEVEL", "info") as LogLevel;
  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL "${logLevel}" invalid; expected one of ${VALID_LOG_LEVELS.join(", ")}.`);
  }

  const defaultDebt = MAINNET.tokens.USDC;
  const rawSubs = parseSubscribers(optRaw("SUBSCRIBERS"));
  const subscribers: SubscriberConfig[] = rawSubs.map((s, i) => {
    const ctx = `SUBSCRIBERS[${i}]`;
    if (!s.address) throw new Error(`${ctx}.address is required`);
    const hfStr = s.hfThreshold === undefined ? "1.05" : String(s.hfThreshold);
    return {
      address: addr(s.address, `${ctx}.address`),
      hfThreshold: parseUnits(hfStr, 18),
      debtAsset: addr(s.debtAsset ?? defaultDebt, `${ctx}.debtAsset`),
      collateralAsset: s.collateralAsset ? addr(s.collateralAsset, `${ctx}.collateralAsset`) : undefined,
      policyId: s.policyId !== undefined ? BigInt(s.policyId) : undefined,
      premiumPaidUntilMs: parsePaidUntil(s.premiumPaidUntilMs, ctx),
    };
  });

  const executorRaw = optRaw("EXECUTOR_ADDRESS");
  const policyRaw = optRaw("POLICY_ADDRESS");

  const config: Config = {
    chainId: DEFAULTS.chainId,
    rpcUrl: opt("CELO_RPC", MAINNET.rpc),
    attributionCode,
    privateKey,
    dryRun,
    logLevel,

    monitorIntervalMs: DEFAULTS.monitorIntervalMs,
    subscribers,

    rescue: {
      enabled: bool("RESCUE_ENABLED", false),
      distressHf: parseUnits(DEFAULTS.rescue.distressHf, 18),
      maxAmount: parseUnits(DEFAULTS.rescue.maxAmount, DEFAULTS.rescue.assetDecimals),
      cooldownMs: DEFAULTS.rescue.cooldownMs,
      maxPerWindow: DEFAULTS.rescue.maxPerWindow,
      windowMs: DEFAULTS.rescue.windowMs,
      viaExecutor: DEFAULTS.rescue.viaExecutor,
      executorAddress: executorRaw ? addr(executorRaw, "EXECUTOR_ADDRESS") : undefined,
      policyAddress: policyRaw ? addr(policyRaw, "POLICY_ADDRESS") : undefined,
      requirePremium: DEFAULTS.rescue.requirePremium,
      // Empty string ("") disables on-disk persistence (in-memory limiter only).
      rateLimitStatePath: DEFAULTS.rescue.stateFile,
    },

    treasury: {
      enabled: bool("TREASURY_ENABLED", false),
      intervalMs: DEFAULTS.treasury.intervalMs,
      tokenA: addr(DEFAULTS.treasury.tokenA, "TREASURY_TOKEN_A"),
      tokenB: addr(DEFAULTS.treasury.tokenB, "TREASURY_TOKEN_B"),
      swapAmount: parseUnits(DEFAULTS.treasury.swapAmount, DEFAULTS.treasury.decimalsA),
      decimalsA: DEFAULTS.treasury.decimalsA,
      decimalsB: DEFAULTS.treasury.decimalsB,
      poolFee: DEFAULTS.treasury.poolFee,
      slippageBps: DEFAULTS.treasury.slippageBps,
      roundTrip: DEFAULTS.treasury.roundTrip,
      routerAddress: addr(DEFAULTS.treasury.router, "TREASURY_ROUTER"),
      minReserve: parseUnits(DEFAULTS.treasury.minReserve, DEFAULTS.treasury.decimalsA),
    },

    x402: {
      // DRY_RUN must mean NO real money moves. x402 settlements are real on-chain
      // payments through the facilitator (they burn credits and settle USDC), so a
      // dry run disables them too — otherwise the boot log's "no transactions will
      // be broadcast" is a lie while the agent pays every poll. To exercise the
      // x402 leg, run with DRY_RUN=false and the other engines off.
      enabled: !dryRun && bool("X402_ENABLED", Boolean(optRaw("X402_DATA_URL"))),
      dataUrl: optRaw("X402_DATA_URL"),
      maxValue: BigInt(DEFAULTS.x402.maxValue), // base units (e.g. 0.10 USDC @ 6dec)
      requestTimeoutMs: DEFAULTS.x402.requestTimeoutMs,
      facilitatorUrl: DEFAULTS.x402.facilitatorUrl,
      relayer: addr(DEFAULTS.x402.relayer, "X402_RELAYER"),
    },

    pricer: {
      enabled: bool("PRICER_ENABLED", false),
      apiKey: opt("DGRID_API_KEY", ""),
      baseUrl: opt("DGRID_BASE_URL", "https://api.dgrid.ai/v1"),
      model: opt("DGRID_MODEL", DEFAULTS.pricer.model),
      timeoutMs: DEFAULTS.pricer.timeoutMs,
      storePath: opt("QUOTE_STORE_PATH", DEFAULTS.pricer.storePath),
      repriceIntervalMs: DEFAULTS.pricer.repriceIntervalMs,
      billingWindowMs: DEFAULTS.pricer.billingWindowMs,
    },
  };

  // An enabled pricer with no key would silently quote the default tier forever —
  // that is a misconfiguration, not a fallback. Fail loudly at boot.
  if (config.pricer.enabled && !config.pricer.apiKey) {
    throw new Error("PRICER_ENABLED=true requires DGRID_API_KEY.");
  }

  // Slippage bound guards the treasury swap's amountOutMinimum. Values >= 10000bps
  // (100%) disable slippage protection entirely (amountOutMinimum <= 0) or make it
  // negative and break uint256 encoding — reject at load rather than swap unprotected.
  if (config.treasury.slippageBps < 0 || config.treasury.slippageBps >= 10_000) {
    throw new Error(
      `TREASURY_SLIPPAGE_BPS must be in [0, 10000); got ${config.treasury.slippageBps} (>=10000 disables slippage protection).`,
    );
  }

  // O7: the treasury's amountOutMinimum assumes a ~1:1 USD-stable pair. Only enforce
  // when the engine is actually enabled — fail fast at boot on a misconfigured pair.
  if (config.treasury.enabled) {
    assertStablePair(config.treasury);
  }

  return config;
}

/** Redacted view of the config for startup logging (never logs the private key). */
export function redactConfig(c: Config) {
  return {
    chainId: c.chainId,
    rpcUrl: c.rpcUrl,
    attributionCode: c.attributionCode,
    hasPrivateKey: Boolean(c.privateKey),
    dryRun: c.dryRun,
    monitorIntervalMs: c.monitorIntervalMs,
    subscribers: c.subscribers.length,
    rescueEnabled: c.rescue.enabled,
    rescueViaExecutor: c.rescue.viaExecutor,
    treasuryEnabled: c.treasury.enabled,
    x402Enabled: c.x402.enabled,
    x402DataUrl: c.x402.dataUrl,
    // The DGRID key itself is never logged.
    pricerEnabled: c.pricer.enabled,
    pricerModel: c.pricer.model,
    quoteStorePath: c.pricer.storePath,
  };
}
