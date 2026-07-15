/**
 * QuoteStore tests. The file is a trust boundary: absent, torn, stale, or hostile
 * content must all resolve to `null` (= flat default premium), never to a thrown
 * error or an out-of-bounds price.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuoteStore } from "../src/quote-store.ts";

const SUB = "0xD38b576B7F21f9A1B22a040d053884f60B5B450F";
const OPTS = { maxPremiumUsdc: "0.05", maxAgeMs: 86_400_000 };

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comato-quotes-"));
  path = join(dir, "quotes.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeStore(quotes: Record<string, unknown>, version = 1) {
  writeFileSync(path, JSON.stringify({ version, updatedAt: new Date().toISOString(), quotes }));
}

function validQuote(premiumUsdc: string, quotedAt = new Date().toISOString()) {
  return { premiumUsdc, riskTier: "high", rationale: "test", fallback: false, quotedAt };
}

describe("QuoteStore.lookup", () => {
  it("returns the quote in atomic units, case-insensitively", () => {
    writeStore({ [SUB.toLowerCase()]: validQuote("0.034155") });
    const q = new QuoteStore(path, OPTS).lookup(SUB.toUpperCase().replace("0X", "0x"));
    expect(q).toEqual({ amountAtomic: "34155", premiumUsdc: "0.034155", riskTier: "high" });
  });

  it("skips only the malformed entry — one bad quote must not blank every subscriber", () => {
    const other = "0x" + "2".repeat(40);
    writeStore({
      [SUB.toLowerCase()]: validQuote("0.01"),
      [other]: { premiumUsdc: "0.02" }, // malformed: missing riskTier/rationale/fallback/quotedAt
    });
    const store = new QuoteStore(path, OPTS);
    expect(store.lookup(SUB)?.amountAtomic).toBe("10000"); // valid entry survives
    expect(store.lookup(other)).toBeNull(); // malformed entry → flat default, not a global blank
  });

  it("returns null when the file does not exist", () => {
    expect(new QuoteStore(join(dir, "missing.json"), OPTS).lookup(SUB)).toBeNull();
  });

  it("returns null for an unknown subscriber", () => {
    writeStore({ [SUB.toLowerCase()]: validQuote("0.01") });
    expect(new QuoteStore(path, OPTS).lookup("0x" + "1".repeat(40))).toBeNull();
  });

  it("returns null for a malformed claimed address (header is attacker input)", () => {
    writeStore({ [SUB.toLowerCase()]: validQuote("0.01") });
    const store = new QuoteStore(path, OPTS);
    expect(store.lookup(undefined)).toBeNull();
    expect(store.lookup("not-an-address")).toBeNull();
    expect(store.lookup("0x1234")).toBeNull();
  });

  it("returns null on torn/invalid JSON instead of throwing", () => {
    writeFileSync(path, '{"version":1,"quotes":{"0xabc');
    expect(new QuoteStore(path, OPTS).lookup(SUB)).toBeNull();
  });

  it("returns null on a wrong schema version", () => {
    writeStore({ [SUB.toLowerCase()]: validQuote("0.01") }, 2);
    expect(new QuoteStore(path, OPTS).lookup(SUB)).toBeNull();
  });

  it("clamps: a premium above the ceiling falls back to null", () => {
    writeStore({ [SUB.toLowerCase()]: validQuote("0.051") });
    expect(new QuoteStore(path, OPTS).lookup(SUB)).toBeNull();
  });

  it("clamps: a zero premium falls back to null", () => {
    writeStore({ [SUB.toLowerCase()]: validQuote("0") });
    expect(new QuoteStore(path, OPTS).lookup(SUB)).toBeNull();
  });

  it("rejects a stale quote — it prices yesterday's risk", () => {
    writeStore({ [SUB.toLowerCase()]: validQuote("0.01", new Date(Date.now() - 90_000_000).toISOString()) });
    expect(new QuoteStore(path, OPTS).lookup(SUB)).toBeNull();
  });

  it("picks up a rewrite (mtime cache invalidation)", async () => {
    writeStore({ [SUB.toLowerCase()]: validQuote("0.01") });
    const store = new QuoteStore(path, OPTS);
    expect(store.lookup(SUB)?.amountAtomic).toBe("10000");
    // mtimeMs has millisecond resolution; make sure the rewrite lands on a new tick.
    await new Promise((r) => setTimeout(r, 5));
    writeStore({ [SUB.toLowerCase()]: validQuote("0.02") });
    expect(store.lookup(SUB)?.amountAtomic).toBe("20000");
  });
});
