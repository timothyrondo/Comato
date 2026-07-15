/**
 * Pricer tests. No network: `fetch` is stubbed per case.
 *
 * The load-bearing property is not "the model answers" — it is that a wrong, slow, or
 * absent model cannot produce a wrong price or stop the agent billing.
 */

import { describe, expect, it, afterEach } from "bun:test";
import { Pricer, premiumFor, TIER_APR, DEFAULT_TIER, type PositionRisk } from "../src/pricer.ts";
import { createLogger } from "../src/logger.ts";

const log = createLogger("test");
const HOUR = 3_600_000;

const cfg = {
  enabled: true,
  apiKey: "sk-test",
  baseUrl: "https://example.invalid/v1",
  model: "test/model",
  timeoutMs: 5_000,
};

const position: PositionRisk = {
  subscriber: "0xD38b576B7F21f9A1B22a040d053884f60B5B450F",
  healthFactor: 1_180_000_000_000_000_000n, // 1.18
  debtUsd: 3_400,
  collateralUsd: 5_000,
  collateralMix: "100% CELO",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubModel(content: string, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("premiumFor", () => {
  it("prices a $1k debt at the documented band floor (sim-economics §4.2)", () => {
    // 4.4% APR on $1,000 over an hourly window is the $0.005 the run is sized around.
    const { premiumUsdc, aprPct } = premiumFor("low", 1_000, HOUR);
    expect(Number(premiumUsdc)).toBeCloseTo(0.005, 4);
    expect(aprPct).toBeCloseTo(4.4, 6);
  });

  it("scales with debt, so a big position pays proportionally", () => {
    const small = Number(premiumFor("low", 1_000, HOUR).premiumUsdc);
    const big = Number(premiumFor("low", 100_000, HOUR).premiumUsdc);
    // Not exactly 100x: quantising to USDC's 6dp costs a little at the small end.
    expect(big / small).toBeCloseTo(100, 1);
  });

  it("keeps every tier inside the defensible 4.4-8.8% APR band", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      const { aprPct } = premiumFor(tier, 3_400, HOUR);
      expect(aprPct).toBeGreaterThanOrEqual(4.4);
      expect(aprPct).toBeLessThanOrEqual(8.8);
    }
  });

  it("orders tiers low < medium < high", () => {
    const p = (t: "low" | "medium" | "high") => Number(premiumFor(t, 3_400, HOUR).premiumUsdc);
    expect(p("low")).toBeLessThan(p("medium"));
    expect(p("medium")).toBeLessThan(p("high"));
  });

  it("emits USDC-settleable precision (6dp)", () => {
    const { premiumUsdc } = premiumFor("high", 1_234.56, HOUR);
    expect(premiumUsdc.split(".")[1]).toHaveLength(6);
  });

  it("halving the window halves the premium (APR is unchanged)", () => {
    const hourly = Number(premiumFor("low", 1_000, HOUR).premiumUsdc);
    const halfHourly = Number(premiumFor("low", 1_000, HOUR / 2).premiumUsdc);
    expect(halfHourly).toBeCloseTo(hourly / 2, 6);
    expect(premiumFor("low", 1_000, HOUR / 2).aprPct).toBeCloseTo(TIER_APR.low * 100, 6);
  });
});

describe("Pricer.quote — happy path", () => {
  it("uses the model's tier and prices it by arithmetic", async () => {
    stubModel('{"riskTier":"high","rationale":"HF 1.18 on volatile CELO collateral."}');
    const q = await new Pricer(cfg, log).quote(position, HOUR);
    expect(q.riskTier).toBe("high");
    expect(q.fallback).toBe(false);
    expect(q.aprPct).toBeCloseTo(8.8, 6);
    expect(Number(q.premiumUsdc)).toBeCloseTo((0.088 * 3_400) / 8_760, 6);
  });

  it("accepts a fenced JSON response", async () => {
    stubModel('```json\n{"riskTier":"low","rationale":"Stable collateral, wide headroom."}\n```');
    const q = await new Pricer(cfg, log).quote(position, HOUR);
    expect(q.riskTier).toBe("low");
    expect(q.fallback).toBe(false);
  });
});

describe("Pricer.quote — the model cannot break billing (fail-OPEN)", () => {
  const expectDefault = (q: { riskTier: string; fallback: boolean; premiumUsdc: string }) => {
    expect(q.riskTier).toBe(DEFAULT_TIER);
    expect(q.fallback).toBe(true);
    expect(Number(q.premiumUsdc)).toBeGreaterThan(0);
  };

  it("falls back when disabled", async () => {
    globalThis.fetch = (async () => {
      throw new Error("must not be called when disabled");
    }) as unknown as typeof fetch;
    expectDefault(await new Pricer({ ...cfg, enabled: false }, log).quote(position, HOUR));
  });

  it("falls back when the gateway errors", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream exploded", { status: 500 })) as unknown as typeof fetch;
    expectDefault(await new Pricer(cfg, log).quote(position, HOUR));
  });

  it("falls back when the network throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expectDefault(await new Pricer(cfg, log).quote(position, HOUR));
  });

  it("falls back on a hallucinated tier rather than inventing a price", async () => {
    stubModel('{"riskTier":"catastrophic","rationale":"made up tier"}');
    expectDefault(await new Pricer(cfg, log).quote(position, HOUR));
  });

  it("falls back on prose instead of JSON", async () => {
    stubModel("I think this position is quite risky, roughly 2 basis points.");
    expectDefault(await new Pricer(cfg, log).quote(position, HOUR));
  });

  it("falls back on an empty response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;
    expectDefault(await new Pricer(cfg, log).quote(position, HOUR));
  });

  it("falls back when the model stalls past the timeout", async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expectDefault(await new Pricer({ ...cfg, timeoutMs: 50 }, log).quote(position, HOUR));
  });

  it("ignores a price the model volunteers — tier is the only channel", async () => {
    // Measured 2026-07-14: asked to price directly, the model returned 157% APR.
    // Even when it smuggles a number in, the premium must come from TIER_APR alone.
    stubModel('{"riskTier":"high","rationale":"Charge 1.8 bps per hour.","premiumBps":1.8}');
    const q = await new Pricer(cfg, log).quote(position, HOUR);
    expect(q.aprPct).toBeCloseTo(8.8, 6);
    expect(q).not.toHaveProperty("premiumBps");
  });
});
