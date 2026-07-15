/**
 * SubscribeFlow — the browser's end-to-end "go live" path.
 *
 * Connect an injected wallet → (no vault) run the create → approve+supply →
 * borrow wizard → (has vault) watch the live position, drive HF down with
 * "borrow more", and see Comato deleverage it back up. Every step is a signed
 * txn with explicit pending / success / error states; the rescue itself is the
 * off-chain agent's job, this only drives the USER's actions + shows live state.
 *
 * `SubscribeFlowView` is a pure function of `{ wallet, vault }`, so every branch
 * is renderable/testable in isolation; the default export wires the real hooks.
 * On-brand: composes the `.glass-*` utilities, orange accent, and motion system.
 */

import { useEffect, useMemo, useState } from "react";
import { parseUnits } from "viem";
import { useWallet, type WalletState } from "../data/wallet";
import { useVault, type VaultView } from "../data/useVault";
import { subscribeConfig } from "../lib/env";
import { TOKENS } from "../lib/constants";
import {
  getWalletClient,
  getWalletPublicClient,
} from "../lib/wallet";
import {
  borrowTx,
  runFunding,
  VAULT_DEFAULTS,
  type StepId,
  type StepStatus,
} from "../lib/vault";
import { riskCopy, type RiskLevel } from "../lib/format";
import { motion, fadeRise, HfCount, MoneyCount } from "../lib/motion";
import HealthRing from "./HealthRing";
import StatTile from "./StatTile";
import PillButton from "./PillButton";
import {
  ShieldCheck,
  Wallet,
  AlertTriangle,
  ArrowRight,
  Bolt,
} from "./icons";

/* ── Small shared bits ──────────────────────────────────── */

function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent " +
        className
      }
      aria-hidden
    />
  );
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function isPositiveAmount(s: string): boolean {
  const n = Number(s);
  return Number.isFinite(n) && n > 0;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <motion.section
      variants={fadeRise}
      initial="hidden"
      animate="visible"
      className="glass rounded-panel p-6"
      aria-label="Protect a live position"
    >
      {children}
    </motion.section>
  );
}

function Header({ chip }: { chip: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
          <Bolt size={18} />
        </span>
        <h3 className="text-[16px] font-bold tracking-tight text-ink">
          Protect a live position
        </h3>
      </div>
      {chip}
    </div>
  );
}

function StatusChip({ tone, children }: { tone: "muted" | "accent" | "safe" | "warn"; children: React.ReactNode }) {
  const cls =
    tone === "accent"
      ? "text-accent-ink"
      : tone === "safe"
        ? "text-safe"
        : tone === "warn"
          ? "text-warn"
          : "text-ink-muted";
  return (
    <span className={"glass-chip inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold " + cls}>
      {children}
    </span>
  );
}

/* Amount input with a token suffix (glass-soft tile). */
function AmountField({
  label,
  token,
  value,
  onChange,
  disabled,
}: {
  label: string;
  token: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
        {label}
      </span>
      <span className="glass-soft mt-1.5 flex items-center gap-2 rounded-tile px-3.5 py-2.5">
        <input
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.0"
          aria-label={label}
          className="tnum w-full min-w-0 bg-transparent text-[16px] font-semibold text-ink outline-none placeholder:text-ink-muted disabled:opacity-60"
        />
        <span className="shrink-0 text-[13px] font-semibold text-ink-soft">{token}</span>
      </span>
    </label>
  );
}

/* ── Wallet-gate bodies ─────────────────────────────────── */

function UnsupportedBody() {
  return (
    <div className="glass-soft flex items-start gap-3 rounded-tile p-4">
      <AlertTriangle size={20} className="mt-0.5 shrink-0 text-warn" />
      <p className="text-[13px] leading-relaxed text-ink-soft">
        No browser wallet detected. Install MetaMask (or another injected wallet)
        to create a Comato vault and protect a real Aave position from your
        browser. The dashboard below stays in live-monitor mode meanwhile.
      </p>
    </div>
  );
}

function ConnectBody({ wallet }: { wallet: WalletState }) {
  const connecting = wallet.status === "connecting";
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Connect your wallet to create a non-custodial Comato vault, supply USDT,
        and borrow USDC — all from the browser. Comato then monitors it and steps
        in before liquidation.
      </p>
      <PillButton
        onClick={wallet.connect}
        disabled={connecting}
        leading={connecting ? <Spinner /> : <Wallet size={19} />}
        trailing={connecting ? undefined : <ArrowRight size={19} />}
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </PillButton>
      {wallet.error && (
        <p className="text-[12px] font-medium text-danger">{wallet.error}</p>
      )}
    </div>
  );
}

function WrongChainBody({ wallet }: { wallet: WalletState }) {
  return (
    <div className="space-y-3">
      <div className="glass-soft flex items-start gap-3 rounded-tile p-4">
        <AlertTriangle size={20} className="mt-0.5 shrink-0 text-warn" />
        <p className="text-[13px] leading-relaxed text-ink-soft">
          Your wallet is on the wrong network. Comato runs on Celo — switch to
          continue.
        </p>
      </div>
      <PillButton onClick={wallet.switchChain} leading={<Bolt size={19} />}>
        Switch to Celo
      </PillButton>
      {wallet.error && (
        <p className="text-[12px] font-medium text-danger">{wallet.error}</p>
      )}
    </div>
  );
}

function NotConfiguredBody() {
  return (
    <div className="glass-soft flex items-start gap-3 rounded-tile p-4">
      <AlertTriangle size={20} className="mt-0.5 shrink-0 text-warn" />
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Vault factory not configured. Set <code className="tnum">VITE_VAULT_FACTORY_ADDR</code>{" "}
        (and <code className="tnum">VITE_OPERATOR_ADDR</code>) to enable the
        create-vault flow. Your wallet is connected on Celo.
      </p>
    </div>
  );
}

/* ── Wizard (create → supply → borrow) ──────────────────── */

const STEP_LABELS: Record<StepId, string> = {
  create: "Create your Comato vault",
  supply: "Approve & supply USDT",
  borrow: "Borrow USDC",
};

function StepDot({ status }: { status: StepStatus }) {
  const map: Record<StepStatus, string> = {
    idle: "border-ink/25 text-ink-muted",
    active: "border-accent text-accent-ink",
    done: "border-safe bg-safe text-[#fff7ef]",
    error: "border-danger text-danger",
  };
  return (
    <span
      className={
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold " +
        map[status]
      }
    >
      {status === "active" ? <Spinner className="h-3 w-3" /> : status === "done" ? "✓" : status === "error" ? "!" : ""}
    </span>
  );
}

function initialSteps(stage: VaultView["fundingStage"]): Record<StepId, StepStatus> {
  return {
    create: stage === "none" ? "idle" : "done",
    supply: stage === "none" || stage === "awaiting-collateral" ? "idle" : "done",
    borrow: "idle",
  };
}

function WizardBody({
  wallet,
  vault,
}: {
  wallet: WalletState;
  vault: VaultView;
}) {
  const [supplyAmount, setSupplyAmount] = useState("15");
  const [borrowAmount, setBorrowAmount] = useState("8");
  const [steps, setSteps] = useState<Record<StepId, StepStatus>>(() =>
    initialSteps(vault.fundingStage),
  );
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  // Keep the checklist in sync with on-chain progress (poll may advance it).
  useEffect(() => {
    if (!running) setSteps(initialSteps(vault.fundingStage));
  }, [vault.fundingStage, running]);

  const operatorMissing = !subscribeConfig.operatorAddr;
  const needCreate = vault.fundingStage === "none";
  const amountsValid =
    (steps.supply !== "done" ? isPositiveAmount(supplyAmount) : true) &&
    isPositiveAmount(borrowAmount);
  const blocked = (needCreate && operatorMissing) || !amountsValid;

  async function run() {
    if (!wallet.account || !subscribeConfig.factoryAddr) return;
    setRunning(true);
    setTxError(null);
    const stage = vault.fundingStage;
    const need = {
      create: stage === "none",
      supply: stage === "none" || stage === "awaiting-collateral",
      borrow: true,
    };
    try {
      await runFunding({
        wallet: getWalletClient(),
        publicClient: getWalletPublicClient(),
        account: wallet.account,
        factory: subscribeConfig.factoryAddr,
        operator: subscribeConfig.operatorAddr ?? wallet.account,
        feeRecipient:
          subscribeConfig.feeRecipient ?? subscribeConfig.operatorAddr ?? wallet.account,
        collateralAsset: TOKENS.USDT,
        debtAsset: TOKENS.USDC,
        existingVault: vault.vault,
        supplyAmount: parseUnits(supplyAmount, VAULT_DEFAULTS.collateralDecimals),
        borrowAmount: parseUnits(borrowAmount, VAULT_DEFAULTS.debtDecimals),
        need,
        onStep: (id, status, stepNote) => {
          setSteps((s) => ({ ...s, [id]: status }));
          setNote(stepNote ?? null);
        },
      });
      vault.refresh();
    } catch (err) {
      setTxError(err instanceof Error ? err.message : String(err));
      setSteps((s) => {
        const next = { ...s };
        for (const id of ["create", "supply", "borrow"] as StepId[]) {
          if (next[id] === "active") next[id] = "error";
        }
        return next;
      });
    } finally {
      setRunning(false);
      setNote(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Supply USDT collateral and borrow USDC against it. Comato watches the
        resulting Health Factor and deleverages before liquidation.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {steps.supply !== "done" && (
          <AmountField
            label="Supply collateral"
            token="USDT"
            value={supplyAmount}
            onChange={setSupplyAmount}
            disabled={running}
          />
        )}
        <AmountField
          label="Borrow"
          token="USDC"
          value={borrowAmount}
          onChange={setBorrowAmount}
          disabled={running}
        />
      </div>

      <ol className="space-y-2.5">
        {(["create", "supply", "borrow"] as StepId[]).map((id) => (
          <li key={id} className="flex items-center gap-3">
            <StepDot status={steps[id]} />
            <span
              className={
                "text-[13.5px] font-semibold " +
                (steps[id] === "done"
                  ? "text-ink-muted line-through"
                  : steps[id] === "active"
                    ? "text-ink"
                    : "text-ink-soft")
              }
            >
              {STEP_LABELS[id]}
              {steps[id] === "active" && note && (
                <span className="ml-1.5 font-normal text-accent-ink">· {note}…</span>
              )}
            </span>
          </li>
        ))}
      </ol>

      {needCreate && operatorMissing && (
        <p className="text-[12px] font-medium text-warn">
          Comato operator not configured — set VITE_OPERATOR_ADDR to create a vault.
        </p>
      )}
      {txError && <p className="text-[12px] font-medium text-danger">{txError}</p>}

      <PillButton
        onClick={run}
        disabled={running || blocked}
        leading={running ? <Spinner /> : <ShieldCheck size={19} />}
      >
        {running ? "Protecting…" : txError ? "Try again" : "Protect a position"}
      </PillButton>
    </div>
  );
}

/* ── Live vault (funded + monitored) ────────────────────── */

const RESCUE_TONE: Record<RiskLevel, { wrap: string; icon: string }> = {
  safe: { wrap: "bg-accent-soft text-accent-ink", icon: "text-accent-ink" },
  warn: { wrap: "bg-warn/15 text-warn", icon: "text-warn" },
  danger: { wrap: "bg-danger/15 text-danger", icon: "text-danger" },
};

function LiveVaultBody({
  wallet,
  vault,
}: {
  wallet: WalletState;
  vault: VaultView;
}) {
  const [bmAmount, setBmAmount] = useState("1");
  const [bmBusy, setBmBusy] = useState(false);
  const [bmError, setBmError] = useState<string | null>(null);

  async function borrowMore() {
    if (!wallet.account || !vault.vault || !isPositiveAmount(bmAmount)) return;
    setBmBusy(true);
    setBmError(null);
    try {
      await borrowTx(
        getWalletClient(),
        getWalletPublicClient(),
        wallet.account,
        vault.vault,
        parseUnits(bmAmount, VAULT_DEFAULTS.debtDecimals),
      );
      vault.refresh();
    } catch (err) {
      setBmError(err instanceof Error ? err.message : String(err));
    } finally {
      setBmBusy(false);
    }
  }

  const tone = RESCUE_TONE[vault.risk];
  const banner = vault.breached
    ? `Health Factor is below ${vault.rescueHf.toFixed(2)} — Comato is deleveraging your position back toward ${vault.targetHf.toFixed(2)}.`
    : vault.rescued
      ? `Comato deleveraged your position — Health Factor recovered to ${vault.hf.toFixed(2)}.`
      : "All clear — Comato is monitoring your position non-stop.";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="glass-chip inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold text-accent-ink">
          <ShieldCheck size={15} />
          Protected by Comato
        </span>
        <span className="tnum text-[11.5px] text-ink-muted">
          {vault.vault ? shortAddr(vault.vault) : ""}
        </span>
      </div>

      <div className="flex flex-col items-center gap-5 lg:flex-row lg:items-center lg:gap-7">
        <div className="shrink-0">
          <HealthRing
            value={vault.hf}
            liquidationHf={vault.liquidationHf}
            rescueHf={vault.rescueHf}
            size={208}
          />
        </div>
        <div className="grid w-full grid-cols-2 gap-3">
          <StatTile
            label="Collateral"
            value={<MoneyCount value={vault.collateralUsd} />}
            sub={vault.collateralAsset}
          />
          <StatTile
            label="Debt"
            value={<MoneyCount value={vault.debtUsd} />}
            sub={vault.debtAsset}
          />
          <StatTile
            tone="dark"
            label="Health Factor"
            value={<HfCount value={vault.hf} />}
            sub={`${riskCopy[vault.risk]} · liq ${vault.liquidationHf.toFixed(2)}`}
          />
          <StatTile
            tone="accent"
            label="Rescue at"
            value={vault.rescueHf.toFixed(2)}
            sub={`Target ${vault.targetHf.toFixed(2)}`}
          />
        </div>
      </div>

      <div className={"flex items-start gap-3 rounded-tile p-4 " + tone.wrap}>
        {vault.breached ? (
          <AlertTriangle size={20} className={"mt-0.5 shrink-0 " + tone.icon} />
        ) : (
          <ShieldCheck size={20} className={"mt-0.5 shrink-0 " + tone.icon} />
        )}
        <p className="text-[13px] font-medium leading-relaxed">{banner}</p>
      </div>

      {/* Drive HF down on camera */}
      <div className="glass-soft rounded-tile p-4">
        <div className="mb-2 text-[12.5px] font-semibold text-ink">
          Borrow more USDC
          <span className="ml-1.5 font-normal text-ink-muted">
            — pushes Health Factor down to trigger a rescue
          </span>
        </div>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <AmountField
              label="Amount"
              token="USDC"
              value={bmAmount}
              onChange={setBmAmount}
              disabled={bmBusy}
            />
          </div>
          <PillButton
            variant="light"
            block={false}
            onClick={borrowMore}
            disabled={bmBusy || !isPositiveAmount(bmAmount)}
            leading={bmBusy ? <Spinner /> : <ArrowRight size={18} />}
            className="mb-0.5"
          >
            {bmBusy ? "Borrowing…" : "Borrow"}
          </PillButton>
        </div>
        {bmError && (
          <p className="mt-2 text-[12px] font-medium text-danger">{bmError}</p>
        )}
      </div>

      <p className="border-t border-line pt-3 text-[11.5px] leading-relaxed text-ink-muted">
        Non-custodial — you own the position. Comato's operator can only
        deleverage when Health Factor is breached; you can revoke it any time.
      </p>
    </div>
  );
}

/* ── View + container ───────────────────────────────────── */

export function SubscribeFlowView({
  wallet,
  vault,
}: {
  wallet: WalletState;
  vault: VaultView;
}) {
  const chip = useMemo<React.ReactNode>(() => {
    if (!wallet.isSupported) return <StatusChip tone="muted">No wallet</StatusChip>;
    if (wallet.status === "connecting")
      return (
        <StatusChip tone="accent">
          <Spinner className="h-3 w-3" /> Connecting
        </StatusChip>
      );
    if (wallet.status !== "connected")
      return <StatusChip tone="muted">Not connected</StatusChip>;
    if (!wallet.isCelo) return <StatusChip tone="warn">Wrong network</StatusChip>;
    return (
      <StatusChip tone="accent">
        <Wallet size={14} />
        {wallet.account ? shortAddr(wallet.account) : "Connected"}
      </StatusChip>
    );
  }, [wallet]);

  let body: React.ReactNode;
  if (!wallet.isSupported) {
    body = <UnsupportedBody />;
  } else if (wallet.status !== "connected") {
    body = <ConnectBody wallet={wallet} />;
  } else if (!wallet.isCelo) {
    body = <WrongChainBody wallet={wallet} />;
  } else if (!vault.ready) {
    // Connected on Celo but the factory isn't configured (vault reads disabled).
    body = <NotConfiguredBody />;
  } else if (vault.fundingStage === "active") {
    body = <LiveVaultBody wallet={wallet} vault={vault} />;
  } else {
    body = <WizardBody wallet={wallet} vault={vault} />;
  }

  return (
    <Shell>
      <Header chip={chip} />
      {body}
    </Shell>
  );
}

export default function SubscribeFlow() {
  const wallet = useWallet();
  const vault = useVault(wallet.account, wallet.isCelo);
  return <SubscribeFlowView wallet={wallet} vault={vault} />;
}
