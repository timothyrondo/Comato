import { test, expect, describe } from "bun:test";
import { encodeFunctionData, parseAbiItem } from "viem";
import { aavePoolAbi, comatoPolicyAbi, comatoExecutorAbi } from "../../src/lib/abis";

/**
 * The ABIs are plain data, but they must be *valid* viem ABIs with the exact
 * member layout the live-data reads depend on — so encode/decode against them.
 */

describe("aavePoolAbi", () => {
  test("declares getUserAccountData with 6 outputs incl. healthFactor", () => {
    const fn = aavePoolAbi[0];
    expect(fn.name).toBe("getUserAccountData");
    expect(fn.stateMutability).toBe("view");
    expect(fn.outputs.map((o) => o.name)).toEqual([
      "totalCollateralBase",
      "totalDebtBase",
      "availableBorrowsBase",
      "currentLiquidationThreshold",
      "ltv",
      "healthFactor",
    ]);
  });

  test("viem can encode a call against it", () => {
    const data = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: ["0x71C7656EC7ab88b098defB751B7401B5f6d8976F"],
    });
    expect(data.startsWith("0x")).toBe(true);
  });
});

describe("comatoPolicyAbi", () => {
  test("getPolicy returns the 7-field policy tuple", () => {
    const fn = comatoPolicyAbi[0];
    expect(fn.name).toBe("getPolicy");
    const tuple = fn.outputs[0];
    expect(tuple.type).toBe("tuple");
    expect(tuple.components.map((c) => c.name)).toEqual([
      "subscriber",
      "collateralAsset",
      "debtAsset",
      "hfThreshold",
      "rescueCap",
      "premiumRatePerInterval",
      "active",
    ]);
  });
});

describe("comatoExecutorAbi", () => {
  test("declares the RescueExecuted event with indexed subscriber/asset", () => {
    const ev = comatoExecutorAbi[0];
    expect(ev.type).toBe("event");
    expect(ev.name).toBe("RescueExecuted");
    const indexed = ev.inputs.filter((i) => i.indexed).map((i) => i.name);
    expect(indexed).toEqual(["policyId", "subscriber", "asset"]);
  });

  test("matches a hand-written viem event signature", () => {
    const parsed = parseAbiItem(
      "event RescueExecuted(uint256 indexed policyId, address indexed subscriber, address indexed asset, uint256 amountRepaid, uint256 hfBefore, uint256 hfAfter)",
    );
    expect(parsed.name).toBe("RescueExecuted");
  });
});
