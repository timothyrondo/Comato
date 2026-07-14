/**
 * The ambient canvas that every glass surface frosts over. A warm, bright,
 * softly-blurred light base (cream → peach → soft-orange glows) — no external
 * network images, so the app stays self-contained and CSP-safe. Fixed and
 * non-interactive; sits behind all UI.
 *
 * ── Dropping in a real background image ────────────────────────────────────
 * Two optional, self-contained hooks (either resolves to a bundled/inlined
 * asset — nothing is fetched from a third-party host, so the strict CSP holds):
 *
 *   1. Env var — set `VITE_BG_IMAGE` to a URL Vite can resolve at build time,
 *      e.g. an imported asset URL or a `/public` path:
 *          VITE_BG_IMAGE=/bg.jpg           (file in apps/web/public/)
 *      (declared in `src/vite-env.d.ts`).
 *
 *   2. Bundled asset — just drop a file at `src/assets/bg.{jpg,jpeg,png,webp,avif}`.
 *      It is auto-discovered via `import.meta.glob` and bundled by Vite; no code
 *      change needed. If both are present, `VITE_BG_IMAGE` wins.
 *
 * When an image is found it is rendered blurred behind the glass with a warm
 * scrim so the frosted panels still read. With no image, the CSS mesh below is
 * the background.
 */

import { useReducedMotion } from "framer-motion";
import { motion } from "../lib/motion";

// Auto-discover an optional bundled background (empty object if none exists —
// the file need not be present, so the build stays green either way).
const bundledBg = Object.values(
  import.meta.glob("../assets/bg.{jpg,jpeg,png,webp,avif}", {
    eager: true,
    query: "?url",
    import: "default",
  }),
)[0] as string | undefined;

const bgImage =
  (import.meta.env.VITE_BG_IMAGE as string | undefined) || bundledBg;

export default function AmbientBackground() {
  const reduce = useReducedMotion();
  // Slow, organic multi-axis drift on each glow (transform-only → GPU-friendly).
  // Disabled entirely under reduced-motion; the glows just sit still.
  const drift = (
    x: number[],
    y: number[],
    scale: number[],
    duration: number,
  ) =>
    reduce
      ? undefined
      : {
          animate: { x, y, scale },
          transition: {
            duration,
            repeat: Infinity,
            repeatType: "mirror" as const,
            ease: "easeInOut" as const,
          },
        };

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      style={{
        background:
          "radial-gradient(135% 105% at 18% -10%, #fdf3e8 0%, #f8e7d5 42%, #f3ddc9 72%, #efd4bd 100%)",
      }}
    >
      {/* Optional real background image (blurred), sits above the base wash. */}
      {bgImage && (
        <>
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${bgImage})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "blur(44px) saturate(118%)",
              transform: "scale(1.12)",
            }}
          />
          {/* Warm scrim so frosted glass keeps its contrast over the photo. */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,244,232,0.55) 0%, rgba(250,232,216,0.62) 100%)",
            }}
          />
        </>
      )}

      {/* Primary orange glow, top-left */}
      <motion.div
        className="absolute -left-[12%] -top-[16%] h-[64vh] w-[64vh] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(241,137,60,0.42) 0%, rgba(241,137,60,0.12) 44%, transparent 70%)",
          filter: "blur(34px)",
        }}
        {...drift([0, 26, -14], [0, -30, 16], [1, 1.07, 1.02], 26)}
      />
      {/* Coral / pink counter-glow, bottom-right */}
      <motion.div
        className="absolute -bottom-[22%] -right-[10%] h-[70vh] w-[70vh] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(226,105,133,0.28) 0%, rgba(226,105,133,0.08) 46%, transparent 72%)",
          filter: "blur(38px)",
        }}
        {...drift([0, -22, 12], [0, 24, -12], [1, 1.05, 1.01], 32)}
      />
      {/* Warm peach highlight to add brightness on the right */}
      <motion.div
        className="absolute right-[16%] top-[26%] h-[44vh] w-[44vh] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(224,149,89,0.3) 0%, transparent 68%)",
          filter: "blur(30px)",
        }}
        {...drift([0, 18, -10], [0, 20, -8], [1, 1.08, 1.03], 22)}
      />
      {/* Soft cream bloom, lower-left, keeps the base from going flat */}
      <motion.div
        className="absolute -bottom-[10%] left-[8%] h-[46vh] w-[46vh] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(255,246,235,0.6) 0%, transparent 66%)",
          filter: "blur(30px)",
        }}
        {...drift([0, 20, -12], [0, -14, 10], [1, 1.06, 1.0], 29)}
      />
      {/* Fine grain to break up the gradients (self-contained SVG noise) */}
      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-multiply"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
      {/* Subtle warm vignette for focus (light, not dark) */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 92% at 50% 42%, transparent 52%, rgba(190,120,70,0.14) 100%)",
        }}
      />
    </div>
  );
}
