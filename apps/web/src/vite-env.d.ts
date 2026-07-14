/// <reference types="vite/client" />

/**
 * Live-data wiring env (all optional — absent ⇒ the UI falls back to mock data,
 * so `bun run dev` works standalone). The demo runner (`bun run demo`) writes
 * these into `apps/web/.env.local` after it deploys to a local Celo fork.
 */
interface ImportMetaEnv {
  /** JSON-RPC endpoint (e.g. the anvil Celo fork at http://127.0.0.1:8546). */
  readonly VITE_RPC_URL?: string;
  /** Chain id of the RPC (Celo mainnet / fork = 42220). */
  readonly VITE_CHAIN_ID?: string;
  /** Deployed ComatoPolicy address. */
  readonly VITE_POLICY_ADDR?: string;
  /** Deployed ComatoExecutor address (source of RescueExecuted events). */
  readonly VITE_EXECUTOR_ADDR?: string;
  /** The subscriber (borrower) address whose Aave position the UI displays. */
  readonly VITE_SUBSCRIBER_ADDR?: string;
  /** The on-chain policy id protecting that subscriber. */
  readonly VITE_POLICY_ID?: string;
  /** First block to scan for RescueExecuted logs (keeps getLogs off Celo history). */
  readonly VITE_FROM_BLOCK?: string;
  /**
   * Optional background image for the warm ambient canvas. A Vite-resolvable
   * URL (imported asset URL or a `/public` path like `/bg.jpg`). Rendered
   * blurred behind the glass; absent ⇒ the self-contained CSS mesh is used.
   * See `components/AmbientBackground.tsx`.
   */
  readonly VITE_BG_IMAGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
