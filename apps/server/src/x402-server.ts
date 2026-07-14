/**
 * x402 resource-server wiring for Comato.
 *
 * THE CRITICAL REQUIREMENT (Track 2): settlements MUST route through Celo's
 * facilitator (`https://api.x402.celo.org`), whose relayer is
 * `0x0d74...FB48`. Any other facilitator submits from a different
 * relayer and would settle fine but NOT count for Track 2. This module:
 *   1. builds the resource server against `HTTPFacilitatorClient({ url })` (Celo), and
 *   2. in `onAfterSettle`, reads the settling tx on-chain and asserts its sender is
 *      the Celo relayer, loudly logging a mismatch (which means the count won't land).
 */

import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type AfterSettleHook,
  type FacilitatorClient,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPublicClient, http, type PublicClient } from "viem";
import { celo } from "viem/chains";
import { CELO_NETWORK, X402_API_KEY_HEADER, X402_RELAYER } from "./constants.ts";
import { logger } from "./logger.ts";
import type { ServerConfig } from "./config.ts";

export type RelayerVerdict = "ok" | "mismatch" | "unverified" | "skipped";

/** Per-path header maps the SDK's `HTTPFacilitatorClient` requests before each call. */
export interface FacilitatorAuthHeaders {
  verify: Record<string, string>;
  settle: Record<string, string>;
  supported: Record<string, string>;
}

/**
 * Builds the `createAuthHeaders` callback for Celo's `HTTPFacilitatorClient`.
 *
 * The SDK calls this before every request and merges the returned per-path map into
 * that path's fetch headers (verified in `@x402/core` `HTTPFacilitatorClient`:
 * `settle()` merges `authHeaders.settle`, `verify()` merges `authHeaders.verify`, etc).
 * Celo requires `X-API-Key` ONLY on `/settle` (1 credit per settlement); `/verify` and
 * `/supported` are public, so the key is scoped to `settle` and the public paths stay
 * keyless (no needless key exposure).
 */
export function celoFacilitatorAuthHeaders(apiKey: string): () => Promise<FacilitatorAuthHeaders> {
  return async () => ({
    verify: {},
    settle: { [X402_API_KEY_HEADER]: apiKey },
    supported: {},
  });
}

/** Pure classification of a settlement's on-chain sender against the Celo relayer. */
export function classifyRelayer(sender: string | null, assertRelayer: boolean): RelayerVerdict {
  if (!assertRelayer) return "skipped";
  if (!sender) return "unverified";
  return sender.toLowerCase() === X402_RELAYER ? "ok" : "mismatch";
}

/**
 * One viem client per RPC URL (O6). onAfterSettle fires on every heartbeat; a
 * fresh client per settlement wastes sockets over a 6-day run. Cached by URL.
 */
const clientCache = new Map<string, PublicClient>();
function getClient(rpcUrl: string): PublicClient {
  let client = clientCache.get(rpcUrl);
  if (!client) {
    client = createPublicClient({ chain: celo, transport: http(rpcUrl) }) as PublicClient;
    clientCache.set(rpcUrl, client);
  }
  return client;
}

/**
 * Retry a sender read a few times, returning null (never throwing) if it can't be
 * resolved (O6). The settling tx may not be readable the instant onAfterSettle
 * runs; a brief retry avoids a spurious `x402.relayer.unverified` before it mines,
 * while never blocking the settlement (the on-chain transfer already happened).
 */
export async function readSenderWithRetry(
  read: () => Promise<string | null>,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<string | null> {
  const retries = opts.retries ?? 4;
  const delayMs = opts.delayMs ?? 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const sender = await read();
      if (sender) return sender;
    } catch {
      // Not readable yet (e.g. tx not found / propagated) — fall through and retry.
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/** Reads the sender (`from`) of a settlement tx from the Celo chain (cached client + retry). */
export async function fetchSettlementSender(txHash: string, rpcUrl: string): Promise<string | null> {
  const client = getClient(rpcUrl);
  return readSenderWithRetry(async () => {
    const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
    return tx.from ?? null;
  });
}

export interface AfterSettleObservation {
  tx: string;
  sender: string | null;
  verdict: RelayerVerdict;
}

export interface AfterSettleHookDeps {
  assertRelayer: boolean;
  rpcUrl: string;
  /** Override the on-chain read (used by tests). */
  getSender?: (txHash: string, rpcUrl: string) => Promise<string | null>;
  /** Test/observability sink invoked once the relayer verdict is known. */
  onObserved?: (obs: AfterSettleObservation) => void;
}

/**
 * Builds the `onAfterSettle` hook: logs the settlement tx hash, then verifies the
 * settling relayer. Any failure here is logged, never thrown — a settlement has
 * already happened on-chain and must not be masked by a monitoring error.
 */
export function makeAfterSettleHook(deps: AfterSettleHookDeps): AfterSettleHook {
  const getSender = deps.getSender ?? fetchSettlementSender;

  return async (ctx): Promise<void> => {
    const { result } = ctx;
    const tx = result.transaction ?? "";

    logger.info("x402.settled", {
      tx,
      network: result.network,
      payer: result.payer,
      amount: result.amount,
      success: result.success,
    });

    if (!deps.assertRelayer) {
      deps.onObserved?.({ tx, sender: null, verdict: "skipped" });
      return;
    }

    let sender: string | null = null;
    try {
      sender = tx ? await getSender(tx, deps.rpcUrl) : null;
    } catch (err) {
      logger.warn("x402.relayer.check_failed", { tx, error: String(err) });
      deps.onObserved?.({ tx, sender: null, verdict: "unverified" });
      return;
    }

    const verdict = classifyRelayer(sender, deps.assertRelayer);
    if (verdict === "ok") {
      logger.info("x402.relayer.ok", { tx, relayer: sender, note: "counts for Track 2" });
    } else if (verdict === "mismatch") {
      logger.error("x402.relayer.mismatch", {
        tx,
        expected: X402_RELAYER,
        got: sender,
        note: "settled by WRONG relayer — will NOT count for Track 2; check facilitator URL",
      });
    } else {
      logger.warn("x402.relayer.unverified", { tx, note: "could not read settling tx sender" });
    }
    deps.onObserved?.({ tx, sender, verdict });
  };
}

export interface BuildServerDeps {
  /** Inject a facilitator client (tests supply a mock; prod uses Celo's HTTP client). */
  facilitator?: FacilitatorClient;
  getSender?: (txHash: string, rpcUrl: string) => Promise<string | null>;
  onObserved?: (obs: AfterSettleObservation) => void;
}

/**
 * Constructs the x402 resource server bound to the Celo facilitator + exact EVM
 * scheme, with the relayer-asserting settle hook attached.
 */
export function buildResourceServer(cfg: ServerConfig, deps: BuildServerDeps = {}): x402ResourceServer {
  if (!deps.facilitator && !cfg.facilitatorUrl.includes("x402.celo.org")) {
    logger.warn("x402.facilitator.suspicious", {
      url: cfg.facilitatorUrl,
      note: "Track 2 requires https://x402.celo.org — a different facilitator will not count",
    });
  }

  if (!deps.facilitator && !cfg.apiKey) {
    logger.warn("x402.apikey.missing", {
      note: "X402_API_KEY unset — /settle will 401 (facilitator requires X-API-Key)",
    });
  }

  const facilitator: FacilitatorClient =
    deps.facilitator ??
    new HTTPFacilitatorClient({
      url: cfg.facilitatorUrl,
      // Attach X-API-Key to /settle (required; 1 credit each). Skip if unset so a
      // missing key surfaces as the facilitator's 401 rather than sending `undefined`.
      createAuthHeaders: cfg.apiKey ? celoFacilitatorAuthHeaders(cfg.apiKey) : undefined,
    });

  return new x402ResourceServer(facilitator)
    .register(CELO_NETWORK, new ExactEvmScheme())
    .onAfterSettle(
      makeAfterSettleHook({
        assertRelayer: cfg.assertRelayer,
        rpcUrl: cfg.rpcUrl,
        getSender: deps.getSender,
        onObserved: deps.onObserved,
      }),
    );
}
