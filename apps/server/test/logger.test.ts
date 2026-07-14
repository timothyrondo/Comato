/**
 * Unit tests for `src/logger.ts` — structured JSON-lines output.
 *
 * Verifies: one JSON object per line with `ts`/`level`/`msg` + fields; BigInt values
 * are stringified (settlement amounts must never crash serialization); and errors/warns
 * route to stderr while info/debug route to stdout. Console is captured (no real I/O).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { logger } from "../src/logger.ts";

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  console.log = (line: string) => out.push(line);
  console.warn = (line: string) => err.push(line);
  console.error = (line: string) => err.push(line);
  return { out, err };
}

describe("logger", () => {
  it("emits one JSON line with ts/level/msg + fields on info (stdout)", () => {
    const { out, err } = capture();
    logger.info("x402.settled", { tx: "0xabc", amount: 1000 });
    expect(err).toHaveLength(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("x402.settled");
    expect(parsed.tx).toBe("0xabc");
    expect(parsed.amount).toBe(1000);
    expect(typeof parsed.ts).toBe("string");
  });

  it("stringifies BigInt fields so serialization never crashes", () => {
    const { out } = capture();
    logger.debug("amount.check", { atomic: 123456789012345678901234567890n });
    const parsed = JSON.parse(out[0]!);
    // BigInt -> decimal string, not a number/throw.
    expect(parsed.atomic).toBe("123456789012345678901234567890");
  });

  it("routes warn and error to stderr", () => {
    const { out, err } = capture();
    logger.warn("x402.relayer.unverified", {});
    logger.error("x402.relayer.mismatch", {});
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(2);
    expect(JSON.parse(err[0]!).level).toBe("warn");
    expect(JSON.parse(err[1]!).level).toBe("error");
  });

  it("routes debug to stdout", () => {
    const { out, err } = capture();
    logger.debug("debug.msg");
    expect(err).toHaveLength(0);
    expect(JSON.parse(out[0]!).level).toBe("debug");
  });
});
