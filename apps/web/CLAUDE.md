# apps/web

Premium **responsive** UI for **Comato** (Vite + React + TS + Tailwind v4). One codebase, two layouts sharing the same data + nav state: a **desktop glass dashboard** (≥1024px) and a **glass-restyled mobile app** (<1024px). Style references: `../../../references/ui/desktop(3).png` (desktop, primary), `desktop.png` / `desktop(2).png` (glass), `mobile.png` (phone).

## Design system — glassmorphism (visionOS)
Frosted translucent surfaces over a deep, blurred **emerald-black** canvas. Protective-green accent adapted to glass (emerald glow/gradient on dark). Tokens + glass utilities live in `src/index.css`.
- **Tokens (`@theme`)**: dark canvas `--color-bg`; **light** ink on dark (`--color-ink`/`-soft`/`-muted`); emerald accent (`--color-accent` `#23d18a`, `-bright`, `-ink` for text, `-soft` translucent tint); glass hairlines (`--color-line` = rgba white); risk (`--color-safe`/`-warn`/`-danger`, brightened); `--radius-panel` (32px, desktop). Fonts unchanged (Plus Jakarta Sans display + Inter body). The "dark" tone tokens are repurposed as a **deep frosted well**.
- **Glass utility classes** (the core of the look; compose with Tailwind layout utils, they carry their own bg/border/shadow — don't add `bg-*`/`shadow-*` on top):
  - `.glass` — primary frosted panel (30px blur, top light edge, deep shadow). Big containers, cards, sidebar, tab bar.
  - `.glass-soft` — lighter tile (18px blur). StatTile `light`, light activity rows, buttons.
  - `.glass-deep` — deep dark-tinted well (emphasis). StatTile `dark`, rescue cards, profile, agent card. Pair with `text-on-dark`.
  - `.glass-accent` — emerald-tinted glass with glow. Hero, accent tiles, active nav, rescue explainer.
  - `.glass-chip` — small inset chip (wallet rows, badges). `.btn-primary` — emerald gradient CTA + protection glow.
- **Patterns**: generous rounding, soft/deep shadows, top light edges, emerald glow on primary actions & the HF ring. Signature = the vital-signs motif: **Health Factor ring** (glowing risk zones) + **ECG PulseLine** + the desktop **Health Factor trace** chart.
- `AmbientBackground` renders the shared fixed canvas (dark gradient + drifting blurred emerald/teal glows + faint noise) that every glass surface frosts over — no external images.

## Structure
- `src/App.tsx` — holds `screen` state; `useIsDesktop()` (`lib/useIsDesktop.ts`, matchMedia ≥1024px) switches between `DesktopApp` and the mobile `PhoneFrame` + screens + `TabBar`. `AmbientBackground` is shared.
- `src/desktop/DesktopApp.tsx` — the glass dashboard: left **Sidebar** (logo + nav Overview/Positions/Activity/Settings + "Timo" + Live/Demo), **TopBar**, and four views (Overview = hero + HF ring/tiles + HF trace + position row + right rail [Activity / Protection premium / All-clear meter]; Positions; Activity; Settings). Nav maps to the SAME `Screen` values as mobile (home/position/activity/account).
- `src/screens/` — mobile HomeScreen / PositionScreen / ActivityScreen / AccountScreen (single-column, glass-restyled). All read `useComatoData()`.
- `src/components/` — PhoneFrame, TabBar, StatTile (tones → glass elevations), HealthRing (glowing gauge), **HealthChart** (`buildHealthSeries()` — HF-over-time trace built from **real** rescue events `hfBefore`/`hfAfter` + current HF; no invented data), RescueTimeline, ActivityCard, PillButton, PulseLine, Avatar, AmbientBackground, icons.
- `src/data/` — `fixtures.ts` (mock + data types: `User`/`Position`/`RescueStep`/`ActivityItem`), `live.ts` (on-chain reads → UI types), `context.tsx` (`ComatoDataProvider` + `useComatoData` — resolves live-or-mock, 12s polling, `refresh()`).
- `src/lib/` — `env.ts` (reads `import.meta.env.VITE_*` → `liveConfig`), `chain.ts` (viem public client, read-only), `abis.ts` (Aave Pool / ComatoPolicy / ComatoExecutor), `constants.ts` (verified Celo addresses, mirrors `packages/shared`), `format.ts`, `useIsDesktop.ts`.
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
- Preserve the premium **glass** look across **both** layouts (desktop dashboard + mobile) — frosted depth, blur, light edges, emerald glow; not flat low-opacity cards. Use the `.glass-*` utilities, don't reinvent surfaces. UI copy in clear, natural English. Import addresses/ABIs, don't guess them. Author identity: **Timo / timothyrondo**.
