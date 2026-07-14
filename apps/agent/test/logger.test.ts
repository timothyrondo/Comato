/**
 * logger.ts tests — the structured JSON-line logger. Verifies level routing
 * (info/debug -> stdout, warn/error -> stderr), level-threshold filtering, and
 * BigInt-safe serialization (a raw BigInt would otherwise throw in JSON.stringify).
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger, setLogLevel } from "../src/logger.ts";

describe("logger", () => {
  afterEach(() => {
    setLogLevel("info"); // restore module-global threshold for other tests
  });

  test("info goes to stdout; warn/error go to stderr", () => {
    setLogLevel("debug");
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const log = createLogger("test");
      log.info("hello", { event: "t.info" });
      log.debug("dbg", { event: "t.debug" });
      log.warn("warn", { event: "t.warn" });
      log.error("err", { event: "t.error" });
      expect(out).toHaveBeenCalledTimes(2); // info + debug
      expect(err).toHaveBeenCalledTimes(2); // warn + error
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  test("threshold filters lower-severity lines", () => {
    setLogLevel("error");
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const log = createLogger("test");
      log.info("suppressed");
      log.warn("suppressed");
      log.error("shown");
      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  test("serializes BigInt context values as decimal strings", () => {
    setLogLevel("info");
    let captured = "";
    const out = spyOn(console, "log").mockImplementation((line: unknown) => {
      captured = String(line);
    });
    try {
      createLogger("test").info("amount", { amount: 12345n });
      const parsed = JSON.parse(captured);
      expect(parsed.amount).toBe("12345");
      expect(parsed.level).toBe("info");
      expect(parsed.module).toBe("test");
      expect(parsed.msg).toBe("amount");
    } finally {
      out.mockRestore();
    }
  });
});
