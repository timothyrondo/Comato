# packages/shared

Shared TypeScript used by every app (agent, server, web): **verified Celo contract addresses**, ABIs, and types.

## Rules
- **Do not guess addresses.** Everything in `src/addresses.ts` is sourced from the official Celo docs / celopedia. Verify against those before adding a new address.
- Critical constants: `X402_FACILITATOR_URL` (`https://api.x402.celo.org` — the `api.` host; the bare `x402.celo.org` is a landing page that crashes the SDK), `X402_RELAYER` (`0x0d74…FB48`), `ERC_8021_MARKER`.
- x402 tokens: **USDC / USDT** (6 decimals). Not cUSD / USDm.

## Usage
```ts
import { MAINNET, X402_FACILITATOR_URL } from "@comato/shared/addresses";
// Aave pool: MAINNET.aaveV3.pool
```
