/**
 * ComatoVault read + write helpers for the browser subscribe flow.
 *
 * Reads shape the live vault position; writes are the USER's own actions
 * (createVault → approve → supply → borrow), each a signed txn awaited to a
 * receipt. Every function takes its clients as arguments (no hidden globals) so
 * the orchestration is unit-testable with plain fakes — the components pass the
 * real injected-wallet clients from `lib/wallet.ts`.
 *
 * The OPERATOR-only `deleverage` is deliberately absent: the browser drives the
 * subscriber, the off-chain agent performs the rescue.
 */

import { parseEther, type Address } from "viem";
import { comatoVaultAbi, comatoVaultFactoryAbi, erc20Abi } from "./abis";
import { walletChain } from "./wallet";

export type Hex = `0x${string}`;

export const ZERO_ADDRESS: Address =
  "0x0000000000000000000000000000000000000000";

/** createVault defaults for the demo (collateral USDT → debt USDC). CELO cannot be Aave
 *  collateral on Celo today — its supply cap is full — so the position uses USDT collateral;
 *  the USDT->USDC deleverage swap is liquid on the fee-100 pool. */
export const VAULT_DEFAULTS = {
  poolFee: 100,
  feeBps: 500n,
  /** Rescue fires strictly below this WAD health factor. */
  hfThreshold: parseEther("1.3"),
  /** Ceiling a rescue may lift HF to (bounds over-deleverage). */
  targetHf: parseEther("1.6"),
  /** USDT collateral decimals. */
  collateralDecimals: 6,
  /** USDC debt decimals. */
  debtDecimals: 6,
} as const;

/* ── Structural client types (viem clients satisfy these; fakes can too) ──
   `any`-typed params are deliberate: viem's `readContract`/`writeContract` are
   heavily-overloaded generic methods, and a narrower param here would make the
   real client fail to structurally match (parameter contravariance). */

export interface ReadClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract: (args: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitForTransactionReceipt: (args: any) => Promise<any>;
}
export interface WriteClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeContract: (args: any) => Promise<Hex>;
}

/* ── Reads ──────────────────────────────────────────────── */

/** The caller's vault address, or `null` when they have none yet. */
export async function readVaultOf(
  client: Pick<ReadClient, "readContract">,
  factory: Address,
  account: Address,
): Promise<Address | null> {
  const vault = (await client.readContract({
    address: factory,
    abi: comatoVaultFactoryAbi,
    functionName: "vaultOf",
    args: [account],
  })) as Address;
  return vault && vault !== ZERO_ADDRESS ? vault : null;
}

export interface RawPosition {
  collateralBase: bigint;
  debtBase: bigint;
  hf: bigint;
}

/** Live position of a vault: collateral/debt in Aave base units (USD, 8dp), HF in WAD. */
export async function readVaultPosition(
  client: Pick<ReadClient, "readContract">,
  vault: Address,
): Promise<RawPosition> {
  const [collateralBase, debtBase, hf] = (await client.readContract({
    address: vault,
    abi: comatoVaultAbi,
    functionName: "position",
  })) as [bigint, bigint, bigint];
  return { collateralBase, debtBase, hf };
}

export interface VaultTerms {
  collateralAsset: Address;
  debtAsset: Address;
  hfThreshold: bigint;
  targetHf: bigint;
  operator: Address;
}

/** The static terms a vault was created with (assets, thresholds, operator). */
export async function readVaultTerms(
  client: Pick<ReadClient, "readContract">,
  vault: Address,
): Promise<VaultTerms> {
  const read = (functionName: string) =>
    client.readContract({ address: vault, abi: comatoVaultAbi, functionName });
  const [collateralAsset, debtAsset, hfThreshold, targetHf, operator] =
    await Promise.all([
      read("collateralAsset") as Promise<Address>,
      read("debtAsset") as Promise<Address>,
      read("hfThreshold") as Promise<bigint>,
      read("targetHf") as Promise<bigint>,
      read("operator") as Promise<Address>,
    ]);
  return { collateralAsset, debtAsset, hfThreshold, targetHf, operator };
}

/** Current ERC-20 allowance the owner has granted the spender. */
export async function readAllowance(
  client: Pick<ReadClient, "readContract">,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
}

/* ── Writes (each awaits its receipt) ───────────────────── */

async function send(
  wallet: WriteClient,
  publicClient: Pick<ReadClient, "waitForTransactionReceipt">,
  args: Record<string, unknown>,
): Promise<Hex> {
  const hash = await wallet.writeContract(args);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export interface CreateVaultParams {
  account: Address;
  factory: Address;
  collateralAsset: Address;
  debtAsset: Address;
  operator: Address;
  feeRecipient: Address;
  poolFee?: number;
  feeBps?: bigint;
  hfThreshold?: bigint;
  targetHf?: bigint;
}

/** Deploy the caller's own vault via the factory. */
export async function createVaultTx(
  wallet: WriteClient,
  publicClient: Pick<ReadClient, "waitForTransactionReceipt">,
  p: CreateVaultParams,
): Promise<Hex> {
  return send(wallet, publicClient, {
    address: p.factory,
    abi: comatoVaultFactoryAbi,
    functionName: "createVault",
    args: [
      p.collateralAsset,
      p.debtAsset,
      p.poolFee ?? VAULT_DEFAULTS.poolFee,
      p.operator,
      p.feeRecipient,
      p.feeBps ?? VAULT_DEFAULTS.feeBps,
      p.hfThreshold ?? VAULT_DEFAULTS.hfThreshold,
      p.targetHf ?? VAULT_DEFAULTS.targetHf,
    ],
    account: p.account,
    chain: walletChain,
  });
}

/** ERC-20 approve — the vault pulls collateral via transferFrom, so `supply` needs it. */
export async function approveTx(
  wallet: WriteClient,
  publicClient: Pick<ReadClient, "waitForTransactionReceipt">,
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<Hex> {
  return send(wallet, publicClient, {
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
    account,
    chain: walletChain,
  });
}

/** Supply collateral into the vault (pulled from the subscriber). */
export async function supplyTx(
  wallet: WriteClient,
  publicClient: Pick<ReadClient, "waitForTransactionReceipt">,
  account: Address,
  vault: Address,
  amount: bigint,
): Promise<Hex> {
  return send(wallet, publicClient, {
    address: vault,
    abi: comatoVaultAbi,
    functionName: "supply",
    args: [amount],
    account,
    chain: walletChain,
  });
}

/** Borrow the debt asset against the vault's collateral (sent to the subscriber). */
export async function borrowTx(
  wallet: WriteClient,
  publicClient: Pick<ReadClient, "waitForTransactionReceipt">,
  account: Address,
  vault: Address,
  amount: bigint,
): Promise<Hex> {
  return send(wallet, publicClient, {
    address: vault,
    abi: comatoVaultAbi,
    functionName: "borrow",
    args: [amount],
    account,
    chain: walletChain,
  });
}

/* ── Funding stage + orchestration ──────────────────────── */

export type FundingStage =
  | "none" // no vault yet
  | "awaiting-collateral" // vault exists, no collateral supplied
  | "awaiting-borrow" // collateral in, nothing borrowed
  | "active"; // fully funded + monitored

/** Classify how far along the create → supply → borrow flow a position is. */
export function fundingStageOf(
  hasVault: boolean,
  collateralBase: bigint,
  debtBase: bigint,
): FundingStage {
  if (!hasVault) return "none";
  if (collateralBase === 0n) return "awaiting-collateral";
  if (debtBase === 0n) return "awaiting-borrow";
  return "active";
}

export type StepId = "create" | "supply" | "borrow";
export type StepStatus = "idle" | "active" | "done" | "error";

export interface RunFundingParams {
  wallet: WriteClient;
  publicClient: ReadClient;
  account: Address;
  factory: Address;
  operator: Address;
  feeRecipient: Address;
  collateralAsset: Address;
  debtAsset: Address;
  /** Existing vault (resume) or null to create one. */
  existingVault: Address | null;
  supplyAmount: bigint;
  borrowAmount: bigint;
  /** Which steps still need doing (derived from the funding stage). */
  need: { create: boolean; supply: boolean; borrow: boolean };
  onStep?: (id: StepId, status: StepStatus, note?: string) => void;
}

/**
 * Run the create → approve+supply → borrow sequence, resuming from wherever the
 * position already is. Each step reports progress via `onStep`. Throws on the
 * first failure (the caller marks that step errored and lets the user retry).
 */
export async function runFunding(
  p: RunFundingParams,
): Promise<{ vault: Address }> {
  let vault = p.existingVault;

  if (p.need.create) {
    p.onStep?.("create", "active");
    await createVaultTx(p.wallet, p.publicClient, {
      account: p.account,
      factory: p.factory,
      collateralAsset: p.collateralAsset,
      debtAsset: p.debtAsset,
      operator: p.operator,
      feeRecipient: p.feeRecipient,
    });
    vault = await readVaultOf(p.publicClient, p.factory, p.account);
    p.onStep?.("create", "done");
  }

  if (!vault) throw new Error("Vault address unavailable after create");

  if (p.need.supply) {
    p.onStep?.("supply", "active", "approving");
    const allowance = await readAllowance(
      p.publicClient,
      p.collateralAsset,
      p.account,
      vault,
    );
    if (allowance < p.supplyAmount) {
      await approveTx(
        p.wallet,
        p.publicClient,
        p.account,
        p.collateralAsset,
        vault,
        p.supplyAmount,
      );
    }
    p.onStep?.("supply", "active", "supplying");
    await supplyTx(p.wallet, p.publicClient, p.account, vault, p.supplyAmount);
    p.onStep?.("supply", "done");
  }

  if (p.need.borrow) {
    p.onStep?.("borrow", "active");
    await borrowTx(p.wallet, p.publicClient, p.account, vault, p.borrowAmount);
    p.onStep?.("borrow", "done");
  }

  return { vault };
}
