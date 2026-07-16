/** QuoteWriter: snapshots in, valid store file out. The pricer is faked — its own behaviour is pricer.test.ts's job. */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuoteWriter, type QuoteStoreFile, type UnderwritablePosition } from "../src/quotes.ts";
import type { Pricer } from "../src/pricer.ts";
import { createLogger } from "../src/logger.ts";

const log = createLogger("test");
const HOUR = 3_600_000;

const fakePricer = {
  quote: async (pos: { debtUsd: number; collateralMix: string }) => ({
    riskTier: "high" as const,
    rationale: pos.collateralMix, // echo the mix so tests can assert it flows through
    premiumUsdc: (pos.debtUsd / 1000).toFixed(6),
    aprPct: 8.8,
    fallback: false,
  }),
} as unknown as Pricer;

function pos(
  subscriber: string,
  debtUsd8: bigint,
  collateralMix = "composition unknown (aggregate position)",
): UnderwritablePosition {
  return {
    subscriber: subscriber as `0x${string}`,
    healthFactor: 1_200_000_000_000_000_000n,
    collateralBase: 500_000_000_000n,
    debtBase: debtUsd8,
    collateralMix,
  };
}

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "comato-qw-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("QuoteWriter.repriceAll", () => {
  it("publishes a valid store keyed by lowercase address, skipping debtless positions", async () => {
    const path = join(dir, "quotes.json");
    const writer = new QuoteWriter(fakePricer, path, HOUR, log);

    await writer.repriceAll([
      pos("0xD38b576B7F21f9A1B22a040d053884f60B5B450F", 340_000_000_000n), // $3,400 debt
      pos("0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF", 0n), // no debt -> skipped
    ]);

    const file = JSON.parse(readFileSync(path, "utf8")) as QuoteStoreFile;
    expect(file.version).toBe(1);
    expect(Object.keys(file.quotes)).toEqual(["0xd38b576b7f21f9a1b22a040d053884f60b5b450f"]);
    const q = file.quotes["0xd38b576b7f21f9a1b22a040d053884f60b5b450f"]!;
    expect(q.premiumUsdc).toBe("3.400000"); // fake pricer: debtUsd/1000
    expect(q.riskTier).toBe("high");
    expect(Date.parse(q.quotedAt)).toBeGreaterThan(0);
  });

  it("underwrites a Model C vault position keyed by its owner, with the precise mix", async () => {
    const path = join(dir, "quotes.json");
    const writer = new QuoteWriter(fakePricer, path, HOUR, log);
    const owner = "0x01659a68AA09616d0a70713ae7fE0eB46D756ba8";

    await writer.repriceAll([pos(owner, 460_000_000n, "WETH collateral → USDT debt (non-custodial vault)")]);

    const file = JSON.parse(readFileSync(path, "utf8")) as QuoteStoreFile;
    const q = file.quotes[owner.toLowerCase()]!;
    expect(q).toBeDefined();
    // The vault's precise collateral mix reached the pricer (fake echoes it as rationale).
    expect(q.rationale).toBe("WETH collateral → USDT debt (non-custodial vault)");
  });

  it("leaves no .tmp behind (atomic rename)", async () => {
    const path = join(dir, "quotes.json");
    await new QuoteWriter(fakePricer, path, HOUR, log).repriceAll([
      pos("0xD38b576B7F21f9A1B22a040d053884f60B5B450F", 100_000_000_000n),
    ]);
    expect(() => readFileSync(`${path}.tmp`)).toThrow();
  });
});
