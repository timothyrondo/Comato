import { test, expect, describe } from "bun:test";
import type { PublicClient } from "viem";
import { fetchLiveData, buildRescuePlan } from "../../src/data/live";
import type { LiveConfig } from "../../src/lib/env";
import { TOKENS } from "../../src/lib/constants";
import { position as mockPosition } from "../../src/data/fixtures";

const SUB = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F" as const;
const POLICY = "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402" as const;
const EXEC = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;

const WAD = (n: number) => BigInt(Math.round(n * 1e18));
const BASE8 = (n: number) => BigInt(Math.round(n * 1e8));
const USDC6 = (n: number) => BigInt(Math.round(n * 1e6));
const MAX_UINT256 = (1n << 256n) - 1n;

function cfg(overrides: Partial<LiveConfig> = {}): LiveConfig {
  return {
    rpcUrl: "http://127.0.0.1:8546",
    chainId: 42220,
    subscriber: SUB,
    policyAddr: POLICY,
    executorAddr: EXEC,
    policyId: 1n,
    fromBlock: 100n,
    ...overrides,
  };
}

/** Aave getUserAccountData tuple. */
function accountData(opts: {
  collateral: number;
  debt: number;
  liqThresholdBps: number;
  hf: bigint;
}) {
  return [
    BASE8(opts.collateral), // totalCollateralBase
    BASE8(opts.debt), // totalDebtBase
    0n, // availableBorrowsBase
    BigInt(opts.liqThresholdBps), // currentLiquidationThreshold
    5500n, // ltv (unused)
    opts.hf, // healthFactor
  ] as const;
}

function policyRecord(over: Partial<Record<string, unknown>> = {}) {
  return {
    subscriber: SUB,
    collateralAsset: TOKENS.USDC,
    debtAsset: TOKENS.USDT,
    hfThreshold: WAD(1.2),
    rescueCap: USDC6(500),
    premiumRatePerInterval: 1n,
    active: true,
    ...over,
  };
}

type ReadArgs = { functionName: string };

/** Build a stub PublicClient with controllable reads. */
function stubClient(handlers: {
  getUserAccountData?: () => unknown;
  getPolicy?: () => unknown;
  events?: unknown[];
  block?: (n: bigint) => unknown;
}): PublicClient {
  return {
    readContract: async ({ functionName }: ReadArgs) => {
      if (functionName === "getUserAccountData") {
        return (handlers.getUserAccountData ??
          (() => accountData({ collateral: 12480, debt: 6850, liqThresholdBps: 8300, hf: WAD(1.82) })))();
      }
      if (functionName === "getPolicy") {
        return (handlers.getPolicy ?? (() => policyRecord()))();
      }
      throw new Error(`unexpected read: ${functionName}`);
    },
    getContractEvents: async () => handlers.events ?? [],
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) =>
      handlers.block
        ? handlers.block(blockNumber)
        : { number: blockNumber, timestamp: BigInt(Math.floor(Date.now() / 1000)) },
  } as unknown as PublicClient;
}

describe("buildRescuePlan", () => {
  test("keys the alert-threshold + interval copy off live values", () => {
    const plan = buildRescuePlan(1.25, 45);
    expect(plan).toHaveLength(4);
    expect(plan[0].detail).toContain("45s");
    expect(plan[1].title).toContain("1.25");
    expect(plan[0].state).toBe("active");
    expect(plan.at(-1)!.state).toBe("ready");
  });
});

describe("fetchLiveData — position mapping (Aave getUserAccountData)", () => {
  test("maps HF, collateral, debt, LTVs + policy assets", async () => {
    const client = stubClient({});
    const data = await fetchLiveData(client, cfg());
    expect(data.position.healthFactor).toBeCloseTo(1.82, 5);
    expect(data.position.collateralUsd).toBe(12480);
    expect(data.position.debtUsd).toBe(6850);
    expect(data.position.liquidationLtv).toBeCloseTo(0.83, 5);
    // currentLtv = debt / collateral
    expect(data.position.currentLtv).toBeCloseTo(6850 / 12480, 5);
    expect(data.position.rescueHf).toBeCloseTo(1.2, 5);
    expect(data.position.collateralAsset).toBe("USDC");
    expect(data.position.debtAsset).toBe("USDT");
    // user wallet is shortened from the subscriber
    expect(data.user.walletShort).toBe("0x71C7…976F");
  });

  test("no-debt position → HF clamps to the 'infinite' sentinel + LTV 0", async () => {
    const client = stubClient({
      getUserAccountData: () =>
        accountData({ collateral: 0, debt: 0, liqThresholdBps: 0, hf: MAX_UINT256 }),
    });
    const data = await fetchLiveData(client, cfg());
    expect(data.position.healthFactor).toBe(999);
    expect(data.position.currentLtv).toBe(0);
  });

  test("policy read failure degrades to mock threshold/assets (no throw)", async () => {
    const client = stubClient({
      getPolicy: () => {
        throw new Error("policy not found");
      },
    });
    const data = await fetchLiveData(client, cfg());
    // rescueHf + assets fall back to the mock fixture values
    expect(data.position.rescueHf).toBe(mockPosition.rescueHf);
    expect(data.position.collateralAsset).toBe(mockPosition.collateralAsset);
  });

  test("no policyAddr configured → policy skipped, mock threshold used", async () => {
    const client = stubClient({});
    const data = await fetchLiveData(client, cfg({ policyAddr: undefined, policyId: undefined }));
    expect(data.position.rescueHf).toBe(mockPosition.rescueHf);
  });
});

describe("fetchLiveData — rescue history (RescueExecuted events)", () => {
  const now = Math.floor(Date.now() / 1000);
  const events = [
    {
      transactionHash: "0xaaa",
      logIndex: 0,
      blockNumber: 10n,
      args: { amountRepaid: USDC6(312), hfBefore: WAD(1.14), hfAfter: WAD(1.66) },
    },
    {
      transactionHash: "0xbbb",
      logIndex: 1,
      blockNumber: 20n,
      args: { amountRepaid: USDC6(486), hfBefore: WAD(1.09), hfAfter: WAD(1.58) },
    },
    {
      transactionHash: "0xccc",
      logIndex: 2,
      blockNumber: 30n,
      args: { amountRepaid: USDC6(212), hfBefore: WAD(1.12), hfAfter: WAD(1.61) },
    },
  ];
  const times: Record<string, number> = {
    "10": now - 30, // Just now / Today
    "20": now - 90_000, // ~25h → Yesterday
    "30": now - 200_000, // >2d → This week
  };

  test("maps events → newest-first activity with HF + time buckets", async () => {
    const client = stubClient({
      events,
      block: (n) => ({ number: n, timestamp: BigInt(times[String(n)]) }),
    });
    const data = await fetchLiveData(client, cfg());
    expect(data.activity).toHaveLength(3);
    // reversed → block 30 first
    expect(data.activity[0].id).toBe("0xccc-2");
    expect(data.activity[0].day).toBe("This week");
    expect(data.activity[0].timeAgo).toBe("2d ago");

    const first = data.activity.at(-1)!; // oldest in array = block 10
    expect(first.hfBefore).toBeCloseTo(1.14, 5);
    expect(first.hfAfter).toBeCloseTo(1.66, 5);
    expect(first.amountUsd).toBe(312);
    expect(first.subtitle).toContain("1.14 → 1.66");
    expect(first.timeAgo).toBe("Just now");
    expect(first.day).toBe("Today");

    // aggregate summary
    expect(data.activitySummary.rescueCount).toBe(3);
    expect(data.activitySummary.totalSavedUsd).toBe(312 + 486 + 212);
  });

  test("relative-time buckets: minutes + hours", async () => {
    const client = stubClient({
      events: [
        { transactionHash: "0x1", logIndex: 0, blockNumber: 5n, args: { amountRepaid: USDC6(10), hfBefore: WAD(1.1), hfAfter: WAD(1.5) } },
        { transactionHash: "0x2", logIndex: 0, blockNumber: 6n, args: { amountRepaid: USDC6(10), hfBefore: WAD(1.1), hfAfter: WAD(1.5) } },
      ],
      block: (n) => ({ number: n, timestamp: BigInt(n === 5n ? now - 600 : now - 7200) }),
    });
    const data = await fetchLiveData(client, cfg());
    const byId = Object.fromEntries(data.activity.map((a) => [a.id, a.timeAgo]));
    expect(byId["0x1-0"]).toBe("10m ago");
    expect(byId["0x2-0"]).toBe("2h ago");
  });

  test("missing blockNumber / hashes → nowSec + fallback id", async () => {
    const client = stubClient({
      events: [
        { logIndex: undefined, blockNumber: null, args: { amountRepaid: USDC6(5), hfBefore: WAD(1.1), hfAfter: WAD(1.4) } },
      ],
    });
    const data = await fetchLiveData(client, cfg());
    expect(data.activity).toHaveLength(1);
    expect(data.activity[0].id).toBe("rescue-0");
    expect(data.activity[0].timeAgo).toBe("Just now");
  });

  test("no executor configured → empty rescue history", async () => {
    const client = stubClient({});
    const data = await fetchLiveData(client, cfg({ executorAddr: undefined }));
    expect(data.activity).toEqual([]);
    expect(data.activitySummary.rescueCount).toBe(0);
    // premium aggregate still comes from the mock fixture
    expect(data.activitySummary.premiumPaidUsd).toBeGreaterThan(0);
  });
});
