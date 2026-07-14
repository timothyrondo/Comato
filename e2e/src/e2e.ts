/**
 * Comato end-to-end integration proof (G6).
 *
 * Spins up an anvil fork of Celo mainnet, deploys ComatoPolicy + ComatoExecutor,
 * sets up two real Aave V3 positions that sit at the edge of liquidation, then
 * drives the ACTUAL off-chain agent code (monitor → eligibility gate → rescue)
 * to rescue them two ways:
 *
 *   Scenario A — EOA-direct repay (the Track-1 counting path, constraint C1):
 *     COMATO_WALLET sends `Pool.repay(onBehalfOf=subscriber)` directly, ERC-8021
 *     tagged. Asserts the tx carries the 0x8021… suffix, is EOA-direct
 *     (transfer.from == tx sender), and restores HF above threshold.
 *
 *   Scenario B — ComatoExecutor.rescue (the atomic safety path):
 *     the agent calls the on-chain executor. Asserts RescueExecuted is emitted
 *     and HF restored — and shows the underlying transfer.from is the CONTRACT
 *     (why this path does NOT count for Track 1).
 *
 * Everything after the fork RPC is local: anvil test accounts + aToken
 * impersonation for funding. No real keys. Kills anvil on every exit path.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  formatUnits,
  parseAbiItem,
  parseEventLogs,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { AnvilFork, loadArtifact } from "./anvil.ts";
import { Asserter } from "./assert.ts";
import {
  COMATO,
  SUB_A,
  SUB_B,
  USDC,
  USDT,
  POOL,
  aUSDC,
  USDC_UNIT,
  WAD,
  RPC_URL,
} from "./constants.ts";

// ---- the real agent code under test (import only; never modified) ----
import { loadConfig, redactConfig, type Config } from "@comato/agent/config.ts";
import { createChain } from "@comato/agent/chain.ts";
import { TxSender } from "@comato/agent/tx.ts";
import { Monitor } from "@comato/agent/monitor.ts";
import { RateLimiter, checkEligibility } from "@comato/agent/eligibility.ts";
import { Rescuer } from "@comato/agent/rescue.ts";
import { createLogger, setLogLevel } from "@comato/agent/logger.ts";
import { endsWithMarker, verifyTaggedTx, decodeTag, MARKER_HEX } from "@comato/agent/tagger.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(__dirname, "../../packages/contracts");
const ATTRIBUTION_CODE = "timo_comato";
const FAR_FUTURE = () => Date.now() + 30 * 24 * 3600 * 1000; // paid-through: +30d
const HF_MARGIN = 3n * 10n ** 16n; // 0.03 in WAD — threshold sits just above the opened HF

const hf = (x: bigint) => Number(formatUnits(x, 18)).toFixed(4);
const usd = (x: bigint) => Number(formatUnits(x, 6)).toFixed(2);

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Build a scenario env, then run it through the REAL `loadConfig()` parser. */
function loadScenarioConfig(opts: {
  subscriber: Address;
  hfThreshold: bigint;
  distressHf: bigint;
  maxAmount: bigint;
  viaExecutor: boolean;
  executorAddress?: Address;
  policyId?: bigint;
}): Config {
  const sub: Record<string, unknown> = {
    address: opts.subscriber,
    hfThreshold: formatUnits(opts.hfThreshold, 18),
    debtAsset: USDC,
    collateralAsset: USDT,
    premiumPaidUntilMs: FAR_FUTURE(),
  };
  if (opts.policyId !== undefined) sub.policyId = Number(opts.policyId);

  Object.assign(process.env, {
    ATTRIBUTION_CODE,
    CELO_RPC: RPC_URL,
    COMATO_PRIVATE_KEY: COMATO.key,
    DRY_RUN: "false",
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn",
    SUBSCRIBERS: JSON.stringify([sub]),
    RESCUE_ENABLED: "true",
    ...(opts.executorAddress ? { EXECUTOR_ADDRESS: opts.executorAddress } : {}),
  });

  // Tuning params (distress ceiling, repay cap, EOA-direct vs Executor path) moved from
  // env to `apps/agent/src/defaults.ts`. This scenario still needs to vary them per-run —
  // the distress ceiling tracks the live fork HF, the repay cap tracks the position's debt,
  // and scenario B exercises the Executor path — so override them on the parsed Config
  // directly instead of through env (which loadConfig no longer reads for these).
  const cfg = loadConfig();
  cfg.rescue.distressHf = opts.distressHf;
  cfg.rescue.maxAmount = opts.maxAmount;
  cfg.rescue.viaExecutor = opts.viaExecutor;
  return cfg;
}

async function main() {
  console.log("Comato E2E — gasless liquidation-rescue on a Celo mainnet fork\n");

  // 0. Compile the contracts so we can deploy them via viem.
  console.log("Building contracts (forge build)...");
  const build = spawnSync("forge", ["build"], { cwd: CONTRACTS_DIR, encoding: "utf8" });
  if (build.status !== 0) {
    throw new Error(`forge build failed:\n${build.stdout}\n${build.stderr}`);
  }
  const policyArt = loadArtifact("ComatoPolicy.sol", "ComatoPolicy");
  const executorArt = loadArtifact("ComatoExecutor.sol", "ComatoExecutor");

  const A = new Asserter();
  const fork = new AnvilFork();
  const cleanup = () => fork.stop();
  process.on("SIGINT", () => (cleanup(), process.exit(130)));
  process.on("SIGTERM", () => (cleanup(), process.exit(143)));

  try {
    console.log(`Starting anvil fork (chain 42220) on ${RPC_URL} ...`);
    await fork.start();
    console.log("anvil ready.\n");

    const comato = privateKeyToAccount(COMATO.key);

    // 1. Deploy the Comato contracts (owner = COMATO_WALLET, the agent's EOA).
    console.log("Deploying ComatoPolicy + ComatoExecutor ...");
    const policyAddr = await fork.deploy(comato, policyArt, [comato.address]);
    const executor = await fork.deploy(comato, executorArt, [POOL, policyAddr, comato.address]);
    console.log(`  ComatoPolicy   @ ${policyAddr}`);
    console.log(`  ComatoExecutor @ ${executor}\n`);
    A.check(policyAddr.length === 42, "ComatoPolicy deployed to the fork", policyAddr);
    A.check(executor.length === 42, "ComatoExecutor deployed to the fork", executor);

    // 2. Set up two edge positions (supply USDT, borrow USDC to ~99% LTV).
    console.log("Opening two Aave V3 edge positions (HF just above 1) ...");
    const posA = await fork.openEdgePosition(SUB_A.key);
    const posB = await fork.openEdgePosition(SUB_B.key);
    console.log(`  Subscriber A ${SUB_A.address}: borrowed ${usd(posA.borrowedUsdc)} USDC, HF=${hf(posA.hf)}`);
    console.log(`  Subscriber B ${SUB_B.address}: borrowed ${usd(posB.borrowedUsdc)} USDC, HF=${hf(posB.hf)}\n`);
    A.check(posA.hf > WAD && posA.hf < 2n * WAD, "position A sits at the liquidation edge (1 < HF < 2)", `HF=${hf(posA.hf)}`);
    A.check(posB.hf > WAD && posB.hf < 2n * WAD, "position B sits at the liquidation edge (1 < HF < 2)", `HF=${hf(posB.hf)}`);

    // =====================================================================
    // SCENARIO A — EOA-direct repay (Track-1 counting path, C1)
    // =====================================================================
    console.log("── Scenario A: EOA-direct rescue (tagged, counts for Track 1) ──");
    const thresholdA = posA.hf + HF_MARGIN; // policy protects just above the current HF
    const maxAmountA = posA.borrowedUsdc / 4n; // repay ~1/4 of debt, like the fork test
    // Fund the agent's EOA float with USDC (its own capital for the repay).
    await fork.deal(USDC, comato.address, maxAmountA + 100n * USDC_UNIT, aUSDC);
    const floatA = await fork.balanceOf(USDC, comato.address);
    A.check(floatA >= maxAmountA, "COMATO_WALLET funded with USDC float", `${usd(floatA)} USDC`);

    const cfgA = loadScenarioConfig({
      subscriber: SUB_A.address,
      hfThreshold: thresholdA,
      distressHf: thresholdA,
      maxAmount: maxAmountA,
      viaExecutor: false,
    });
    setLogLevel(cfgA.logLevel);
    console.log("  loaded agent config:", JSON.stringify(redactConfig(cfgA)));
    A.check(cfgA.chainId === 42220 && !cfgA.dryRun && cfgA.rescue.enabled, "real loadConfig() parsed a live (non-dry-run) rescue config");

    const chainA = createChain(cfgA);
    A.check(chainA.account?.address.toLowerCase() === comato.address.toLowerCase(), "agent wallet == COMATO_WALLET", chainA.account?.address ?? "none");
    const txA = new TxSender(chainA, cfgA, createLogger("tx"));
    const rlA = new RateLimiter(cfgA.rescue.cooldownMs, cfgA.rescue.maxPerWindow, cfgA.rescue.windowMs);
    const monitorA = new Monitor(chainA.publicClient, cfgA, createLogger("monitor"));
    const rescuerA = new Rescuer(chainA.publicClient, txA, cfgA, rlA, createLogger("rescue"));
    const subA = cfgA.subscribers[0]!;

    // Monitor reads HF and flags the breach.
    const snapA = await monitorA.pollSubscriber(subA);
    A.check(snapA.hasDebt && snapA.breached, "monitor flags subscriber A as breached", `HF=${hf(snapA.healthFactor)} < threshold ${hf(subA.hfThreshold)}`);

    // Eligibility gate PASSES (premium paid, genuine distress, rate-ok, has debt).
    const eligA = await checkEligibility({ publicClient: chainA.publicClient, snapshot: snapA, sub: subA, config: cfgA, rateLimiter: rlA, log: createLogger("elig") });
    A.check(eligA.eligible, "eligibility gate PASSES for a paid, genuinely-distressed position", `variableDebt=${usd(eligA.variableDebt)} USDC`);

    // Negative control: the same position, unpaid, is REJECTED (fail-closed gate).
    const unpaidSub = { ...subA, premiumPaidUntilMs: Date.now() - 1000 };
    const eligUnpaid = await checkEligibility({ publicClient: chainA.publicClient, snapshot: snapA, sub: unpaidSub, config: cfgA, rateLimiter: new RateLimiter(0, 9, 1), log: createLogger("elig") });
    A.check(!eligUnpaid.eligible && eligUnpaid.reasons.some((r) => r.includes("premium")), "eligibility gate REJECTS an unpaid subscriber (fail-closed)", eligUnpaid.reasons.join("; "));

    // Drive the rescue (the loop body from index.ts).
    const hfBeforeA = await fork.healthFactor(SUB_A.address);
    const outA = await rescuerA.maybeRescue(snapA, subA);
    A.check(outA.status === "executed" && !!outA.result?.hash, "agent executed the EOA-direct rescue", `status=${outA.status} hash=${outA.result?.hash ?? "none"}`);
    const hashA = outA.result!.hash!;

    // --- ERC-8021 + EOA-direct assertions on the rescue tx ---
    const tagged = outA.result!.taggedData;
    A.check(endsWithMarker(tagged), "built rescue calldata ends with the ERC-8021 marker (0x8021…)", `…${tagged.slice(-34)}`);

    const txOnChain = await fork.pub.getTransaction({ hash: hashA });
    A.check(endsWithMarker(txOnChain.input), "on-chain rescue tx calldata carries the 0x8021… suffix", `…${txOnChain.input.slice(-34)}`);
    const decoded = decodeTag(txOnChain.input);
    A.check(!!decoded && decoded.codes.includes(ATTRIBUTION_CODE), "decoded ERC-8021 tag contains our attribution code", decoded ? decoded.codes.join(",") : "none");
    const verified = await verifyTaggedTx(fork.pub, hashA, ATTRIBUTION_CODE);
    A.check(verified, "@celo/attribution-tags verifyTx confirms the tag on-chain", `marker=0x${MARKER_HEX}`);
    A.check(txOnChain.from.toLowerCase() === comato.address.toLowerCase(), "rescue tx sent EOA-direct (tx.from == COMATO_WALLET)", txOnChain.from);

    // Prove C1's shape: an ERC20 transfer whose from == tx sender (the EOA).
    const rcptA = await fork.pub.getTransactionReceipt({ hash: hashA });
    const usdcTransfers = parseEventLogs({ abi: [transferEvent], logs: rcptA.logs, eventName: "Transfer" }).filter((l) => l.address.toLowerCase() === USDC.toLowerCase());
    const eoaDirectTransfer = usdcTransfers.find((l) => (l.args.from as Address).toLowerCase() === comato.address.toLowerCase());
    A.check(!!eoaDirectTransfer, "USDC repay transfer has from == tx sender (C1 counts this)", eoaDirectTransfer ? `${usd(eoaDirectTransfer.args.value as bigint)} USDC from EOA` : "none");

    // HF restored.
    const hfAfterA = await fork.healthFactor(SUB_A.address);
    A.check(hfAfterA > hfBeforeA, "health factor rose after the EOA-direct rescue", `${hf(hfBeforeA)} → ${hf(hfAfterA)}`);
    A.check(hfAfterA > subA.hfThreshold, "health factor restored ABOVE the policy threshold", `HF ${hf(hfAfterA)} > threshold ${hf(subA.hfThreshold)}`);
    console.log(`  Scenario A: HF ${hf(hfBeforeA)} → ${hf(hfAfterA)} (repaid ${usd(outA.repayAmount ?? 0n)} USDC)\n`);

    // =====================================================================
    // SCENARIO B — ComatoExecutor.rescue (atomic safety path)
    // =====================================================================
    console.log("── Scenario B: ComatoExecutor rescue (atomic safety net, emits RescueExecuted) ──");
    const thresholdB = posB.hf + HF_MARGIN;
    const rescueCapB = posB.borrowedUsdc / 4n;

    // Subscriber B creates the on-chain policy; agent EOA (owner) drives the executor.
    const wSubB = fork.wallet(privateKeyToAccount(SUB_B.key));
    const createHash = await wSubB.writeContract({
      account: privateKeyToAccount(SUB_B.key),
      chain: fork.pub.chain,
      address: policyAddr,
      abi: policyArt.abi,
      functionName: "createPolicy",
      args: [USDT, USDC, thresholdB, rescueCapB, 100_000n],
      gas: 3_000_000n,
    });
    const createRcpt = await fork.mineTx(createHash, "createPolicy");
    const created = parseEventLogs({ abi: policyArt.abi, logs: createRcpt.logs, eventName: "PolicyCreated" })[0] as
      | { args: { policyId: bigint; subscriber: Address } }
      | undefined;
    const policyId = created?.args.policyId ?? 1n;
    A.check(!!created && created.args.subscriber.toLowerCase() === SUB_B.address.toLowerCase(), "on-chain ComatoPolicy created for subscriber B", `policyId=${policyId}`);

    // Fund the executor's USDC float (Comato's own capital) via aToken impersonation.
    await fork.deal(USDC, executor, rescueCapB + 100n * USDC_UNIT, aUSDC);
    const executorFloat = await fork.balanceOf(USDC, executor);
    A.check(executorFloat >= rescueCapB, "ComatoExecutor funded with USDC float", `${usd(executorFloat)} USDC`);

    const cfgB = loadScenarioConfig({
      subscriber: SUB_B.address,
      hfThreshold: thresholdB,
      distressHf: thresholdB,
      maxAmount: rescueCapB,
      viaExecutor: true,
      executorAddress: executor,
      policyId,
    });
    const chainB = createChain(cfgB);
    const txB = new TxSender(chainB, cfgB, createLogger("tx"));
    const rlB = new RateLimiter(cfgB.rescue.cooldownMs, cfgB.rescue.maxPerWindow, cfgB.rescue.windowMs);
    const monitorB = new Monitor(chainB.publicClient, cfgB, createLogger("monitor"));
    const rescuerB = new Rescuer(chainB.publicClient, txB, cfgB, rlB, createLogger("rescue"));
    const subB = cfgB.subscribers[0]!;
    A.check(cfgB.rescue.viaExecutor && cfgB.rescue.executorAddress?.toLowerCase() === executor.toLowerCase(), "agent configured for the Executor safety path", `executor=${executor}`);

    const snapB = await monitorB.pollSubscriber(subB);
    A.check(snapB.breached, "monitor flags subscriber B as breached", `HF=${hf(snapB.healthFactor)}`);

    const hfBeforeB = await fork.healthFactor(SUB_B.address);
    const outB = await rescuerB.maybeRescue(snapB, subB);
    A.check(outB.status === "executed" && !!outB.result?.hash, "agent executed the rescue via ComatoExecutor", `status=${outB.status} hash=${outB.result?.hash ?? "none"}`);
    const hashB = outB.result!.hash!;

    // RescueExecuted event emitted by the executor.
    const rcptB = await fork.pub.getTransactionReceipt({ hash: hashB });
    const rescueEvents = parseEventLogs({ abi: executorArt.abi, logs: rcptB.logs, eventName: "RescueExecuted" }) as Array<{
      args: { policyId: bigint; subscriber: Address; amountRepaid: bigint; hfBefore: bigint; hfAfter: bigint };
    }>;
    const ev = rescueEvents[0];
    A.check(!!ev, "ComatoExecutor emitted RescueExecuted", ev ? `policyId=${ev.args.policyId} repaid=${usd(ev.args.amountRepaid)} USDC` : "none");
    A.check(!!ev && ev.args.subscriber.toLowerCase() === SUB_B.address.toLowerCase() && ev.args.amountRepaid > 0n, "RescueExecuted names subscriber B and a positive repay", ev ? `HF ${hf(ev.args.hfBefore)} → ${hf(ev.args.hfAfter)}` : "none");

    // Attribution contrast: here the USDC transfer's from is the CONTRACT, not the EOA.
    const usdcTransfersB = parseEventLogs({ abi: [transferEvent], logs: rcptB.logs, eventName: "Transfer" }).filter((l) => l.address.toLowerCase() === USDC.toLowerCase());
    const contractTransfer = usdcTransfersB.find((l) => (l.args.from as Address).toLowerCase() === executor.toLowerCase());
    A.check(!!contractTransfer, "Executor repay transfer.from == the contract (NOT the EOA) → does NOT count for Track 1", contractTransfer ? `${usd(contractTransfer.args.value as bigint)} USDC from executor` : "none");

    const hfAfterB = await fork.healthFactor(SUB_B.address);
    A.check(hfAfterB > hfBeforeB && hfAfterB > subB.hfThreshold, "health factor restored above threshold via the executor", `${hf(hfBeforeB)} → ${hf(hfAfterB)}`);
    console.log(`  Scenario B: HF ${hf(hfBeforeB)} → ${hf(hfAfterB)} (RescueExecuted repaid ${usd(ev!.args.amountRepaid)} USDC)\n`);

    // ---- final report ----
    A.report();
    console.log("\nRESULT: Comato E2E PASSED — agent detected both breaches and rescued them on the Celo fork.");
    console.log(`  Scenario A (EOA-direct, tagged, C1): HF ${hf(hfBeforeA)} → ${hf(hfAfterA)}`);
    console.log(`  Scenario B (ComatoExecutor safety):  HF ${hf(hfBeforeB)} → ${hf(hfAfterB)}`);
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error("\nE2E FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
