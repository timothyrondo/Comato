# apps/agent — Comato off-chain agent (the brain)

The always-on TypeScript agent for **Comato** (gasless liquidation-rescue insurance
on Aave V3, Celo). It drives BOTH Dune leaderboard tracks and does the real
protection work: monitor health factors, buy risk data via x402, rescue breached
positions, and run the treasury volume engine. Runtime: **bun + viem**.

> Identity: the sole author/identity for this code, commits, and docs is
> **Timo** (`timothyrondo`) — never any other handle or email.

## What it does (modules)

| Module | File | Role |
| --- | --- | --- |
| Config | `src/config.ts` | Loads secrets/toggles/per-deploy from env; pulls all tuning from `src/defaults.ts`. Validated, typed `Config`. Safe defaults (DRY_RUN on). |
| Chain | `src/chain.ts` | viem public (reads) + wallet (writes) clients on Celo. |
| Tagger | `src/tagger.ts` | ERC-8021 `toDataSuffix`/`verifyTx` — the **C1** mechanism. |
| Tx sender | `src/tx.ts` | The only write path: encode → append tag → EOA-direct send. DRY_RUN aware. |
| Monitor | `src/monitor.ts` | Polls `Pool.getUserAccountData` → health factor per subscriber. |
| Eligibility | `src/eligibility.ts` | The off-chain **trust gate** (premium/distress/rate-limit/debt asset). |
| Rescue | `src/rescue.ts` | Eligible breach → EOA-direct `repay(...)`, tagged (**C1**). Optional Executor safety path. |
| Deliberate | `src/deliberate.ts` | **Decision layer** (pure): weighs a vault deleverage's cost (swap loss + service fee) against the liquidation penalty it prevents (Aave `liquidationBonus`, read on-chain), scaled by urgency (imminent vs deliberate band). Returns act/defer + a numeric rationale. Turns the deleverage from a thermostat trigger into an economic choice. |
| Deleverage | `src/deleverage.ts` | Model C non-custodial rescue: size → quote → **deliberate** → operator-only `vault.deleverage(...)`. |
| Vaults | `src/vaults.ts` | **Auto-discovery**: reads the factory's `allVaults`, keeps only Comato-operated vaults (grief-capped, TTL-cached, fail-safe). A web subscriber is picked up next cycle — no `VAULTS` env edit. Explicit `VAULTS` still overrides. |
| Treasury | `src/treasury.ts` | EOA-direct tagged round-trip swaps — the Track 1 volume engine (**C1**). |
| x402 client | `src/x402.ts` | Pays per data query (payer = wallet) → **C2** + **C3**; verifies the Celo relayer. |
| Entry | `src/index.ts` | Wires modules, runs loops, graceful shutdown. |

## Attribution constraints — how each is enforced in code

These come from the live Dune SQL (`../../../docs/comato-architecture.md` §1). Violate
one and the action is invisible on the leaderboard.

- **C1 — Track 1 counts only EOA-direct transfers in tagged txs**
  (`transfer.from == tx_from`, calldata contains our code + ends with `0x80218021…`).
  - Every write goes through `TxSender.sendTagged`, which does
    `data = concat([encodeFunctionData(...), toDataSuffix(ATTRIBUTION_CODE)])` and
    sends **EOA-direct** via `walletClient.sendTransaction` (never a relayer/contract,
    which would strip the suffix or change `from`). An invariant throws if the built
    calldata doesn't end with the marker.
  - Counting paths: `treasury.ts` (`exactInputSingle` — router pulls `tokenIn` from the
    EOA) and `rescue.ts` (EOA-direct `repay(onBehalfOf)` — Aave pulls from the EOA).
- **C2 — x402 count needs the Celo facilitator relayer + our wallet on a leg.**
  - `x402.ts` pays with `COMATO_WALLET` as payer via the official `@x402/*` SDK
    (`@x402/core` + `@x402/evm`, viem-based) — signs an EIP-3009 authorization.
  - ⚠️ The facilitator is chosen by the **resource server**, not the client (the x402
    client only signs; it has no facilitator param). So the
    data endpoint must settle through `https://api.x402.celo.org`. The agent **verifies**
    each settlement on-chain: it decodes the `X-PAYMENT-RESPONSE` tx hash and asserts
    `tx.from == X402_RELAYER` (`0x0d74…FB48`), warning loudly on a mismatch.
- **C3 — x402 settlements also add Track 1 volume** — free, automatic: it's the same
  facilitator settlement that C2 counts.

## Trust model — the agent is the eligibility gate (do NOT auto-rescue)

The contracts (`ComatoExecutor.sol` SECURITY/TRUST MODEL) deliberately do **not** enforce
eligibility on-chain: `createPolicy` is permissionless and `premiumRatePerInterval` is
informational, so `active && HF<threshold` alone can be farmed (self-register
`hfThreshold=10e18`, harvest free debt paydowns). Before ANY rescue, `eligibility.ts`
verifies **fail-closed** (all four must pass):

1. **Premium paid** — subscriber has an unexpired paid-through time
   (`premiumPaidUntilMs`; in production, matched x402 settlements to COMATO_WALLET).
2. **Genuine distress** — HF below the subscriber threshold **and** an absolute distress
   ceiling (`RESCUE_DISTRESS_HF`), not merely below an attacker-chosen threshold. HF is
   read **fresh** (`getUserAccountData`) right before the decision, not from the monitor
   snapshot (which may be up to one poll old) — a position that recovered in between is
   not rescued (O2, TOCTOU). Fail-closed: if the fresh read fails, the rescue is blocked.
3. **Rate limit** — per-subscriber cooldown + max rescues per rolling window. The limit is
   recorded on tx **broadcast**, not on receipt confirmation (O1): if the repay broadcasts
   but the receipt read fails, the next cycle's gate blocks a re-rescue of the (already
   repaid) position instead of draining the float. State is **persisted to disk**
   (`RESCUE_STATE_FILE`, default `.comato/rate-limiter-state.json`) and reloaded on boot, so
   a crash/restart during the run does NOT clear cooldowns (O3). An in-flight set also
   prevents two overlapping rescues for the same subscriber.
4. **Correct debt asset** — subscriber actually holds variable debt in `debtAsset`
   (else live Aave reverts `NO_DEBT_OF_SELECTED_TYPE`).

Repay is bounded by `min(RESCUE_MAX_AMOUNT, variableDebt, EOA float)` (R13 — never over-pull).
The treasury engine additionally fail-fasts at config load unless the swap pair is a verified
USD stable pair at 6/6 decimals (`assertStablePair`, O7) — the `amountOutMinimum` math assumes
~1:1, a footgun on a misconfigured pair; use the verified USDC/USDT pool or wire QuoterV2.

## Run

```bash
cp .env.example .env      # fill ATTRIBUTION_CODE + SUBSCRIBERS (+ COMATO_PRIVATE_KEY to send)
bun install
bun run dev               # start the agent (DRY_RUN=true by default → no broadcasts)
bun test                  # tagger / rescue-eligibility / treasury-sizing (mocked RPC)
bun run typecheck         # tsc --noEmit
```

> `.env` holds only secrets + per-deployment values + operational toggles. **Tuning
> params (intervals, rescue/treasury/x402 knobs, chain id, addresses) live in
> `src/defaults.ts` (`DEFAULTS`)** — adjust them there, not in `.env`.

- **Read-only mode:** omit `COMATO_PRIVATE_KEY` → monitors HF only, DRY_RUN forced.
- **Live sending:** set a funded `COMATO_PRIVATE_KEY` and `DRY_RUN=false`, then enable the
  engines (`TREASURY_ENABLED`, `RESCUE_ENABLED`, `X402_ENABLED`) as needed.
- Logs are structured JSON lines (one object per line) — grep by `"event"`.

## Rules (repo)

- Work only in `apps/agent`. Don't touch `apps/server`, `apps/web`, or
  `packages/contracts` source. `packages/shared/src/addresses.ts` is the verified
  source of truth for addresses — import, don't hardcode.
- No secrets in code; env only. `.env` is gitignored. No `git commit`/`push` without approval.
- Counted actions MUST stay EOA-direct + tagged. The `ComatoExecutor` path is the atomic
  **safety** net only — its internal legs do **not** count for Track 1 (documented in `rescue.ts`).
