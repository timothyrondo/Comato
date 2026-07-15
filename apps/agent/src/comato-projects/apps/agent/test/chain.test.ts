/**
 * chain.ts tests — viem client construction. Offline: `http()` transport is lazy
 * (no RPC call at construction) and `privateKeyToAccount` is a pure local derive.
 * Verifies read-only vs wallet mode shape + chain id.
 */

import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { createChain } from "../src/chain.ts";
import { makeConfig } from "./_helpers.ts";
import type { Hex } from "viem";

// Anvil well-known test key (public, offline). Never a real funded key.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

describe("chain.createChain", () => {
  test("read-only (no key): public client only, chain id 42220", () => {
    const chain = createChain(makeConfig({ privateKey: undefined }));
    expect(chain.publicClient).toBeDefined();
    expect(chain.walletClient).toBeUndefined();
    expect(chain.account).toBeUndefined();
    expect(chain.publicClient.chain?.id).toBe(42220);
  });

  test("with key: public + wallet client + account, on Celo", () => {
    const chain = createChain(makeConfig({ privateKey: KEY }));
    expect(chain.publicClient).toBeDefined();
    expect(chain.walletClient).toBeDefined();
    expect(chain.account).toBeDefined();
    expect(chain.walletClient!.chain?.id).toBe(42220);
    // The wallet account IS COMATO_WALLET (derived locally from the key).
    expect(chain.account!.address).toBe(privateKeyToAccount(KEY).address);
  });
});
