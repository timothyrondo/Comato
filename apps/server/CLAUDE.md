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
  thirdweb's default facilitator settles from a **different** relayer — it works, but
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
  `X402_ASSERT_RELAYER`. The reader (`fetchSettlementSender`) reuses **one cached viem
  client per RPC** and does a **brief non-throwing retry** (O6) so a settlement that
  isn't yet propagated doesn't emit a spurious `x402.relayer.unverified`; it never throws
  and never blocks the settlement (returns `null` → `unverified` only after retries).

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
src/heartbeat-client.ts  subscriber loop (wrapFetchWithPayment) — the count engine
test/heartbeat.test.ts  402 unpaid, 200 paid + settle, relayer classification
```

## Run

```bash
cp .env.example .env         # fill COMATO_WALLET, SUBSCRIBER_PRIVATE_KEYS, THIRDWEB_SECRET_KEY
bun run start                # server (bun run dev = watch mode)
bun run heartbeat            # in another shell: drive paid heartbeats
bun run typecheck            # tsc --noEmit
bun test                     # mocked-facilitator tests (no funds/network needed)
```

`X402_SYNC_ON_START=true` (default) is **required** for real runs: the server fetches
supported kinds from the facilitator on boot to build the 402. With it off the server
boots but `/heartbeat` 500s ("call initialize()"). Tests pass a mock facilitator, so
they run fully offline.

## Env

| var | purpose |
|---|---|
| `COMATO_WALLET` | registered EOA, premium **payee** (required) |
| `X402_FACILITATOR_URL` | facilitator API base (default `https://api.x402.celo.org`) |
| `CELO_RPC` | RPC for the relayer assertion (default forno) |
| `PREMIUM_USDC` | premium per heartbeat, decimal USDC (default `0.001`) |
| `PORT` | server port (default `4021`) |
| `X402_SYNC_ON_START` / `X402_ASSERT_RELAYER` | facilitator sync / relayer check toggles |
| `HEARTBEAT_URL` | client target (default `http://localhost:4021/heartbeat`) |
| `SUBSCRIBER_PRIVATE_KEYS` | comma-separated 0x keys of test subscribers (client) |
| `THIRDWEB_SECRET_KEY` | thirdweb SDK secret (client) |
| `HEARTBEAT_INTERVAL_MS` / `HEARTBEAT_CONCURRENCY` / `HEARTBEAT_MAX` | loop cadence |
| `MAX_PAYMENT_USDC` | per-payment ceiling guard (client, default `0.01`) |

Secrets from env only — never commit real keys. `.env` is gitignored; `.env.example`
holds placeholders.

## How the Track 2 count is earned

1. Subscriber client `GET /heartbeat` → server replies `402` with the price + `payTo`.
2. Client signs an EIP-3009 authorization (`wrapFetchWithPayment`), retries with the
   `PAYMENT-SIGNATURE` header.
3. Server verifies + settles via `api.x402.celo.org`; the Celo relayer (`0x0d74…FB48`)
   submits the on-chain transfer to `COMATO_WALLET`.
4. That tx satisfies C2 (`tx_from = relayer`, `to = wallet`) → **+1 Track 2**, and its
   USD adds to Track 1 (C3). `onAfterSettle` logs the tx hash and confirms the relayer.
5. The client loop repeats every `HEARTBEAT_INTERVAL_MS` across all subscribers,
   accumulating count over the 6-day run.

**Identity:** commits/authorship are **Timo / timothyrondo**.
