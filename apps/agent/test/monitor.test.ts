/**
 * monitor.ts tests — Aave health-factor polling. Mocks the public client's
 * `getUserAccountData` read; uses the REAL retry module. Persistent-failure paths
 * would otherwise sleep through exponential backoff, so those tests run under
 * fake timers and drain the backoff via `advanceTimersByTime` + microtask flushes.
 *
 * Covers: HF/breach compute (breached, healthy, no-debt/inf), pollAll skipping a
 * failed subscriber, and pollSubscriber propagating a persistent read failure.
 */

import { describe, expect, jest, test } from "bun:test";
import { parseUnits } from "viem";
import type { Address, PublicClient } from "viem";
import { Monitor, isBreached, HF_NO_DEBT } from "../src/monitor.ts";
import { makeConfig, silentLog } from "./_helpers.ts";
import type { SubscriberConfig } from "../src/config.ts";

const SUB_A = "0x00000000000000000000000000000000000000a1" as Address;
const SUB_B = "0x00000000000000000000000000000000000000b2" as Address;

function sub(address: Address, hfThreshold = parseUnits("1.05", 18)): SubscriberConfig {
  return {
    address,
    hfThreshold,
    debtAsset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address,
  };
}

/** Public client returning a fixed `getUserAccountData` tuple. */
function mockPublic(tuple: readonly bigint[]): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getUserAccountData") return tuple;
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

const acct = (collateral: bigint, debt: bigint, hf: bigint): readonly bigint[] => [
  collateral,
  debt,
  0n,
  0n,
  0n,
  hf,
];

/**
 * Run a promise under fake timers, draining `withRetry`'s real exponential
 * backoff synchronously (no ~8s wall-clock wait). Returns the settled outcome.
 */
async function runWithTimers<T>(
  start: () => Promise<T>,
): Promise<{ ok: boolean; value?: T; error?: string }> {
  jest.useFakeTimers();
  let result: { ok: boolean; value?: T; error?: string } = { ok: false };
  const p = start().then(
    (v) => {
      result = { ok: true, value: v };
    },
    (e) => {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    },
  );
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(9_000);
  }
  await p;
  jest.useRealTimers();
  return result;
}

describe("monitor.isBreached", () => {
  test("only when hasDebt and HF < threshold", () => {
    const thr = parseUnits("1.05", 18);
    expect(isBreached(parseUnits("1.02", 18), thr, true)).toBe(true);
    expect(isBreached(parseUnits("1.10", 18), thr, true)).toBe(false);
    expect(isBreached(parseUnits("1.02", 18), thr, false)).toBe(false);
  });
});

describe("monitor.pollSubscriber", () => {
  test("breached: debt present and HF below threshold", async () => {
    const pub = mockPublic(acct(200n * 10n ** 8n, 100n * 10n ** 8n, parseUnits("1.02", 18)));
    const m = new Monitor(pub, makeConfig(), silentLog);
    const snap = await m.pollSubscriber(sub(SUB_A));
    expect(snap.breached).toBe(true);
    expect(snap.hasDebt).toBe(true);
    expect(snap.healthFactor).toBe(parseUnits("1.02", 18));
    expect(snap.totalDebtBase).toBe(100n * 10n ** 8n);
    expect(snap.subscriber).toBe(SUB_A);
  });

  test("healthy: HF at/above threshold => not breached", async () => {
    const pub = mockPublic(acct(200n * 10n ** 8n, 100n * 10n ** 8n, parseUnits("1.30", 18)));
    const m = new Monitor(pub, makeConfig(), silentLog);
    const snap = await m.pollSubscriber(sub(SUB_A));
    expect(snap.breached).toBe(false);
    expect(snap.hasDebt).toBe(true);
  });

  test("no debt (HF = MaxUint256 'inf') => hasDebt false, not breached", async () => {
    const pub = mockPublic(acct(0n, 0n, HF_NO_DEBT));
    const m = new Monitor(pub, makeConfig(), silentLog);
    const snap = await m.pollSubscriber(sub(SUB_A));
    expect(snap.hasDebt).toBe(false);
    expect(snap.breached).toBe(false);
    expect(snap.healthFactor).toBe(HF_NO_DEBT);
  });

  test("propagates a persistent read failure (fail-closed)", async () => {
    const pub = {
      readContract: async () => {
        throw new Error("rpc down");
      },
    } as unknown as PublicClient;
    const m = new Monitor(pub, makeConfig(), silentLog);
    const r = await runWithTimers(() => m.pollSubscriber(sub(SUB_A)));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("rpc down");
  });
});

describe("monitor.pollAll", () => {
  test("collects healthy reads and skips a failing subscriber", async () => {
    const pub = {
      readContract: async ({ args }: { args: readonly unknown[] }) => {
        if (args[0] === SUB_B) throw new Error("rpc down for B");
        return acct(200n * 10n ** 8n, 100n * 10n ** 8n, parseUnits("1.02", 18));
      },
    } as unknown as PublicClient;
    const config = makeConfig({ subscribers: [sub(SUB_A), sub(SUB_B)] });
    const m = new Monitor(pub, config, silentLog);
    const r = await runWithTimers(() => m.pollAll());
    expect(r.ok).toBe(true);
    expect(r.value!.length).toBe(1);
    expect(r.value![0]!.subscriber).toBe(SUB_A);
    expect(r.value![0]!.breached).toBe(true);
  });

  test("empty when there are no subscribers", async () => {
    const pub = mockPublic(acct(0n, 0n, HF_NO_DEBT));
    const m = new Monitor(pub, makeConfig({ subscribers: [] }), silentLog);
    expect(await m.pollAll()).toEqual([]);
  });
});
