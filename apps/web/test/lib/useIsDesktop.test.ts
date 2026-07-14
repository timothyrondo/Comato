import { test, expect, describe } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useIsDesktop } from "../../src/lib/useIsDesktop";
import { setDesktop } from "../helpers";

/**
 * useIsDesktop reads window.matchMedia synchronously on first render. The
 * harness stubs matchMedia with a controllable `matches` flag (setDesktop).
 */

describe("useIsDesktop", () => {
  test("true when the media query matches (≥1024px)", () => {
    setDesktop(true);
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
  });

  test("false below the breakpoint", () => {
    setDesktop(false);
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(false);
  });

  test("accepts a custom query", () => {
    setDesktop(true);
    const { result } = renderHook(() => useIsDesktop("(min-width: 640px)"));
    expect(result.current).toBe(true);
  });
});
