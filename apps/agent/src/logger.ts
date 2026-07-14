/**
 * Minimal structured (JSON-line) logger. No external deps.
 *
 * Every line is a single JSON object: `{ ts, level, module, msg, ...ctx }`.
 * Structured logs make the 6-day continuous run greppable (e.g. filter for
 * `"event":"rescue.executed"`), and keep secrets out of the output — never log
 * the private key or a raw signed authorization; log addresses and tx hashes.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let threshold: number = LEVEL_ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_ORDER[level];
}

type Ctx = Record<string, unknown>;

function emit(level: LogLevel, module: string, msg: string, ctx?: Ctx): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    module,
    msg,
    ...ctx,
  };
  // BigInt is not JSON-serializable by default; stringify it as a decimal string.
  const serialized = JSON.stringify(line, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  if (level === "error" || level === "warn") {
    console.error(serialized);
  } else {
    console.log(serialized);
  }
}

/** Create a logger bound to a module name (e.g. "monitor", "rescue"). */
export function createLogger(module: string) {
  return {
    debug: (msg: string, ctx?: Ctx) => emit("debug", module, msg, ctx),
    info: (msg: string, ctx?: Ctx) => emit("info", module, msg, ctx),
    warn: (msg: string, ctx?: Ctx) => emit("warn", module, msg, ctx),
    error: (msg: string, ctx?: Ctx) => emit("error", module, msg, ctx),
  };
}

export type Logger = ReturnType<typeof createLogger>;
