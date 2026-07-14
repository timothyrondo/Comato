/**
 * Shared test helpers: a provider-wrapped render + handles on the harness stubs
 * defined in `setup.ts`.
 */
import type { ReactElement, ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { ComatoDataProvider } from "../src/data/context";

const store = globalThis as Record<string, unknown>;

/** Swap the viem stub client's methods for the current test. */
export function setClientStub(partial: {
  readContract?: (...a: unknown[]) => Promise<unknown>;
  getContractEvents?: (...a: unknown[]) => Promise<unknown>;
  getBlock?: (...a: unknown[]) => Promise<unknown>;
}): void {
  (store.__setClientStub as (p: unknown) => void)(partial);
}

/** The args the last `createPublicClient` call received (chain + transport). */
export function lastCreateClientArgs(): { chain?: { id?: number } } | null {
  return store.__createClientArgs as { chain?: { id?: number } } | null;
}

/** Toggle the matchMedia stub to report desktop (≥1024px) or mobile. */
export function setDesktop(on: boolean): void {
  (store.__setDesktop as (on: boolean) => void)(on);
}

/** Flip the mocked useReducedMotion return (default true → count-ups snap). */
export function setReducedMotion(on: boolean): void {
  store.__reducedMotion = on;
}

/** Render a tree wrapped in the real ComatoDataProvider (LIVE-configured). */
export function renderWithData(ui: ReactElement): RenderResult {
  return render(<ComatoDataProvider>{ui}</ComatoDataProvider>);
}

export function Wrapper({ children }: { children: ReactNode }) {
  return <ComatoDataProvider>{children}</ComatoDataProvider>;
}
