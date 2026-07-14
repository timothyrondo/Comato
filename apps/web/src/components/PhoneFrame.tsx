import type { ReactNode } from "react";

/**
 * Centers the app in a phone-width column over the shared ambient canvas. On a
 * real phone it's full-bleed; on wider screens it floats as a frosted glass
 * device. (Desktop ≥1024px swaps to the dashboard, so this only renders below.)
 */
export default function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh w-full justify-center overflow-hidden px-0 sm:px-6 sm:py-8">
      <div className="relative flex min-h-dvh w-full max-w-[440px] flex-col overflow-hidden bg-transparent sm:min-h-[880px] sm:rounded-[2.75rem] sm:border sm:border-ink/10 sm:shadow-float">
        {children}
      </div>
    </div>
  );
}
