# Comato 🛡️

**Gasless liquidation-rescue for Aave positions on Celo.**

Comato watches your Aave V3 health factor around the clock and, the moment liquidation looms, deleverages your position using *your own* collateral — before the liquidators get to it. You authorize it once (signature only, no gas), pay a tiny premium for each interval you're protected, and stop anytime. When the danger hits at 3am while you're asleep and out of gas, Comato acts for you. No custody, no gas from you, no Comato capital at risk.

Built for the **Celo Agentic Payments & DeFAI Hackathon**.

---

## The problem

Aave liquidations are brutal and instant. A position that's healthy at bedtime can cross the threshold overnight, and the first bot to notice takes a 5–10% penalty out of your collateral. You either babysit the position 24/7 or you eat the loss.

The naive fix — an insurer that repays your debt for you — isn't a business. It just moves the loss onto the insurer's balance sheet.

## The design

Comato flips it: **the position never leaves the user, and the rescue is paid for out of the user's own collateral.** Comato is the engine and the operator; it takes a capped service fee and risks none of its own money.

Two loops run against every protected position:

1. **Monitor loop** — polls the health factor every interval and streams a gasless micro-premium over [x402](https://x402.org) (EIP-3009 `transferWithAuthorization` — no gas from the user).
2. **Rescue loop** — when `HF < threshold`, the agent sizes and executes a **deleverage**: withdraw a bounded slice of the user's collateral → swap it on Uniswap V3 → repay the user's debt → HF climbs back above the danger line. The slice is computed to reach a target HF without overshooting, and the operator is contractually forbidden from any action that doesn't improve the position.

Pay-per-interval protection is an insurance shape that only becomes possible with sub-cent, gasless micropayments — exactly what x402 on Celo enables. Every on-chain action carries an ERC-8021 attribution tag.

## Non-custodial by construction (Model C)

The user's Aave position lives inside a **per-user `ComatoVault`** that the user alone owns:

- **Subscriber-only funds** — only the vault owner can `supply`, `borrow`, `repay`, or `withdrawCollateral`. Comato can never move funds to itself.
- **Bounded operator** — the agent (operator role) can *only* call `deleverage`, and only when `HF < hfThreshold`. The call reverts unless it (a) improves HF and (b) does not overshoot `targetHf`. It cannot drain the vault.
- **Capped fee** — the service fee is hard-limited to `MAX_FEE_BPS = 1000` (10%) in the contract; it can't be raised silently.
- **Upgradeable** — vaults are beacon proxies, so a bug that could strand funds can be patched without a migration.

## Deployed on Celo mainnet (chain 42220)

| Contract | Address |
|---|---|
| `ComatoVaultFactory` | [`0x7A4ef436A54D93D54157BA12a8160564F4806D9e`](https://celoscan.io/address/0x7A4ef436A54D93D54157BA12a8160564F4806D9e) |
| `ComatoVault` (implementation) | [`0xCFa53B26049D6cCdD3Faf67164Bd2ECCa7d2Ac3e`](https://celoscan.io/address/0xCFa53B26049D6cCdD3Faf67164Bd2ECCa7d2Ac3e) |
| Vault beacon | [`0x910793a27f734AC90f33b4523cC024a3c11E365B`](https://celoscan.io/address/0x910793a27f734AC90f33b4523cC024a3c11E365B) |
| `ComatoPolicy` | [`0xd27CdB1cD00e0e5223Fa8DCfAd1310f26a8c60bb`](https://celoscan.io/address/0xd27CdB1cD00e0e5223Fa8DCfAd1310f26a8c60bb) |
| `ComatoExecutor` | [`0xF0f5c2CC518060D284b3EAd3BBF0ee8C74d8556D`](https://celoscan.io/address/0xF0f5c2CC518060D284b3EAd3BBF0ee8C74d8556D) |

**Agent identity (ERC-8004):** agentId `9684` on registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` — [view](https://celoscan.io/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/9684). Metadata: [`apps/web/public/agent.json`](apps/web/public/agent.json).

## Architecture (monorepo)

```
apps/
  agent/       autonomous monitor + rescue/deleverage engine (viem, bun)
  server/      x402 premium-settlement API (Hono, Celo facilitator)
  web/         subscriber dashboard + subscribe flow (Vite, React, Tailwind)
packages/
  contracts/   Foundry — ComatoVault, ComatoVaultFactory, ComatoPolicy, ComatoExecutor
  shared/      verified Celo addresses, ABIs, shared types
e2e/           end-to-end integration proof (anvil fork of Celo mainnet)
```

## Tech stack

- **Contracts:** Solidity 0.8.24, Foundry (fork-tested against live Celo Aave V3), OpenZeppelin (AccessControl, beacon-upgradeable proxies).
- **Runtime:** Bun + TypeScript, viem.
- **Payments:** [x402](https://x402.org) via Celo's facilitator (`api.x402.celo.org`), EIP-3009 gasless settlement in USDC/USDT.
- **Lending / swaps:** Aave V3 + Uniswap V3 on Celo.
- **Attribution / identity:** ERC-8021 attribution tags; ERC-8004 agent identity.

## Run it

Requires [Bun](https://bun.sh) and [Foundry](https://getfoundry.sh).

```bash
bun install

# contracts
bun run contracts:build
bun run contracts:test          # unit + Celo-fork tests (fork tests need a Celo RPC)

# local e2e node (fork Celo mainnet)
bun run anvil:celo

# apps — each reads its own .env (copy the .env.example, never commit secrets)
bun run web:dev                 # dashboard
bun run agent:dev               # monitor + rescue loop
bun run server:dev              # x402 settlement API

# everything
bun run test                    # agent + server + web
bun run typecheck
```

`DRY_RUN=true` runs the full agent loop without sending transactions.

## How a rescue actually fires

1. User connects a wallet on the dashboard and creates a vault (`factory.createVault`).
2. User supplies collateral and borrows through the vault — the Aave position now lives in the vault.
3. The agent picks up the vault, streams the gasless premium, and watches HF.
4. HF drops below the threshold → the agent computes the collateral slice needed to reach the target HF, quotes the swap on Uniswap V3, and calls `vault.deleverage(...)`.
5. HF is restored; Comato takes its capped fee; the action is tagged on-chain.

---

*Comato is experimental software, not financial advice. Use at your own risk.*
