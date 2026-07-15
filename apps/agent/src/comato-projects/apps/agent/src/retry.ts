/**
 * Retry with exponential backoff + jitter, for flaky RPC reads/writes.
 *
 * Celo public RPC (forno) occasionally rate-limits or times out; a monitor that
 * dies on the first hiccup is useless for a 6-day run. Reads are always safe to
 * retry. Writes (tx sends) are retried too, but callers must ensure the
 * operation is idempotent enough not to double-send (we retry the *build/submit*
 * step, and treat a submitted-but-unconfirmed tx as terminal — see tx.ts).
 */

import type { Logger } from "./logger.ts";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /** Optional label for logging. */
  label?: string;
  logger?: Logger;
  /** Return false to stop retrying a specific error (e.g. a revert). */
  shouldRetry?: (err: unknown) => boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8_000;
  const factor = opts.factor ?? 2;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !shouldRetry(err)) {
        throw err;
      }
      const backoff = Math.min(max, base * factor ** (attempt - 1));
      const jitter = Math.random() * backoff * 0.25;
      const delay = Math.round(backoff + jitter);
      opts.logger?.warn("retrying after error", {
        label: opts.label,
        attempt,
        retries,
        delayMs: delay,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }
}
