/**
 * Deleverage executor tests (Model C — non-custodial vault deleverage).
 * Covers: the pure sizing math (debt reduction to target, collateral fraction,
 * slippage-guarded min-out), the breach gate, a DRY_RUN end-to-end that asserts the
 * deleverage tx is tagged (C1 marker) and correctly sized, a reverted receipt →
 * failed with the rate-limit rolled back, and the O1 broadcast-records-cooldown path.
 *
 * Chain reads are mocked (a stub publicClient keyed by functionName); the send path
 * uses either a real TxSender in DRY_RUN or a stub TxSender for the broadcast tests.
 */

import { describe, expect, test } from "bun:test";
import { parseUnits, type Address, type PublicClient } from "viem";
import { Deleverager } from "../src/deleverage.ts";
import { RateLimiter } from "../src/eligibility.ts";
import { TxSender } from "../src/tx.ts";
import { decodeTag, endsWithMarker } from "../src/tagger.ts";
import type { Chain } from "../src/chain.ts";
import { makeConfig, silentLog, EOA } from "./_helpers.ts";

const VAULT = "0x00000000000000000000000000000000000000d4" as Address;
const ACELO = "0x00000000000000000000000000000000000000e5" as Address;
const CELO = "0x471EcE3750Da237f93B8E339c536989b8978a438" as Address;
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address;

/** USD base units (8 dec) and WAD (18 dec) helpers. */
const usd = (n: string) => parseUnits(n, 8);
const wad = (n: string) => parseUnits(n, 18);

/**
 * Mock publicClient answering every read the Deleverager makes:
 *   vault.position()        -> [C, D, hf]  (8dec USD, 8dec USD, WAD)
 *   vault.hfThreshold()     -> threshold (WAD)
 *   vault.targetHf()        -> target (WAD)
 *   vault.collateralAsset() -> CELO
 *   vault.debtAsset()       -> USDC
 *   vault.poolFee()         -> 100
 *   POOL.getReserveData()   -> { aTokenAddress: ACELO }
 *   erc20.balanceOf(ACELO)  -> collateralHeld (CELO token units)
 *   quoter.quoteExactInput  -> [quotedOut, 0, 0, 0]
 *
 * Defaults describe a genuine, SOLVENT breach: C=200 USD, D=139 USD, hf=1.15,
 * threshold=1.3, target=1.6, T=1000 collateral units. (C·0.8/D = 1.151, so the
 * position is consistent with an LT of 80% rather than synthetic.)
 *
 * The old defaults used hf=0.95 — an UNDERWATER position. Aave reverts any withdraw
 * there (mid-tx HF < 1 no matter how small the slice), so a deleverage cannot fix it
 * at all; only a repay funded from outside can. Sizing tests built on it were
 * asserting a scenario that could never execute on-chain, which is part of why the
 * missing mid-tx bound survived to the first live mainnet attempt (2026-07-16).
 */
function mockPublic(
  opts: {
    collateralBase?: bigint;
    debtBase?: bigint;
    hf?: bigint;
    hfThreshold?: bigint;
    targetHf?: bigint;
    feeBps?: bigint;
    liquidationBonusBps?: number;
    collateralHeld?: bigint;
    quotedOut?: bigint;
  } = {},
): PublicClient {
  const C = opts.collateralBase ?? usd("200");
  const D = opts.debtBase ?? usd("139");
  const hf = opts.hf ?? wad("1.15");
  const threshold = opts.hfThreshold ?? wad("1.3");
  const target = opts.targetHf ?? wad("1.6");
  const feeBps = opts.feeBps ?? 0n;
  const bonus = BigInt(opts.liquidationBonusBps ?? 11000); // 10% penalty by default
  const held = opts.collateralHeld ?? parseUnits("1000", 18);
  const quotedOut = opts.quotedOut ?? parseUnits("100", 6);
  return {
    readContract: async ({ address, functionName }: any) => {
      switch (functionName) {
        case "position":
          return [C, D, hf];
        case "hfThreshold":
          return threshold;
        case "targetHf":
          return target;
        case "feeBps":
          return feeBps;
        case "collateralAsset":
          return CELO;
        case "debtAsset":
          return USDC;
        case "poolFee":
          return 100;
        case "getReserveConfigurationData":
          // [decimals, ltv, liquidationThreshold, liquidationBonus, ...] — index 3 is read.
          return [18n, 8000n, 8500n, bonus, 0n, true, true, false, true, false];
        case "decimals":
          return 6; // debt asset (USDC) decimals
        case "getReserveData":
          return { aTokenAddress: ACELO };
        case "balanceOf":
          return address === ACELO ? held : 0n;
        case "quoteExactInputSingle":
          return [quotedOut, 0n, 0, 0n];
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

describe("deleverage — pure sizing", () => {
  const d = new Deleverager({} as PublicClient, {} as TxSender, makeConfig(), new RateLimiter(0, 10, 1000), silentLog);

  test("computeDebtReductionBase lifts HF to exactly the target (equal-value model)", () => {
    // C=200, D=100, hf=0.95, target=1.10  ->  r = C·D·(t-hf)/(t·C - hf·D) = 24 USD.
    const r = d.computeDebtReductionBase(usd("200"), usd("100"), wad("0.95"), wad("1.10"));
    expect(r).toBe(usd("24"));
    // Sanity: withdrawing r from both sides puts HF at the target.
    // new hf = (hf/D * (C-r)) ... check via LT: LT = hf*D/C = 0.475; (C-r)=176,(D-r)=76.
    // 0.475 * 176 / 76 = 1.10  ✓
  });

  test("computeDebtReductionBase returns 0 when not breached toward target", () => {
    expect(d.computeDebtReductionBase(usd("200"), usd("100"), wad("1.20"), wad("1.10"))).toBe(0n); // hf >= target
    expect(d.computeDebtReductionBase(usd("200"), 0n, wad("0.95"), wad("1.10"))).toBe(0n); // no debt
    expect(d.computeDebtReductionBase(0n, usd("100"), wad("0.95"), wad("1.10"))).toBe(0n); // no collateral
  });

  test("computeCollateralIn is the r/C fraction of holdings, capped", () => {
    // fraction = 24/200 = 0.12 of 1000 CELO = 120 CELO.
    expect(d.computeCollateralIn(parseUnits("1000", 18), usd("24"), usd("200"), 0n)).toBe(parseUnits("120", 18));
    // Defensive clamp: never withdraw more than the actual holdings (degenerate r > C).
    expect(d.computeCollateralIn(parseUnits("50", 18), usd("250"), usd("200"), 0n)).toBe(parseUnits("50", 18));
    // Absolute cap wins when smaller.
    expect(d.computeCollateralIn(parseUnits("1000", 18), usd("24"), usd("200"), parseUnits("10", 18))).toBe(
      parseUnits("10", 18),
    );
    expect(d.computeCollateralIn(0n, usd("24"), usd("200"), 0n)).toBe(0n);
  });

  test("computeMinDebtOut applies the slippage guard", () => {
    // 100 USDC quoted, 100bps slippage -> 99 USDC min.
    expect(d.computeMinDebtOut(parseUnits("100", 6), 100)).toBe(parseUnits("99", 6));
    expect(d.computeMinDebtOut(parseUnits("100", 6), 0)).toBe(parseUnits("100", 6));
  });
});

describe("Deleverager.maybeDeleverage", () => {
  function makeDeleverager(pub: PublicClient, cfgOverrides = {}) {
    const config = makeConfig(cfgOverrides);
    const chain: Chain = { publicClient: pub, walletClient: {} as any, account: { address: EOA } as any };
    const tx = new TxSender(chain, config, silentLog);
    const rateLimiter = new RateLimiter(0, 10, 10_000);
    return { deleverager: new Deleverager(pub, tx, config, rateLimiter, silentLog), config };
  }

  test("skips when the engine is disabled", async () => {
    const { deleverager } = makeDeleverager(mockPublic(), { deleverage: { ...makeConfig().deleverage, enabled: false } });
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("skipped_disabled");
  });

  test("skips when HF is at/above the vault threshold (no breach)", async () => {
    const { deleverager } = makeDeleverager(mockPublic({ hf: wad("1.35") }));
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("skipped_no_breach");
  });

  test("skips when the position has no debt", async () => {
    const { deleverager } = makeDeleverager(mockPublic({ debtBase: 0n }));
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("skipped_no_breach");
  });

  test("breach -> tagged, correctly sized deleverage in dry-run (no broadcast)", async () => {
    const { deleverager } = makeDeleverager(mockPublic());
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("executed");
    // Target-based size wants r=$78.11 -> 390.57 units, but ONE call cannot lift that
    // much: the mid-tx bound caps it at 0.7 * C*(hf-floor)/hf = $17.65 -> 88.26 units.
    // The clamp is the point — sizing at the aspiration is what Aave reverts.
    expect(out.collateralIn).toBe(88260869550000000000n);
    // Quoted 100 USDC, 100bps slippage -> 99 USDC min-out (the slippage guard).
    expect(out.quotedOut).toBe(parseUnits("100", 6));
    expect(out.minDebtOut).toBe(parseUnits("99", 6));
    expect(out.result?.dryRun).toBe(true);
    expect(out.result?.hash).toBeUndefined();
    // The deleverage calldata must carry our ERC-8021 tag (C1 marker).
    const data = out.result!.taggedData;
    expect(endsWithMarker(data)).toBe(true);
    expect(decodeTag(data)!.codes).toEqual(["timo_comato"]);
  });

  test("slippage guard tracks the quoted amount", async () => {
    // A different quote flows straight through to min-out at the configured bps.
    const { deleverager } = makeDeleverager(mockPublic({ quotedOut: parseUnits("250", 6) }));
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("executed");
    // 250 USDC * (10000-100)/10000 = 247.5 USDC.
    expect(out.minDebtOut).toBe(parseUnits("247.5", 6));
  });

  test("fail-closed when a vault read throws", async () => {
    const throwing = {
      readContract: async ({ functionName }: any) => {
        if (functionName === "position") throw new Error("rpc down");
        return 0n;
      },
    } as unknown as PublicClient;
    const { deleverager } = makeDeleverager(throwing);
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("failed");
    expect(out.reasons?.some((r) => r.includes("vault state read failed"))).toBe(true);
  });

  // --- decision layer (deliberate.ts) wired into the driver ------------------

  test("imminent breach (HF <= criticalHf) acts even with a punitive fee", async () => {
    // hf=1.02 <= criticalHf 1.05 -> imminent -> act regardless of cost. It still
    // sizes >0 because the mid-tx floor (1.005) sits just under it — a 1.02 floor
    // would zero the cap here and refuse the most urgent rescue there is.
    const { deleverager } = makeDeleverager(
      mockPublic({ hf: wad("1.02"), feeBps: 5000n, liquidationBonusBps: 10500 }),
    );
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("executed");
    expect(out.decision?.urgency).toBe("imminent");
    expect(out.decision?.act).toBe(true);
  });

  test("deliberate band: defers when the rescue costs about as much as the penalty", async () => {
    // hf 1.10 is between criticalHf (1.05) and threshold (1.30) -> deliberate band.
    // feeBps 1000 (10%) vs a 5% liquidation penalty -> not worth it -> defer, no send.
    const { deleverager } = makeDeleverager(
      mockPublic({
        hf: wad("1.10"),
        hfThreshold: wad("1.30"),
        targetHf: wad("1.60"),
        feeBps: 1000n,
        liquidationBonusBps: 10500, // 5% penalty
      }),
    );
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("skipped_deferred");
    expect(out.decision?.urgency).toBe("deliberate");
    expect(out.decision?.act).toBe(false);
    expect(out.decision?.penaltyBps).toBe(500);
    expect(out.reasons?.[0]).toContain("defer");
  });

  test("deliberate band: acts when the penalty clearly outweighs the rescue cost", async () => {
    // Same band, but a cheap rescue (fee 0) vs a 7.5% WETH-like penalty -> act.
    const { deleverager } = makeDeleverager(
      mockPublic({
        hf: wad("1.10"),
        hfThreshold: wad("1.30"),
        targetHf: wad("1.60"),
        feeBps: 0n,
        liquidationBonusBps: 10750, // 7.5% penalty
      }),
    );
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("executed");
    expect(out.decision?.urgency).toBe("deliberate");
    expect(out.decision?.act).toBe(true);
    expect(out.decision?.penaltyBps).toBe(750);
  });

  test("fail-closed when the asset-risk read throws (cannot deliberate -> do not act)", async () => {
    const base = mockPublic();
    const throwing = {
      readContract: async (a: any) => {
        if (a.functionName === "getReserveConfigurationData") throw new Error("rpc down");
        return (base as any).readContract(a);
      },
    } as unknown as PublicClient;
    const { deleverager } = makeDeleverager(throwing);
    const out = await deleverager.maybeDeleverage(VAULT);
    expect(out.status).toBe("failed");
    expect(out.reasons?.some((r) => r.includes("asset risk read failed"))).toBe(true);
  });
});

describe("Deleverager double-action safety (O1)", () => {
  const config = makeConfig({ dryRun: false });
  const pub = mockPublic();

  /** A TxSender stub that can send + optionally simulate a receipt-read failure. */
  function stubTx(sendTagged: (a: any) => Promise<any>): TxSender {
    return { canSend: true, senderAddress: EOA, sendTagged } as unknown as TxSender;
  }

  test("records the rate limit on BROADCAST even when the receipt read fails", async () => {
    const rl = new RateLimiter(3_600_000, 3, 86_400_000); // 1h cooldown
    const tx = stubTx(async (a) => {
      a.onBroadcast?.("0xhash"); // tx broadcast: hash returned
      throw new Error("waitForTransactionReceipt: retries exhausted");
    });
    const deleverager = new Deleverager(pub, tx, config, rl, silentLog);

    const first = await deleverager.maybeDeleverage(VAULT);
    expect(first.status).toBe("failed"); // the receipt read threw

    // Broadcast consumed the rate limit, so the next cycle is blocked (not re-deleveraged).
    const second = await deleverager.maybeDeleverage(VAULT);
    expect(second.status).toBe("skipped_cooldown");
    expect(second.reasons?.some((r) => r.includes("cooldown"))).toBe(true);
  });

  test("rolls back the rate limit when the deleverage reverts on-chain (retry allowed)", async () => {
    const rl = new RateLimiter(3_600_000, 3, 86_400_000);
    const tx = stubTx(async (a) => {
      a.onBroadcast?.("0xhash"); // broadcast records the rate limit
      return { dryRun: false, taggedData: "0x", hash: "0xhash", status: "reverted" };
    });
    const deleverager = new Deleverager(pub, tx, config, rl, silentLog);

    const first = await deleverager.maybeDeleverage(VAULT);
    expect(first.status).toBe("failed");
    expect(first.reasons?.some((r) => r.includes("reverted"))).toBe(true);

    // The revert did nothing on-chain, so the budget was rolled back: no cooldown.
    expect(rl.check(VAULT)).toBeNull();
  });

  test("skips a second overlapping deleverage for the same vault (idempotency)", async () => {
    const rl = new RateLimiter(0, 10, 10_000);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tx = stubTx(async (a) => {
      a.onBroadcast?.("0xhash");
      await gate; // keep the first deleverage in-flight
      return { dryRun: false, taggedData: "0x", hash: "0xhash" };
    });
    const deleverager = new Deleverager(pub, tx, config, rl, silentLog);

    // First call synchronously marks the vault in-flight, then suspends on the gate.
    const p1 = deleverager.maybeDeleverage(VAULT);
    const second = await deleverager.maybeDeleverage(VAULT);
    expect(second.status).toBe("skipped_in_flight");

    release();
    expect((await p1).status).toBe("executed");
  });
});

/**
 * REGRESSION — the first live mainnet deleverage (2026-07-16) reverted with Aave's
 * `HealthFactorLowerThanLiquidationThreshold` (0x6679996d) because the sizing aimed
 * straight at targetHf and ignored that `deleverage` withdraws BEFORE it repays.
 *
 * The fork test never caught this: it sized with its OWN helper (`_sizeDeleverage`),
 * so it proved the CONTRACT climbs, never that the AGENT sizes a climbable step.
 * These lock the bound at the agent's own sizing.
 */
describe("mid-tx solvency bound", () => {
  // Only the pure sizing methods are exercised — no chain, no tx.
  const d = new Deleverager(
    mockPublic(),
    null as unknown as TxSender,
    makeConfig(),
    new RateLimiter(0, 10, 10_000),
    silentLog,
  );
  // The exact live position that reverted: C=$9.6093, D=$5.9949642, hf=1.282316…
  const C = 960930000n; // 8-dec USD
  const HELD = 5010000000000000n; // ~0.00501 WETH
  const HF = 1282316248026969035n;
  const FLOOR = parseUnits("1.02", 18);

  test("caps the withdraw so mid-tx HF cannot fall below the floor", () => {
    const cap = d.computeMidTxCollateralCap(HELD, C, HF, FLOOR, 10_000n); // full room
    // v_max = C·(hf−floor)/hf, converted to token units via held/C.
    const vMaxBase = (C * (HF - FLOOR)) / HF;
    expect(cap).toBe((HELD * vMaxBase) / C);
    // Mid-tx HF at exactly the cap lands on the floor (within rounding).
    const vBase = (cap * C) / HELD;
    const midHf = (HF * (C - vBase)) / C;
    expect(midHf >= FLOOR - 1n).toBe(true);
  });

  test("roomBps only takes a fraction of the room (drift headroom)", () => {
    const full = d.computeMidTxCollateralCap(HELD, C, HF, FLOOR, 10_000n);
    const partial = d.computeMidTxCollateralCap(HELD, C, HF, FLOOR, 7000n);
    // roomBps is applied in 8-dec USD *before* the token conversion, so this is
    // ~70% of full rather than exactly (full*7000)/10000 — assert the intent, not
    // the truncation order.
    const want = (full * 7000n) / 10_000n;
    const drift = partial > want ? partial - want : want - partial;
    expect(partial < full).toBe(true);
    expect(drift * 1_000_000n < want).toBe(true); // within 1e-6 relative
  });

  test("returns 0 at or below the floor — nothing is withdrawable pre-repay", () => {
    expect(d.computeMidTxCollateralCap(HELD, C, FLOOR, FLOOR, 7000n)).toBe(0n);
    expect(d.computeMidTxCollateralCap(HELD, C, FLOOR - 1n, FLOOR, 7000n)).toBe(0n);
  });

  test("the cap is TIGHTER than the target-based size at the live position (the actual bug)", () => {
    const r = d.computeDebtReductionBase(C, 599496420n, HF, parseUnits("1.6", 18));
    const wanted = d.computeCollateralIn(HELD, r, C, 0n);
    const cap = d.computeMidTxCollateralCap(HELD, C, HF, FLOOR, 7000n);
    expect(wanted > cap).toBe(true); // ← unclamped, this is what Aave reverted
  });

  test("a deeper breach lifts LESS per call (why the rescue must iterate)", () => {
    const deep = d.computeMidTxCollateralCap(HELD, C, parseUnits("1.10", 18), FLOOR, 7000n);
    const shallow = d.computeMidTxCollateralCap(HELD, C, parseUnits("1.28", 18), FLOOR, 7000n);
    expect(deep < shallow).toBe(true);
  });
});
