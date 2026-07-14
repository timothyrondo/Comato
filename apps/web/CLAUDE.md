# apps/web

Premium mobile UI for **Comato** (Vite + React + TS + Tailwind). Style reference: `../../../references/ui/mobile.png`.

## Design system
- Accent: **protective emerald + green-tinted near-black** over a warm off-white. Tokens live in `src/index.css` (`--color-*`).
- Patterns: floating rounded cards + hairline borders, bold headers + muted subtext, **dark pill CTAs** + icons, **stat tiles** (big numbers + tiny labels, mixed dark/light), line-icon bottom tab, gradient hero card. Mobile-first, wrapped in a phone frame.

## Structure
- `src/screens/` — HomeScreen (protected status + stat tiles + "Protect Position" CTA), PositionScreen (health-factor ring + threshold + timeline), ActivityScreen (rescue cards), AccountScreen. All read data through `useComatoData()`.
- `src/components/` — PhoneFrame, RescueTimeline, HealthRing, etc.
- `src/data/` — `fixtures.ts` (mock + data types: `User`/`Position`/`RescueStep`/`ActivityItem`), `live.ts` (on-chain reads → UI types), `context.tsx` (`ComatoDataProvider` + `useComatoData` — resolves live-or-mock, 12s polling, `refresh()`).
- `src/lib/` — `env.ts` (reads `import.meta.env.VITE_*` → `liveConfig`), `chain.ts` (viem public client, read-only), `abis.ts` (Aave Pool / ComatoPolicy / ComatoExecutor), `constants.ts` (verified Celo addresses, mirrors `packages/shared`), `format.ts`.
- `src/types.ts` — navigation type (`Screen`).

## Live-data wiring (ALREADY connected)
Screen data comes from `useComatoData()`. It resolves to **live on-chain** data when the env below is populated, otherwise it **falls back to the mock** `fixtures.ts` (so `bun run dev` runs standalone with no setup). All reads use **viem in the browser** (read-only; the UI never signs a tx).

| Data | Live source |
| --- | --- |
| Health factor + collateral/debt + LTV/threshold | Aave V3 `Pool.getUserAccountData(subscriber)` |
| Rescue threshold + collateral/debt asset + policy status | `ComatoPolicy.getPolicy(policyId)` |
| Rescue history (rescue cards + summary) | `ComatoExecutor` event `RescueExecuted` (scanned from `VITE_FROM_BLOCK`) |

Env (Vite; all optional → absent = mock). Written automatically by `bun run demo` into `apps/web/.env.local` (gitignored, ephemeral, **no secrets**):

| Var | Example | Meaning |
| --- | --- | --- |
| `VITE_RPC_URL` | `http://127.0.0.1:8546` | RPC (anvil Celo fork during the demo) |
| `VITE_CHAIN_ID` | `42220` | chain id (Celo / fork) |
| `VITE_POLICY_ADDR` | `0x…` | ComatoPolicy address |
| `VITE_EXECUTOR_ADDR` | `0x…` | ComatoExecutor address (source of the RescueExecuted event) |
| `VITE_SUBSCRIBER_ADDR` | `0x…` | the borrower being displayed |
| `VITE_POLICY_ID` | `1` | that borrower's policy id |
| `VITE_FROM_BLOCK` | `72081000` | starting block for log scans (keeps getLogs from sweeping all of Celo's history) |

Minimum to go live: `VITE_RPC_URL` + `VITE_SUBSCRIBER_ADDR` + one of (`VITE_POLICY_ADDR`/`VITE_EXECUTOR_ADDR`). A malformed env / failed read auto-degrades to mock (the UI never goes blank). The badge on Home shows **Live** (on-chain) vs **Demo** (mock).

## Run
- `bun run dev` (dev server, standalone mock) · `bun run build` (tsc + vite build).
- **`bun run demo`** (from the repo root) — fork Celo + deploy + real rescue + serve the live UI. See `DEMO.md`.

## Rules
- Preserve the premium design (don't regress the look). UI copy in clear, natural English. Import addresses/ABIs, don't guess them. Author identity: **Timo / timothyrondo**.
