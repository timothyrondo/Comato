# apps/server — x402 premium-heartbeat server (Track 2 engine)

Paid `GET /heartbeat` gated by x402. Each successful call = **one facilitator
settlement** with `COMATO_WALLET` as payee → **+1 Track 2 count** (plus a little
Track 1 volume, C3). Bun + Hono. The bundled heartbeat client drives paid calls from
self-operated test subscriber wallets to accumulate the count continuously.

See `../../docs/comato-architecture.md` §4 (x402 wiring) and §7.1 (streaming premium).

## The facilitator/relayer gotcha (read this)

Track 2 (Dune constraint **C2**) only counts settlements whose on-chain `tx_from` is
the **Celo relayer** `0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48`. That means:

- The facilitator **must** be Celo's: `HTTPFacilitatorClient({ url: "https://api.x402.celo.org" })`.
  Any other facilitator settles from a **different** relayer — it works, but
  counts for **nothing**.
- **Base URL = the `api.` host.** Verified against the live endpoint:
  `https://api.x402.celo.org/supported` returns JSON; `https://x402.celo.org/supported`
  returns the landing-page HTML and crashes the SDK. The arch doc's
  "facilitator `https://x402.celo.org`" is the human-facing site; the API is `api.…`.
  The `/supported` `signers` map lists the eip155:42220 relayer as `0x0d74…FB48`,
  confirming this host is the real Celo facilitator.
- **Enforcement in code:** `onAfterSettle` (in `src/x402-server.ts`) logs
  `SettleResponse.transaction`, then reads that tx from the Celo RPC and asserts
  `tx.from === X402_RELAYER`. A mismatch logs `x402.relayer.mismatch` at error level
  (the count will not land — check the facilitator URL). Toggle with
  `DEFAULTS.assertRelayer` (`src/constants.ts`). The reader (`fetchSettlementSender`) reuses **one cached viem
  client per RPC** and does a **brief non-throwing retry** (O6) so a settlement that
  isn't yet propagated doesn't emit a spurious `x402.relayer.unverified`; it never throws
  and never blocks the settlement (returns `null` → `unverified` only after retries).

## API key & credits (required to settle — read this)

The Celo facilitator's **`POST /settle` requires an `X-API-Key` header** and **spends
1 credit per settlement**. Verified live (2026-07-14): `POST /settle` with no key →
`401 {"error":"unauthorized","message":"Missing X-API-Key"}`. Without the key the server
boots and returns 402s fine but **every paid heartbeat fails at settle** → zero Track 2
counts. `/verify`, `/supported`, `/health` are **public** (no key).

- **Config:** `X402_API_KEY` (required; zod-validated in `src/config.ts` → `cfg.apiKey`).
  Create it on the **x402.celo.org dashboard** by signing with the Comato ops wallet
  (no gas, no tx) — bind it to the same wallet so settlements + credits align.
- **How it's wired:** `src/x402-server.ts` `celoFacilitatorAuthHeaders(cfg.apiKey)`
  builds the SDK's `createAuthHeaders` callback and passes it to
  `new HTTPFacilitatorClient({ url, createAuthHeaders })`. The SDK merges the returned
  per-path map into each request; we attach `X-API-Key` to **`settle` only** (scoped —
  `/verify` and `/supported` are public and stay keyless). Header name is
  `X402_API_KEY_HEADER` (`X-API-Key`) in `src/constants.ts`.
- **Economics:** **500 free credits mainnet, 1000 testnet**, then top up (~$0.001/credit,
  $5 = 5,000). At **0 credits `/settle` → 402** until you top up. 1 x402 count = 1 credit.
- **Endpoints:** mainnet `https://api.x402.celo.org` (Celo **42220**); testnet
  `https://api.x402.sepolia.celo.org` (Celo Sepolia **11142220**) — see
  `X402_FACILITATOR_URL_TESTNET` in `src/constants.ts`. Use an `x402_live_…` key on
  mainnet, `x402_test_…` on testnet.

## Pricing / token

- Price is an explicit `AssetAmount` — Celo (eip155:42220) is **not** in the SDK's
  default stablecoin table, so asset + EIP-712 domain must be supplied:
  `{ asset: <USDC>, amount: "1000", extra: { name: "USDC", version: "2" } }`.
- Asset: native USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` (6 dec, EIP-3009).
  `name`/`version` were read on-chain (`name()`→"USDC", `version()`→"2").
- Default premium `PREMIUM_USDC=0.001` → `1000` atomic units.

## Layout

```
src/constants.ts       Celo x402 constants (mirrors packages/shared/addresses.ts)
src/config.ts          env loading + validation (zod + viem) — server & client
src/logger.ts          structured JSON-lines logger
src/x402-server.ts     facilitator + resource server + onAfterSettle relayer assertion
src/app.ts             Hono app: GET /heartbeat (paid) + GET /health (open)
src/index.ts           boot + graceful shutdown (Bun.serve)
src/heartbeat-client.ts  subscriber loop (@x402/* payer client) — the count engine
test/heartbeat.test.ts  402 unpaid, 200 paid + settle, relayer classification
```

## Run

```bash
cp .env.example .env         # fill COMATO_WALLET, X402_API_KEY, SUBSCRIBER_PRIVATE_KEYS
bun run start                # server (bun run dev = watch mode)
bun run heartbeat            # in another shell: drive paid heartbeats
bun run typecheck            # tsc --noEmit
bun test                     # mocked-facilitator tests (no funds/network needed)
```

`DEFAULTS.syncFacilitatorOnStart` (`src/constants.ts`, default `true`) is **required**
for real runs: the server fetches supported kinds from the facilitator on boot to build
the 402. With it off the server boots but `/heartbeat` 500s ("call initialize()"). Tests
pass a mock facilitator, so they run fully offline.

## Env

`.env` holds only secrets + per-deployment values. **Tuning params (port,
facilitator URL, `X402_SYNC_ON_START`/`X402_ASSERT_RELAYER` toggles, heartbeat
cadence, `MAX_PAYMENT_USDC` ceiling) live in `src/constants.ts` (`DEFAULTS`)** —
adjust them there, not in `.env`.

| var | purpose |
|---|---|
| `COMATO_WALLET` | registered EOA, premium **payee** (required) |
| `X402_API_KEY` | **required** — Celo facilitator key, sent as `X-API-Key` on `/settle` (1 credit each; 500 free mainnet / 1000 testnet). `/verify`+`/supported` are public |
| `SUBSCRIBER_PRIVATE_KEYS` | **required** — comma-separated 0x keys of test subscribers (client) |
| `CELO_RPC` | RPC for the relayer assertion (default forno) |
| `PREMIUM_USDC` | premium per heartbeat, decimal USDC (default `0.001`) |
| `HEARTBEAT_URL` | client target (default `http://localhost:4021/heartbeat`) |

Secrets from env only — never commit real keys. `.env` is gitignored; `.env.example`
holds placeholders.

## How the Track 2 count is earned

1. Subscriber client `GET /heartbeat` → server replies `402` with the price + `payTo`.
2. Client signs an EIP-3009 authorization (the `@x402/*` payer client), retries with the
   `PAYMENT-SIGNATURE` header.
3. Server verifies + settles via `api.x402.celo.org`; the Celo relayer (`0x0d74…FB48`)
   submits the on-chain transfer to `COMATO_WALLET`.
4. That tx satisfies C2 (`tx_from = relayer`, `to = wallet`) → **+1 Track 2**, and its
   USD adds to Track 1 (C3). `onAfterSettle` logs the tx hash and confirms the relayer.
5. The client loop repeats every `HEARTBEAT_INTERVAL_MS` across all subscribers,
   accumulating count over the 6-day run.

**Identity:** commits/authorship are **Timo / timothyrondo**.
