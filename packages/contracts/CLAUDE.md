# packages/contracts — Comato Solidity (Foundry)

On-chain layer for **Comato**: gasless liquidation-rescue insurance for Aave V3 on Celo. These
contracts are the **atomic safety + fee net** — a policy registry, a shared-float reference executor,
and a **factory + per-subscriber upgradeable guard** layer (OZ `AccessControl` + protocol fee). The
volume-earning path is off-chain (EOA-direct); see the attribution note below.

## Contracts

| File | Purpose |
| --- | --- |
| `src/ComatoPolicy.sol` | Insurance policy registry. Per policy: `subscriber`, `collateralAsset`, `debtAsset`, `hfThreshold` (WAD), `rescueCap`, `premiumRatePerInterval`, `active`. Subscriber owns their policy; owner/operators can administer. Pure state — holds no funds. |
| `src/ComatoExecutor.sol` | **Shared-float reference executor** (kept). Owner/operator rescue against Comato's single pooled float; reads HF via `Pool.getUserAccountData`; if `HF < hfThreshold`, repays `min(rescueCap, float)` via `Pool.repay(..., onBehalfOf=subscriber)`. `Ownable` + `isOperator`; `nonReentrant`; SafeERC20. Anchors the fork attribution demo (executor vs EOA-direct). |
| `src/ComatoGuardFactory.sol` | **Factory** (OZ `AccessControl`). Deploys the shared `ComatoGuard` implementation + an `UpgradeableBeacon` it OWNS, then one `BeaconProxy` **guard per subscriber**. Holds the canonical whitelist template + fee defaults (seeds new guards), tracks guards (`guardOf`/`isGuard`/`allGuards`), and gates the single upgrade path (`upgradeGuards` → beacon). Roles: `DEFAULT_ADMIN_ROLE` (deployer), `OPERATOR_ROLE` (agent — may `createGuard`). |
| `src/ComatoGuard.sol` | **Per-subscriber guard** behind a beacon proxy. `Initializable + AccessControl + Pausable + ReentrancyGuardTransient`. (1) **Whitelist-gated executor**: `execute`/`executeBatch` run operator calldata against whitelisted targets only (Aave Pool, DEX router, USDC/USDT) — the atomic deleverage path. (2) **Bounded `rescue`**: repays `min(rescueCap, float-after-fee)` of the subscriber's Aave debt, restoring HF. (3) **Capped protocol fee** on rescue (`feeBps ≤ MAX_FEE_BPS = 10%`), reserved from float so `repay + fee ≤ float`, **decoupled** so a fee-transfer failure can't revert the repay. Admin: whitelist/fee/`withdrawFloat`/`revokeAllowance`/`unpause`/roles; `GUARDIAN_ROLE`: `pause`. |
| `src/interfaces/IAaveV3Pool.sol` | Minimal Aave V3 Pool interface (`getUserAccountData`, `supply`, `borrow`, `repay`, `withdraw`, `getReserveData`). The `ReserveData` struct layout is verified against the live Celo pool. |

### Guard/Factory architecture (factory + per-subscriber guard)

- **Beacon proxy, not Clones (justified in NatSpec):** every guard is a `BeaconProxy` pointing at one
  `UpgradeableBeacon` the factory owns. A single admin `upgradeGuards(newImpl)` atomically upgrades
  **all** guards — "if there's an upgrade, the deployer can handle it" — with no per-guard migration.
  Clones would be cheaper to deploy but non-upgradeable (a fix would need redeploy + per-subscriber
  float/whitelist/policy migration). For real-money guards that may need a hot fix, one-switch
  upgradeability wins. The beacon is a trust anchor, contained: factory-owned, `DEFAULT_ADMIN_ROLE`-only.
- **Proxy-safe bases:** `POOL`/`POLICY_REGISTRY` are `immutable` in the shared impl (global, gas-cheap);
  per-subscriber state (`subscriber`, `policyId`, `feeRecipient`, `feeBps`, `_whitelist`) lives in proxy
  storage, set once by `initialize` (impl ctor calls `_disableInitializers`). `ReentrancyGuardTransient`
  (cancun, transient) + `Initializable` (ERC-7201) use collision-free slots; `AccessControl`/`Pausable`
  set only zero-value ctor state, so a proxy that skips those ctors is correct. Upgrades are append-only.
- **Roles (least privilege):** `DEFAULT_ADMIN_ROLE` = deployer (whitelist/fee/roles/withdraw/upgrade);
  `OPERATOR_ROLE` = agent hot wallet (rescue + whitelisted execute); `GUARDIAN_ROLE` = emergency pause
  (admin unpauses — a guardian halts fast, admin decides to resume).
- **Whitelist + fee mechanism:** the whitelist gates `execute`/`executeBatch` **targets** (not selectors
  — see trust model); a non-whitelisted (or codeless) target reverts. The fee is `amountRepaid * feeBps
  / 10_000`, reserved before the repay (`repay + fee ≤ float` always), hard-capped at `MAX_FEE_BPS`, and
  sent to the admin-set `feeRecipient`; a fee-transfer failure is caught (`FeeSkipped`) so it never
  reverts the life-saving repay.
- **Attribution:** guard/factory token moves have `from == guard`, so they do **NOT** count for Track 1
  volume (C1). Intentional — this is the **safety + fee** layer; the Track-1 volume path stays
  EOA-direct in `apps/agent`. Do not try to make the guard count for Track 1.
- **Executor vs Guard:** `ComatoExecutor` is the minimal shared-float reference/safety executor (and
  anchors the fork attribution demo). `ComatoGuard` is the productionized **per-subscriber, upgradeable,
  fee-bearing** evolution. Both reuse `ComatoPolicy`. The executor is retained rather than deleted to
  preserve its green fork/unit/invariant coverage; fully retiring it is an open question for the orchestrator.

## Attribution trade-off (READ THIS — it drives the whole design)

Track 1 ("Most Revenue" / volume) on the Celo Dune leaderboard counts a token transfer **only when
`transfer.from == the tx-sending EOA`** inside an ERC-8021 tagged tx (constraint **C1** in
`../../docs/comato-architecture.md`).

- **`ComatoExecutor.rescue()` does NOT earn Track 1 volume.** When the executor calls
  `Pool.repay(...)`, Aave pulls funds via `transferFrom(address(executor), ...)`, so the transfer's
  `from` is the **contract**, not the EOA. Contract-internal legs are invisible to C1.
- **The volume path is EOA-direct**, done by the off-chain agent (`apps/agent`): `COMATO_WALLET`
  (an EOA) sends `repay(onBehalfOf=subscriber)` and treasury swaps directly, tag appended, so the
  pulled transfer's `from == tx.origin` and counts.

Both are supported. Use the **Executor** when atomicity/bounding matters (a race window makes a
single tx worth losing attribution); use **EOA-direct** for everything that must count for volume.
The `test/ComatoRescueFork.t.sol::test_Fork_EoaDirectRepay_*` test demonstrates the counting path;
`test_Fork_ExecutorRescue_*` demonstrates the safety path.

## Conventions (enforced)

- Fixed pragma `0.8.24`; custom errors (no `require` strings); checks-effects-interactions;
  `ReentrancyGuard` on fund-moving external funcs; `immutable` for pool/registry; full NatSpec;
  named constants (no magic numbers); events on every state change.
- `SafeERC20` (`forceApprove`/`safeTransfer`) for all token movement — Celo USDC/USDT are proxies.
  Fund-moving externals that must survive a token-side revert (e.g. the guard's protocol fee) are
  decoupled via a self-external-call + try/catch so a non-critical failure can't revert a safety action.
- Access control: `ComatoPolicy`/`ComatoExecutor` use OpenZeppelin `Ownable` + an `isOperator` mapping;
  the `ComatoGuardFactory`/`ComatoGuard` layer uses OpenZeppelin **`AccessControl`** with
  `DEFAULT_ADMIN_ROLE` (deployer), `OPERATOR_ROLE` (agent), `GUARDIAN_ROLE` (pauser) + `Pausable`.
- Guard is upgradeable via `UpgradeableBeacon` + `BeaconProxy` (factory-owned beacon, admin-gated
  `upgradeGuards`); guard state uses `Initializable` + append-only layout, `ReentrancyGuardTransient`.
- Run `forge fmt` before committing (config in `foundry.toml`).

## How to run

```bash
# from packages/contracts (or `bun run contracts:build` / `contracts:test` from repo root)
forge build
forge test                 # all 114 tests (108 unit/invariant + 6 fork)
forge test --no-match-path "test/*Fork*"   # unit + invariants only, no RPC needed
forge test --match-path "test/*Fork*" -vv  # fork integration (needs RPC): executor + guard
forge fmt                  # format
```

- **Fork tests** hit Celo mainnet via `rpc_endpoints.celo = https://forno.celo.org` (see
  `foundry.toml`). If the RPC is unreachable, `ComatoRescueFork.t.sol` self-skips in `setUp`
  (the `forked` guard) and the fork test bodies early-return; the unit suites are RPC-independent
  and still cover all contract logic.
- `evm_version = "cancun"` is **required**: Celo is now an OP-stack L2 and the live Aave bytecode
  uses post-Paris opcodes (PUSH0). Under `paris` the fork reverts with `NotActivated`.

## Verified Celo mainnet addresses (chain 42220)

Source of truth: `../shared/src/addresses.ts` and `../../docs/comato-architecture.md`.

- Aave V3 Pool: `0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402`
- USDC (6 dec): `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` — borrow/collateral enabled (LTV 75%, LT 78%)
- USDT (6 dec): `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` — borrow/collateral enabled (LTV 75%, LT 78%)
- CELO: `0x471EcE3750Da237f93B8E339c536989b8978a438` — collateral only, **borrowing disabled** (LTV 55%, LT 61%)
- Health factor is WAD (1e18); `< 1e18` is liquidatable. Base currency is USD with 8 decimals.

Fork test scenario: subscriber supplies USDT, borrows USDC to ~99% of LTV (HF just above 1), policy
threshold set above that HF → breach → executor repays USDC from float → HF restored above threshold
(observed 1.05 → 1.40).

## Security model & audit notes

### Guard/Factory — 12-agent `solidity-auditor` pass (2026-07-14, `ComatoGuard` + `ComatoGuardFactory`)

All 12 agents independently concluded **no unprivileged fund-theft or state-corruption**: every
float-outflow is `OPERATOR_ROLE`/`DEFAULT_ADMIN_ROLE`-gated, `depositFloat` is add-only, the
fee-reservation invariant `repay + fee ≤ float` is proven for all `feeBps ≤ MAX_FEE_BPS`, and CEI,
transient `nonReentrant`, `SafeERC20` allowance-reset, Aave tuple indexing, and beacon-proxy storage
layout are all correct. One confirmed finding + several leads were **addressed**:

- **`createGuard` unvalidated/unrecoverable policy binding (FINDING — fixed).** `createGuard` now
  requires `POLICY_REGISTRY.subscriberOf(policyId) == subscriber` (rejects wrong/nonexistent ids that
  would permanently brick a subscriber's one-guard slot), and an admin `retireGuard(subscriber)` frees
  the slot for a renewed policy. Covered by `test_CreateGuard_RevertOnPolicySubscriberMismatch` /
  `test_RetireGuard_*`.
- **Fee/repay coupling DoS (fixed).** The protocol fee is routed through `this.pushFee` in a try/catch,
  so a blacklisted/paused `feeRecipient` (USDC/USDT are freezable) is **skipped** (`FeeSkipped`, stays
  as admin-recoverable float) instead of reverting the safety-critical repay. Proven by
  `test_Rescue_FeeSkippedWhenRecipientBlacklisted_RepayStillLands` (`MockBlacklistERC20`).
- **Compromised-operator standing allowance (fixed).** `execute` can plant `approve(x, max)` on a
  whitelisted token that survives pause/rotation/`withdrawFloat`; admin `revokeAllowance(token, spender)`
  neutralizes it directly (no self-granting `OPERATOR_ROLE`).
- **Codeless whitelisted target (fixed).** `_execute` reverts `TargetHasNoCode` so a mis-whitelisted EOA
  can't silently no-op / strand native value.
- **Whitelist confines targets, not selectors (accepted, documented).** Needed for the deleverage path;
  a compromised operator can move float within the whitelist. Contained by pause + operator rotation +
  admin whitelist control + `withdrawFloat` + `revokeAllowance`. A per-selector allow-list is a deferred
  hardening (open question below). Fee-basis, dust-liveness, and Pausable-ctor NatSpec were corrected to
  match the code.
- **Stateful invariants (`test/invariant/ComatoGuardInvariants.t.sol`, fizz-style):** whitelist can't be
  bypassed (rogue target never executes), `feeBps ≤ MAX_FEE_BPS` always, fee ≤ `repaid·MAX_FEE_BPS`,
  repay ≤ cap, **pause halts all privileged actions**, no residual pool allowance, and float
  conservation (`balance == deposited − withdrawn − repaid − fees`).

### Executor/Policy — prior 12-agent `solidity-auditor` pass (2026-07-14)

The prior pass on `ComatoExecutor`/`ComatoPolicy` found **no unprivileged direct fund-theft**: every
float-outflow path is `onlyOwner`/`onlyOperator`, and CEI, `nonReentrant`, `SafeERC20` with
allowance-reset, and Aave tuple indexing are all correct. The findings were economic/trust-boundary:

- **Bounded `rescueCap` (fixed).** `createPolicy` now enforces `rescueCap <= MAX_RESCUE_CAP`
  (1,000,000e6), mirroring the `hfThreshold` bounds, so a policy can't be provisioned to claim an
  unbounded amount.
- **Dead `onlyOperatorOrOwner` modifier (removed).** NatSpec `<`/"at-under" wording reconciled.
- **Unpriced rescue outflow — mitigated + documented (deferred).** `rescue` repays the subscriber's
  Aave debt from Comato's own float and does NOT enforce premium/eligibility on-chain
  (`createPolicy` is permissionless; `premiumRatePerInterval` is informational). This is deliberate:
  the executor is the *bounded safety net*, and eligibility (premium paid via x402, genuine distress,
  rate-limiting, correct variable-debt asset) is the **off-chain agent's responsibility**. The
  operator (agent hot wallet) MUST verify those before calling `rescue` — see the SECURITY / TRUST
  MODEL block in `ComatoExecutor.sol`. **Do NOT auto-rescue on the on-chain `active && HF<threshold`
  gate alone** — an attacker can self-register an always-breached policy (`hfThreshold=10e18`) and
  farm free debt paydowns.
- **Open questions for the orchestrator:**
  1. **On-chain eligibility binding** — a fuller premium/escrow binding (e.g. per-policy `paidUntil`
     funded by an x402/EIP-3009 redemption, checked in `rescue`) plus a per-policy cooldown/cumulative
     cap. Deferred for the MVP; both executor and guard are safe as bounded, operator-gated spenders of
     Comato's own capital (guard adds per-subscriber isolation + pause + `revokeAllowance`).
  2. **Per-selector whitelist on `ComatoGuard.execute`** — the whitelist gates targets, not selectors, so
     a compromised operator can move float within the whitelist. Deferred hardening; contained today by
     pause + rotation + `withdrawFloat` + `revokeAllowance`.
  3. **Retire `ComatoExecutor`?** — the guard subsumes its rescue logic (per-subscriber + fee). Kept for
     now to preserve the fork attribution demo and its green coverage; retiring it would drop 3 files of
     tests. Orchestrator's call.
- **Aggregate HF vs single-asset repay:** `rescue` triggers on account-wide HF but repays one asset;
  `policy.debtAsset` must be the subscriber's actual variable-debt asset (live Aave reverts
  `NO_DEBT_OF_SELECTED_TYPE` otherwise). The agent must set this correctly.

## Dependencies

- `forge-std` (vendored, `lib/forge-std`).
- `openzeppelin-contracts` v5.1.0 (vendored plain files at `lib/openzeppelin-contracts`, no
  submodule — matches the forge-std pattern). Remapping in `remappings.txt`:
  `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`.

## Tests (114 total: 108 unit/invariant + 6 fork)

- `test/ComatoPolicy.t.sol` — CRUD, validation bounds, access control (unit; incl. fuzz).
- `test/ComatoExecutor.t.sol` — shared-float rescue happy path, cap/float/debt bounds, reverts, float
  mgmt, constructor guards, a bounds+HF fuzz invariant (unit vs. `MockAavePool`).
- `test/ComatoGuard.t.sol` — guard driven through a real factory-deployed **beacon proxy**: init/roles,
  whitelist enforcement (whitelisted succeeds, non-whitelisted + codeless revert), `executeBatch`
  atomicity, bounded rescue + capped fee, fee-skip-on-blacklist, `revokeAllowance`, `pushFee` self-only,
  pause halts execute+rescue, guardian-pause/admin-unpause, operator rotation.
- `test/ComatoGuardFactory.t.sol` — deploy (beacon owned by factory), `createGuard` tracking + seeding +
  policy↔subscriber validation, guard-admin ≠ caller, duplicate/mismatch reverts, `retireGuard` recovery,
  and the **beacon upgrade** swapping the impl for all guards while preserving storage.
- `test/ComatoRescueFork.t.sol` — live Aave: executor rescue, not-breached revert, EOA-direct repay.
- `test/ComatoGuardFork.t.sol` — live Aave: factory-deployed guard rescue restores HF (1.05→1.40) + capped
  fee delivered/bounded, whitelisted `executeBatch` deleverage, non-whitelisted revert.
- `test/mocks/` — `MockERC20`, `MockAavePool` (deterministic HF), `MockTarget` (execute target),
  `MockBlacklistERC20` (issuer-freeze model), `ComatoGuardV2` (beacon-upgrade proof).
- Stateful invariants (Echidna/Medusa-compatible handler pattern): `test/invariant/` —
  `ComatoPolicyInvariants`, `ComatoExecutorInvariants`, and `ComatoGuardInvariants` (whitelist can't be
  bypassed, fee ≤ cap, pause halts, float conservation, no residual allowance).
