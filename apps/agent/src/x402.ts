/**
 * x402 client — the payer side of Track 2 (C2) plus free Track 1 (C3).
 *
 * The monitor buys price/risk data per poll with `thirdweb/x402`
 * `wrapFetchWithPayment`, signing an EIP-3009 authorization from COMATO_WALLET.
 *
 * IMPORTANT nuance about the facilitator (verified against thirdweb v5 source):
 *   `wrapFetchWithPayment(fetch, client, wallet, opts)` has NO client-side
 *   facilitator parameter. In x402 the facilitator is chosen by the RESOURCE
 *   SERVER (the data endpoint): the client signs, the server settles via ITS
 *   configured facilitator. So for the payer-side count to register, the data
 *   endpoint MUST be configured to settle through `https://x402.celo.org`
 *   (relayer 0x0d74…FB48). In the Comato system that endpoint is Comato-operated
 *   (see apps/server), so it is wired to the Celo facilitator.
 *
 * We still enforce C2 defensively: after each paid request we decode the
 * settlement tx hash from the `X-PAYMENT-RESPONSE` header and verify on-chain
 * that its `from` is the Celo relayer. A mismatch => it settled via the wrong
 * facilitator and WON'T count for Track 2; we log a loud warning.
 */

import { getAddress, type Address, type PublicClient } from "viem";
import { createThirdwebClient, defineChain, type ThirdwebClient } from "thirdweb";
import { privateKeyToAccount, createWalletAdapter } from "thirdweb/wallets";
import { wrapFetchWithPayment } from "thirdweb/x402";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

const PAYMENT_RESPONSE_HEADER = "x-payment-response";

export interface DataResult {
  ok: boolean;
  status: number;
  data?: unknown;
  settlementTx?: `0x${string}`;
  relayerVerified?: boolean;
}

export class X402Client {
  private fetchWithPay?: typeof globalThis.fetch;
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
    if (!x.thirdwebClientId && !x.thirdwebSecretKey) {
      this.log.warn("x402 disabled: THIRDWEB_CLIENT_ID/SECRET_KEY not set", { event: "x402.no_thirdweb" });
      return;
    }

    const client: ThirdwebClient = createThirdwebClient(
      x.thirdwebSecretKey ? { secretKey: x.thirdwebSecretKey } : { clientId: x.thirdwebClientId! },
    );
    const chain = defineChain({ id: this.config.chainId, rpc: this.config.rpcUrl });
    const account = privateKeyToAccount({ client, privateKey: this.config.privateKey });

    const wallet = createWalletAdapter({
      client,
      adaptedAccount: account,
      chain,
      onDisconnect: () => {},
      switchChain: () => {
        // Single-chain agent; a switch request means the data endpoint priced on
        // another chain — refuse rather than silently pay elsewhere.
        throw new Error("x402: chain switch not supported (Celo only)");
      },
    });

    this.fetchWithPay = wrapFetchWithPayment(globalThis.fetch, client, wallet, {
      maxValue: x.maxValue,
    }) as unknown as typeof globalThis.fetch;

    this.enabled = true;
    this.log.info("x402 client ready", {
      event: "x402.ready",
      dataUrl: x.dataUrl,
      maxValue: x.maxValue,
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
    if (!this.enabled || !this.fetchWithPay || !target) {
      return { ok: false, status: 0 };
    }
    // Bound the whole paid request (initial 402 + retry) with a hard timeout so a
    // hostile/hung data endpoint cannot stall the (non-overlapping) monitor->rescue
    // loop or block graceful shutdown. wrapFetchWithPayment forwards `init` — incl.
    // `signal` — to both the initial and the payment-retry fetch (verified against
    // thirdweb v5 source), so one signal covers the entire exchange.
    const res = await this.fetchWithPay(target, {
      signal: AbortSignal.timeout(this.config.x402.requestTimeoutMs),
    });
    const settlementTx = this.parseSettlementTx(res);
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

  /** Decode the settlement tx hash from the base64 X-PAYMENT-RESPONSE header. */
  private parseSettlementTx(res: Response): `0x${string}` | undefined {
    const header = res.headers.get(PAYMENT_RESPONSE_HEADER);
    if (!header) return undefined;
    try {
      const json = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        transaction?: string;
        txHash?: string;
      };
      const tx = json.transaction ?? json.txHash;
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
