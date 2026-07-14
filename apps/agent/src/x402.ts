/**
 * x402 client — the payer side of Track 2 (C2) plus free Track 1 (C3).
 *
 * The monitor buys price/risk data per poll with the official `@x402/*` SDK
 * (viem-based — the same stack the resource server uses), signing an EIP-3009
 * `transferWithAuthorization` from COMATO_WALLET. This is the exact client family
 * `x402.celo.org` runs; no third-party payment wrapper is involved.
 *
 * IMPORTANT nuance about the facilitator: the x402 client only SIGNS the payment;
 * it does not choose the facilitator. In x402 the facilitator is selected by the
 * RESOURCE SERVER (the data endpoint): the client signs, the server settles via
 * ITS configured facilitator. So for the payer-side count to register, the data
 * endpoint MUST be configured to settle through `https://api.x402.celo.org`
 * (relayer 0x0d74…FB48). In the Comato system that endpoint is Comato-operated
 * (see apps/server), so it is wired to the Celo facilitator.
 *
 * We still enforce C2 defensively: after each paid request we decode the
 * settlement tx hash from the `PAYMENT-RESPONSE` header and verify on-chain that
 * its `from` is the Celo relayer. A mismatch => it settled via the wrong
 * facilitator and WON'T count for Track 2; we log a loud warning.
 */

import { getAddress, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export interface DataResult {
  ok: boolean;
  status: number;
  data?: unknown;
  settlementTx?: `0x${string}`;
  relayerVerified?: boolean;
}

export class X402Client {
  private client?: x402HTTPClient;
  private enabled = false;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.init();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private init(): void {
    const x = this.config.x402;
    if (!x.enabled) {
      this.log.info("x402 client disabled", { event: "x402.disabled" });
      return;
    }
    if (!this.config.privateKey) {
      this.log.warn("x402 disabled: no COMATO_PRIVATE_KEY (payer key required)", { event: "x402.no_key" });
      return;
    }
    if (!x.dataUrl) {
      this.log.warn("x402 disabled: X402_DATA_URL not set", { event: "x402.no_url" });
      return;
    }

    const account = privateKeyToAccount(this.config.privateKey);
    const signer = toClientEvmSigner(account);
    // v2 CAIP-2 network id (e.g. eip155:42220) derived from the configured chain —
    // matches the network the resource server advertises in its 402.
    const network = `eip155:${this.config.chainId}` as `${string}:${string}`;
    const core = new x402Client()
      .register(network, new ExactEvmScheme(signer))
      // maxValue cap (safety): refuse any accepted requirement above the per-request
      // ceiling. If every option exceeds it, the selector has nothing and
      // createPaymentPayload throws -> buyData catches and declines to pay.
      .registerPolicy((_version, requirements) =>
        requirements.filter((r) => BigInt(r.amount) <= x.maxValue),
      );
    this.client = new x402HTTPClient(core);

    this.enabled = true;
    this.log.info("x402 client ready", {
      event: "x402.ready",
      dataUrl: x.dataUrl,
      maxValue: x.maxValue,
      payer: account.address,
      facilitatorUrl: x.facilitatorUrl,
      note: "facilitator is server-side; settlements verified against Celo relayer",
    });
  }

  /**
   * Buy one unit of price/risk data (pays via x402 if the endpoint returns 402).
   * Returns the data and whether the settlement was relayed by the Celo relayer.
   */
  async buyData(url?: string): Promise<DataResult> {
    const target = url ?? this.config.x402.dataUrl;
    const client = this.client;
    if (!this.enabled || !client || !target) {
      return { ok: false, status: 0 };
    }

    // Bound the whole paid request (initial 402 + retry) with a hard timeout so a
    // hostile/hung data endpoint cannot stall the (non-overlapping) monitor->rescue
    // loop or block graceful shutdown. The same signal covers both fetches.
    const signal = AbortSignal.timeout(this.config.x402.requestTimeoutMs);
    const init: RequestInit = { signal };

    let res = await fetch(target, init);

    if (res.status === 402) {
      let body: unknown;
      try {
        body = await res.clone().json();
      } catch {
        body = undefined;
      }
      const required = client.getPaymentRequiredResponse((n) => res.headers.get(n), body);
      try {
        const payload = await client.createPaymentPayload(required);
        res = await fetch(target, {
          ...init,
          headers: { ...client.encodePaymentSignatureHeader(payload) },
        });
      } catch (err) {
        // No affordable/supported requirement (e.g. price above X402_MAX_VALUE) —
        // decline to pay rather than sign an over-cap or unsupported authorization.
        this.log.warn("x402 payment declined (over max value or unsupported requirement)", {
          event: "x402.declined",
          url: target,
          maxValue: this.config.x402.maxValue,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, status: 402 };
      }
    }

    const settlementTx = this.parseSettlementTx(client, res);
    let relayerVerified: boolean | undefined;
    if (settlementTx) relayerVerified = await this.verifyRelayer(settlementTx);

    let data: unknown;
    try {
      data = await res.clone().json();
    } catch {
      data = await res.text().catch(() => undefined);
    }

    this.log.info("x402 data purchased", {
      event: "x402.paid",
      url: target,
      status: res.status,
      settlementTx,
      relayerVerified,
    });

    return { ok: res.ok, status: res.status, data, settlementTx, relayerVerified };
  }

  /** Decode the settlement tx hash from the x402 PAYMENT-RESPONSE header, if present. */
  private parseSettlementTx(client: x402HTTPClient, res: Response): `0x${string}` | undefined {
    try {
      const settle = client.getPaymentSettleResponse((n) => res.headers.get(n));
      const tx = settle.transaction;
      return tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx as `0x${string}`) : undefined;
    } catch {
      return undefined;
    }
  }

  /** C2 guard: confirm the settlement tx was submitted by the Celo relayer. */
  private async verifyRelayer(txHash: `0x${string}`): Promise<boolean> {
    try {
      const tx = await this.publicClient.getTransaction({ hash: txHash });
      const from = getAddress(tx.from) as Address;
      const relayer = getAddress(this.config.x402.relayer);
      const match = from === relayer;
      if (!match) {
        this.log.warn("x402 settlement NOT via Celo relayer — will NOT count for Track 2", {
          event: "x402.wrong_relayer",
          settlementFrom: from,
          expectedRelayer: relayer,
          txHash,
        });
      }
      return match;
    } catch (err) {
      this.log.warn("could not verify settlement relayer", {
        event: "x402.verify_error",
        txHash,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
