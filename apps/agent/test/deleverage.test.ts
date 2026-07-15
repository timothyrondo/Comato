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
 * Defaults describe a genuine breach: C=200 USD, D=100 USD, hf=0.95, threshold=1.05,
 * target=1.10 -> debtReduction r = 24 USD; with T=1000 CELO -> collateralIn = 120 CELO.
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
  const D = opts.debtBase ?? usd("100");
  const hf = opts.hf ?? wad("0.95");
  const threshold = opts.hfThreshold ?? wad("1.05");
  const target = opts.targetHf ?? wad("1.10");
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
    const { deleverager } = makeDeleverager(mockPublic({ hf: wad("1.20") }));
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
    // r=24 USD, fraction 24/200 of 1000 CELO = 120 CELO withdrawn.
    expect(out.collateralIn).toBe(parseUnits("120", 18));
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
    // Default hf=0.95 <= criticalHf 1.05 -> imminent -> act regardless of cost.
    const { deleverager } = makeDeleverager(mockPublic({ feeBps: 5000n, liquidationBonusBps: 10500 }));
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
