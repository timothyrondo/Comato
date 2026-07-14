import { test, expect, describe } from "bun:test";
import { createReadClient } from "../../src/lib/chain";
import type { LiveConfig } from "../../src/lib/env";
import { lastCreateClientArgs } from "../helpers";

/**
 * viem's `createPublicClient` is mocked in the harness (test/setup.ts) to return
 * a stub and record its args. We assert `createReadClient` builds the client
 * with the configured chain id + RPC — the mock guarantees no network I/O.
 */

function cfg(overrides: Partial<LiveConfig> = {}): LiveConfig {
  return {
    rpcUrl: "http://127.0.0.1:8546",
    chainId: 44787,
    subscriber: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    fromBlock: 0n,
    ...overrides,
  };
}

describe("createReadClient", () => {
  test("returns a read client (the stub) without touching the network", () => {
    const client = createReadClient(cfg());
    expect(client).toBeDefined();
    expect(typeof (client as { readContract?: unknown }).readContract).toBe(
      "function",
    );
  });

  test("passes the configured chain id through to createPublicClient", () => {
    createReadClient(cfg({ chainId: 44787 }));
    const args = lastCreateClientArgs();
    expect(args?.chain?.id).toBe(44787);
  });

  test("honours a custom chain id (Celo mainnet)", () => {
    createReadClient(cfg({ chainId: 42220 }));
    expect(lastCreateClientArgs()?.chain?.id).toBe(42220);
  });
});
