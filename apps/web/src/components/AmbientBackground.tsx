/**
 * The ambient canvas that every glass surface frosts over. A deep emerald-black
 * base with a few large, softly drifting radial glows — no external images, so
 * the app stays self-contained. Fixed and non-interactive; sits behind all UI.
 */
export default function AmbientBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      style={{
        background:
          "radial-gradient(130% 100% at 15% -10%, #0d1c16 0%, #070d0b 45%, #050907 100%)",
      }}
    >
      {/* Primary protective-emerald glow, top-left */}
      <div
        className="drift absolute -left-[12%] -top-[18%] h-[62vh] w-[62vh] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(35,209,138,0.42) 0%, rgba(35,209,138,0.10) 42%, transparent 70%)",
          filter: "blur(30px)",
        }}
      />
      {/* Teal counter-glow, bottom-right */}
      <div
        className="drift absolute -bottom-[22%] -right-[10%] h-[70vh] w-[70vh] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(28,150,180,0.30) 0%, rgba(28,150,180,0.08) 45%, transparent 72%)",
          filter: "blur(34px)",
          animationDelay: "-6s",
        }}
      />
      {/* Warm deep accent to add depth on the right */}
      <div
        className="drift absolute right-[18%] top-[30%] h-[40vh] w-[40vh] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(87,240,168,0.18) 0%, transparent 68%)",
          filter: "blur(26px)",
          animationDelay: "-11s",
        }}
      />
      {/* Fine grain to break up the gradients (self-contained SVG noise) */}
      <div
        className="absolute inset-0 opacity-[0.04] mix-blend-soft-light"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
      {/* Subtle vignette for focus */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(0,0,0,0.35) 100%)",
        }}
      />
    </div>
  );
}
