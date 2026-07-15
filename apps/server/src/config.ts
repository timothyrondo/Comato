/**
 * Environment-driven configuration for the Comato x402 heartbeat server.
 * (The subscriber heartbeat client lives in the separate `comato-subscriber` repo.)
 * Secrets are read from env only — never hard-coded. All input is validated
 * (zod + viem address checks) and fails fast with a clear message.
 */

import { z } from "zod";
import { isAddress, parseUnits } from "viem";
import {
  CELO_NETWORK,
  DEFAULT_CELO_RPC,
  DEFAULTS,
  USDC,
  X402_FACILITATOR_URL,
  type CeloNetwork,
} from "./constants.ts";

type Env = Record<string, string | undefined>;

const addressSchema = z
  .string()
  .refine((v) => isAddress(v), { message: "must be a 0x EVM address" });

function toAtomicUsdc(value: string, label: string): string {
  try {
    return parseUnits(value, USDC.decimals).toString();
  } catch {
    throw new Error(`${label}="${value}" is not a valid USDC decimal amount`);
  }
}

export interface ServerConfig {
  payTo: `0x${string}`;
  facilitatorUrl: string;
  /**
   * Celo facilitator API key (`x402_live_…` / `x402_test_…`). Sent as `X-API-Key`
   * on `/settle` — the facilitator requires it and burns 1 credit per settlement.
   */
  apiKey: string;
  rpcUrl: string;
  network: CeloNetwork;
  /** Human-readable premium, e.g. "0.001". */
  premiumUsdc: string;
  /** Premium in atomic USDC units (6 dec), e.g. "1000". */
  premiumAtomic: string;
  port: number;
  /** Sync supported kinds with the facilitator on boot (true for real runs). */
  syncFacilitatorOnStart: boolean;
  /** Verify each settlement's on-chain sender is the Celo relayer. */
  assertRelayer: boolean;
  /** Path to the agent-written quote store; absent file = flat premium for all. */
  quoteStorePath: string;
  /** Absolute ceiling for a quoted premium (decimal USDC); above it -> flat default. */
  quoteMaxPremiumUsdc: string;
  /** Quotes older than this are ignored (ms). */
  quoteMaxAgeMs: number;
}

export function loadServerConfig(env: Env = process.env): ServerConfig {
  const schema = z.object({
    COMATO_WALLET: addressSchema,
    // Required: the Celo facilitator rejects /settle without X-API-Key (401). Create it
    // on the x402.celo.org dashboard (sign with a wallet, no gas). 1 credit per settle.
    X402_API_KEY: z
      .string()
      .min(1, "X402_API_KEY is required — create it on the x402.celo.org dashboard; /settle 401s without it"),
    CELO_RPC: z.string().url().default(DEFAULT_CELO_RPC),
    PREMIUM_USDC: z.string().default("0.001"),
    QUOTE_STORE_PATH: z.string().default(DEFAULTS.quoteStorePath),
  });

  const parsed = schema.parse(env);
  return {
    payTo: parsed.COMATO_WALLET as `0x${string}`,
    // Facilitator MUST stay Celo's own — a different relayer settles fine but does not
    // count for Track 2. Not env-overridable; it is a fixed constant.
    facilitatorUrl: X402_FACILITATOR_URL,
    apiKey: parsed.X402_API_KEY,
    rpcUrl: parsed.CELO_RPC,
    network: CELO_NETWORK,
    premiumUsdc: parsed.PREMIUM_USDC,
    premiumAtomic: toAtomicUsdc(parsed.PREMIUM_USDC, "PREMIUM_USDC"),
    port: DEFAULTS.port,
    syncFacilitatorOnStart: DEFAULTS.syncFacilitatorOnStart,
    assertRelayer: DEFAULTS.assertRelayer,
    quoteStorePath: parsed.QUOTE_STORE_PATH,
    quoteMaxPremiumUsdc: DEFAULTS.quoteMaxPremiumUsdc,
    quoteMaxAgeMs: DEFAULTS.quoteMaxAgeMs,
  };
}

