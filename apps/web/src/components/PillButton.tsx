import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "dark" | "light" | "ghost";

const VARIANTS: Record<Variant, string> = {
  dark: "btn-primary active:scale-[0.985]",
  light: "glass-soft text-ink hover:brightness-125 active:scale-[0.985]",
  ghost: "bg-transparent text-ink hover:bg-ink/5 active:scale-[0.985]",
};

interface PillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  leading?: ReactNode;
  trailing?: ReactNode;
  block?: boolean;
}

/** The signature dark pill CTA (and its light/ghost siblings). */
export default function PillButton({
  variant = "dark",
  leading,
  trailing,
  block = true,
  className = "",
  children,
  ...rest
}: PillButtonProps) {
  return (
    <button
      type="button"
      className={
        "inline-flex items-center justify-center gap-2.5 rounded-full px-5 py-4 text-[15px] font-semibold tracking-tight transition-all duration-200 " +
        (block ? "w-full " : "") +
        VARIANTS[variant] +
        (className ? " " + className : "")
      }
      {...rest}
    >
      {leading && <span className="shrink-0">{leading}</span>}
      <span>{children}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </button>
  );
}
