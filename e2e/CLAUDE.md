# e2e — Comato end-to-end integration proof (G6)

The **genuine-utility proof** for Comato (gasless liquidation-rescue insurance on
Aave V3, Celo). It stands up a **forked Celo mainnet**, deploys the real Comato
contracts, puts real Aave positions at the edge of liquidation, and drives the
**actual off-chain agent code** (`apps/agent/src`) to rescue them — then asserts
the health factor was restored, the rescue tx carries the ERC-8021 attribution
tag, and it was sent **EOA-direct** (the shape Track 1 counts).

> Identity: author/identity is **Timo** (`timothyrondo`).

## What it proves (two scenarios, one run)

Both scenarios open a subscriber position: supply **2,000 USDT** collateral, borrow
**USDC to ~99% of LTV** → health factor lands just above 1 (a genuine
"sitting at the edge of liquidation" state), mirroring
`packages/contracts/test/ComatoRescueFork.t.sol`.

**Scenario A — EOA-direct repay (the Track-1 counting path, constraint C1).**
The agent's `COMATO_WALLET` sends `Pool.repay(onBehalfOf=subscriber)` directly,
ERC-8021 tagged. This is the volume-earning path.

**Scenario B — `ComatoExecutor.rescue` (the atomic safety path).**
The agent calls the on-chain executor, which repays from its float and emits
`RescueExecuted`. Atomic + bounded, but its internal transfer's `from` is the
contract — so it does **not** count for Track 1 (demonstrated by contrast).

The full pipeline exercised is the real agent code, imported un-modified:
`loadConfig` → `createChain` → `Monitor.pollSubscriber` (reads HF) →
`checkEligibility` (the fail-closed trust gate) → `Rescuer.maybeRescue`
(`TxSender.sendTagged` → `tagger` → EOA-direct broadcast).

## Assertions (28, all must pass)

- Contracts deploy to the fork; both positions sit at `1 < HF < 2`.
- `loadConfig()` parses a live, non-dry-run rescue config; agent wallet == `COMATO_WALLET`.
- Monitor flags each position **breached**; eligibility gate **passes** for a paid,
  genuinely-distressed position and **rejects an unpaid** one (fail-closed).
- Scenario A: the rescue tx's calldata **ends with the `0x8021…` marker** (built and
  on-chain), `@celo/attribution-tags verifyTx` confirms our code, and the tx is
  **EOA-direct** (`tx.from == COMATO_WALLET`) with a USDC `Transfer` whose
  `from == tx sender` (the exact C1 shape). HF restored above the policy threshold.
- Scenario B: `RescueExecuted` is emitted (subscriber + positive repay), HF restored,
  and the underlying USDC `Transfer.from == the executor contract` (why it is invisible
  to Track 1).

Observed HF each run (pinned block): **1.0507 → 1.4009** for both scenarios (repay
≈ 1/4 of the ~1,483 USDC debt).

## Run

```bash
bun run e2e            # from repo root (spawns anvil, runs everything, kills anvil)
# or:
cd e2e && bun run src/e2e.ts
```

Needs `anvil`/`forge` (Foundry) on PATH and network access to the Celo fork RPC.
Everything after the fork RPC is local: it uses the well-known **anvil dev
accounts** and funds them by impersonating Aave aTokens — **no real private keys**.
`forge build` is run automatically to produce the deploy artifacts.

### Config knobs (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `FORK_BLOCK` | `72081000` | Pinned Celo block (deterministic + cached). Set `latest` to fork the tip. |
| `CELO_FORK_URL` | `https://forno.celo.org` | Fork RPC. |
| `E2E_LOG_LEVEL` | `warn` | Agent log verbosity (`debug`/`info`/`warn`/`error`). |

## Files

- `src/e2e.ts` — orchestrator: build → fork → deploy → positions → scenario A → B → report.
- `src/anvil.ts` — fork lifecycle, viem clients, token dealing (aToken impersonation),
  viem deploy from forge artifacts, and the Aave edge-position setup.
- `src/constants.ts` — verified addresses (imported from `@comato/shared`), anvil dev
  accounts, the pinned block.
- `src/assert.ts` — labelled assertion + final report.

## Rules / boundaries

- **Import only** from other packages (`apps/agent`, `packages/shared`,
  `packages/contracts` artifacts). Never modify their source — this workspace proves
  they work as-is.
- Deterministic + self-cleaning: pinned fork block; anvil is killed on every exit path
  (normal, throw, SIGINT/SIGTERM). No real keys, no secrets.

## Integration notes (found while wiring agent ↔ contracts)

1. **`@comato/shared` is a tsconfig-path alias, not an installed package** (no
   `package.json`). This workspace re-declares the same `paths` (plus points `viem`
   and `@celo/attribution-tags` at `apps/agent/node_modules`) so there is a single
   `viem` instance and no install step is required.
2. **The counting path and the `RescueExecuted` event are mutually exclusive.** The
   EOA-direct repay (C1-counting, tagged) does NOT emit `RescueExecuted` — that event
   belongs to `ComatoExecutor`, whose internal transfer is `from = contract`. Proving
   *both* the tag/EOA-direct assertions and the `RescueExecuted` assertion therefore
   requires **both** scenarios. This matches the architecture's dual-path design.
3. **viem gas estimation under-estimates the 2nd Aave `borrow` on an anvil fork**
   (mines out-of-gas though it would succeed). Setup txs pass an explicit gas limit.
   The agent's own `repay` / `executor.rescue` estimate fine — no agent change needed.
4. **Pin the fork block.** Against "latest", the 2nd borrow's under-estimate surfaced
   intermittently; pinning makes the run deterministic and lets anvil cache fork state
   (far fewer RPC calls, much faster reruns).
5. **The agent config path works verbatim** — `loadConfig()` from env, `createChain`
   on the `celo` viem chain against the anvil RPC (chain id 42220), and
   `TxSender.sendTagged` all broadcast correctly to the fork.
