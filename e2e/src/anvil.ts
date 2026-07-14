/**
 * Local Celo-mainnet fork harness: spawn/kill anvil, viem read/write/test
 * clients, deterministic token funding (impersonate an aToken and transfer),
 * viem-based contract deployment from forge artifacts, and the Aave V3
 * "edge position" setup (supply collateral, borrow to ~99% of LTV → HF just
 * above 1) that mirrors packages/contracts/test/ComatoRescueFork.t.sol.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import {
  RPC_URL,
  RPC_PORT,
  FORK_URL,
  FORK_BLOCK,
  CHAIN_ID,
  POOL,
  USDC,
  USDT,
  aUSDC,
  aUSDT,
  USDC_UNIT,
  TX_TIMEOUT_MS,
} from "./constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_OUT = resolve(__dirname, "../../packages/contracts/out");

/** Anvil fork chain: real Celo id, but RPC pointed at the local fork. */
export const forkChain = {
  ...celo,
  id: CHAIN_ID,
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

// retryCount: 2 tolerates transient forno hiccups surfaced through anvil.
const transport = () => http(RPC_URL, { timeout: TX_TIMEOUT_MS, retryCount: 2 });

const poolAbi = parseAbi([
  "function getUserAccountData(address) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
  "function supply(address,uint256,address,uint16)",
  "function borrow(address,uint256,uint256,uint16,address)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

// Explicit gas limit for setup txs. viem's eth_estimateGas on an anvil fork can
// under-estimate the 2nd Aave `borrow` (variable-debt mint + user-config bit),
// making the mined tx run out of gas even though it would succeed — so we skip
// estimation for deterministic setup writes. Well under anvil's 30M block limit.
const SETUP_GAS = 6_000_000n;

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

function loadArtifact(sol: string, name: string): Artifact {
  const path = `${CONTRACTS_OUT}/${sol}/${name}.json`;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { abi: raw.abi as Abi, bytecode: raw.bytecode.object as Hex };
}

export class AnvilFork {
  private proc?: ChildProcess;
  readonly pub: PublicClient;
  readonly test: ReturnType<typeof createTestClient>;

  constructor() {
    this.pub = createPublicClient({ chain: forkChain, transport: transport() }) as PublicClient;
    this.test = createTestClient({ chain: forkChain, mode: "anvil", transport: transport() });
  }

  /** Spawn `anvil --fork-url <celo> --chain-id 42220` and wait until ready. */
  async start(): Promise<void> {
    const args = [
      "--fork-url",
      FORK_URL,
      "--chain-id",
      String(CHAIN_ID),
      "--port",
      String(RPC_PORT),
      // Make forked-state fetches robust: retry spurious forno errors and allow a
      // generous per-request timeout so a slow archive read can't silently corrupt
      // a tx's execution (which would otherwise revert with wrong state).
      "--retries",
      "10",
      "--timeout",
      "120000",
      "--silent",
    ];
    if (FORK_BLOCK) args.push("--fork-block-number", FORK_BLOCK);
    this.proc = spawn("anvil", args, { stdio: "ignore" });
    this.proc.on("exit", (code) => {
      if (code && code !== 0 && code !== 143) console.error(`anvil exited with code ${code}`);
    });
    for (let i = 0; i < 120; i++) {
      try {
        if ((await this.pub.getChainId()) === CHAIN_ID) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("anvil did not become ready within 60s");
  }

  stop(): void {
    this.proc?.kill("SIGKILL");
  }

  wallet(account: Account | Address): WalletClient {
    return createWalletClient({ account, chain: forkChain, transport: transport() });
  }

  /** Wait for `hash` and REQUIRE it succeeded — a reverted setup tx must fail loud. */
  async mineTx(hash: Hex, label = "tx") {
    const rcpt = await this.pub.waitForTransactionReceipt({ hash, timeout: TX_TIMEOUT_MS, pollingInterval: 500 });
    if (rcpt.status !== "success") {
      throw new Error(`${label} reverted on-chain (hash ${hash}) — setup cannot continue`);
    }
    return rcpt;
  }

  /** Fund `holder` with `value` of `token` by impersonating a whale `source`. */
  async deal(token: Address, holder: Address, value: bigint, source: Address): Promise<void> {
    await this.test.setBalance({ address: source, value: 10n ** 18n });
    await this.test.impersonateAccount({ address: source });
    const w = this.wallet(source);
    const hash = await w.writeContract({
      account: source,
      chain: forkChain,
      address: token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [holder, value],
      gas: SETUP_GAS,
    });
    await this.mineTx(hash, `deal ${token}`);
    await this.test.stopImpersonatingAccount({ address: source });
  }

  async balanceOf(token: Address, who: Address): Promise<bigint> {
    return this.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  }

  async healthFactor(user: Address): Promise<bigint> {
    const [, , , , , hf] = await this.pub.readContract({
      address: POOL,
      abi: poolAbi,
      functionName: "getUserAccountData",
      args: [user],
    });
    return hf;
  }

  async accountData(user: Address) {
    const [totalCollateralBase, totalDebtBase, availableBorrowsBase, , , healthFactor] =
      await this.pub.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "getUserAccountData",
        args: [user],
      });
    return { totalCollateralBase, totalDebtBase, availableBorrowsBase, healthFactor };
  }

  /** Deploy a compiled contract via viem, return its address. */
  async deploy(deployer: Account, art: Artifact, args: readonly unknown[]): Promise<Address> {
    const w = this.wallet(deployer);
    const hash = await w.deployContract({
      account: deployer,
      chain: forkChain,
      abi: art.abi,
      bytecode: art.bytecode,
      args: args as never,
      gas: SETUP_GAS,
    });
    const rcpt = await this.mineTx(hash, "deploy");
    if (!rcpt.contractAddress) throw new Error("deploy: no contractAddress in receipt");
    return rcpt.contractAddress;
  }

  /**
   * Open a "sitting at the edge of liquidation" position for `sub`: deal USDT
   * collateral, supply it, borrow USDC to ~99% of the available LTV headroom so
   * the health factor lands just above 1. Mirrors the Foundry fork test.
   * @returns the borrowed USDC amount and the resulting HF.
   */
  async openEdgePosition(
    subKey: Hex,
    collateralUsdt = 2000n * USDC_UNIT,
  ): Promise<{ borrowedUsdc: bigint; hf: bigint }> {
    const sub = privateKeyToAccount(subKey);
    await this.deal(USDT, sub.address, collateralUsdt, aUSDT);

    const w = this.wallet(sub);
    let hash = await w.writeContract({
      account: sub,
      chain: forkChain,
      address: USDT,
      abi: erc20Abi,
      functionName: "approve",
      args: [POOL, collateralUsdt],
      gas: SETUP_GAS,
    });
    await this.mineTx(hash, `${sub.address} approve USDT`);
    hash = await w.writeContract({
      account: sub,
      chain: forkChain,
      address: POOL,
      abi: poolAbi,
      functionName: "supply",
      args: [USDT, collateralUsdt, sub.address, 0],
      gas: SETUP_GAS,
    });
    await this.mineTx(hash, `${sub.address} supply USDT`);

    const { availableBorrowsBase } = await this.accountData(sub.address);
    // Base currency = USD, 8 dec; USDC ~ $1, 6 dec => USDC ≈ base / 1e2.
    const borrowedUsdc = (availableBorrowsBase * 99n) / 100n / 100n;
    hash = await w.writeContract({
      account: sub,
      chain: forkChain,
      address: POOL,
      abi: poolAbi,
      functionName: "borrow",
      args: [USDC, borrowedUsdc, 2n, 0, sub.address],
      gas: SETUP_GAS,
    });
    await this.mineTx(hash, `${sub.address} borrow USDC`);

    const hf = await this.healthFactor(sub.address);
    return { borrowedUsdc, hf };
  }
}

export { loadArtifact, poolAbi, erc20Abi, formatUnits };
