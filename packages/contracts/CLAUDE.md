# packages/contracts — Comato Solidity (Foundry)

On-chain layer for **Comato**: gasless liquidation-rescue insurance for Aave V3 on Celo. These
contracts are the **atomic safety net** — a policy registry plus a bounded rescue executor. The
volume-earning path is off-chain (EOA-direct); see the attribution note below.

## Contracts

| File | Purpose |
| --- | --- |
| `src/ComatoPolicy.sol` | Insurance policy registry. Per policy: `subscriber`, `collateralAsset`, `debtAsset`, `hfThreshold` (WAD), `rescueCap`, `premiumRatePerInterval`, `active`. Subscriber owns their policy; owner/operators can administer. Pure state — holds no funds. |
| `src/ComatoExecutor.sol` | Operator-only rescue. Reads a subscriber's health factor via `Pool.getUserAccountData`; if `HF < hfThreshold`, repays `min(rescueCap, float)` of the debt asset via `Pool.repay(asset, amount, 2, onBehalfOf=subscriber)`. Holds a debt-asset float; `nonReentrant`; SafeERC20. |
| `src/interfaces/IAaveV3Pool.sol` | Minimal Aave V3 Pool interface (`getUserAccountData`, `supply`, `borrow`, `repay`, `withdraw`, `getReserveData`). The `ReserveData` struct layout is verified against the live Celo pool. |

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
- Access control: OpenZeppelin `Ownable` + an `isOperator` mapping. Owner is the Comato admin;
  operators (the agent hot wallet, the executor) can trigger/administer.
- Run `forge fmt` before committing (config in `foundry.toml`).

## How to run

```bash
# from packages/contracts (or `bun run contracts:build` / `contracts:test` from repo root)
forge build
forge test                 # all 44 tests (41 unit + 3 fork)
forge test --no-match-path "test/*Fork*"   # unit only, no RPC needed
forge test --match-path "test/ComatoRescueFork.t.sol" -vv   # fork integration (needs RPC)
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

A 12-agent `solidity-auditor` pass (2026-07-14) found **no unprivileged direct fund-theft**: every
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
- **Open question for the orchestrator:** whether to add a fuller *on-chain* premium/escrow binding
  (e.g. per-policy `paidUntil` funded by an x402/EIP-3009 redemption, checked in `rescue`) plus a
  per-policy cooldown/cumulative cap and per-policy float reservation. Deferred for the MVP; the
  contract is safe as a bounded, operator-gated executor of Comato's own capital, contained by the
  owner's `withdrawFloat` + policy deactivation.
- **Aggregate HF vs single-asset repay:** `rescue` triggers on account-wide HF but repays one asset;
  `policy.debtAsset` must be the subscriber's actual variable-debt asset (live Aave reverts
  `NO_DEBT_OF_SELECTED_TYPE` otherwise). The agent must set this correctly.

## Dependencies

- `forge-std` (vendored, `lib/forge-std`).
- `openzeppelin-contracts` v5.1.0 (vendored plain files at `lib/openzeppelin-contracts`, no
  submodule — matches the forge-std pattern). Remapping in `remappings.txt`:
  `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`.

## Tests

- `test/ComatoPolicy.t.sol` — CRUD, validation bounds, access control (unit; 22 tests incl. 2 fuzz).
- `test/ComatoExecutor.t.sol` — rescue happy path, cap/float/debt bounds, reverts, float mgmt,
  constructor guards, a bounds+HF fuzz invariant (unit vs. `MockAavePool`; 19 tests).
- `test/ComatoRescueFork.t.sol` — live Aave integration: executor rescue, not-breached revert,
  EOA-direct repay (3 tests).
- `test/mocks/` — `MockERC20`, `MockAavePool` (deterministic HF model for RPC-free unit testing).
- Fuzz/invariant harness for Echidna/Medusa: `test/invariant/` (see `fizz`-generated suite).
