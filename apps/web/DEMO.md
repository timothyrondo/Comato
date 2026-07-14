# Comato — one-command live demo

> Fork Celo mainnet → deploy the Comato contracts → put a real Aave V3 position
> at the edge of liquidation → rescue it for real → show it in the premium UI.

```bash
# from the repo root — needs `anvil` + `forge` (Foundry) on PATH and network
# access to the Celo fork RPC.
bun run demo
```

Then open the Vite URL it prints (default **http://localhost:5173**).

`Ctrl-C` stops everything (kills both Vite and the anvil fork).

## What it does

`bun run demo` runs `e2e/src/demo.ts`, reusing the e2e harness (`AnvilFork`) — no
duplicated fork/deploy logic, no real keys (it uses the public anvil dev accounts
and funds them by impersonating Aave aTokens on the local fork):

1. `forge build`, then boot `anvil --fork-url <celo>` (chain 42220, pinned block).
2. Deploy **ComatoPolicy** + **ComatoExecutor** (owner = the Comato operator EOA).
3. Open a real Aave V3 position: supply USDT, borrow USDC to ~99% LTV → **HF just
   above 1.0** (genuinely near liquidation).
4. Subscriber creates an on-chain policy (USDT collateral, USDC debt, threshold
   HF 1.20).
5. Fund the executor's USDC float, then drive **real rescues** through
   `ComatoExecutor.rescue()` — each repays part of the debt and emits
   `RescueExecuted`, lifting the health factor back into the safe zone. A second
   rescue fires after a re-breach (subscriber borrows again) for a fuller feed.
6. Write the deployed addresses to **`apps/web/.env.local`** (gitignored).
7. Serve `apps/web` (Vite) pointed at the fork — the browser reads the fork
   directly with viem.

## What a judge sees (all LIVE, read from the fork)

- **Home** — "Protected", a **Live** badge, the real **health factor** (e.g.
  `1.64`), real collateral value, and the latest real rescue as a teaser. A
  "Checked N s ago" counter ticks against the last on-chain read.
- **Position** — the health-factor **ring** at the live HF, real **Collateral /
  Debt** (from `Pool.getUserAccountData`), live **LTV** and **liquidation
  threshold**, and the rescue trigger read from the on-chain policy (`1.20`). The
  refresh button re-reads the chain.
- **Activity** — the real **`RescueExecuted`** events as rescue cards
  (`HF 1.05 → 1.58 · repaid $494 to Aave`), with total-saved / count / average
  computed from them.

## No setup? Still works.

Without `apps/web/.env.local`, the UI falls back to the built-in mock fixtures, so
plain `bun run dev` (in `apps/web`) runs standalone — the Home badge reads **Demo**
instead of **Live**. Delete `.env.local` to return to mock mode.

## Troubleshooting

- **Port in use** — the fork uses `127.0.0.1:8546`, Vite uses `5173`. Free them or
  stop a previous `bun run demo`.
- **Cold fork is slow** — the first heavy tx makes anvil lazily fetch state from
  forno; give it a few seconds. The block is pinned for determinism + caching.
- **UI shows Demo, not Live** — check `apps/web/.env.local` exists and the fork is
  still running; a failed read degrades gracefully to mock.
