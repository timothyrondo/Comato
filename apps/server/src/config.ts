/**
 * Environment-driven configuration for the Comato x402 heartbeat server and the
 * heartbeat client. Secrets are read from env only — never hard-coded. All input is
 * validated (zod + viem address/hex checks) and fails fast with a clear message.
 */

import { z } from "zod";
import { isAddress, parseUnits } from "viem";
import {
  CELO_NETWORK,
  DEFAULT_CELO_RPC,
  USDC,
  X402_FACILITATOR_URL,
  type CeloNetwork,
} from "./constants.ts";

type Env = Record<string, string | undefined>;

const addressSchema = z
  .string()
  .refine((v) => isAddress(v), { message: "must be a 0x EVM address" });

const privateKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key");

/** Parse an env boolean: "true"/"1" -> true, anything else -> false; unset -> default. */
function boolEnv(def: boolean) {
  return z.preprocess((v) => {
    if (v === undefined || v === "") return def;
    if (typeof v === "string") return v === "true" || v === "1";
    return Boolean(v);
  }, z.boolean());
}

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
}

export function loadServerConfig(env: Env = process.env): ServerConfig {
  const schema = z.object({
    COMATO_WALLET: addressSchema,
    X402_FACILITATOR_URL: z.string().url().default(X402_FACILITATOR_URL),
    CELO_RPC: z.string().url().default(DEFAULT_CELO_RPC),
    PREMIUM_USDC: z.string().default("0.001"),
    PORT: z.coerce.number().int().positive().max(65535).default(4021),
    X402_SYNC_ON_START: boolEnv(true),
    X402_ASSERT_RELAYER: boolEnv(true),
  });

  const parsed = schema.parse(env);
  return {
    payTo: parsed.COMATO_WALLET as `0x${string}`,
    facilitatorUrl: parsed.X402_FACILITATOR_URL,
    rpcUrl: parsed.CELO_RPC,
    network: CELO_NETWORK,
    premiumUsdc: parsed.PREMIUM_USDC,
    premiumAtomic: toAtomicUsdc(parsed.PREMIUM_USDC, "PREMIUM_USDC"),
    port: parsed.PORT,
    syncFacilitatorOnStart: parsed.X402_SYNC_ON_START,
    assertRelayer: parsed.X402_ASSERT_RELAYER,
  };
}

export interface ClientConfig {
  heartbeatUrl: string;
  subscriberKeys: `0x${string}`[];
  thirdwebSecretKey: string;
  intervalMs: number;
  concurrency: number;
  /** Total heartbeats to send before stopping. 0 = run forever. */
  maxHeartbeats: number;
  /** Upper bound per payment, atomic USDC units — guards against a mispriced route. */
  maxValueAtomic: bigint;
}

export function loadClientConfig(env: Env = process.env): ClientConfig {
  const schema = z.object({
    HEARTBEAT_URL: z.string().url().default("http://localhost:4021/heartbeat"),
    SUBSCRIBER_PRIVATE_KEYS: z.string().min(1, "SUBSCRIBER_PRIVATE_KEYS is required"),
    THIRDWEB_SECRET_KEY: z.string().min(1, "THIRDWEB_SECRET_KEY is required"),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
    HEARTBEAT_CONCURRENCY: z.coerce.number().int().positive().optional(),
    HEARTBEAT_MAX: z.coerce.number().int().nonnegative().default(0),
    MAX_PAYMENT_USDC: z.string().default("0.01"),
  });

  const parsed = schema.parse(env);

  const keys = parsed.SUBSCRIBER_PRIVATE_KEYS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((k, i) => {
      const result = privateKeySchema.safeParse(k);
      if (!result.success) {
        throw new Error(`SUBSCRIBER_PRIVATE_KEYS[${i}] invalid: ${result.error.issues[0]?.message}`);
      }
      return result.data as `0x${string}`;
    });

  if (keys.length === 0) {
    throw new Error("SUBSCRIBER_PRIVATE_KEYS must contain at least one private key");
  }

  return {
    heartbeatUrl: parsed.HEARTBEAT_URL,
    subscriberKeys: keys,
    thirdwebSecretKey: parsed.THIRDWEB_SECRET_KEY,
    intervalMs: parsed.HEARTBEAT_INTERVAL_MS,
    concurrency: parsed.HEARTBEAT_CONCURRENCY ?? keys.length,
    maxHeartbeats: parsed.HEARTBEAT_MAX,
    maxValueAtomic: parseUnits(parsed.MAX_PAYMENT_USDC, USDC.decimals),
  };
}
