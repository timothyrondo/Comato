import { useEffect, useState } from "react";

/**
 * True at the desktop breakpoint (≥1024px). Drives the layout switch between the
 * glass dashboard and the single-column phone experience. Reads synchronously on
 * first render so there's no wrong-layout flash, and stays in sync on resize.
 */
export function useIsDesktop(query = "(min-width: 1024px)"): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setIsDesktop(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return isDesktop;
}
