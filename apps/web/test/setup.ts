/**
 * Test harness preload (wired via bunfig.toml `[test] preload`).
 *
 * Runs ONCE before any test file, and establishes a fully offline React test
 * environment on top of `bun test`:
 *
 *   1. happy-dom  — a real DOM (document/window) so @testing-library/react can
 *      mount components. Registered globally.
 *   2. framer-motion is mocked to inert pass-through components + a
 *      `useReducedMotion() → true` stub. This keeps happy-dom out of the
 *      animation runtime and, crucially, makes every count-up (`useCountUp`)
 *      snap straight to its target value — so rendered numbers are assertable.
 *   3. viem's `createPublicClient` is mocked to return a controllable stub
 *      client (`clientStub`). Every other viem export (formatUnits, isAddress,
 *      getAddress, http, …) is the REAL implementation, so env/constants/chain/
 *      live all run their genuine logic. Because the ONLY client factory returns
 *      a stub, no test can ever reach the network — the harness is offline by
 *      construction.
 *   4. `VITE_*` env is populated so the real `liveConfig` resolves NON-null and
 *      the data context runs its LIVE code path. `bun test` shares one module
 *      registry across files and `liveConfig` is a module singleton, so a single
 *      mode must serve the whole run; LIVE is chosen because it exercises the
 *      most code. The default stub returns never-settling promises, so provider
 *      renders sit on the initial mock fixtures ("Demo" badge) with no async
 *      state churn — individual context tests swap the stub to drive live/error.
 *   5. `window.matchMedia` is a controllable stub (drives `useIsDesktop`).
 *
 * Test-only helpers are exposed on `globalThis` (see `test/helpers.ts`).
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock, afterEach } from "bun:test";
import * as React from "react";
import * as realViem from "viem";

/* ── 1. DOM ─────────────────────────────────────────────── */
GlobalRegistrator.register();

/* ── 4. Live-data env (must be set before env.ts is imported) ─── */
process.env.VITE_RPC_URL = "http://127.0.0.1:8546";
process.env.VITE_CHAIN_ID = "42220";
process.env.VITE_SUBSCRIBER_ADDR = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
process.env.VITE_POLICY_ADDR = "0x3e59a31363e2ad014dcbc521c4a0d5757d9f3402";
process.env.VITE_POLICY_ID = "1";
process.env.VITE_FROM_BLOCK = "100";
// Subscribe-flow config (browser vault flow). Present so the connected branches
// of SubscribeFlow are reachable; no test reaches the network (viem is stubbed).
process.env.VITE_VAULT_FACTORY_ADDR = "0x1111111111111111111111111111111111111111";
process.env.VITE_OPERATOR_ADDR = "0x2222222222222222222222222222222222222222";

/* ── 5. matchMedia (controllable; default = mobile) ─────── */
type MatchState = { matches: boolean };
const matchState: MatchState = { matches: false };
(globalThis as Record<string, unknown>).__setDesktop = (on: boolean) => {
  matchState.matches = on;
};
window.matchMedia = ((query: string) => ({
  matches: matchState.matches,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

/* ── 3. viem stub client (offline) ──────────────────────── */
const neverSettle = () => new Promise<never>(() => {});
export interface ClientStub {
  readContract: (...a: unknown[]) => Promise<unknown>;
  getContractEvents: (...a: unknown[]) => Promise<unknown>;
  getBlock: (...a: unknown[]) => Promise<unknown>;
}
const clientStub: ClientStub = {
  readContract: neverSettle,
  getContractEvents: neverSettle,
  getBlock: neverSettle,
};
const store = globalThis as Record<string, unknown>;
store.__clientStub = clientStub;
store.__createClientArgs = null;
/** Replace the stub methods for a single test (see helpers.setClientStub). */
store.__setClientStub = (partial: Partial<ClientStub>) => {
  Object.assign(clientStub, partial);
};
store.__resetClientStub = () => {
  clientStub.readContract = neverSettle;
  clientStub.getContractEvents = neverSettle;
  clientStub.getBlock = neverSettle;
};

mock.module("viem", () => ({
  ...realViem,
  createPublicClient: (args: unknown) => {
    store.__createClientArgs = args;
    return clientStub;
  },
}));

/* ── 2. framer-motion (inert pass-through) ──────────────── */
const MOTION_PROPS = new Set([
  "initial", "animate", "exit", "transition", "variants", "custom",
  "whileHover", "whileTap", "whileFocus", "whileInView", "whileDrag",
  "drag", "dragConstraints", "dragElastic", "dragMomentum", "dragSnapToOrigin",
  "layout", "layoutId", "layoutDependency", "layoutScroll", "layoutRoot",
  "viewport", "onViewportEnter", "onViewportLeave", "transformTemplate",
  "onUpdate", "onAnimationStart", "onAnimationComplete",
  "onHoverStart", "onHoverEnd", "onTap", "onTapStart", "onTapCancel",
  "onDrag", "onDragStart", "onDragEnd", "onPan", "onPanStart", "onPanEnd",
  "style", // recombined below (kept), but stripped from the raw spread first
]);

function strip(props: Record<string, unknown>) {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (key === "children") continue;
    if (key === "style") {
      clean.style = props.style;
      continue;
    }
    if (MOTION_PROPS.has(key)) continue;
    clean[key] = props[key];
  }
  return clean;
}

const motionCache = new Map<string, React.ElementType>();
function motionComponent(tag: string): React.ElementType {
  let comp = motionCache.get(tag);
  if (!comp) {
    comp = React.forwardRef(
      (props: Record<string, unknown>, ref: React.Ref<unknown>) =>
        React.createElement(
          tag,
          { ref, ...strip(props) },
          props.children as React.ReactNode,
        ),
    );
    (comp as { displayName?: string }).displayName = `motion.${tag}`;
    motionCache.set(tag, comp);
  }
  return comp;
}

const motionProxy = new Proxy(
  {},
  {
    get: (_t, key: string) => motionComponent(key),
  },
) as Record<string, React.ElementType>;

const passthrough = ({ children }: { children?: React.ReactNode }) =>
  React.createElement(React.Fragment, null, children);

// Reduced motion defaults ON (count-ups snap to their target so rendered
// numbers are assertable). A test may flip it via helpers.setReducedMotion to
// exercise the animated code path.
store.__reducedMotion = true;
mock.module("framer-motion", () => ({
  motion: motionProxy,
  AnimatePresence: passthrough,
  MotionConfig: passthrough,
  useReducedMotion: () => store.__reducedMotion as boolean,
  useInView: () => true,
  animate: (_from: unknown, to: unknown, opts?: { onUpdate?: (v: unknown) => void }) => {
    opts?.onUpdate?.(to);
    return { stop() {}, then: (r: () => void) => r() };
  },
}));

/* ── @testing-library/react cleanup between tests ───────── */
import { cleanup } from "@testing-library/react";
afterEach(() => {
  cleanup();
  (store.__resetClientStub as (() => void) | undefined)?.();
  store.__reducedMotion = true;
});
