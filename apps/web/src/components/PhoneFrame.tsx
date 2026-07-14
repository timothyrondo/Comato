import type { ReactNode } from "react";

/**
 * Centers the app in a phone-width column. On mobile it's full-bleed; on larger
 * screens it floats as a device on a calm ambient backdrop. The inner column is
 * `position: relative` so the bottom tab bar can anchor to it.
 */
export default function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh w-full justify-center overflow-hidden bg-[#e6e9e3]">
      {/* Ambient backdrop for wide screens */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden sm:block"
        style={{
          background:
            "radial-gradient(120% 80% at 50% -10%, rgba(34,197,136,0.14), transparent 55%), radial-gradient(90% 60% at 50% 120%, rgba(19,32,24,0.12), transparent 60%)",
        }}
      />
      <div className="relative flex min-h-dvh w-full max-w-[440px] flex-col bg-bg sm:my-6 sm:min-h-[860px] sm:overflow-hidden sm:rounded-[2.75rem] sm:shadow-float sm:ring-1 sm:ring-black/5">
        {children}
      </div>
    </div>
  );
}
