/**
 * tx.ts tests — the ONLY write path. Covers the real broadcast branch (mocked
 * wallet + public clients, no network): tagged send + receipt, the onBroadcast
 * hook (fired with hash, throwing hook swallowed), the ERC-8021 marker invariant,
 * ensureApproval (skip/early-return/real approve), and read helpers with/without
 * a sender. Fully offline.
 */

import { describe, expect, test } from "bun:test";
import { parseUnits } from "viem";
import type { Address, Hex } from "viem";
import { MAINNET } from "@comato/shared/addresses";
import { TxSender } from "../src/tx.ts";
import { aavePoolAbi } from "../src/abis.ts";
import { endsWithMarker, decodeTag } from "../src/tagger.ts";
import type { Chain } from "../src/chain.ts";
import { makeConfig, silentLog, EOA } from "./_helpers.ts";

const POOL = MAINNET.aaveV3.pool as Address;
const USDC = MAINNET.tokens.USDC as Address;

/** A wallet+public chain whose reads/writes are fully controllable. */
function makeChain() {
  const state = {
    sent: undefined as undefined | { to: Address; data: Hex; value: bigint },
    receiptStatus: "success" as "success" | "reverted",
    allowance: 0n,
    balance: 0n,
    sendCount: 0,
  };
  const walletClient = {
    chain: { id: 42220 },
    sendTransaction: async (args: { to: Address; data: Hex; value: bigint }) => {
      state.sendCount++;
      state.sent = { to: args.to, data: args.data, value: args.value };
      return "0xhash" as Hex;
    },
  };
  const publicClient = {
    waitForTransactionReceipt: async () => ({ status: state.receiptStatus, gasUsed: 21_000n }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return state.allowance;
      if (functionName === "balanceOf") return state.balance;
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  const chain: Chain = {
    publicClient: publicClient as never,
    walletClient: walletClient as never,
    account: { address: EOA } as never,
  };
  return { chain, state };
}

const repayArgs = () => ({
  to: POOL,
  abi: aavePoolAbi,
  functionName: "repay",
  args: [USDC, 1_000_000n, 2n, EOA] as const,
  label: "test.repay",
});

describe("tx.sendTagged (real broadcast)", () => {
  test("broadcasts a tagged tx and returns hash + confirmed status", async () => {
    const { chain, state } = makeChain();
    const tx = new TxSender(chain, makeConfig({ dryRun: false }), silentLog);
    const res = await tx.sendTagged(repayArgs());

    expect(res.dryRun).toBe(false);
    expect(res.hash).toBe("0xhash");
    expect(res.status).toBe("success");
    expect(endsWithMarker(res.taggedData)).toBe(true);
    expect(decodeTag(res.taggedData)!.codes).toEqual(["timo_comato"]);
    expect(state.sent!.to).toBe(POOL);
    expect(state.sent!.value).toBe(0n);
    expect(state.sent!.data).toBe(res.taggedData);
  });

  test("fires onBroadcast with the hash before awaiting the receipt", async () => {
    const { chain } = makeChain();
    const tx = new TxSender(chain, makeConfig({ dryRun: false }), silentLog);
    let seen: Hex | undefined;
    const res = await tx.sendTagged({ ...repayArgs(), onBroadcast: (h) => (seen = h) });
    expect(seen).toBe("0xhash");
    expect(res.status).toBe("success");
  });

  test("swallows a throwing onBroadcast hook (never aborts a sent tx)", async () => {
    const { chain } = makeChain();
    const tx = new TxSender(chain, makeConfig({ dryRun: false }), silentLog);
    const res = await tx.sendTagged({
      ...repayArgs(),
      onBroadcast: () => {
        throw new Error("hook boom");
      },
    });
    expect(res.status).toBe("success"); // hook error logged + swallowed
    expect(res.hash).toBe("0xhash");
  });

  test("surfaces a reverted receipt status", async () => {
    const { chain, state } = makeChain();
    state.receiptStatus = "reverted";
    const tx = new TxSender(chain, makeConfig({ dryRun: false }), silentLog);
    const res = await tx.sendTagged(repayArgs());
    expect(res.status).toBe("reverted");
  });

  test("throws when the built calldata is missing the ERC-8021 marker", async () => {
    const { chain } = makeChain();
    const tx = new TxSender(chain, makeConfig({ dryRun: false }), silentLog);
    // Force an untagged payload to trip the counted-tx invariant.
    (tx as unknown as { buildTaggedData: () => Hex }).buildTaggedData = () => "0xdeadbeef";
    await expect(tx.sendTagged(repayArgs())).rejects.toThrow(/marker/);
  });

  test("dry-run does not broadcast", async () => {
    const { chain, state } = makeChain();
    const tx = new TxSender(chain, makeConfig({ dryRun: true }), silentLog);
    const res = await tx.sendTagged(repayArgs());
    expect(res.dryRun).toBe(true);
    expect(res.hash).toBeUndefined();
    expect(state.sendCount).toBe(0);
  });
});

describe("tx.ensureApproval", () => {
  test("no-op when amount <= 0", async () => {
    const { chain, state } = makeChain();
    const tx = new TxSender(chain, makeConfig({ dryRun: false }), silentLog);
    await tx.ensureApproval(USDC, POOL, 0n, "x");
    expect(state.sendCount).toBe(0);
  });

  test("no-op when the existing allowance already covers amount", async () => {
    const { chain, state } = makeChain();
    state.allowance = parseUnits("100", 6);
    const tx = new TxSender(chain, makeConfig({ dryRun: false }), silentLog);
    await tx.ensureApproval(USDC, POOL, parseUnits("10", 6), "x");
    expect(state.sendCount).toBe(0);
  });

  test("broadcasts an exact-amount approve when the allowance is short", async () => {
    const { chain, state } = makeChain();
    state.allowance = 0n;
    const tx = new TxSender(chain, makeConfig({ dryRun: false }), silentLog);
    await tx.ensureApproval(USDC, POOL, parseUnits("10", 6), "rescue");
    expect(state.sendCount).toBe(1);
    expect(state.sent!.to).toBe(USDC); // approve is sent to the token
    expect(endsWithMarker(state.sent!.data)).toBe(true);
  });
});

describe("tx read helpers", () => {
  test("with a sender: reads allowance and balance", async () => {
    const { chain, state } = makeChain();
    state.allowance = 123n;
    state.balance = 456n;
    const tx = new TxSender(chain, makeConfig(), silentLog);
    expect(tx.canSend).toBe(true);
    expect(tx.senderAddress).toBe(EOA);
    expect(await tx.allowanceOf(USDC, POOL)).toBe(123n);
    expect(await tx.balanceOf(USDC)).toBe(456n);
    expect(await tx.balanceOf(USDC, EOA)).toBe(456n);
  });

  test("read-only (no account): canSend false, reads short-circuit to 0", async () => {
    const publicClient = {
      readContract: async () => {
        throw new Error("should not read without a sender");
      },
    };
    const tx = new TxSender(
      { publicClient: publicClient as never },
      makeConfig(),
      silentLog,
    );
    expect(tx.canSend).toBe(false);
    expect(tx.senderAddress).toBeUndefined();
    expect(await tx.allowanceOf(USDC, POOL)).toBe(0n);
    expect(await tx.balanceOf(USDC)).toBe(0n);
  });
});
