/**
 * Deliberation (decision layer) tests — the economic judgment that turns a breach
 * trigger into a choice. Covers urgency classification, the realized swap-loss
 * rate, and the act/defer verdict across the imminent + deliberate bands.
 */

import { describe, expect, test } from "bun:test";
import { classifyUrgency, deliberate, swapLossBps, type DeliberationInput } from "../src/deliberate.ts";
import { parseUnits } from "viem";

const wad = (n: string) => parseUnits(n, 18);
const usd = (n: string) => parseUnits(n, 8);

describe("classifyUrgency", () => {
  test("imminent at/below the critical line, deliberate above it", () => {
    expect(classifyUrgency(wad("1.04"), wad("1.05"))).toBe("imminent");
    expect(classifyUrgency(wad("1.05"), wad("1.05"))).toBe("imminent"); // inclusive
    expect(classifyUrgency(wad("1.06"), wad("1.05"))).toBe("deliberate");
  });
});

describe("swapLossBps", () => {
  test("loss = fraction of collateral value not recovered in the swap output", () => {
    // Withdrew $100 of collateral, swap yielded $99 of repayment -> 100 bps lost.
    expect(swapLossBps(usd("100"), usd("99"))).toBe(100);
    // $100 -> $95 = 500 bps.
    expect(swapLossBps(usd("100"), usd("95"))).toBe(500);
  });

  test("clamps to zero when the quote yields >= the collateral value", () => {
    expect(swapLossBps(usd("100"), usd("100"))).toBe(0);
    expect(swapLossBps(usd("100"), usd("101"))).toBe(0); // never negative cost
  });

  test("zero collateral value -> zero (no division)", () => {
    expect(swapLossBps(0n, usd("50"))).toBe(0);
  });
});

/** A deliberate-band input (HF above critical) with tunable economics. */
function input(over: Partial<DeliberationInput> = {}): DeliberationInput {
  return {
    hf: wad("1.15"),
    criticalHf: wad("1.05"),
    collateralInUsd: usd("100"),
    debtOutUsd: usd("99.7"), // ~30 bps swap loss (a liquid pool)
    liquidationBonusBps: 10750, // 7.5% penalty
    feeBps: 0,
    costGateK: 1.25,
    ...over,
  };
}

describe("deliberate — imminent band", () => {
  test("acts regardless of cost when liquidation is imminent", () => {
    // A brutal cost (50% fee) and a small penalty still act — the alternative is
    // a near-certain liquidation.
    const d = deliberate(input({ hf: wad("1.02"), feeBps: 5000, liquidationBonusBps: 10500 }));
    expect(d.urgency).toBe("imminent");
    expect(d.act).toBe(true);
    expect(d.rationale).toContain("imminent");
  });

  test("reports the penalty and total cost in bps", () => {
    const d = deliberate(input({ hf: wad("1.00"), feeBps: 200, liquidationBonusBps: 10750 }));
    expect(d.penaltyBps).toBe(750);
    expect(d.swapLossBps).toBe(30); // 100 -> 99.7
    expect(d.costBps).toBe(230); // 30 swap + 200 fee
  });
});

describe("deliberate — deliberate band", () => {
  test("acts when the penalty is comfortably above the rescue cost", () => {
    // 7.5% penalty (750 bps) vs ~30 bps cost -> clearly worth it.
    const d = deliberate(input());
    expect(d.urgency).toBe("deliberate");
    expect(d.act).toBe(true);
    expect(d.rationale).toContain("worth it");
  });

  test("defers when the service fee makes the rescue rival the penalty", () => {
    // 5% penalty (500 bps) vs a 5% fee (+ swap) -> costBps ~530 >= 500/1.25 fails -> defer.
    const d = deliberate(input({ feeBps: 500, liquidationBonusBps: 10500 }));
    expect(d.act).toBe(false);
    expect(d.penaltyBps).toBe(500);
    expect(d.rationale).toContain("defer");
  });

  test("the cost gate honours costGateK (need penalty >= k * cost)", () => {
    // penalty 750, cost 30+500=530. k=1.25 -> 750 >= 662.5 -> act.
    expect(deliberate(input({ feeBps: 500, costGateK: 1.25 })).act).toBe(true);
    // Same numbers, stricter gate k=2 -> 750 >= 1060 -> defer.
    expect(deliberate(input({ feeBps: 500, costGateK: 2 })).act).toBe(false);
  });

  test("a blown-out swap (illiquid pool) defers even at a normal fee", () => {
    // 8% swap loss vs a 7.5% penalty -> the cure costs more than the disease -> defer.
    const d = deliberate(input({ debtOutUsd: usd("92"), feeBps: 0, liquidationBonusBps: 10750 }));
    expect(d.swapLossBps).toBe(800);
    expect(d.act).toBe(false);
  });
});
