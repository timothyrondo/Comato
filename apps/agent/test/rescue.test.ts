/**
 * Rescue + eligibility tests — HF/decision logic and the off-chain trust gate.
 * Covers: breach detection, repay bounding (R13), rate limiting, the four
 * eligibility checks, and a DRY_RUN end-to-end that asserts the repay tx is
 * tagged (C1) and correctly bounded — with no real broadcast.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnits, type Address, type PublicClient } from "viem";
import { isBreached, HF_NO_DEBT, type HealthSnapshot } from "../src/monitor.ts";
import { RateLimiter, checkEligibility } from "../src/eligibility.ts";
import { Rescuer } from "../src/rescue.ts";
import { TxSender } from "../src/tx.ts";
import { decodeTag, endsWithMarker } from "../src/tagger.ts";
import type { Chain } from "../src/chain.ts";
import type { SubscriberConfig } from "../src/config.ts";
import { makeConfig, silentLog, EOA } from "./_helpers.ts";

const SUB = "0x00000000000000000000000000000000000000b2" as Address;
const VDTOKEN = "0x00000000000000000000000000000000000000c3" as Address;
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address;

function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    subscriber: SUB,
    healthFactor: parseUnits("1.02", 18),
    hfThreshold: parseUnits("1.05", 18),
    totalCollateralBase: 200n * 10n ** 8n,
    totalDebtBase: 100n * 10n ** 8n,
    hasDebt: true,
    breached: true,
    at: Date.now(),
    ...overrides,
  };
}

function sub(overrides: Partial<SubscriberConfig> = {}): SubscriberConfig {
  return {
    address: SUB,
    hfThreshold: parseUnits("1.05", 18),
    debtAsset: USDC,
    premiumPaidUntilMs: Date.now() + 3_600_000,
    ...overrides,
  };
}

/**
 * Mock publicClient:
 *   getUserAccountData -> fresh [collateral, debt, _, _, _, HF] (O2 TOCTOU read),
 *   getReserveData     -> VDTOKEN,
 *   balanceOf(VDTOKEN) -> variable debt, else -> float.
 * `healthFactor`/`totalDebtBase` default to the snapshot() defaults so the fresh
 * read agrees with the snapshot unless a test overrides them.
 */
function mockPublic(opts: {
  variableDebt: bigint;
  float: bigint;
  allowance?: bigint;
  healthFactor?: bigint;
  totalDebtBase?: bigint;
}): PublicClient {
  const hf = opts.healthFactor ?? parseUnits("1.02", 18);
  const debtBase = opts.totalDebtBase ?? 100n * 10n ** 8n;
  return {
    readContract: async ({ address, functionName }: any) => {
      if (functionName === "getUserAccountData") {
        return [200n * 10n ** 8n, debtBase, 0n, 0n, 0n, hf];
      }
      if (functionName === "getReserveData") return { variableDebtTokenAddress: VDTOKEN };
      if (functionName === "allowance") return opts.allowance ?? 2n ** 255n;
      if (functionName === "balanceOf") {
        return address === VDTOKEN ? opts.variableDebt : opts.float;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe("monitor.isBreached", () => {
  test("breached only when hasDebt and HF < threshold", () => {
    const thr = parseUnits("1.05", 18);
    expect(isBreached(parseUnits("1.02", 18), thr, true)).toBe(true);
    expect(isBreached(parseUnits("1.10", 18), thr, true)).toBe(false);
    expect(isBreached(parseUnits("1.02", 18), thr, false)).toBe(false); // no debt
    expect(isBreached(HF_NO_DEBT, thr, false)).toBe(false);
  });
});

describe("rescue.computeRepayAmount (R13 bounding)", () => {
  const rescuer = new Rescuer(
    {} as PublicClient,
    {} as TxSender,
    makeConfig({ rescue: { ...makeConfig().rescue, maxAmount: parseUnits("50", 6) } }),
    new RateLimiter(0, 10, 1000),
    silentLog,
  );
  test("takes min(cap, debt, float)", () => {
    expect(rescuer.computeRepayAmount(parseUnits("100", 6), parseUnits("30", 6))).toBe(parseUnits("30", 6));
    expect(rescuer.computeRepayAmount(parseUnits("100", 6), parseUnits("80", 6))).toBe(parseUnits("50", 6));
    expect(rescuer.computeRepayAmount(parseUnits("10", 6), parseUnits("80", 6))).toBe(parseUnits("10", 6));
    expect(rescuer.computeRepayAmount(0n, parseUnits("80", 6))).toBe(0n);
  });
});

describe("eligibility.RateLimiter", () => {
  test("cooldown blocks a second rescue immediately after one", () => {
    const rl = new RateLimiter(1000, 5, 10_000);
    const t = 1_000_000;
    expect(rl.check(SUB, t)).toBeNull();
    rl.record(SUB, t);
    expect(rl.check(SUB, t + 500)).toContain("cooldown");
    expect(rl.check(SUB, t + 1500)).toBeNull(); // cooldown elapsed
  });

  test("max-per-window blocks after N rescues", () => {
    const rl = new RateLimiter(0, 2, 10_000);
    const t = 2_000_000;
    rl.record(SUB, t);
    rl.record(SUB, t + 1);
    expect(rl.check(SUB, t + 2)).toContain("rate limit");
  });
});

describe("eligibility.checkEligibility (trust model)", () => {
  const config = makeConfig();
  const rl = () => new RateLimiter(0, 10, 10_000);

  test("eligible when premium paid, genuinely distressed, has debt", async () => {
    const res = await checkEligibility({
      publicClient: mockPublic({ variableDebt: parseUnits("100", 6), float: parseUnits("30", 6) }),
      snapshot: snapshot(),
      sub: sub(),
      config,
      rateLimiter: rl(),
      log: silentLog,
    });
    expect(res.eligible).toBe(true);
    expect(res.variableDebt).toBe(parseUnits("100", 6));
  });

  test("ineligible when premium missing (fail-closed)", async () => {
    const res = await checkEligibility({
      publicClient: mockPublic({ variableDebt: parseUnits("100", 6), float: parseUnits("30", 6) }),
      snapshot: snapshot(),
      sub: sub({ premiumPaidUntilMs: undefined }),
      config,
      rateLimiter: rl(),
      log: silentLog,
    });
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("premium"))).toBe(true);
  });

  test("ineligible when HF above the absolute distress ceiling", async () => {
    // HF 1.20 is below a lenient subscriber threshold (1.5) but above distress (1.05).
    const res = await checkEligibility({
      publicClient: mockPublic({
        variableDebt: parseUnits("100", 6),
        float: parseUnits("30", 6),
        healthFactor: parseUnits("1.20", 18),
      }),
      snapshot: snapshot({ healthFactor: parseUnits("1.20", 18), hfThreshold: parseUnits("1.5", 18) }),
      sub: sub({ hfThreshold: parseUnits("1.5", 18) }),
      config,
      rateLimiter: rl(),
      log: silentLog,
    });
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("distress ceiling"))).toBe(true);
  });

  test("O2: uses the FRESH HF, not the stale snapshot (position recovered)", async () => {
    // Snapshot still shows distress (1.02), but a fresh read shows the position
    // recovered to 1.30 (repaid/topped up since the last poll) -> must NOT rescue.
    const res = await checkEligibility({
      publicClient: mockPublic({
        variableDebt: parseUnits("100", 6),
        float: parseUnits("30", 6),
        healthFactor: parseUnits("1.30", 18),
      }),
      snapshot: snapshot({ healthFactor: parseUnits("1.02", 18) }),
      sub: sub(),
      config,
      rateLimiter: rl(),
      log: silentLog,
    });
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("distress ceiling") || r.includes("threshold"))).toBe(true);
  });

  test("O2: fail-closed when the fresh account read throws", async () => {
    const throwingPublic = {
      readContract: async ({ functionName }: any) => {
        if (functionName === "getUserAccountData") throw new Error("rpc down");
        if (functionName === "getReserveData") return { variableDebtTokenAddress: VDTOKEN };
        if (functionName === "balanceOf") return parseUnits("100", 6);
        throw new Error(`unexpected read ${functionName}`);
      },
    } as unknown as PublicClient;
    const res = await checkEligibility({
      publicClient: throwingPublic,
      snapshot: snapshot(),
      sub: sub(),
      config,
      rateLimiter: rl(),
      log: silentLog,
    });
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("fresh account data"))).toBe(true);
  });

  test("ineligible when subscriber has no variable debt in the configured asset", async () => {
    const res = await checkEligibility({
      publicClient: mockPublic({ variableDebt: 0n, float: parseUnits("30", 6) }),
      snapshot: snapshot(),
      sub: sub(),
      config,
      rateLimiter: rl(),
      log: silentLog,
    });
    expect(res.eligible).toBe(false);
    expect(res.reasons.some((r) => r.includes("no variable debt"))).toBe(true);
  });
});

describe("Rescuer.maybeRescue (DRY_RUN end-to-end)", () => {
  function makeRescuer(cfgOverrides = {}) {
    const config = makeConfig(cfgOverrides);
    const pub = mockPublic({ variableDebt: parseUnits("100", 6), float: parseUnits("30", 6) });
    const chain: Chain = {
      publicClient: pub,
      walletClient: {} as any,
      account: { address: EOA } as any,
    };
    const tx = new TxSender(chain, config, silentLog);
    const rescuer = new Rescuer(pub, tx, config, new RateLimiter(0, 10, 10_000), silentLog);
    return { rescuer, config };
  }

  test("skips when rescue disabled", async () => {
    const { rescuer } = makeRescuer({ rescue: { ...makeConfig().rescue, enabled: false } });
    const out = await rescuer.maybeRescue(snapshot(), sub());
    expect(out.status).toBe("skipped_disabled");
  });

  test("skips ineligible (unpaid premium)", async () => {
    const { rescuer } = makeRescuer();
    const out = await rescuer.maybeRescue(snapshot(), sub({ premiumPaidUntilMs: undefined }));
    expect(out.status).toBe("skipped_ineligible");
  });

  test("executes a bounded, tagged repay in dry-run (no broadcast)", async () => {
    const { rescuer } = makeRescuer();
    const out = await rescuer.maybeRescue(snapshot(), sub());
    expect(out.status).toBe("executed");
    // min(cap=50, debt=100, float=30) = 30 USDC
    expect(out.repayAmount).toBe(parseUnits("30", 6));
    expect(out.result?.dryRun).toBe(true);
    expect(out.result?.hash).toBeUndefined();
    // The repay calldata must carry our ERC-8021 tag (C1).
    const data = out.result!.taggedData;
    expect(endsWithMarker(data)).toBe(true);
    expect(decodeTag(data)!.codes).toEqual(["timo_comato"]);
  });
});

describe("Rescuer double-rescue safety (O1)", () => {
  const config = makeConfig({ dryRun: false });
  const pub = mockPublic({ variableDebt: parseUnits("100", 6), float: parseUnits("30", 6) });

  /** A TxSender stub that can send + optionally simulate a receipt-read failure. */
  function stubTx(sendTagged: (a: any) => Promise<any>): TxSender {
    return {
      canSend: true,
      senderAddress: EOA,
      balanceOf: async () => parseUnits("30", 6),
      ensureApproval: async () => {},
      sendTagged,
    } as unknown as TxSender;
  }

  test("records the rate limit on BROADCAST even when the receipt read fails", async () => {
    const rl = new RateLimiter(3_600_000, 3, 86_400_000); // 1h cooldown
    const tx = stubTx(async (a) => {
      a.onBroadcast?.("0xhash"); // tx broadcast: hash returned
      throw new Error("waitForTransactionReceipt: retries exhausted");
    });
    const rescuer = new Rescuer(pub, tx, config, rl, silentLog);

    const first = await rescuer.maybeRescue(snapshot(), sub());
    expect(first.status).toBe("failed"); // the receipt read threw

    // Broadcast consumed the rate limit, so the next cycle is blocked (not re-rescued).
    const second = await rescuer.maybeRescue(snapshot(), sub());
    expect(second.status).toBe("skipped_ineligible");
    expect(second.reasons?.some((r) => r.includes("cooldown"))).toBe(true);
  });

  test("skips a second overlapping rescue for the same subscriber (idempotency)", async () => {
    const rl = new RateLimiter(0, 10, 10_000);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tx = stubTx(async (a) => {
      a.onBroadcast?.("0xhash");
      await gate; // keep the first rescue in-flight
      return { dryRun: false, taggedData: "0x", hash: "0xhash" };
    });
    const rescuer = new Rescuer(pub, tx, config, rl, silentLog);

    // First call synchronously marks the subscriber in-flight, then suspends on the gate.
    const p1 = rescuer.maybeRescue(snapshot(), sub());
    const second = await rescuer.maybeRescue(snapshot(), sub());
    expect(second.status).toBe("skipped_in_flight");

    release();
    expect((await p1).status).toBe("executed");
  });
});

describe("eligibility.RateLimiter persistence (O3)", () => {
  test("reloads cooldown state from disk after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "comato-rl-"));
    const path = join(dir, "state.json");
    const t = 5_000_000;
    try {
      const first = new RateLimiter(3_600_000, 3, 86_400_000, { persistPath: path });
      expect(first.check(SUB, t)).toBeNull();
      first.record(SUB, t);
      expect(first.check(SUB, t + 1000)).toContain("cooldown");

      // Simulate a crash/restart: a brand-new limiter reads the same file on boot.
      const restarted = new RateLimiter(3_600_000, 3, 86_400_000, { persistPath: path });
      expect(restarted.check(SUB, t + 1000)).toContain("cooldown"); // survived the restart
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("in-memory limiter (no persistPath) works and touches no disk", () => {
    const rl = new RateLimiter(1000, 3, 10_000);
    rl.record(SUB, 1);
    expect(rl.check(SUB, 500)).toContain("cooldown");
  });
});
