import type { ComponentType, SVGProps } from "react";
import { useComatoData } from "../data/context";
import { money } from "../lib/format";
import Avatar from "../components/Avatar";
import {
  ShieldCheck,
  Coins,
  Lock,
  Settings,
  ChevronRight,
} from "../components/icons";

type IconType = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

export default function AccountScreen() {
  const { user, position } = useComatoData();
  const ROWS: { Icon: IconType; label: string; value: string }[] = [
    { Icon: ShieldCheck, label: "Protection", value: "Active" },
    {
      Icon: Coins,
      label: "Premium method",
      value: `x402 · ${money(position.premiumPerHourUsd)}/hr`,
    },
    { Icon: Lock, label: "Security & vouchers", value: "EIP-3009" },
    { Icon: Settings, label: "Preferences", value: "" },
  ];

  return (
    <div className="px-5 pb-4">
      <header className="pt-3">
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-ink">
          Account
        </h1>
      </header>

      {/* Profile card */}
      <section
        className="glass-deep rise mt-4 rounded-card p-5 text-on-dark"
        style={{ animationDelay: "40ms" }}
      >
        <div className="flex items-center gap-4">
          <Avatar name={user.name} size={56} ring={false} />
          <div className="min-w-0">
            <div className="text-[18px] font-bold">{user.name}</div>
            <div className="text-[13px] text-on-dark-muted">@{user.handle}</div>
          </div>
        </div>
        <div className="glass-chip mt-4 flex items-center justify-between rounded-tile px-4 py-3">
          <span className="text-[12px] text-on-dark-muted">Wallet</span>
          <span className="tnum text-[13px] font-semibold">
            {user.walletShort}
          </span>
        </div>
      </section>

      {/* Settings list */}
      <section
        className="glass rise mt-4 overflow-hidden rounded-card"
        style={{ animationDelay: "100ms" }}
      >
        {ROWS.map(({ Icon, label, value }, i) => (
          <button
            key={label}
            type="button"
            className={
              "flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-white/5 " +
              (i > 0 ? "border-t border-line" : "")
            }
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
              <Icon size={19} />
            </span>
            <span className="flex-1 text-[15px] font-semibold text-ink">
              {label}
            </span>
            {value && (
              <span className="text-[13px] text-ink-muted">{value}</span>
            )}
            <ChevronRight size={18} className="text-ink-muted" />
          </button>
        ))}
      </section>

      <p className="mt-6 text-center text-[12px] text-ink-muted">
        Comato · anti-liquidation insurance on Celo
      </p>
    </div>
  );
}
