/**
 * Tests for the x402 heartbeat server.
 *
 * The facilitator is mocked (no network, no funded wallet needed) so we can exercise
 * both the unpaid 402 path and the paid 200 + settlement path deterministically.
 * Live on-chain settlement additionally requires a funded relayer/subscriber and is
 * covered by running the real client against the real Celo facilitator (see CLAUDE.md).
 */

import { describe, expect, it } from "bun:test";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.ts";
import { classifyRelayer, readSenderWithRetry } from "../src/x402-server.ts";
import type { AfterSettleObservation } from "../src/x402-server.ts";
import type { ServerConfig } from "../src/config.ts";
import { CELO_NETWORK, USDC, X402_RELAYER } from "../src/constants.ts";

const PAYER = "0x2222222222222222222222222222222222222222";

const baseConfig: ServerConfig = {
  payTo: "0x1111111111111111111111111111111111111111",
  facilitatorUrl: "https://x402.celo.org",
  rpcUrl: "https://forno.celo.org",
  network: CELO_NETWORK,
  premiumUsdc: "0.001",
  premiumAtomic: "1000",
  port: 0,
  syncFacilitatorOnStart: true,
  assertRelayer: true,
};

/** Facilitator stub: advertises the Celo exact kind, always verifies, always settles. */
function mockFacilitator(settleTx = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef") {
  let settleCalls = 0;
  const client: FacilitatorClient = {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: CELO_NETWORK }],
        extensions: [],
        signers: {},
      };
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

interface Accept {
  scheme: string;
  network: string;
  payTo: string;
  asset: string;
  amount: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** Reads payment requirements from the x402 402 response (they live in the header). */
function readAccepts(res: Response): Accept[] {
  const header = res.headers.get("payment-required");
  if (!header) throw new Error("no payment-required header on 402");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts: Accept[] };
  return decoded.accepts;
}

/** Builds a base64 X-PAYMENT payload whose `accepted` exactly matches the 402 accepts. */
function encodePaymentHeader(accepted: unknown): string {
  const payload = {
    x402Version: 2,
    accepted,
    payload: {
      signature: `0x${"00".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: (accepted as { payTo: string }).payTo,
        value: (accepted as { amount: string }).amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: `0x${"11".repeat(32)}`,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("GET /heartbeat", () => {
  it("returns 402 with Celo payment requirements when unpaid", async () => {
    const { client } = mockFacilitator();
    const app = createApp(baseConfig, { facilitator: client, getSender: async () => X402_RELAYER });

    const res = await app.request("/heartbeat");
    expect(res.status).toBe(402);

    const accepts = readAccepts(res);
    expect(Array.isArray(accepts)).toBe(true);
    const accepted = accepts[0]!;
    expect(accepted.scheme).toBe("exact");
    expect(accepted.network).toBe(CELO_NETWORK);
    expect(accepted.payTo.toLowerCase()).toBe(baseConfig.payTo.toLowerCase());
    expect(accepted.asset.toLowerCase()).toBe(USDC.address.toLowerCase());
    expect(accepted.amount).toBe("1000");
    // Celo-specific EIP-712 domain (Celo isn't in the SDK default table).
    expect(accepted.extra).toEqual({ name: USDC.name, version: USDC.version });
  });

  it("returns 200 and settles once when a valid payment is supplied", async () => {
    const { client, settleCalls } = mockFacilitator();
    const observed: AfterSettleObservation[] = [];
    const app = createApp(baseConfig, {
      facilitator: client,
      getSender: async () => X402_RELAYER,
      onObserved: (o) => observed.push(o),
    });

    // First learn the exact requirement from the 402, then pay for it.
    const res402 = await app.request("/heartbeat");
    const accepted = readAccepts(res402)[0]!;

    const res = await app.request("/heartbeat", {
      headers: { "PAYMENT-SIGNATURE": encodePaymentHeader(accepted) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; protection: string };
    expect(body.ok).toBe(true);
    expect(body.protection).toBe("active");
    expect(settleCalls()).toBe(1);

    // onAfterSettle ran and confirmed the Celo relayer settled it.
    expect(observed).toHaveLength(1);
    expect(observed[0]!.verdict).toBe("ok");
  });

  it("flags a settlement made by the wrong relayer (would not count for Track 2)", async () => {
    const { client } = mockFacilitator();
    const observed: AfterSettleObservation[] = [];
    const app = createApp(baseConfig, {
      facilitator: client,
      getSender: async () => "0x00000000000000000000000000000000deadbeef", // not the Celo relayer
      onObserved: (o) => observed.push(o),
    });

    const res402 = await app.request("/heartbeat");
    const accepted = readAccepts(res402)[0]!;
    await app.request("/heartbeat", { headers: { "PAYMENT-SIGNATURE": encodePaymentHeader(accepted) } });

    expect(observed[0]!.verdict).toBe("mismatch");
  });

  it("leaves the ungated /health route open", async () => {
    const { client } = mockFacilitator();
    const app = createApp(baseConfig, { facilitator: client });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

describe("classifyRelayer", () => {
  it("accepts the Celo relayer (case-insensitive)", () => {
    expect(classifyRelayer(X402_RELAYER.toUpperCase(), true)).toBe("ok");
  });
  it("rejects any other sender", () => {
    expect(classifyRelayer("0x00000000000000000000000000000000deadbeef", true)).toBe("mismatch");
  });
  it("reports unverified when the sender is unknown", () => {
    expect(classifyRelayer(null, true)).toBe("unverified");
  });
  it("skips when assertion is disabled", () => {
    expect(classifyRelayer(null, false)).toBe("skipped");
  });
});

describe("readSenderWithRetry (O6 — brief retry, never throws)", () => {
  it("returns the sender once it becomes readable (no spurious unverified)", async () => {
    let calls = 0;
    const sender = await readSenderWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("tx not found yet"); // not mined/propagated on first tries
        return X402_RELAYER;
      },
      { retries: 5, delayMs: 0 },
    );
    expect(sender).toBe(X402_RELAYER);
    expect(calls).toBe(3);
  });

  it("returns null (does not throw) when the read never resolves", async () => {
    const sender = await readSenderWithRetry(
      async () => {
        throw new Error("rpc down");
      },
      { retries: 2, delayMs: 0 },
    );
    expect(sender).toBeNull();
  });
});
