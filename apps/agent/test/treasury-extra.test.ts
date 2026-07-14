/**
 * treasury.ts — the branches treasury.test.ts leaves out (src/treasury.ts
 * 203-219): a swap leg whose send throws (=> "failed" with reason) and the full
 * runCycle round-trip. Offline: TxSender is a stub.
 */

import { describe, expect, test } from "bun:test";
import { parseUnits } from "viem";
import type { Address, PublicClient } from "viem";
import { Treasury } from "../src/treasury.ts";
import { TxSender } from "../src/tx.ts";
import type { Chain } from "../src/chain.ts";
import { makeConfig, silentLog, EOA } from "./_helpers.ts";

/** Public client with a huge balance + allowance so guards pass. */
function mockPublic(balance: bigint): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return 2n ** 255n;
      if (functionName === "balanceOf") return balance;
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe("treasury.runLeg failure", () => {
  test("returns 'failed' with the error reason when the swap send throws", async () => {
    const config = makeConfig();
    const tx = {
      canSend: true,
      senderAddress: EOA,
      balanceOf: async () => parseUnits("100", 6),
      ensureApproval: async () => {},
      sendTagged: async () => {
        throw new Error("swap send boom");
      },
    } as unknown as TxSender;
    const treasury = new Treasury(tx, config, silentLog);
    const leg = treasury.buildCycle()[0]!;
    const out = await treasury.runLeg(leg);
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("swap send boom");
  });
});

describe("treasury.runCycle", () => {
  test("runs both legs of a round-trip in dry-run", async () => {
    const config = makeConfig({ dryRun: true });
    const chain: Chain = {
      publicClient: mockPublic(parseUnits("100", 6)),
      walletClient: {} as never,
      account: { address: EOA } as never,
    };
    const treasury = new Treasury(new TxSender(chain, config, silentLog), config, silentLog);
    const outcomes = await treasury.runCycle();
    expect(outcomes.length).toBe(2);
    expect(outcomes.every((o) => o.status === "swapped")).toBe(true);
  });

  test("single-leg cycle when roundTrip is disabled", async () => {
    const config = makeConfig({ dryRun: true, treasury: { ...makeConfig().treasury, roundTrip: false } });
    const chain: Chain = {
      publicClient: mockPublic(parseUnits("100", 6)) as PublicClient,
      walletClient: {} as never,
      account: { address: EOA } as never,
    };
    const treasury = new Treasury(new TxSender(chain, config, silentLog), config, silentLog);
    const outcomes = await treasury.runCycle();
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.status).toBe("swapped");
  });
});
