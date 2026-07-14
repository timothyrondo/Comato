/**
 * Integration test — the full Track-2 paid-heartbeat flow, client <-> server, OFFLINE.
 *
 * Wires the REAL pieces and mocks only the two things that would otherwise touch the
 * network:
 *   1. the facilitator — a fake `FacilitatorClient` injected into the real resource
 *      server (`buildResourceServer` via `createApp`). Its `verify` returns valid and
 *      `settle` returns a deterministic fake tx hash. No HTTP, no credits, no keys.
 *   2. the on-chain relayer read — `getSender` is stubbed per case so `onAfterSettle`
 *      can classify ok vs mismatch without a Celo RPC.
 *
 * The payer is a REAL `@x402/*` client (viem Anvil dev account) that signs a genuine
 * EIP-3009 authorization — the same client family `heartbeat-client.ts` runs. The app
 * is served in-process via `app.fetch(Request)` (no port, no sockets). Every assumption
 * is documented inline.
 *
 * ASSUMPTION: the mock facilitator's `verify` short-circuits signature verification
 * (returns `{ isValid: true }`). This is deliberate — verifying a real EIP-3009
 * signature would require the facilitator's on-chain simulation. We still exercise the
 * REAL 402 negotiation, the REAL client-side signing + header encode, the REAL server
 * middleware match/settle wiring, and the REAL relayer-assertion hook. Live signature
 * verification + on-chain settlement is covered by running against Celo's real
 * facilitator (see apps/server/CLAUDE.md).
 */

import { describe, expect, it } from "bun:test";
import { parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";
import type { AfterSettleObservation } from "../src/x402-server.ts";
import { CELO_NETWORK, USDC, X402_RELAYER } from "../src/constants.ts";

// Well-known Anvil dev key (public test vector). NOT a real key / never funded on mainnet.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ANVIL_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // account(ANVIL_KEY)
const COMATO_WALLET = "0x1111111111111111111111111111111111111111"; // the premium payee
const HEARTBEAT_URL = "http://localhost:4021/heartbeat";
const HEALTH_URL = "http://localhost:4021/health";
const FAKE_SETTLE_TX = "0x" + "ab".repeat(32);

const cfg: ServerConfig = {
  payTo: COMATO_WALLET,
  facilitatorUrl: "https://api.x402.celo.org",
  apiKey: "x402_test_integration_key",
  rpcUrl: "https://forno.celo.org",
  network: CELO_NETWORK,
  premiumUsdc: "0.001",
  premiumAtomic: "1000",
  port: 0,
  syncFacilitatorOnStart: true,
  assertRelayer: true,
};

/**
 * Deterministic fake facilitator. Records the `settle` args so the test can assert the
 * payee (COMATO_WALLET) and count. No network, no credits.
 */
function fakeFacilitator() {
  // `settle` params are contextually typed from FacilitatorClient; capture them loosely.
  const settles: { payload: unknown; requirements: unknown }[] = [];
  let verifyCalls = 0;
  const client: FacilitatorClient = {
    async getSupported() {
      // Advertise exactly the kind the app registers, so the middleware can build a 402.
      return { kinds: [{ x402Version: 2, scheme: "exact", network: CELO_NETWORK }], extensions: [], signers: {} };
    },
    async verify() {
      verifyCalls += 1;
      // Short-circuit signature verification (documented assumption above).
      return { isValid: true, payer: ANVIL_ADDR };
    },
    async settle(payload, requirements) {
      settles.push({ payload, requirements });
      return { success: true, transaction: FAKE_SETTLE_TX, network: CELO_NETWORK, payer: ANVIL_ADDR };
    },
  };
  return { client, settles, verifyCalls: () => verifyCalls };
}

/** A real `@x402/*` payer client bound to the Anvil dev account (offline EIP-3009 signer). */
function makePayer(maxValueAtomic = parseUnits("0.01", USDC.decimals)) {
  const account = privateKeyToAccount(ANVIL_KEY);
  const signer = toClientEvmSigner(account);
  const core = new x402Client()
    .register(CELO_NETWORK, new ExactEvmScheme(signer))
    .registerPolicy((_v, reqs) => reqs.filter((r) => BigInt(r.amount) <= maxValueAtomic));
  return { address: account.address, http: new x402HTTPClient(core) };
}

/**
 * Runs the real client <-> server handshake against the in-proc app:
 *   GET /heartbeat -> 402 -> sign EIP-3009 -> retry with PAYMENT-SIGNATURE -> 200.
 * Returns both the unpaid and paid responses so the test can assert each stage.
 */
async function payHeartbeat(app: ReturnType<typeof createApp>, http: x402HTTPClient) {
  const unpaid = await app.fetch(new Request(HEARTBEAT_URL, { method: "GET" }));
  let paid: Response | undefined;
  if (unpaid.status === 402) {
    const body = await unpaid.clone().json().catch(() => undefined);
    const required = http.getPaymentRequiredResponse((n) => unpaid.headers.get(n), body);
    const payload = await http.createPaymentPayload(required);
    paid = await app.fetch(
      new Request(HEARTBEAT_URL, { method: "GET", headers: { ...http.encodePaymentSignatureHeader(payload) } }),
    );
  }
  return { unpaid, paid };
}

describe("x402 Track-2 integration (real client <-> real app, mock facilitator, offline)", () => {
  it("negotiates the 402 with the correct price + payTo, then settles on the paid retry", async () => {
    const { client: facilitator, settles, verifyCalls } = fakeFacilitator();
    const observed: AfterSettleObservation[] = [];
    // getSender stubbed to the Celo relayer -> onAfterSettle classifies this as `ok`.
    const app = createApp(cfg, {
      facilitator,
      getSender: async () => X402_RELAYER,
      onObserved: (o) => observed.push(o),
    });
    const { http } = makePayer();

    const { unpaid, paid } = await payHeartbeat(app, http);

    // --- Stage 1: unpaid GET -> 402 advertising price + payTo ---
    expect(unpaid.status).toBe(402);
    const required = http.getPaymentRequiredResponse(
      (n) => unpaid.headers.get(n),
      await unpaid.clone().json().catch(() => undefined),
    );
    const accept = required.accepts[0] as unknown as { payTo: string; asset: string; amount: string; network: string };
    expect(accept.network).toBe(CELO_NETWORK);
    expect(accept.payTo.toLowerCase()).toBe(COMATO_WALLET.toLowerCase()); // premium payee
    expect(accept.asset.toLowerCase()).toBe(USDC.address.toLowerCase());
    expect(accept.amount).toBe("1000"); // 0.001 USDC atomic

    // --- Stage 2: paid retry -> 200 protection receipt ---
    expect(paid).toBeDefined();
    expect(paid!.status).toBe(200);
    const receipt = (await paid!.json()) as { ok: boolean; protection: string; payTo: string };
    expect(receipt.ok).toBe(true);
    expect(receipt.protection).toBe("active");
    expect(receipt.payTo.toLowerCase()).toBe(COMATO_WALLET.toLowerCase());

    // --- Stage 3: exactly one settlement happened, to the COMATO wallet ---
    expect(verifyCalls()).toBe(1);
    expect(settles).toHaveLength(1);
    expect((settles[0]!.requirements as { payTo: string }).payTo.toLowerCase()).toBe(COMATO_WALLET.toLowerCase());

    // --- Stage 4: the payment-response header carries the settlement tx hash ---
    const settle = http.getPaymentSettleResponse((n) => paid!.headers.get(n));
    expect(settle.transaction).toBe(FAKE_SETTLE_TX);
    expect(settle.success).toBe(true);

    // --- Stage 5: onAfterSettle classified the Celo relayer as ok (counts for Track 2) ---
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({ tx: FAKE_SETTLE_TX, sender: X402_RELAYER, verdict: "ok" });
  });

  it("classifies a settlement from the WRONG relayer as mismatch (would not count)", async () => {
    const { client: facilitator, settles } = fakeFacilitator();
    const observed: AfterSettleObservation[] = [];
    // Same full flow, but the on-chain read returns a non-relayer sender.
    const app = createApp(cfg, {
      facilitator,
      getSender: async () => "0x00000000000000000000000000000000deadbeef",
      onObserved: (o) => observed.push(o),
    });
    const { http } = makePayer();

    const { paid } = await payHeartbeat(app, http);

    expect(paid!.status).toBe(200); // settlement still succeeds on-chain...
    expect(settles).toHaveLength(1);
    // ...but the relayer assertion flags it: this settlement would NOT count for Track 2.
    expect(observed[0]!.verdict).toBe("mismatch");
  });

  it("leaves /health open (never gated by payment)", async () => {
    const { client: facilitator } = fakeFacilitator();
    const app = createApp(cfg, { facilitator });
    const res = await app.fetch(new Request(HEALTH_URL, { method: "GET" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("comato-heartbeat");
  });
});
