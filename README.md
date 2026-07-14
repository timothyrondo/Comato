# Comato 🛡️

**Gasless liquidation-rescue insurance for Celo lending positions.**

Comato watches your Aave V3 position around the clock and rescues it — repay or deleverage — *before* it can be liquidated. You authorize it once (signature only, no gas), pay a tiny premium per moment you're protected, and stop anytime. When the danger hits at 3am while you're asleep and out of gas, Comato acts for you.

Built for the **Celo Agentic Payments & DeFAI Hackathon**.

---

## The problem

Borrowers on lending markets get liquidated for a 5–10% penalty exactly when they can't act — asleep, offline, or holding no gas to send a rescue transaction. Existing tools demand an upfront approval, native gas, constant babysitting, and a flat subscription whether or not you were ever at risk.

## How Comato works

1. **Subscribe once, gasless.** You sign an authorization — no `approve` tx, no CELO for gas needed.
2. **Pay-as-you-go protection.** A tiny premium settles each interval you're covered, over the **x402** micropayment rail (gasless for you). Stop whenever.
3. **Autonomous rescue.** Comato monitors your health factor; when it nears the liquidation line, it repays/deleverages your position on Aave V3 — bounded, operator-verified, and only when you're genuinely at risk.

Pay-per-second protection is an insurance shape that only becomes possible with sub-cent, gasless micropayments — which is exactly what x402 on Celo enables.

## Architecture (monorepo)

```
packages/contracts   Foundry — ComatoPolicy (policy registry) + ComatoExecutor (bounded rescue) + Aave interface
packages/shared      Verified Celo addresses, ABIs, shared types
apps/agent           Off-chain brain: health-factor monitor, ERC-8021 tagger, x402 client, rescue + treasury engine
apps/server          x402 premium-heartbeat endpoint (Celo facilitator)
apps/web             Vite + React mobile UI — premium, mobile-first
```

## Tech stack

- **Contracts:** Solidity 0.8.24, Foundry (fork-tested against live Celo Aave V3), OpenZeppelin. 52 tests, 12-agent security audit pass.
- **Runtime:** Bun + TypeScript, viem.
- **Payments:** [x402](https://x402.org) via Celo's facilitator (`x402.celo.org`), EIP-3009 gasless settlement in USDC/USDT.
- **Lending:** Aave V3 on Celo.
- **Attribution:** ERC-8021 attribution tags; ERC-8004 agent identity.

## Run

```bash
bun install

# contracts
bun run contracts:build
bun run contracts:test        # fork tests need internet (Celo RPC)

# local e2e node (fork Celo mainnet)
bun run anvil:celo

# apps
bun run server:dev            # x402 premium server
bun run agent:dev             # monitor + rescue agent
bun run web:dev               # mobile UI
```

Copy each app's `.env.example` and fill in your own values. **Never commit secrets.**

## Status

🚧 Active hackathon build. Contracts + UI landed; agent + server in progress; on-chain registration pending. See per-package `CLAUDE.md` for details.

---

*Comato is experimental software, not financial advice. Use at your own risk.*
