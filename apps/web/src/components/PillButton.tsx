import type { ReactNode } from "react";
import type { HTMLMotionProps } from "framer-motion";
import { motion, hoverPop, tapPress } from "../lib/motion";

type Variant = "dark" | "light" | "ghost";

const VARIANTS: Record<Variant, string> = {
  dark: "btn-primary",
  light: "glass-soft text-ink hover:brightness-125",
  ghost: "bg-transparent text-ink hover:bg-ink/5",
};

interface PillButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: Variant;
  leading?: ReactNode;
  trailing?: ReactNode;
  block?: boolean;
  children?: ReactNode;
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
    <motion.button
      type="button"
      whileHover={hoverPop}
      whileTap={tapPress}
      className={
        "inline-flex items-center justify-center gap-2.5 rounded-full px-5 py-4 text-[15px] font-semibold tracking-tight transition-colors duration-200 will-change-transform " +
        (block ? "w-full " : "") +
        VARIANTS[variant] +
        (className ? " " + className : "")
      }
      {...rest}
    >
      {leading && <span className="shrink-0">{leading}</span>}
      <span>{children}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </motion.button>
  );
}
