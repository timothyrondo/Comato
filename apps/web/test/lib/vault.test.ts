import { test, expect, describe } from "bun:test";
import { parseEther, parseUnits } from "viem";
import {
  ZERO_ADDRESS,
  VAULT_DEFAULTS,
  COLLATERAL_OPTIONS,
  DEFAULT_COLLATERAL,
  collateralOptionBySymbol,
  readVaultOf,
  readVaultPosition,
  readVaultTerms,
  readAllowance,
  createVaultTx,
  approveTx,
  supplyTx,
  borrowTx,
  fundingStageOf,
  runFunding,
  type Hex,
  type StepId,
  type StepStatus,
} from "../../src/lib/vault";
import { TOKENS } from "../../src/lib/constants";

/**
 * vault.ts takes its clients as arguments, so the whole create → supply → borrow
 * orchestration is exercised with plain fakes — no network, no viem client. We
 * assert the exact writeContract args (the on-chain call shape) + the receipt is
 * always awaited, plus the resume/skip branches of runFunding.
 */

const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F" as const;
const VAULT = "0x0000000000000000000000000000000000000abc" as const;

interface WriteCall {
  functionName: string;
  args?: readonly unknown[];
  address: string;
  account?: string;
}

function fakeWallet() {
  const calls: WriteCall[] = [];
  let n = 0;
  return {
    calls,
    wallet: {
      writeContract: async (a: WriteCall): Promise<Hex> => {
        calls.push(a);
        n += 1;
        return `0x${"0".repeat(63)}${n}` as Hex;
      },
    },
  };
}

function fakePublic(reads: (functionName: string) => unknown) {
  const receipts: Hex[] = [];
  return {
    receipts,
    client: {
      readContract: async (a: { functionName: string }) => reads(a.functionName),
      waitForTransactionReceipt: async (a: { hash: Hex }) => {
        receipts.push(a.hash);
        return { status: "success" };
      },
    },
  };
}

describe("reads", () => {
  test("readVaultOf → null on the zero address, else the vault", async () => {
    const zero = { readContract: async () => ZERO_ADDRESS };
    const some = { readContract: async () => VAULT };
    expect(await readVaultOf(zero, FACTORY, ACCOUNT)).toBeNull();
    expect(await readVaultOf(some, FACTORY, ACCOUNT)).toBe(VAULT);
  });

  test("readVaultPosition maps the position tuple", async () => {
    const client = { readContract: async () => [1000n, 400n, parseEther("1.8")] };
    const p = await readVaultPosition(client, VAULT);
    expect(p.collateralBase).toBe(1000n);
    expect(p.debtBase).toBe(400n);
    expect(p.hf).toBe(parseEther("1.8"));
  });

  test("readVaultTerms fans out the five term reads", async () => {
    const client = {
      readContract: async (a: { functionName: string }) => {
        switch (a.functionName) {
          case "collateralAsset":
            return TOKENS.CELO;
          case "debtAsset":
            return TOKENS.USDC;
          case "hfThreshold":
            return parseEther("1.3");
          case "targetHf":
            return parseEther("1.6");
          case "operator":
            return ACCOUNT;
          default:
            return 0n;
        }
      },
    };
    const t = await readVaultTerms(client, VAULT);
    expect(t.collateralAsset).toBe(TOKENS.CELO);
    expect(t.debtAsset).toBe(TOKENS.USDC);
    expect(t.hfThreshold).toBe(parseEther("1.3"));
    expect(t.targetHf).toBe(parseEther("1.6"));
    expect(t.operator).toBe(ACCOUNT);
  });

  test("readAllowance returns the bigint allowance", async () => {
    const client = { readContract: async () => 500n };
    expect(await readAllowance(client, TOKENS.CELO, ACCOUNT, VAULT)).toBe(500n);
  });
});

describe("writes construct the correct call + await a receipt", () => {
  test("createVaultTx applies the demo defaults", async () => {
    const { wallet, calls } = fakeWallet();
    const { client, receipts } = fakePublic(() => 0n);
    const hash = await createVaultTx(wallet, client, {
      account: ACCOUNT,
      factory: FACTORY,
      collateralAsset: TOKENS.CELO,
      debtAsset: TOKENS.USDC,
      operator: ACCOUNT,
      feeRecipient: ACCOUNT,
    });
    expect(receipts).toEqual([hash]);
    const call = calls[0];
    expect(call.functionName).toBe("createVault");
    expect(call.address).toBe(FACTORY);
    expect(call.args).toEqual([
      TOKENS.CELO,
      TOKENS.USDC,
      DEFAULT_COLLATERAL.poolFee, // poolFee falls back to the default option (WETH → 3000)
      ACCOUNT,
      ACCOUNT,
      VAULT_DEFAULTS.feeBps,
      VAULT_DEFAULTS.hfThreshold,
      VAULT_DEFAULTS.targetHf,
    ]);
  });

  test("approve / supply / borrow shape their calls", async () => {
    const { wallet, calls } = fakeWallet();
    const { client } = fakePublic(() => 0n);
    await approveTx(wallet, client, ACCOUNT, TOKENS.CELO, VAULT, 42n);
    await supplyTx(wallet, client, ACCOUNT, VAULT, 42n);
    await borrowTx(wallet, client, ACCOUNT, VAULT, 7n);
    expect(calls.map((c) => c.functionName)).toEqual(["approve", "supply", "borrow"]);
    expect(calls[0].args).toEqual([VAULT, 42n]);
    expect(calls[0].address).toBe(TOKENS.CELO);
    expect(calls[1].args).toEqual([42n]);
    expect(calls[1].address).toBe(VAULT);
    expect(calls[2].args).toEqual([7n]);
  });
});

describe("fundingStageOf", () => {
  test("classifies each stage", () => {
    expect(fundingStageOf(false, 0n, 0n)).toBe("none");
    expect(fundingStageOf(true, 0n, 0n)).toBe("awaiting-collateral");
    expect(fundingStageOf(true, 100n, 0n)).toBe("awaiting-borrow");
    expect(fundingStageOf(true, 100n, 50n)).toBe("active");
  });
});

describe("runFunding", () => {
  function tracker() {
    const steps: [StepId, StepStatus][] = [];
    return {
      steps,
      onStep: (id: StepId, status: StepStatus) => steps.push([id, status]),
    };
  }

  test("full run: create → approve (allowance 0) → supply → borrow", async () => {
    const { wallet, calls } = fakeWallet();
    const { client } = fakePublic((fn) => {
      if (fn === "vaultOf") return VAULT; // resolved after create
      if (fn === "allowance") return 0n; // needs approve
      return 0n;
    });
    const t = tracker();
    const out = await runFunding({
      wallet,
      publicClient: client,
      account: ACCOUNT,
      factory: FACTORY,
      operator: ACCOUNT,
      feeRecipient: ACCOUNT,
      collateralAsset: TOKENS.CELO,
      debtAsset: TOKENS.USDC,
      existingVault: null,
      supplyAmount: parseUnits("5", 18),
      borrowAmount: parseUnits("3", 6),
      need: { create: true, supply: true, borrow: true },
      onStep: t.onStep,
    });
    expect(out.vault).toBe(VAULT);
    expect(calls.map((c) => c.functionName)).toEqual([
      "createVault",
      "approve",
      "supply",
      "borrow",
    ]);
    // every step reaches "done"
    expect(t.steps).toContainEqual(["create", "done"]);
    expect(t.steps).toContainEqual(["supply", "done"]);
    expect(t.steps).toContainEqual(["borrow", "done"]);
  });

  test("skips approve when the allowance already covers the supply", async () => {
    const { wallet, calls } = fakeWallet();
    const { client } = fakePublic((fn) => (fn === "allowance" ? parseUnits("100", 18) : 0n));
    await runFunding({
      wallet,
      publicClient: client,
      account: ACCOUNT,
      factory: FACTORY,
      operator: ACCOUNT,
      feeRecipient: ACCOUNT,
      collateralAsset: TOKENS.CELO,
      debtAsset: TOKENS.USDC,
      existingVault: VAULT,
      supplyAmount: parseUnits("5", 18),
      borrowAmount: parseUnits("3", 6),
      need: { create: false, supply: true, borrow: true },
    });
    expect(calls.map((c) => c.functionName)).toEqual(["supply", "borrow"]);
  });

  test("resume awaiting-borrow only borrows", async () => {
    const { wallet, calls } = fakeWallet();
    const { client } = fakePublic(() => 0n);
    await runFunding({
      wallet,
      publicClient: client,
      account: ACCOUNT,
      factory: FACTORY,
      operator: ACCOUNT,
      feeRecipient: ACCOUNT,
      collateralAsset: TOKENS.CELO,
      debtAsset: TOKENS.USDC,
      existingVault: VAULT,
      supplyAmount: 0n,
      borrowAmount: parseUnits("3", 6),
      need: { create: false, supply: false, borrow: true },
    });
    expect(calls.map((c) => c.functionName)).toEqual(["borrow"]);
  });

  test("throws when the vault can't be resolved after create", async () => {
    const { wallet } = fakeWallet();
    const { client } = fakePublic(() => ZERO_ADDRESS); // vaultOf stays zero
    await expect(
      runFunding({
        wallet,
        publicClient: client,
        account: ACCOUNT,
        factory: FACTORY,
        operator: ACCOUNT,
        feeRecipient: ACCOUNT,
        collateralAsset: TOKENS.CELO,
        debtAsset: TOKENS.USDC,
        existingVault: null,
        supplyAmount: 1n,
        borrowAmount: 1n,
        need: { create: true, supply: true, borrow: true },
      }),
    ).rejects.toThrow("Vault address unavailable");
  });
});

describe("collateral options drive createVault + supply", () => {
  test("shape: WETH default (→USDT, fee 3000); USDT + USDm (→USDC, fee 100)", () => {
    expect(DEFAULT_COLLATERAL).toBe(COLLATERAL_OPTIONS[0]);

    const weth = COLLATERAL_OPTIONS[0];
    expect(weth.symbol).toBe("WETH");
    expect(weth.collateralAddr).toBe(TOKENS.WETH);
    expect(weth.collateralDecimals).toBe(18);
    expect(weth.debtSymbol).toBe("USDT");
    expect(weth.debtAddr).toBe(TOKENS.USDT);
    expect(weth.debtDecimals).toBe(6);
    expect(weth.poolFee).toBe(3000);

    const usdt = COLLATERAL_OPTIONS[1];
    expect(usdt.symbol).toBe("USDT");
    expect(usdt.collateralAddr).toBe(TOKENS.USDT);
    expect(usdt.collateralDecimals).toBe(6);
    expect(usdt.debtAddr).toBe(TOKENS.USDC);
    expect(usdt.poolFee).toBe(100);

    const usdm = COLLATERAL_OPTIONS[2];
    expect(usdm.symbol).toBe("USDm");
    expect(usdm.collateralAddr).toBe(TOKENS.USDm);
    expect(usdm.collateralDecimals).toBe(18);
    expect(usdm.debtAddr).toBe(TOKENS.USDC);
    expect(usdm.poolFee).toBe(100);
  });

  test("collateralOptionBySymbol resolves known symbols, else the default", () => {
    expect(collateralOptionBySymbol("USDm")).toBe(COLLATERAL_OPTIONS[2]);
    expect(collateralOptionBySymbol("WETH")).toBe(COLLATERAL_OPTIONS[0]);
    expect(collateralOptionBySymbol("CELO")).toBe(DEFAULT_COLLATERAL); // unknown → default
  });

  // The core of the "dynamic collateral" change: the picked option must change
  // the collateral address + decimals + poolFee that reach createVault/supply.
  async function runWith(opt: typeof COLLATERAL_OPTIONS[number]) {
    const { wallet, calls } = fakeWallet();
    const { client } = fakePublic((fn) => {
      if (fn === "vaultOf") return VAULT;
      if (fn === "allowance") return 0n;
      return 0n;
    });
    await runFunding({
      wallet,
      publicClient: client,
      account: ACCOUNT,
      factory: FACTORY,
      operator: ACCOUNT,
      feeRecipient: ACCOUNT,
      collateralAsset: opt.collateralAddr,
      debtAsset: opt.debtAddr,
      poolFee: opt.poolFee,
      existingVault: null,
      supplyAmount: parseUnits(opt.defaultSupply, opt.collateralDecimals),
      borrowAmount: parseUnits(opt.defaultBorrow, opt.debtDecimals),
      need: { create: true, supply: true, borrow: true },
    });
    return calls;
  }

  test("selecting USDm → USDm/USDC + fee 100 + 18-decimal supply amount", async () => {
    const calls = await runWith(collateralOptionBySymbol("USDm"));
    const create = calls.find((c) => c.functionName === "createVault");
    // createVault args: [collateral, debt, poolFee, operator, feeRecipient, feeBps, hf, target]
    expect(create?.args?.[0]).toBe(TOKENS.USDm);
    expect(create?.args?.[1]).toBe(TOKENS.USDC);
    expect(create?.args?.[2]).toBe(100);
    const supply = calls.find((c) => c.functionName === "supply");
    expect(supply?.args?.[0]).toBe(parseUnits("15", 18));
  });

  test("selecting WETH (default) → WETH/USDT + fee 3000 + 18-decimal supply amount", async () => {
    const calls = await runWith(DEFAULT_COLLATERAL);
    const create = calls.find((c) => c.functionName === "createVault");
    expect(create?.args?.[0]).toBe(TOKENS.WETH);
    expect(create?.args?.[1]).toBe(TOKENS.USDT);
    expect(create?.args?.[2]).toBe(3000);
    const supply = calls.find((c) => c.functionName === "supply");
    expect(supply?.args?.[0]).toBe(parseUnits("0.02", 18));
  });
});
