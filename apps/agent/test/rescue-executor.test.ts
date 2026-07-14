/**
 * rescue.ts — the ComatoExecutor SAFETY path (RESCUE_VIA_EXECUTOR=true). Covers
 * the branch that rescue.test.ts leaves out (src/rescue.ts 181-215): eligible
 * breach routed through the executor — success, misconfig (no executor / no
 * policyId), no-key, and a send failure. Eligibility is exercised via a mocked
 * public client (fresh distressed HF + variable debt); no network.
 */

import { describe, expect, test } from "bun:test";
import { parseUnits } from "viem";
import type { Address, PublicClient } from "viem";
import { Rescuer } from "../src/rescue.ts";
import { RateLimiter } from "../src/eligibility.ts";
import { TxSender } from "../src/tx.ts";
import { endsWithMarker, decodeTag } from "../src/tagger.ts";
import type { Chain } from "../src/chain.ts";
import type { HealthSnapshot } from "../src/monitor.ts";
import type { SubscriberConfig } from "../src/config.ts";
import { makeConfig, silentLog, EOA } from "./_helpers.ts";

const SUB = "0x00000000000000000000000000000000000000b2" as Address;
const VDTOKEN = "0x00000000000000000000000000000000000000c3" as Address;
const EXECUTOR = "0x00000000000000000000000000000000000000e4" as Address;
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address;

function snapshot(): HealthSnapshot {
  return {
    subscriber: SUB,
    healthFactor: parseUnits("1.02", 18),
    hfThreshold: parseUnits("1.05", 18),
    totalCollateralBase: 200n * 10n ** 8n,
    totalDebtBase: 100n * 10n ** 8n,
    hasDebt: true,
    breached: true,
    at: Date.now(),
  };
}

function sub(overrides: Partial<SubscriberConfig> = {}): SubscriberConfig {
  return {
    address: SUB,
    hfThreshold: parseUnits("1.05", 18),
    debtAsset: USDC,
    premiumPaidUntilMs: Date.now() + 3_600_000,
    policyId: 7n,
    ...overrides,
  };
}

/** Eligibility-passing public client (fresh distressed HF, real variable debt). */
function mockPublic(): PublicClient {
  return {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (functionName === "getUserAccountData")
        return [200n * 10n ** 8n, 100n * 10n ** 8n, 0n, 0n, 0n, parseUnits("1.02", 18)];
      if (functionName === "getReserveData") return { variableDebtTokenAddress: VDTOKEN };
      if (functionName === "balanceOf") return address === VDTOKEN ? parseUnits("100", 6) : parseUnits("30", 6);
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

function executorConfig(over: Record<string, unknown> = {}) {
  return makeConfig({
    dryRun: true,
    rescue: { ...makeConfig().rescue, viaExecutor: true, executorAddress: EXECUTOR, ...over },
  });
}

const freshRl = () => new RateLimiter(0, 10, 10_000);

/** Combined public client: eligibility reads + a tx receipt (for real sends). */
function mockPublicWithReceipt(): PublicClient {
  return {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (functionName === "getUserAccountData")
        return [200n * 10n ** 8n, 100n * 10n ** 8n, 0n, 0n, 0n, parseUnits("1.02", 18)];
      if (functionName === "getReserveData") return { variableDebtTokenAddress: VDTOKEN };
      if (functionName === "balanceOf") return address === VDTOKEN ? parseUnits("100", 6) : parseUnits("30", 6);
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 1n }),
  } as unknown as PublicClient;
}

describe("Rescuer.rescueViaExecutor (safety path)", () => {
  test("routes an eligible breach through the executor (real broadcast, tagged)", async () => {
    const pub = mockPublicWithReceipt();
    let sentData = "0x" as `0x${string}`;
    const walletClient = {
      chain: { id: 42220 },
      sendTransaction: async (a: { data: `0x${string}` }) => {
        sentData = a.data;
        return "0xhash" as `0x${string}`;
      },
    };
    const chain: Chain = {
      publicClient: pub,
      walletClient: walletClient as never,
      account: { address: EOA } as never,
    };
    // dryRun=false so the send actually broadcasts and fires the onBroadcast
    // rate-limit hook on the executor leg.
    const config = executorConfig({}) as ReturnType<typeof executorConfig>;
    (config as { dryRun: boolean }).dryRun = false;
    const rl = new RateLimiter(3_600_000, 3, 86_400_000); // real cooldown to observe recording
    const rescuer = new Rescuer(pub, new TxSender(chain, config, silentLog), config, rl, silentLog);

    const out = await rescuer.maybeRescue(snapshot(), sub());
    expect(out.status).toBe("executed");
    expect(out.result?.hash).toBe("0xhash");
    expect(out.result?.status).toBe("success");
    // The safety leg is still ERC-8021-tagged (harmless; it just does not earn C1).
    expect(endsWithMarker(sentData)).toBe(true);
    expect(decodeTag(sentData)!.codes).toEqual(["timo_comato"]);
    // Broadcast consumed the rate-limit budget (recorded via onBroadcast).
    expect(rl.check(SUB, Date.now())).toContain("cooldown");
  });

  test("fails when executorAddress is missing", async () => {
    const pub = mockPublic();
    const chain: Chain = { publicClient: pub, walletClient: {} as never, account: { address: EOA } as never };
    const config = executorConfig({ executorAddress: undefined });
    const rescuer = new Rescuer(pub, new TxSender(chain, config, silentLog), config, freshRl(), silentLog);
    const out = await rescuer.maybeRescue(snapshot(), sub());
    expect(out.status).toBe("failed");
    expect(out.reasons?.some((r) => r.includes("EXECUTOR_ADDRESS and policyId required"))).toBe(true);
  });

  test("fails when the subscriber has no policyId", async () => {
    const pub = mockPublic();
    const chain: Chain = { publicClient: pub, walletClient: {} as never, account: { address: EOA } as never };
    const config = executorConfig();
    const rescuer = new Rescuer(pub, new TxSender(chain, config, silentLog), config, freshRl(), silentLog);
    const out = await rescuer.maybeRescue(snapshot(), sub({ policyId: undefined }));
    expect(out.status).toBe("failed");
    expect(out.reasons?.some((r) => r.includes("EXECUTOR_ADDRESS and policyId required"))).toBe(true);
  });

  test("skips with no key (read-only) even on the executor path", async () => {
    const pub = mockPublic();
    const config = executorConfig();
    const tx = new TxSender({ publicClient: pub }, config, silentLog); // no wallet/account
    const rescuer = new Rescuer(pub, tx, config, freshRl(), silentLog);
    const out = await rescuer.maybeRescue(snapshot(), sub());
    expect(out.status).toBe("skipped_no_key");
  });

  test("returns failed when the executor send throws", async () => {
    const pub = mockPublic();
    const config = executorConfig({}); // dryRun true but we use a stub tx that always throws
    const tx = {
      canSend: true,
      senderAddress: EOA,
      sendTagged: async () => {
        throw new Error("executor send boom");
      },
    } as unknown as TxSender;
    const rescuer = new Rescuer(pub, tx, config, freshRl(), silentLog);
    const out = await rescuer.maybeRescue(snapshot(), sub());
    expect(out.status).toBe("failed");
    expect(out.reasons?.some((r) => r.includes("executor send boom"))).toBe(true);
  });
});
