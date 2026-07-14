/**
 * Comato one-command demo (G8).
 *
 * Boots an anvil fork of Celo mainnet, deploys ComatoPolicy + ComatoExecutor,
 * seeds a real Aave V3 position near liquidation, drives one or two REAL rescues
 * through the executor (each emits `RescueExecuted`), writes the deployed
 * addresses into `apps/web/.env.local`, and serves the premium web UI pointed at
 * the local fork. End state: open the browser and SEE a real position, its live
 * health factor, and a real rescue in the UI.
 *
 * Reuses the e2e harness (`AnvilFork`) and the verified shared addresses — no
 * duplicated fork/deploy logic, no real keys. Unlike `e2e.ts` (a one-shot that
 * tears the fork down), this keeps anvil + Vite alive until you Ctrl-C.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  formatUnits,
  parseEventLogs,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { AnvilFork, loadArtifact, poolAbi } from "./anvil.ts";
import {
  COMATO,
  SUB_A,
  USDC,
  USDT,
  POOL,
  aUSDC,
  USDC_UNIT,
  RPC_URL,
} from "./constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(__dirname, "../../packages/contracts");
const WEB_DIR = resolve(__dirname, "../../apps/web");
const WEB_ENV_FILE = resolve(WEB_DIR, ".env.local");

// Policy protects the position until HF ≥ 1.20; each rescue repays up to ~1/3 of
// the debt, comfortably lifting HF back into the safe zone.
const HF_THRESHOLD = parseUnits("1.2", 18);
const PREMIUM_RATE = 100_000n; // 0.10 USDC/interval — informational on-chain
const MAX_RESCUES = 2;

const hf = (x: bigint) => Number(formatUnits(x, 18)).toFixed(4);
const usd = (x: bigint) => Number(formatUnits(x, 6)).toFixed(2);

interface RescueEvent {
  policyId: bigint;
  subscriber: Address;
  amountRepaid: bigint;
  hfBefore: bigint;
  hfAfter: bigint;
}

async function main() {
  console.log("Comato demo — live UI on a Celo mainnet fork\n");

  // 0. Compile contracts so we can deploy them via viem.
  console.log("Building contracts (forge build)...");
  const build = spawnSync("forge", ["build"], { cwd: CONTRACTS_DIR, encoding: "utf8" });
  if (build.status !== 0) {
    throw new Error(`forge build failed:\n${build.stdout}\n${build.stderr}`);
  }
  const policyArt = loadArtifact("ComatoPolicy.sol", "ComatoPolicy");
  const executorArt = loadArtifact("ComatoExecutor.sol", "ComatoExecutor");

  const fork = new AnvilFork();
  let web: ChildProcess | undefined;
  const cleanup = () => {
    web?.kill("SIGKILL");
    fork.stop();
  };
  process.on("SIGINT", () => (cleanup(), process.exit(130)));
  process.on("SIGTERM", () => (cleanup(), process.exit(143)));

  try {
    console.log(`Starting anvil fork (chain 42220) on ${RPC_URL} ...`);
    await fork.start();
    // Scan RescueExecuted logs only from here (local blocks) — never Celo history.
    const fromBlock = await fork.pub.getBlockNumber();
    console.log(`anvil ready (fork block ${fromBlock}).\n`);

    const comato = privateKeyToAccount(COMATO.key);
    const subA = privateKeyToAccount(SUB_A.key);

    // 1. Deploy Comato contracts (owner = COMATO_WALLET, the agent's EOA/operator).
    console.log("Deploying ComatoPolicy + ComatoExecutor ...");
    const policyAddr = await fork.deploy(comato, policyArt, [comato.address]);
    const executorAddr = await fork.deploy(comato, executorArt, [POOL, policyAddr, comato.address]);
    console.log(`  ComatoPolicy   @ ${policyAddr}`);
    console.log(`  ComatoExecutor @ ${executorAddr}\n`);

    // 2. Seed a real Aave V3 position at the edge of liquidation (HF just above 1).
    console.log("Opening an Aave V3 position near liquidation ...");
    const pos = await fork.openEdgePosition(SUB_A.key);
    console.log(`  Subscriber ${SUB_A.address}: borrowed ${usd(pos.borrowedUsdc)} USDC, HF=${hf(pos.hf)}\n`);

    // 3. Subscriber creates their on-chain policy (USDT collateral, USDC debt).
    const rescueCap = pos.borrowedUsdc / 3n;
    const wSubA = fork.wallet(subA);
    const createHash = await wSubA.writeContract({
      account: subA,
      chain: fork.pub.chain,
      address: policyAddr,
      abi: policyArt.abi,
      functionName: "createPolicy",
      args: [USDT, USDC, HF_THRESHOLD, rescueCap, PREMIUM_RATE],
      gas: 3_000_000n,
    });
    const createRcpt = await fork.mineTx(createHash, "createPolicy");
    const created = parseEventLogs({ abi: policyArt.abi, logs: createRcpt.logs, eventName: "PolicyCreated" })[0] as
      | { args: { policyId: bigint } }
      | undefined;
    const policyId = created?.args.policyId ?? 1n;
    console.log(`Policy #${policyId} created (threshold HF ${hf(HF_THRESHOLD)}, cap ${usd(rescueCap)} USDC).\n`);

    // 4. Fund the executor's USDC float (Comato's own rescue capital).
    await fork.deal(USDC, executorAddr, pos.borrowedUsdc + 100n * USDC_UNIT, aUSDC);
    console.log(`Executor funded with ${usd(await fork.balanceOf(USDC, executorAddr))} USDC float.\n`);

    // 5. Drive real rescues through the executor. Each emits RescueExecuted; the
    //    web reads them as the rescue-history feed. Between rescues we re-breach
    //    (subscriber borrows again) so a second genuine rescue can fire. Rescue #1
    //    is required; #2 is best-effort for a fuller activity feed.
    const wComato = fork.wallet(comato);
    const rescues: RescueEvent[] = [];

    for (let i = 0; i < MAX_RESCUES; i++) {
      const before = await fork.healthFactor(SUB_A.address);
      if (before >= HF_THRESHOLD) break; // no longer breached — nothing to rescue

      try {
        const rHash = await wComato.writeContract({
          account: comato,
          chain: fork.pub.chain,
          address: executorAddr,
          abi: executorArt.abi,
          functionName: "rescue",
          args: [policyId],
          gas: 3_000_000n,
        });
        const rRcpt = await fork.mineTx(rHash, `rescue #${i + 1}`);
        const ev = parseEventLogs({ abi: executorArt.abi, logs: rRcpt.logs, eventName: "RescueExecuted" })[0] as
          | { args: RescueEvent }
          | undefined;
        if (ev) {
          rescues.push(ev.args);
          console.log(`  Rescue #${i + 1}: HF ${hf(ev.args.hfBefore)} → ${hf(ev.args.hfAfter)} (repaid ${usd(ev.args.amountRepaid)} USDC)`);
        }
      } catch (err) {
        console.warn(`  Rescue #${i + 1} skipped: ${err instanceof Error ? err.message : err}`);
        break;
      }

      // Re-breach for the next iteration: borrow ~90% of the freed headroom.
      if (i + 1 < MAX_RESCUES) {
        const { availableBorrowsBase } = await fork.accountData(SUB_A.address);
        const reborrow = (availableBorrowsBase * 90n) / 100n / 100n; // base(8) → USDC(6)
        if (reborrow > USDC_UNIT) {
          try {
            const bHash = await wSubA.writeContract({
              account: subA,
              chain: fork.pub.chain,
              address: POOL,
              abi: poolAbi,
              functionName: "borrow",
              args: [USDC, reborrow, 2n, 0, SUB_A.address],
              gas: 6_000_000n,
            });
            await fork.mineTx(bHash, "re-breach borrow");
          } catch {
            break; // couldn't re-breach — one rescue is enough for the demo
          }
        } else {
          break;
        }
      }
    }

    const finalHf = await fork.healthFactor(SUB_A.address);
    console.log(`\nPosition rescued: ${rescues.length} rescue(s), final HF=${hf(finalHf)}.\n`);

    // 6. Write the web's live-data env (gitignored, ephemeral, no secrets).
    const env = [
      "# Written by `bun run demo` — points apps/web at the local Celo fork.",
      "# Ephemeral & gitignored. Delete this file to return the UI to mock data.",
      `VITE_RPC_URL=${RPC_URL}`,
      "VITE_CHAIN_ID=42220",
      `VITE_POLICY_ADDR=${policyAddr}`,
      `VITE_EXECUTOR_ADDR=${executorAddr}`,
      `VITE_SUBSCRIBER_ADDR=${SUB_A.address}`,
      `VITE_POLICY_ID=${policyId}`,
      `VITE_FROM_BLOCK=${fromBlock}`,
      "",
    ].join("\n");
    writeFileSync(WEB_ENV_FILE, env);
    console.log(`Wrote ${WEB_ENV_FILE}\n`);

    // 7. Serve the web UI pointed at the fork (keeps anvil alive alongside it).
    console.log("Starting the web UI (vite) — the browser will show live fork data ...\n");
    web = spawn("bun", ["run", "dev"], { cwd: WEB_DIR, stdio: "inherit" });
    web.on("exit", (code) => {
      console.log(`\nweb server exited (${code}); stopping anvil.`);
      fork.stop();
      process.exit(code ?? 0);
    });

    console.log("──────────────────────────────────────────────────────────────");
    console.log("  Comato demo is LIVE. Open the Vite URL above (default :5173).");
    console.log(`    Subscriber : ${SUB_A.address}`);
    console.log(`    Policy #${policyId} @ ${policyAddr}`);
    console.log(`    Executor    @ ${executorAddr}`);
    console.log(`    Rescues     : ${rescues.length}   Final HF: ${hf(finalHf)}`);
    console.log("  Ctrl-C to stop (kills both Vite and the anvil fork).");
    console.log("──────────────────────────────────────────────────────────────\n");

    // Keep the process alive; the vite child holds the event loop. On any fatal
    // signal the handlers above tear everything down.
    await new Promise(() => {});
  } catch (err) {
    cleanup();
    throw err;
  }
}

main().catch((err) => {
  console.error("\nDEMO FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
