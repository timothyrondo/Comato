/**
 * Treasury tests — the Track 1 volume engine. Covers swap sizing
 * (rescale/amountOutMin), round-trip cycle construction, balance/reserve guards,
 * and a DRY_RUN swap that asserts the exactInputSingle calldata is tagged (C1).
 */

import { describe, expect, test } from "bun:test";
import { parseUnits, type Address, type PublicClient } from "viem";
import { rescaleAmount, computeAmountOutMin, assertStablePair, Treasury } from "../src/treasury.ts";
import { TxSender } from "../src/tx.ts";
import { decodeTag, endsWithMarker } from "../src/tagger.ts";
import type { Chain } from "../src/chain.ts";
import { makeConfig, silentLog, EOA } from "./_helpers.ts";

const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address;
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address;

describe("treasury.rescaleAmount", () => {
  test("identity when decimals match", () => {
    expect(rescaleAmount(parseUnits("1", 6), 6, 6)).toBe(parseUnits("1", 6));
  });
  test("scales up and down", () => {
    expect(rescaleAmount(1_000_000n, 6, 18)).toBe(1_000_000n * 10n ** 12n);
    expect(rescaleAmount(1_000_000n * 10n ** 12n, 18, 6)).toBe(1_000_000n);
  });
});

describe("treasury.computeAmountOutMin (slippage bound)", () => {
  test("applies slippage bps to a 1:1 same-decimal swap", () => {
    // 1 USDC in, 0.5% slippage -> 0.995 USDC min out
    expect(computeAmountOutMin(parseUnits("1", 6), 6, 6, 50)).toBe(995_000n);
  });
  test("0 slippage returns the rescaled expected out", () => {
    expect(computeAmountOutMin(parseUnits("1", 6), 6, 6, 0)).toBe(parseUnits("1", 6));
  });
  test("handles differing decimals", () => {
    // 1e6 (6dec) -> 18dec = 1e18, minus 0.5% = 0.995e18
    expect(computeAmountOutMin(parseUnits("1", 6), 6, 18, 50)).toBe((10n ** 18n * 9950n) / 10_000n);
  });
});

describe("treasury.assertStablePair (O7 1:1 guard)", () => {
  const CELO = "0x471EcE3750Da237f93B8E339c536989b8978a438" as Address;
  const t = (over: Partial<ReturnType<typeof makeConfig>["treasury"]> = {}) => ({
    ...makeConfig().treasury,
    ...over,
  });

  test("accepts the verified USDC/USDT stable pair (either direction)", () => {
    expect(() => assertStablePair(t())).not.toThrow();
    expect(() => assertStablePair(t({ tokenA: USDT, tokenB: USDC }))).not.toThrow();
  });

  test("rejects a non-stable pair (USDC/CELO) — the 1:1 footgun", () => {
    expect(() => assertStablePair(t({ tokenB: CELO }))).toThrow(/not a verified USD stable/);
  });

  test("rejects a same-token pair", () => {
    expect(() => assertStablePair(t({ tokenB: USDC }))).toThrow(/must differ/);
  });

  test("rejects non-6-decimal stables", () => {
    expect(() => assertStablePair(t({ decimalsB: 18 }))).toThrow(/decimals must be 6\/6/);
  });
});

describe("treasury.buildCycle", () => {
  test("round-trip builds two legs A->B then B->A", () => {
    const t = new Treasury({} as TxSender, makeConfig(), silentLog);
    const legs = t.buildCycle();
    expect(legs.length).toBe(2);
    expect(legs[0]!.tokenIn).toBe(USDC);
    expect(legs[0]!.tokenOut).toBe(USDT);
    expect(legs[1]!.tokenIn).toBe(USDT);
    expect(legs[1]!.tokenOut).toBe(USDC);
    expect(legs[0]!.amountIn).toBe(parseUnits("1", 6));
    expect(legs[1]!.amountIn).toBe(parseUnits("1", 6)); // 6/6 decimals
  });

  test("single leg when roundTrip disabled", () => {
    const t = new Treasury(
      {} as TxSender,
      makeConfig({ treasury: { ...makeConfig().treasury, roundTrip: false } }),
      silentLog,
    );
    expect(t.buildCycle().length).toBe(1);
  });
});

/** Mock publicClient with a fixed token balance + huge allowance. */
function mockPublic(balance: bigint): PublicClient {
  return {
    readContract: async ({ functionName }: any) => {
      if (functionName === "allowance") return 2n ** 255n;
      if (functionName === "balanceOf") return balance;
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

function makeTreasury(balance: bigint, cfgOverrides = {}) {
  const config = makeConfig(cfgOverrides);
  const chain: Chain = {
    publicClient: mockPublic(balance),
    walletClient: {} as any,
    account: { address: EOA } as any,
  };
  const tx = new TxSender(chain, config, silentLog);
  return new Treasury(tx, config, silentLog);
}

describe("treasury.runLeg guards", () => {
  const legA = () => new Treasury({} as TxSender, makeConfig(), silentLog).buildCycle()[0]!;

  test("skips when balance < amountIn", async () => {
    const t = makeTreasury(parseUnits("0.5", 6)); // less than 1 USDC swap
    const out = await t.runLeg(legA());
    expect(out.status).toBe("skipped_low_balance");
  });

  test("skips when the swap would breach min reserve", async () => {
    const t = makeTreasury(parseUnits("1.5", 6), {
      treasury: { ...makeConfig().treasury, minReserve: parseUnits("1", 6) },
    });
    // balance 1.5 - amountIn 1.0 = 0.5 < minReserve 1.0 -> skip
    const out = await t.runLeg(legA());
    expect(out.status).toBe("skipped_reserve");
  });

  test("executes a tagged swap in dry-run when balances allow", async () => {
    const t = makeTreasury(parseUnits("100", 6));
    const out = await t.runLeg(legA());
    expect(out.status).toBe("swapped");
    expect(out.amountOutMin).toBe(995_000n); // 1 USDC - 0.5%
    expect(out.result?.dryRun).toBe(true);
    expect(endsWithMarker(out.result!.taggedData)).toBe(true);
    expect(decodeTag(out.result!.taggedData)!.codes).toEqual(["timo_comato"]);
  });
});

describe("treasury.runCycle round-trip sizing (one-way drain guard)", () => {
  test("return leg swaps the ACTUAL tokenB balance, not a fixed 1:1 rescale", async () => {
    const config = makeConfig({ dryRun: false });
    const legBAmounts: bigint[] = [];
    const tx = {
      canSend: true,
      senderAddress: EOA,
      ensureApproval: async () => {},
      // tokenA (USDC) rich; tokenB (USDT) only 0.9 — leg A returned less than 1:1
      // after spread+fee, so a fixed 1.0 return leg would skip_low_balance forever.
      balanceOf: async (token: Address) =>
        token.toLowerCase() === USDT.toLowerCase() ? parseUnits("0.9", 6) : parseUnits("100", 6),
      sendTagged: async (a: any) => {
        if (a.label === "treasury.swap.BtoA") legBAmounts.push(a.args[0].amountIn);
        return { dryRun: false, taggedData: "0x", hash: "0xhash", status: "success" };
      },
    } as unknown as TxSender;

    const outcomes = await new Treasury(tx, config, silentLog).runCycle();
    expect(outcomes[0]!.status).toBe("swapped"); // leg A
    expect(outcomes[1]!.status).toBe("swapped"); // leg B ran instead of skipping
    // It swapped the available 0.9 USDT, NOT the fixed 1.0 → no one-way drain.
    expect(legBAmounts[0]).toBe(parseUnits("0.9", 6));
  });

  test("a reverted swap is reported failed, not swapped", async () => {
    const config = makeConfig({ dryRun: false });
    const tx = {
      canSend: true,
      senderAddress: EOA,
      ensureApproval: async () => {},
      balanceOf: async () => parseUnits("100", 6),
      sendTagged: async () => ({ dryRun: false, taggedData: "0x", hash: "0xhash", status: "reverted" }),
    } as unknown as TxSender;

    const out = await new Treasury(tx, config, silentLog).runLeg(
      new Treasury({} as TxSender, config, silentLog).buildCycle()[0]!,
    );
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("reverted");
  });
});
