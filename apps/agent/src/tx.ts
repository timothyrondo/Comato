/**
 * Tagged EOA-direct transaction sender. This is the ONLY path the agent uses to
 * send value-moving txs, so the ERC-8021 tag (C1) is appended uniformly.
 *
 * Flow per tx:
 *   1. encodeFunctionData(abi, fn, args)              -> raw calldata
 *   2. tagCalldata(calldata, ATTRIBUTION_CODE)        -> calldata ++ 8021 suffix
 *   3. walletClient.sendTransaction({ to, data })     -> EOA-direct (from = tx_from)
 *   4. waitForTransactionReceipt                      -> confirmation
 *
 * Trailing suffix bytes are ignored by Solidity calldata decoding (Aave `repay`,
 * Uniswap `exactInputSingle`), so the call executes normally while the marker
 * rides along for attribution.
 *
 * DRY_RUN: builds and logs the exact tagged calldata but does NOT broadcast.
 */

import {
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain as ViemChain,
} from "viem";
import type { Chain } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import { tagCalldata, endsWithMarker } from "./tagger.ts";
import { erc20Abi } from "./abis.ts";
import { withRetry } from "./retry.ts";

export interface SendResult {
  dryRun: boolean;
  /** The full tagged calldata that was (or would be) sent. */
  taggedData: Hex;
  hash?: Hex;
  status?: "success" | "reverted";
}

export interface SendTaggedArgs {
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  /** Human label for logs (e.g. "rescue.repay", "treasury.swap"). */
  label: string;
  /**
   * Fired the moment the tx is BROADCAST (hash returned), BEFORE we await the
   * receipt. Callers that must not repeat a broadcast action even if the receipt
   * read later fails (e.g. the rescue rate limiter — O1) record their state here.
   * Never fires in DRY_RUN (nothing is broadcast). A throw from the hook is logged
   * and swallowed so it can never abort an already-sent tx.
   */
  onBroadcast?: (hash: Hex) => void;
}

export class TxSender {
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly account?: Account;

  constructor(
    chain: Chain,
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.publicClient = chain.publicClient;
    this.walletClient = chain.walletClient;
    this.account = chain.account;
  }

  get canSend(): boolean {
    return Boolean(this.walletClient && this.account);
  }

  get senderAddress(): Address | undefined {
    return this.account?.address;
  }

  /** Encode + tag calldata for `args`, returning the exact bytes to be sent. */
  buildTaggedData(abi: Abi, functionName: string, args: readonly unknown[]): Hex {
    const raw = encodeFunctionData({ abi, functionName, args });
    return tagCalldata(raw, this.config.attributionCode);
  }

  /**
   * Send a tagged EOA-direct tx. Honors DRY_RUN. Returns the tagged calldata and
   * (when broadcast) the tx hash + status.
   */
  async sendTagged(a: SendTaggedArgs): Promise<SendResult> {
    const taggedData = this.buildTaggedData(a.abi, a.functionName, a.args);

    // Invariant: a counted tx MUST end with the marker, or Track 1 ignores it.
    if (!endsWithMarker(taggedData)) {
      throw new Error(`${a.label}: tagged calldata does not end with the ERC-8021 marker`);
    }

    if (this.config.dryRun || !this.canSend) {
      this.log.info("dry-run: tx not broadcast", {
        event: "tx.dryrun",
        label: a.label,
        to: a.to,
        from: this.senderAddress,
        value: a.value ?? 0n,
        taggedDataTail: taggedData.slice(-42), // len+schema+marker
      });
      return { dryRun: true, taggedData };
    }

    const walletClient = this.walletClient!;
    const account = this.account!;

    // NEVER retry the broadcast itself (retries: 0). A `sendTransaction` that
    // throws after the node already accepted the tx (e.g. an HTTP timeout on the
    // response) is INDISTINGUISHABLE from one that never left — and with the nonce
    // manager attached a retry consumes a FRESH nonce, so a retried send that the
    // node did receive becomes a genuine double-broadcast (two repays / two swaps).
    // One shot only: on failure we surface the error and let the next monitor cycle
    // re-decide on a FRESH health-factor read (O2) — a repay that actually landed
    // moves HF and is not re-attempted; one that didn't is retried cleanly.
    const hash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain as ViemChain,
      to: a.to,
      data: taggedData,
      value: a.value ?? 0n,
    });

    this.log.info("tx broadcast", { event: "tx.sent", label: a.label, to: a.to, hash });

    // O1: signal broadcast BEFORE awaiting the receipt. If the receipt read below
    // exhausts its retries and throws, the caller has already recorded its "this
    // action went out" state (e.g. the rate limiter) and will not re-broadcast a
    // tx that likely already mined. A throwing hook must never abort a sent tx.
    if (a.onBroadcast) {
      try {
        a.onBroadcast(hash);
      } catch (cbErr) {
        this.log.warn("onBroadcast hook threw (ignored)", {
          event: "tx.onbroadcast_error",
          label: a.label,
          hash,
          error: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
    }

    const receipt = await withRetry(
      () => this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }),
      { label: `${a.label}.receipt`, logger: this.log, retries: 3 },
    );

    this.log.info("tx confirmed", {
      event: "tx.confirmed",
      label: a.label,
      hash,
      status: receipt.status,
      gasUsed: receipt.gasUsed,
    });

    return { dryRun: false, taggedData, hash, status: receipt.status };
  }

  /** Read an ERC20 allowance for the COMATO_WALLET. */
  async allowanceOf(token: Address, spender: Address): Promise<bigint> {
    if (!this.senderAddress) return 0n;
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.senderAddress, spender],
    });
  }

  async balanceOf(token: Address, owner?: Address): Promise<bigint> {
    const who = owner ?? this.senderAddress;
    if (!who) return 0n;
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [who],
    });
  }

  /**
   * Ensure `spender` can pull at least `amount` of `token` from COMATO_WALLET.
   *
   * Least-privilege: we approve the EXACT `amount` needed, never a headroom
   * multiple. The spenders here are the Aave Pool (an upgradeable proxy) and the
   * Uniswap router; a standing over-allowance on the wallet that holds the whole
   * insurance float is drainable if a spender (or a proxy admin) is ever
   * compromised. `exactInputSingle`/`repay` consume the allowance in full, so it
   * returns to ~0 after each action and never accumulates. Approvals are tagged
   * (harmless; no transfer, so no C1 count).
   */
  async ensureApproval(token: Address, spender: Address, amount: bigint, label: string): Promise<void> {
    if (amount <= 0n) return;
    const current = await this.allowanceOf(token, spender);
    if (current >= amount) {
      this.log.debug("approval sufficient", { label, token, spender, current });
      return;
    }
    this.log.info("approving token", { event: "tx.approve", label, token, spender, amount });
    await this.sendTagged({
      to: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
      label: `${label}.approve`,
    });
  }
}
