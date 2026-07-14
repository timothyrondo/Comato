/**
 * Tiny assertion + reporting helper. Each `check` records a labelled pass/fail
 * so the run prints one clear, self-contained assertion table at the end and
 * exits non-zero on the first failure (with a helpful message).
 */

export interface CheckResult {
  ok: boolean;
  label: string;
  detail: string;
}

export class Asserter {
  readonly results: CheckResult[] = [];

  /** Assert `cond`; `detail` is shown in the report (e.g. the observed value). */
  check(cond: boolean, label: string, detail = ""): void {
    this.results.push({ ok: cond, label, detail });
    const tag = cond ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${label}${detail ? `  — ${detail}` : ""}`);
    if (!cond) {
      throw new Error(`ASSERTION FAILED: ${label}${detail ? `  (${detail})` : ""}`);
    }
  }

  get passed(): number {
    return this.results.filter((r) => r.ok).length;
  }

  report(): void {
    console.log("\n" + "=".repeat(72));
    console.log(`E2E ASSERTIONS: ${this.passed}/${this.results.length} passed`);
    console.log("=".repeat(72));
    for (const r of this.results) {
      console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}${r.detail ? `  — ${r.detail}` : ""}`);
    }
    console.log("=".repeat(72));
  }
}
