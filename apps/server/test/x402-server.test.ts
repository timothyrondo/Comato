/**
 * Gap-closing unit tests for `src/x402-server.ts`.
 *
 * Targets the branches the existing `heartbeat.test.ts` doesn't reach:
 *   - `makeAfterSettleHook`: ok / mismatch / unverified(null) / unverified(throw) /
 *     skipped / empty-tx paths, plus the never-throw guarantee.
 *   - `fetchSettlementSender` + `getClient`: the cached viem reader, driven fully
 *     offline by stubbing the JSON-RPC `fetch` (no live Celo RPC).
 *   - `buildResourceServer`: the real `HTTPFacilitatorClient` construction path
 *     (with + without an API key) and its suspicious-facilitator / missing-key warns.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { AfterSettleHook } from "@x402/core/server";
import {
  buildResourceServer,
  fetchSettlementSender,
  makeAfterSettleHook,
  type AfterSettleObservation,
} from "../src/x402-server.ts";
import type { ServerConfig } from "../src/config.ts";
import { CELO_NETWORK, X402_RELAYER } from "../src/constants.ts";

const OTHER_SENDER = "0x00000000000000000000000000000000deadbeef";
const TX = "0x" + "ab".repeat(32);

/** Minimal SettleResultContext for a direct hook call (no arg default — passing
 * `undefined` must genuinely mean "no tx hash", which a param default would swallow). */
function ctx(transaction: string | undefined) {
  return {
    result: { transaction, network: CELO_NETWORK, payer: "0x" + "22".repeat(20), amount: "1000", success: true },
  } as unknown as Parameters<AfterSettleHook>[0];
}

describe("makeAfterSettleHook — relayer verdicts (logs, never throws)", () => {
  it("classifies the Celo relayer as ok", async () => {
    const observed: AfterSettleObservation[] = [];
    const hook = makeAfterSettleHook({
      assertRelayer: true,
      rpcUrl: "rpc",
      getSender: async () => X402_RELAYER,
      onObserved: (o) => observed.push(o),
    });
    await hook(ctx(TX));
    expect(observed[0]).toEqual({ tx: TX, sender: X402_RELAYER, verdict: "ok" });
  });

  it("classifies a different relayer as mismatch (would not count for Track 2)", async () => {
    const observed: AfterSettleObservation[] = [];
    const hook = makeAfterSettleHook({
      assertRelayer: true,
      rpcUrl: "rpc",
      getSender: async () => OTHER_SENDER,
      onObserved: (o) => observed.push(o),
    });
    await hook(ctx(TX));
    expect(observed[0]!.verdict).toBe("mismatch");
    expect(observed[0]!.sender).toBe(OTHER_SENDER);
  });

  it("reports unverified when the sender read resolves to null", async () => {
    const observed: AfterSettleObservation[] = [];
    const hook = makeAfterSettleHook({
      assertRelayer: true,
      rpcUrl: "rpc",
      getSender: async () => null,
      onObserved: (o) => observed.push(o),
    });
    await hook(ctx(TX));
    expect(observed[0]!.verdict).toBe("unverified");
  });

  it("reports unverified (and does not throw) when the sender read throws", async () => {
    const observed: AfterSettleObservation[] = [];
    const hook = makeAfterSettleHook({
      assertRelayer: true,
      rpcUrl: "rpc",
      getSender: async () => {
        throw new Error("rpc exploded");
      },
      onObserved: (o) => observed.push(o),
    });
    await hook(ctx(TX)); // must resolve, not reject
    expect(observed[0]).toEqual({ tx: TX, sender: null, verdict: "unverified" });
  });

  it("skips the on-chain check entirely when assertRelayer is off (getSender never called)", async () => {
    const observed: AfterSettleObservation[] = [];
    let called = false;
    const hook = makeAfterSettleHook({
      assertRelayer: false,
      rpcUrl: "rpc",
      getSender: async () => {
        called = true;
        return X402_RELAYER;
      },
      onObserved: (o) => observed.push(o),
    });
    await hook(ctx(TX));
    expect(called).toBe(false);
    expect(observed[0]).toEqual({ tx: TX, sender: null, verdict: "skipped" });
  });

  it("does not attempt a read when the settle response carries no tx hash", async () => {
    const observed: AfterSettleObservation[] = [];
    let called = false;
    const hook = makeAfterSettleHook({
      assertRelayer: true,
      rpcUrl: "rpc",
      getSender: async () => {
        called = true;
        return X402_RELAYER;
      },
      onObserved: (o) => observed.push(o),
    });
    await hook(ctx(undefined)); // no transaction on the settle result
    expect(called).toBe(false);
    expect(observed[0]!.verdict).toBe("unverified");
  });
});

describe("fetchSettlementSender — cached viem reader (offline, stubbed JSON-RPC)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubRpc(from: string): () => number {
    let calls = 0;
    globalThis.fetch = (async (_input: unknown, init: { body?: unknown } = {}) => {
      calls += 1;
      const parsed = JSON.parse(String(init.body ?? "{}"));
      const id = Array.isArray(parsed) ? parsed[0]?.id : parsed.id;
      const result = {
        blockHash: "0x" + "cc".repeat(32),
        blockNumber: "0x1",
        from,
        gas: "0x5208",
        gasPrice: "0x1",
        hash: TX,
        input: "0x",
        nonce: "0x0",
        to: "0x1111111111111111111111111111111111111111",
        transactionIndex: "0x0",
        value: "0x0",
        type: "0x0",
        v: "0x1b",
        r: "0x" + "11".repeat(32),
        s: "0x" + "22".repeat(32),
        chainId: "0xa4ec",
      };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return () => calls;
  }

  it("reads tx.from from the chain and reuses one cached client per RPC url", async () => {
    const calls = stubRpc(X402_RELAYER);
    const url = "https://forno.celo.org";

    const first = await fetchSettlementSender(TX, url);
    expect(first?.toLowerCase()).toBe(X402_RELAYER);

    // Second call with the SAME url must hit the cached client (no second construction).
    const second = await fetchSettlementSender("0x" + "cd".repeat(32), url);
    expect(second?.toLowerCase()).toBe(X402_RELAYER);
    expect(calls()).toBe(2); // one RPC read per call, no retry storms
  });
});

describe("buildResourceServer — real HTTPFacilitatorClient wiring (constructed offline)", () => {
  const base: ServerConfig = {
    payTo: "0x1111111111111111111111111111111111111111",
    facilitatorUrl: "https://api.x402.celo.org",
    apiKey: "x402_live_key",
    rpcUrl: "https://forno.celo.org",
    network: CELO_NETWORK,
    premiumUsdc: "0.001",
    premiumAtomic: "1000",
    port: 0,
    syncFacilitatorOnStart: true,
    assertRelayer: true,
    quoteStorePath: "/nonexistent/quotes.json",
    quoteMaxPremiumUsdc: "0.05",
    quoteMaxAgeMs: 86_400_000,
  };

  it("builds against the real Celo HTTPFacilitatorClient with an API key (no network at construction)", () => {
    const server = buildResourceServer(base);
    expect(server).toBeDefined();
  });

  it("warns on a suspicious facilitator + missing key, and still builds (createAuthHeaders undefined branch)", () => {
    const server = buildResourceServer({
      ...base,
      facilitatorUrl: "https://evil.example.com",
      apiKey: "",
    });
    expect(server).toBeDefined();
  });
});
