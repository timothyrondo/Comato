/**
 * x402.ts tests — the payer-side of Track 2 (C2/C3). Fully offline:
 *   - the `@x402/*` SDK (client/http/evm) is mocked per-file (verified no leak),
 *     with the HTTP client's four methods delegated to a per-test `httpImpl`;
 *   - global `fetch` is stubbed per test (initial 402 + paid retry);
 *   - the viem settlement-sender read (`publicClient.getTransaction`) is mocked.
 *
 * Covers: disabled / no-key / no-url no-ops; enabled happy 402 -> data; payment
 * DECLINED over the maxValue cap (no second fetch); relayer verify OK vs MISMATCH
 * vs read-error; request timeout via AbortSignal; non-402 passthrough; malformed
 * 402 body; non-hex settlement hash; text-body fallback.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getAddress } from "viem";
import type { Address, PublicClient } from "viem";
import { X402_RELAYER } from "@comato/shared/addresses";
import { makeConfig, silentLog } from "./_helpers.ts";
import type { Config } from "../src/config.ts";

// Per-test control surface for the mocked x402HTTPClient methods.
let httpImpl: {
  getPaymentRequiredResponse?: (...a: unknown[]) => unknown;
  createPaymentPayload?: (...a: unknown[]) => unknown;
  encodePaymentSignatureHeader?: (...a: unknown[]) => Record<string, string>;
  getPaymentSettleResponse?: (...a: unknown[]) => unknown;
} = {};

mock.module("@x402/core/client", () => ({
  x402Client: class {
    register() {
      return this;
    }
    // The real client applies the registered policy to advertised requirements;
    // invoke it here so the agent's maxValue-cap filter is actually exercised
    // (both the affordable and over-cap branches) during construction.
    registerPolicy(fn: (version: number, requirements: Array<{ amount: string }>) => unknown) {
      fn(0, [{ amount: "1000" }, { amount: "999999999999" }]);
      return this;
    }
  },
}));
mock.module("@x402/core/http", () => ({
  x402HTTPClient: class {
    constructor(_core: unknown) {}
    // The real client reads x402 headers via the passed getter; invoke it so the
    // agent's `(n) => res.headers.get(n)` header accessor is actually exercised.
    getPaymentRequiredResponse(getHeader: (n: string) => string | null, body: unknown) {
      getHeader("X-Payment-Required");
      return httpImpl.getPaymentRequiredResponse?.(getHeader, body);
    }
    createPaymentPayload(...a: unknown[]) {
      return httpImpl.createPaymentPayload?.(...a);
    }
    encodePaymentSignatureHeader(...a: unknown[]) {
      return httpImpl.encodePaymentSignatureHeader?.(...a) ?? {};
    }
    getPaymentSettleResponse(getHeader: (n: string) => string | null) {
      getHeader("X-Payment-Response");
      return httpImpl.getPaymentSettleResponse?.(getHeader);
    }
  },
}));
mock.module("@x402/evm/exact/client", () => ({
  ExactEvmScheme: class {
    constructor(_signer: unknown) {}
  },
}));
mock.module("@x402/evm", () => ({ toClientEvmSigner: (acct: unknown) => acct }));

const { X402Client } = await import("../src/x402.ts");

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DATA_URL = "https://data.example/price";
const TXHASH = `0x${"1".repeat(64)}` as `0x${string}`;
const OTHER = "0x00000000000000000000000000000000000000ff" as Address;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  httpImpl = {};
});

function enabledConfig(over: Partial<Config["x402"]> = {}): Config {
  return makeConfig({
    privateKey: KEY as `0x${string}`,
    x402: { ...makeConfig().x402, enabled: true, dataUrl: DATA_URL, ...over },
  });
}

/** Public client whose settlement-sender read is controllable. */
function pubWith(getTransaction: (a: { hash: `0x${string}` }) => Promise<{ from: string }>): PublicClient {
  return { getTransaction } as unknown as PublicClient;
}
const pubRelayer = () => pubWith(async () => ({ from: X402_RELAYER }));

/** Queue of fetch responses; each fetch call shifts one and records its init. */
function stubFetch(responses: Response[]) {
  const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("fetch called more times than stubbed");
    return next;
  }) as unknown as typeof fetch;
  return calls;
}

const json402 = () => new Response(JSON.stringify({ accepts: [{ amount: "1000" }] }), { status: 402 });
const ok200 = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

describe("X402Client — disabled / not-ready no-ops", () => {
  test("x402 disabled: no-op, buyData returns {ok:false,status:0}", async () => {
    const client = new X402Client(
      pubRelayer(),
      makeConfig({ x402: { ...makeConfig().x402, enabled: false } }),
      silentLog,
    );
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when disabled");
    }) as unknown as typeof fetch;
    expect(client.isEnabled).toBe(false);
    expect(await client.buyData()).toEqual({ ok: false, status: 0 });
  });

  test("enabled but no private key => disabled", () => {
    const client = new X402Client(
      pubRelayer(),
      makeConfig({ privateKey: undefined, x402: { ...makeConfig().x402, enabled: true, dataUrl: DATA_URL } }),
      silentLog,
    );
    expect(client.isEnabled).toBe(false);
  });

  test("enabled with a key but no data URL => disabled", () => {
    const client = new X402Client(
      pubRelayer(),
      makeConfig({
        privateKey: KEY as `0x${string}`,
        x402: { ...makeConfig().x402, enabled: true, dataUrl: undefined },
      }),
      silentLog,
    );
    expect(client.isEnabled).toBe(false);
  });
});

describe("X402Client.buyData — paid 402 flow", () => {
  test("happy path: pays, gets data, relayer verified on-chain", async () => {
    httpImpl = {
      getPaymentRequiredResponse: () => ({ required: true }),
      createPaymentPayload: () => ({ payload: true }),
      encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "sig" }),
      getPaymentSettleResponse: () => ({ transaction: TXHASH }),
    };
    const calls = stubFetch([json402(), ok200({ price: 42 })]);
    const client = new X402Client(pubRelayer(), enabledConfig(), silentLog);
    expect(client.isEnabled).toBe(true);

    const res = await client.buyData();
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ price: 42 });
    expect(res.settlementTx).toBe(TXHASH);
    expect(res.relayerVerified).toBe(true);
    // Two fetches: the initial 402 and the paid retry carrying the signature header.
    expect(calls.length).toBe(2);
    expect((calls[1]!.init!.headers as Record<string, string>)["X-PAYMENT"]).toBe("sig");
  });

  test("payment DECLINED over maxValue: no signature, no second fetch", async () => {
    httpImpl = {
      getPaymentRequiredResponse: () => ({ required: true }),
      createPaymentPayload: () => {
        throw new Error("no affordable requirement (over max value)");
      },
    };
    const calls = stubFetch([json402()]);
    const client = new X402Client(pubRelayer(), enabledConfig(), silentLog);
    const res = await client.buyData();
    expect(res).toEqual({ ok: false, status: 402 });
    expect(calls.length).toBe(1); // never paid / retried
  });

  test("malformed 402 body is tolerated (parse fails -> undefined), then declines", async () => {
    httpImpl = {
      getPaymentRequiredResponse: () => ({ required: true }),
      createPaymentPayload: () => {
        throw new Error("nothing to sign");
      },
    };
    const calls = stubFetch([new Response("garbage{", { status: 402 })]);
    const client = new X402Client(pubRelayer(), enabledConfig(), silentLog);
    const res = await client.buyData();
    expect(res).toEqual({ ok: false, status: 402 });
    expect(calls.length).toBe(1);
  });

  test("relayer MISMATCH: settled by a non-Celo relayer => relayerVerified false", async () => {
    httpImpl = {
      getPaymentRequiredResponse: () => ({}),
      createPaymentPayload: () => ({}),
      encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "sig" }),
      getPaymentSettleResponse: () => ({ transaction: TXHASH }),
    };
    stubFetch([json402(), ok200({ price: 1 })]);
    const client = new X402Client(pubWith(async () => ({ from: OTHER })), enabledConfig(), silentLog);
    const res = await client.buyData();
    expect(res.ok).toBe(true);
    expect(res.settlementTx).toBe(TXHASH);
    expect(res.relayerVerified).toBe(false);
  });

  test("relayer verify read error => relayerVerified false (still returns data)", async () => {
    httpImpl = {
      getPaymentRequiredResponse: () => ({}),
      createPaymentPayload: () => ({}),
      encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "sig" }),
      getPaymentSettleResponse: () => ({ transaction: TXHASH }),
    };
    stubFetch([json402(), ok200({ price: 1 })]);
    const client = new X402Client(
      pubWith(async () => {
        throw new Error("getTransaction rpc error");
      }),
      enabledConfig(),
      silentLog,
    );
    const res = await client.buyData();
    expect(res.relayerVerified).toBe(false);
    expect(res.data).toEqual({ price: 1 });
  });

  test("non-hex settlement hash => settlementTx undefined, no relayer read", async () => {
    let getTxCalls = 0;
    httpImpl = {
      getPaymentRequiredResponse: () => ({}),
      createPaymentPayload: () => ({}),
      encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "sig" }),
      getPaymentSettleResponse: () => ({ transaction: "0xnothex" }),
    };
    stubFetch([json402(), ok200({ price: 1 })]);
    const client = new X402Client(
      pubWith(async () => {
        getTxCalls++;
        return { from: X402_RELAYER };
      }),
      enabledConfig(),
      silentLog,
    );
    const res = await client.buyData();
    expect(res.settlementTx).toBeUndefined();
    expect(res.relayerVerified).toBeUndefined();
    expect(getTxCalls).toBe(0);
  });
});

describe("X402Client.buyData — no-payment paths", () => {
  test("non-402 passthrough: returns data, no settlement, no payment attempt", async () => {
    let paid = false;
    httpImpl = {
      createPaymentPayload: () => {
        paid = true;
        return {};
      },
      getPaymentSettleResponse: () => {
        throw new Error("no settle header");
      },
    };
    const calls = stubFetch([ok200({ price: 7 })]);
    const client = new X402Client(pubRelayer(), enabledConfig(), silentLog);
    const res = await client.buyData();
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ price: 7 });
    expect(res.settlementTx).toBeUndefined();
    expect(paid).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("text body fallback when the response is not JSON", async () => {
    httpImpl = { getPaymentSettleResponse: () => undefined };
    stubFetch([new Response("plain text body", { status: 200 })]);
    const client = new X402Client(pubRelayer(), enabledConfig(), silentLog);
    const res = await client.buyData();
    expect(res.ok).toBe(true);
    expect(res.data).toBe("plain text body");
  });

  test("uses an explicit URL argument when provided", async () => {
    httpImpl = { getPaymentSettleResponse: () => undefined };
    const calls = stubFetch([ok200({ ok: true })]);
    const client = new X402Client(pubRelayer(), enabledConfig(), silentLog);
    await client.buyData("https://other.example/data");
    expect(calls[0]!.url).toBe("https://other.example/data");
  });
});

describe("X402Client.buyData — request timeout (AbortSignal)", () => {
  test("a hung endpoint is aborted by the request timeout", async () => {
    httpImpl = {};
    // fetch that never resolves until its AbortSignal fires.
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
        );
      })) as unknown as typeof fetch;
    const client = new X402Client(pubRelayer(), enabledConfig({ requestTimeoutMs: 20 }), silentLog);
    await expect(client.buyData()).rejects.toThrow();
  });

  test("the fetch is given an AbortSignal", async () => {
    let sawSignal = false;
    httpImpl = { getPaymentSettleResponse: () => undefined };
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return Promise.resolve(ok200({ price: 1 }));
    }) as unknown as typeof fetch;
    const client = new X402Client(pubRelayer(), enabledConfig(), silentLog);
    await client.buyData();
    expect(sawSignal).toBe(true);
  });
});

describe("relayer checksum handling", () => {
  test("the configured relayer is matched case-insensitively (checksummed compare)", async () => {
    httpImpl = {
      getPaymentRequiredResponse: () => ({}),
      createPaymentPayload: () => ({}),
      encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "sig" }),
      getPaymentSettleResponse: () => ({ transaction: TXHASH }),
    };
    stubFetch([json402(), ok200({ price: 1 })]);
    // Return the checksummed relayer; verifyRelayer normalizes both sides.
    const client = new X402Client(
      pubWith(async () => ({ from: getAddress(X402_RELAYER) })),
      enabledConfig(),
      silentLog,
    );
    expect((await client.buyData()).relayerVerified).toBe(true);
  });
});
