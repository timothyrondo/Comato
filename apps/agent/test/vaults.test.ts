/**
 * VaultRegistry tests — factory auto-discovery of Comato-operated vaults.
 * Covers: the explicit VAULTS override (no factory reads), read-only mode,
 * the operator filter (ignore vaults we don't operate), the grief cap, the
 * TTL cache, and the fail-safe (reuse last-known set on a read error).
 */

import { describe, expect, test } from "bun:test";
import type { Address, PublicClient } from "viem";
import { VaultRegistry, type VaultRegistryOptions } from "../src/vaults.ts";
import { silentLog } from "./_helpers.ts";

const FACTORY = "0x00000000000000000000000000000000000000fa" as Address;
const OP = "0x00000000000000000000000000000000000000aa" as Address; // our operator
const OTHER = "0x00000000000000000000000000000000000000bb" as Address; // someone else

/** Deterministic 20-byte address from a small int (0x…01, 0x…02, …). */
const V = (n: number): Address => (`0x${n.toString(16).padStart(40, "0")}`) as Address;

/** A mock factory + vaults, tracking read count so cache tests can assert no re-scan. */
function mockFactory(opts: {
  vaults: Address[];
  operators?: Record<string, Address>; // vault(lowercased) -> operator; default OTHER
  failCount?: boolean;
}) {
  let reads = 0;
  const client = {
    readContract: async ({ address, functionName, args }: any) => {
      reads++;
      switch (functionName) {
        case "vaultCount":
          if (opts.failCount) throw new Error("rpc down");
          return BigInt(opts.vaults.length);
        case "allVaults":
          return opts.vaults[Number(args[0])];
        case "operator":
          return opts.operators?.[(address as string).toLowerCase()] ?? OTHER;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;
  return { client, reads: () => reads };
}

const opts = (over: Partial<VaultRegistryOptions> = {}): VaultRegistryOptions => ({
  explicit: [],
  ttlMs: 1000,
  maxVaults: 100,
  ...over,
});

describe("VaultRegistry", () => {
  test("explicit VAULTS override wins and never touches the factory", async () => {
    const { client, reads } = mockFactory({ vaults: [V(9)] });
    const reg = new VaultRegistry(client, FACTORY, OP, opts({ explicit: [V(1), V(2)] }), silentLog);
    expect(await reg.list()).toEqual([V(1), V(2)]);
    expect(reads()).toBe(0);
  });

  test("read-only (no operator) with no override discovers nothing", async () => {
    const { client, reads } = mockFactory({ vaults: [V(1)] });
    const reg = new VaultRegistry(client, FACTORY, null, opts(), silentLog);
    expect(await reg.list()).toEqual([]);
    expect(reads()).toBe(0);
  });

  test("keeps only vaults this agent operates", async () => {
    const { client } = mockFactory({
      vaults: [V(1), V(2), V(3)],
      operators: { [V(1).toLowerCase()]: OP, [V(2).toLowerCase()]: OTHER, [V(3).toLowerCase()]: OP },
    });
    const reg = new VaultRegistry(client, FACTORY, OP, opts(), silentLog);
    expect(await reg.list()).toEqual([V(1), V(3)]);
  });

  test("caps enumeration against a spammed factory", async () => {
    const many = [V(1), V(2), V(3), V(4), V(5)];
    const operators = Object.fromEntries(many.map((v) => [v.toLowerCase(), OP]));
    const { client } = mockFactory({ vaults: many, operators });
    const reg = new VaultRegistry(client, FACTORY, OP, opts({ maxVaults: 2 }), silentLog);
    // Only the first 2 are enumerated even though all 5 are ours.
    expect(await reg.list()).toEqual([V(1), V(2)]);
  });

  test("caches discovery within the TTL, re-scans after it", async () => {
    let t = 0;
    const { client, reads } = mockFactory({ vaults: [V(1)], operators: { [V(1).toLowerCase()]: OP } });
    const reg = new VaultRegistry(client, FACTORY, OP, opts({ ttlMs: 1000, nowMs: () => t }), silentLog);

    expect(await reg.list()).toEqual([V(1)]);
    const afterFirst = reads();
    expect(afterFirst).toBeGreaterThan(0);

    t = 500; // within TTL -> served from cache, no new reads
    expect(await reg.list()).toEqual([V(1)]);
    expect(reads()).toBe(afterFirst);

    t = 1500; // past TTL -> re-scans
    expect(await reg.list()).toEqual([V(1)]);
    expect(reads()).toBeGreaterThan(afterFirst);
  });

  test(
    "fail-safe: reuses the last-known set on a discovery error",
    async () => {
      let fail = false;
      let n = 0;
      const client = {
        readContract: async ({ functionName }: any) => {
          if (functionName === "vaultCount") {
            if (fail) throw new Error("rpc down");
            return 1n;
          }
          if (functionName === "allVaults") return V(1);
          if (functionName === "operator") return OP;
          throw new Error("unexpected");
        },
      } as unknown as PublicClient;
      const reg = new VaultRegistry(client, FACTORY, OP, opts({ ttlMs: 0, nowMs: () => n++ }), silentLog);

      expect(await reg.list()).toEqual([V(1)]); // primes the cache
      fail = true;
      expect(await reg.list()).toEqual([V(1)]); // read fails -> reuse cache
    },
    10_000,
  );

  test(
    "fail-safe: empty set when the very first discovery fails",
    async () => {
      const { client } = mockFactory({ vaults: [], failCount: true });
      const reg = new VaultRegistry(client, FACTORY, OP, opts(), silentLog);
      expect(await reg.list()).toEqual([]);
    },
    10_000,
  );
});
