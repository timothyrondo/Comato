/**
 * Comato motion system — a thin, tasteful layer over Framer Motion.
 *
 * Design intent: Apple/Linear-grade restraint. Content fades + rises with a
 * gentle stagger; numbers count up; the health gauge sweeps; screens cross-fade.
 * Everything animates GPU-friendly props only (transform / opacity / pathLength)
 * and every motion path respects `prefers-reduced-motion` — the whole tree is
 * wrapped in `<MotionConfig reducedMotion="user">` (see App.tsx), and the
 * imperative helpers below (count-up, path-draw) branch on `useReducedMotion()`.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  animate,
  useReducedMotion,
  type TargetAndTransition,
  type Variants,
} from "framer-motion";
import { money } from "./format";

export { motion, AnimatePresence } from "framer-motion";

/* ── Easing + timing tokens ──────────────────────────────────
   EASE_OUT: soft decelerate (entrances, sweeps). EASE_SOFT: symmetric
   (cross-fades). Kept in one place so the whole app moves as one system. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_SOFT = [0.4, 0, 0.2, 1] as const;

/* Fade + rise — the app's core entrance. Used as a child variant under a
   stagger container, or standalone via initial="hidden" animate="visible". */
export const fadeRise: Variants = {
  hidden: { opacity: 0, y: 14 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, ease: EASE_OUT },
  },
};

/* Stagger container variants. Children with `fadeRise` cascade in gently. */
export function staggerContainer(
  staggerChildren = 0.07,
  delayChildren = 0.05,
): Variants {
  return {
    hidden: {},
    visible: { transition: { staggerChildren, delayChildren } },
  };
}

/* Screen cross-fade — used as the AnimatePresence child on desktop + mobile. */
export const screenFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.22, ease: EASE_SOFT } },
  exit: { opacity: 0, transition: { duration: 0.16, ease: EASE_SOFT } },
};

/* Micro-interaction presets (spread into whileHover / whileTap). Subtle by
   design; under reduced motion MotionConfig strips the transform automatically. */
export const hoverLift: TargetAndTransition = {
  y: -3,
  transition: { type: "spring", stiffness: 380, damping: 24 },
};
export const hoverPop: TargetAndTransition = {
  scale: 1.02,
  y: -1,
  transition: { type: "spring", stiffness: 400, damping: 22 },
};
export const tapPress: TargetAndTransition = { scale: 0.97 };

/* ── Count-up ────────────────────────────────────────────────
   Animate a number from 0 → target on mount, and smoothly from the last shown
   value on subsequent updates (so live polls glide rather than jump). Snaps
   instantly under reduced motion. */
export function useCountUp(
  target: number,
  { duration = 1.1, delay = 0 }: { duration?: number; delay?: number } = {},
): number {
  const reduce = useReducedMotion();
  const [value, setValue] = useState(0);
  const currentRef = useRef(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (reduce) {
      currentRef.current = target;
      setValue(target);
      return;
    }
    const from = startedRef.current ? currentRef.current : 0;
    startedRef.current = true;
    const controls = animate(from, target, {
      duration,
      delay,
      ease: EASE_OUT,
      onUpdate: (v) => {
        currentRef.current = v;
        setValue(v);
      },
    });
    return () => controls.stop();
  }, [target, reduce, duration, delay]);

  return value;
}

/** Money value that counts up (keeps integer vs. cents precision of the target). */
export function MoneyCount({
  value,
  duration,
  delay,
}: {
  value: number;
  duration?: number;
  delay?: number;
}) {
  const n = useCountUp(value, { duration, delay });
  const shown = Number.isInteger(value) ? Math.round(n) : Math.round(n * 100) / 100;
  return <>{money(shown)}</>;
}

/** Health-factor number that counts up to two decimals. */
export function HfCount({
  value,
  duration,
  delay,
}: {
  value: number;
  duration?: number;
  delay?: number;
}) {
  const n = useCountUp(value, { duration, delay });
  return <>{n.toFixed(2)}</>;
}

/** Generic count-up with a caller-supplied formatter. */
export function CountUp({
  value,
  format,
  duration,
  delay,
}: {
  value: number;
  format: (n: number) => ReactNode;
  duration?: number;
  delay?: number;
}) {
  const n = useCountUp(value, { duration, delay });
  return <>{format(n)}</>;
}
