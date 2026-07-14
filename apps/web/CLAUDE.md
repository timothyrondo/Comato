# apps/web

Premium **responsive** UI for **Comato** (Vite + React + TS + Tailwind v4). One codebase, two layouts sharing the same data + nav state: a **desktop glass dashboard** (≥1024px) and a **glass-restyled mobile app** (<1024px). Style references: `../../../references/ui/desktop.png` (warm light glass, **primary**), `desktop(2).png` / `desktop(3).png` (other glass refs), `mobile.png` (phone).

## Design system — warm-light glassmorphism (visionOS)
Frosted translucent **white** surfaces over a soft, bright, blurred **warm** canvas (cream → peach → soft-orange). **Orange** brand accent with a **pink/coral** secondary; warm dark-brown ink on light. Tokens + glass utilities live in `src/index.css`.
- **Tokens (`@theme`)**: warm-light canvas `--color-bg` `#f7ede2` / `-bg-2` `#f4e0cf`; warm dark-brown ink on light (`--color-ink` `#33261d` / `-soft` / `-muted`); **orange** accent (`--color-accent` `#f1893c`, `-bright` `#ff9a4a` for gradients/dots/glows, `-ink` `#bd5713` = readable orange TEXT on light glass, `-deep` `#d9702a`, `-soft` translucent tint); **pink/coral** secondary (`--color-accent-2` `#e26985`, `-2-ink` `#c74d6a`, `-2-soft`); warm secondary orange `--color-accent-warm` `#e09559`; glass hairlines (`--color-line` = rgba warm-brown on light); risk warm-tuned & legible on light (`--color-safe` `#2a9d6f`, `-warn` `#e0912f`, `-danger` `#e0524e`); `--radius-panel` (32px, desktop). Fonts unchanged (Plus Jakarta Sans display + Inter body). The "dark" tone tokens (`--color-dark*`, `--color-on-dark*`) are repurposed as a **warm peach emphasis tile with dark warm ink**.
- **Glass utility classes** (the core of the look; compose with Tailwind layout utils, they carry their own bg/border/shadow — don't add `bg-*`/`shadow-*` on top):
  - `.glass` — primary frosted **white** panel (30px blur, bright top edge, soft warm shadow). Big containers, cards, sidebar, tab bar.
  - `.glass-soft` — lighter white tile (18px blur). StatTile `light`, light activity rows, buttons.
  - `.glass-deep` — **warm peach emphasis tile** (soft cream/peach glass, dark warm ink). StatTile `dark`, rescue cards, profile, agent card. Pair with `text-on-dark` (now dark ink) and `text-accent-ink` for emphasis numbers.
  - `.glass-accent` — **orange-tinted** glass with soft glow. Hero, accent tiles, active nav, rescue explainer. Dark ink reads on it.
  - `.glass-chip` — small inset white chip (wallet rows, badges). `.btn-primary` — **orange** gradient CTA + warm glow (light `#fff7ef` text).
- **Patterns**: generous rounding, soft warm shadows, bright top light edges, orange glow on primary actions & the HF ring, an orange→coral chart line. Signature = the vital-signs motif: **Health Factor ring** (glowing risk zones) + **ECG PulseLine** + the desktop **Health Factor trace** chart. Text/icons on an orange surface use the warm-white `#fff7ef`; deep orange `text-accent-ink` is the readable accent text on light glass.
- `AmbientBackground` renders the shared fixed canvas (warm cream→peach base + drifting blurred orange/coral/peach glows + faint noise + light warm vignette) that every glass surface frosts over — self-contained, no network images.
  - **Drop-in background image (CSP-safe):** either set env `VITE_BG_IMAGE` to a Vite-resolvable URL (an imported asset URL or a `/public` path like `/bg.jpg`), **or** just place a file at `src/assets/bg.{jpg,jpeg,png,webp,avif}` (auto-discovered via `import.meta.glob`, bundled by Vite — no code change). If present it renders **blurred behind the glass** with a warm scrim; if both, `VITE_BG_IMAGE` wins. Absent ⇒ the CSS mesh. No external/CDN hosts (strict CSP holds). Declared in `src/vite-env.d.ts`.

## Motion system — Framer Motion (`framer-motion`)
Tasteful, premium in-app motion (Apple/Linear restraint — subtle, not flashy). All primitives live in **`src/lib/motion.tsx`**; everything animates GPU-friendly props only (transform / opacity / `pathLength`) for 60fps, and **`prefers-reduced-motion` is respected end-to-end**.
- **Reduced motion:** the whole tree is wrapped in `<MotionConfig reducedMotion="user">` (App.tsx) → transform/layout animations are stripped, opacity kept. Imperative helpers (count-up, path-draw, ambient drift) additionally branch on `useReducedMotion()` and snap to their final state. The legacy CSS `@media (prefers-reduced-motion: reduce)` block in `index.css` still covers the remaining CSS loops (`pulse-dot`, `ecg-draw`).
- **Primitives (`lib/motion.tsx`):** `EASE_OUT`/`EASE_SOFT` easing tokens · `fadeRise` (fade + 14px rise, the core entrance) · `staggerContainer(stagger, delayChildren)` · `screenFade` (AnimatePresence view cross-fade) · `hoverLift`/`hoverPop`/`tapPress` micro-interaction presets · `useCountUp()` (imperative `animate()` 0→target, glides from last value on live-poll updates, snaps under reduced motion) + `MoneyCount` / `HfCount` / `CountUp` wrappers. Re-exports `motion` + `AnimatePresence`.
- **What animates & where:**
  - *Entrance:* desktop panels (`Panel`, `HeroBanner`) rise on mount via per-`delay` transitions; the **Sidebar** brand/nav/footer stagger in (nav items cascade); mobile screens (Home/Position/Activity/Account) are `staggerContainer`s whose sections are `fadeRise` items.
  - *Health Factor ring* (`HealthRing`): risk arcs draw in via `pathLength` (clockwise), the centre number counts up 0→value, and the knob glides along the arc to match — a "revival" sweep.
  - *HF trace* (`HealthChart`): line draws in via `pathLength`, area fades under it, dip/current markers pop in after.
  - *Count-up:* the ring HF, mobile Home HF tile, desktop Positions HF tile, chart HF, position-row HF, and every `$` StatTile / "Total saved" figure.
  - *Micro-interactions:* `StatTile` + `ActivityCard` hover-lift; `PillButton` / "Protect position" hover-pop + tap-press; nav items, filter chips, settings rows, refresh/bell tap feedback (refresh icon spins on tap).
  - *Screen/tab transitions:* `AnimatePresence mode="wait"` wraps the desktop view switch (TopBar persists) and the mobile `<main>` (keyed by screen → cross-fade + replayed stagger + scroll reset).
  - *Active-nav indicator:* a shared `layoutId` glass pill slides between items — `"sidebar-active"` (desktop) and `"tab-active"` (mobile TabBar).
  - *Ambient background:* the four glow blobs get a slow, organic multi-axis transform drift (`AmbientBackground`, replacing the old `.drift` CSS); the buffer meter in `AlertRail` grows in via `scaleX`.
- **Rules:** animate transform/opacity/`pathLength` only (never width/top/layout thrash — the buffer bar uses `scaleX`, not `width`); keep it subtle; always guard imperative/continuous motion with `useReducedMotion()`. Motion is presentation-only — it never touches `useComatoData()`, the Live/Demo badge, or the glass surfaces.

## Structure
- `src/App.tsx` — holds `screen` state; `useIsDesktop()` (`lib/useIsDesktop.ts`, matchMedia ≥1024px) switches between `DesktopApp` and the mobile `PhoneFrame` + screens + `TabBar`. Wraps everything in `<MotionConfig reducedMotion="user">`; mobile screen switches go through `AnimatePresence`. `AmbientBackground` is shared.
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
- Preserve the premium **warm-light glass** look across **both** layouts (desktop dashboard + mobile) — frosted white depth, blur, bright top edges, orange glow; not flat low-opacity cards. Keep the **orange** brand accent + **pink/coral** secondary; no emerald/green (a warm green-teal is allowed only for the risk-"safe" state's legibility). Use the `.glass-*` utilities, don't reinvent surfaces. UI copy in clear, natural English. Import addresses/ABIs, don't guess them. Author identity: **Timo / timothyrondo**.
