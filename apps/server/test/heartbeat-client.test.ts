/**
 * Unit tests for `src/heartbeat-client.ts` — the Track 2 count engine.
 *
 * `runHeartbeats(cfg)` is the only export, so every behavior is driven through it
 * with an injected `ClientConfig` (no env, no global mutation). `globalThis.fetch`
 * is stubbed per test — either a plain canned Response (for the error / stop /
 * concurrency paths, which never need a valid 402) or routed into a REAL Hono `app`
 * with a mock facilitator (for the pay / decline paths, which need a genuine 402 +
 * real EIP-3009 signing). Fully offline: no network, no funded wallets, no real keys.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseUnits } from "viem";
import { type FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.ts";
import { runHeartbeats } from "../src/heartbeat-client.ts";
import type { ClientConfig } from "../src/config.ts";
import type { ServerConfig } from "../src/config.ts";
import type { AfterSettleObservation } from "../src/x402-server.ts";
import { CELO_NETWORK, USDC, X402_RELAYER } from "../src/constants.ts";

// Well-known Anvil dev keys (public test vectors). NOT real / never funded on mainnet.
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const KEY2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const HEARTBEAT_URL = "http://localhost:4021/heartbeat";
const PAYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // account(KEY0)

const serverCfg: ServerConfig = {
  payTo: "0x1111111111111111111111111111111111111111",
  facilitatorUrl: "https://api.x402.celo.org",
  apiKey: "x402_test_key",
  rpcUrl: "https://forno.celo.org",
  network: CELO_NETWORK,
  premiumUsdc: "0.001",
  premiumAtomic: "1000",
  port: 0,
  syncFacilitatorOnStart: true,
  assertRelayer: true,
};

function makeClientCfg(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    heartbeatUrl: HEARTBEAT_URL,
    subscriberKeys: [KEY0],
    intervalMs: 1,
    concurrency: 1,
    maxHeartbeats: 1,
    maxValueAtomic: parseUnits("0.01", USDC.decimals), // 10_000 atomic — above the 1000 price
    ...overrides,
  };
}

/** Mock facilitator: advertises the Celo exact kind, always verifies, always settles. */
function mockFacilitator(settleTx = "0x" + "ab".repeat(32)) {
  let settleCalls = 0;
  const client: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: CELO_NETWORK }], extensions: [], signers: {} };
    },
    async verify() {
      return { isValid: true, payer: PAYER };
    },
    async settle() {
      settleCalls += 1;
      return { success: true, transaction: settleTx, network: CELO_NETWORK, payer: PAYER };
    },
  };
  return { client, settleCalls: () => settleCalls };
}

/** A `fetch` implementation that routes every request into the in-proc Hono app. */
function appFetch(app: ReturnType<typeof createApp>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    app.fetch(new Request(input as never, init as never))) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;

// runHeartbeats registers SIGINT/SIGTERM listeners. Snapshot the pre-existing set and
// remove ONLY the ones each test added — never touch the runner's own handlers.
let sigint0: ReturnType<typeof process.listeners>;
let sigterm0: ReturnType<typeof process.listeners>;

beforeEach(() => {
  sigint0 = process.listeners("SIGINT");
  sigterm0 = process.listeners("SIGTERM");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const l of process.listeners("SIGINT")) if (!sigint0.includes(l)) process.off("SIGINT", l as never);
  for (const l of process.listeners("SIGTERM")) if (!sigterm0.includes(l)) process.off("SIGTERM", l as never);
});

describe("runHeartbeats — pay path (real @x402 client -> real app -> mock facilitator)", () => {
  it("pays a 402 (402 -> sign EIP-3009 -> retry -> 200) and settles exactly once", async () => {
    const { client: facilitator, settleCalls } = mockFacilitator();
    const observed: AfterSettleObservation[] = [];
    const app = createApp(serverCfg, {
      facilitator,
      getSender: async () => X402_RELAYER,
      onObserved: (o) => observed.push(o),
    });
    globalThis.fetch = appFetch(app);

    await runHeartbeats(makeClientCfg({ maxHeartbeats: 1 }));

    expect(settleCalls()).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.verdict).toBe("ok");
  });

  it("declines (does not sign / does not settle) when the price exceeds MAX_PAYMENT cap", async () => {
    const { client: facilitator, settleCalls } = mockFacilitator();
    const app = createApp(serverCfg, { facilitator, getSender: async () => X402_RELAYER });

    let fetchCount = 0;
    const routed = appFetch(app);
    globalThis.fetch = (async (i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      fetchCount += 1;
      return routed(i as never, init as never);
    }) as unknown as typeof fetch;

    // Cap of 1 atomic unit is below the 1000-unit price -> policy filters it out ->
    // createPaymentPayload throws -> client logs `heartbeat.declined` and returns.
    await runHeartbeats(makeClientCfg({ maxHeartbeats: 1, maxValueAtomic: 1n }));

    expect(settleCalls()).toBe(0); // never settled
    expect(fetchCount).toBe(1); // only the unpaid 402 GET, no paid retry
  });
});

describe("runHeartbeats — resilience (never throws on a bad server)", () => {
  it("handles a 5xx response gracefully (no throw, one fetch)", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("boom", { status: 503 });
    }) as unknown as typeof fetch;

    await expect(runHeartbeats(makeClientCfg({ maxHeartbeats: 1 }))).resolves.toBeUndefined();
    expect(fetchCount).toBe(1);
  });

  it("handles a network error (fetch throws) gracefully (no throw)", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(runHeartbeats(makeClientCfg({ maxHeartbeats: 1 }))).resolves.toBeUndefined();
    expect(fetchCount).toBe(1);
  });
});

describe("runHeartbeats — loop control", () => {
  it("stops after exactly HEARTBEAT_MAX heartbeats (multi-round)", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    // 1 subscriber, cap 3 -> 3 rounds of 1 -> exactly 3 heartbeats, then stop.
    await runHeartbeats(makeClientCfg({ subscriberKeys: [KEY0], maxHeartbeats: 3, intervalMs: 1 }));
    expect(fetchCount).toBe(3);
  });

  it("runs multiple subscriber keys concurrently within a round", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let total = 0;
    globalThis.fetch = (async () => {
      inFlight += 1;
      total += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10)); // hold the slot so overlap is observable
      inFlight -= 1;
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    // 3 keys, concurrency 3, cap 3 -> one round of 3 in parallel.
    await runHeartbeats(
      makeClientCfg({ subscriberKeys: [KEY0, KEY1, KEY2], concurrency: 3, maxHeartbeats: 3, intervalMs: 1 }),
    );

    expect(total).toBe(3);
    expect(maxInFlight).toBe(3); // all three ran at once — proves concurrency
  });

  it("stops gracefully on SIGTERM during an otherwise-infinite run", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    // maxHeartbeats 0 = run forever; only a signal can stop it.
    const done = runHeartbeats(makeClientCfg({ maxHeartbeats: 0, intervalMs: 2 }));
    await new Promise((r) => setTimeout(r, 25)); // let a few rounds run
    process.emit("SIGTERM");

    await done; // must resolve (not hang) once stop is observed
    expect(fetchCount).toBeGreaterThan(0);
  });
});
