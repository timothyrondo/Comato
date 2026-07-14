import type { ComponentType, SVGProps } from "react";
import type { Screen } from "../types";
import { ShieldCheck, Activity, Clock, User } from "./icons";

type IconType = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const TABS: { id: Screen; label: string; Icon: IconType }[] = [
  { id: "home", label: "Home", Icon: ShieldCheck },
  { id: "position", label: "Position", Icon: Activity },
  { id: "activity", label: "Activity", Icon: Clock },
  { id: "account", label: "Account", Icon: User },
];

export default function TabBar({
  active,
  onChange,
}: {
  active: Screen;
  onChange: (s: Screen) => void;
}) {
  return (
    <nav
      aria-label="Main navigation"
      className="absolute inset-x-0 bottom-0 z-20 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"
    >
      <div className="glass mx-auto flex items-center justify-around rounded-[1.75rem] px-2 py-2">
        {TABS.map(({ id, label, Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              aria-current={isActive ? "page" : undefined}
              aria-label={label}
              className="group relative flex flex-1 flex-col items-center gap-1 rounded-2xl py-1.5"
            >
              <span
                className={
                  "flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200 " +
                  (isActive
                    ? "bg-gradient-to-b from-accent-bright to-accent text-[#fff7ef] shadow-[0_0_20px_-4px_rgba(241,137,60,0.85)]"
                    : "text-ink-muted group-hover:text-ink")
                }
              >
                <Icon size={21} strokeWidth={isActive ? 2 : 1.75} />
              </span>
              <span
                className={
                  "text-[11px] font-medium transition-colors duration-200 " +
                  (isActive ? "text-ink" : "text-ink-muted")
                }
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
