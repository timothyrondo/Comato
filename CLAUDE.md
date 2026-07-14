# Comato — Repo

Monorepo for **Comato**: gasless liquidation-rescue insurance on Celo (Aave V3). See `README.md` for the product overview.

Author: **Timo** (`timothyrondo`).

## Monorepo layout (bun workspaces)
```
packages/contracts   Foundry (Solidity) — ComatoPolicy, ComatoExecutor, Aave interface
packages/shared      Shared TS: verified Celo addresses, ABIs, types (src/addresses.ts)
apps/agent           Off-chain agent (bun/TS): health-factor monitor, ERC-8021 tagger, x402 client, rescue + treasury engine
apps/server          x402 premium-heartbeat server (bun/Hono) — payTo = COMATO_WALLET
apps/web             Vite — premium mobile UI
e2e                  End-to-end integration proof (anvil fork of Celo mainnet)
```
Each stack is separated; every relevant folder has its own `CLAUDE.md`.

## Stack & tooling
- **Bun** (package manager + TS runtime). **Foundry** (forge/anvil/cast) for contracts.
- **E2E:** `anvil --fork-url https://forno.celo.org` (fork Celo mainnet) → open position → breach → rescue.

## Key on-chain rules (drive the design)
- On-chain volume attribution counts only transfers whose `from` equals the tx-sending EOA, inside ERC-8021 tagged transactions → value-moving actions are **EOA-direct**, never routed through a contract intermediary.
- x402 stack is the **`@x402/*` SDK** (x402-rs family) end-to-end: `@x402/core`+`@x402/evm` viem client, `@x402/hono` server. Payments MUST route through the **Celo facilitator** `https://api.x402.celo.org` (relayer `0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48`) with an `X-API-Key` on `/settle` — any other facilitator relayer won't count for Track 2.
- x402 tokens: **USDC / USDT** (6 decimals, EIP-3009). Not cUSD / USDm.
- Attribution: `@celo/attribution-tags` `toDataSuffix` + `verifyTx`. Marker `0x80218021802180218021802180218021`.

## Commands
- `bun run contracts:build` / `contracts:test` / `contracts:fmt`
- `bun run anvil:celo` (fork node for e2e)
- `bun run web:dev` / `agent:dev` / `server:dev`
- `bun run e2e` (integration proof) / `bun run demo` (fork + deploy + rescue + live UI)
