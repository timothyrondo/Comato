import { test, expect, describe } from "bun:test";
import {
  money,
  percent,
  riskLevel,
  riskCopy,
  riskTextClass,
} from "../../src/lib/format";

describe("money", () => {
  test("integer USD → id-ID grouping, no decimals", () => {
    expect(money(12480)).toBe("$12.480");
    expect(money(0)).toBe("$0");
    expect(money(212)).toBe("$212");
  });

  test("fractional USD → two decimals with comma", () => {
    expect(money(0.02)).toBe("$0,02");
    expect(money(1234.5)).toBe("$1.234,50");
  });

  test("compact abbreviates values ≥ 1000", () => {
    // id-ID compact uses "rb" (ribu) for thousands, "jt" (juta) for millions.
    // Intl inserts a narrow no-break space before the unit → normalise it.
    const norm = (s: string) => s.replace(/\s+/g, " ");
    expect(norm(money(1500, { compact: true }))).toBe("$1,5 rb");
    expect(norm(money(1_200_000, { compact: true }))).toBe("$1,2 jt");
  });

  test("compact below 1000 stays standard", () => {
    expect(money(999, { compact: true })).toBe("$999");
  });

  test("negative values keep the leading $", () => {
    expect(money(-212)).toBe("$-212");
  });
});

describe("percent", () => {
  test("fraction → percent string, 0 digits by default", () => {
    expect(percent(0.55)).toBe("55%");
    expect(percent(0.83)).toBe("83%");
  });

  test("honours a digit count", () => {
    expect(percent(0.555, 1)).toBe("55,5%");
    expect(percent(0, 2)).toBe("0,00%");
  });
});

describe("riskLevel", () => {
  const rescue = 1.2;
  const liq = 1.0;

  test("at or below liquidation → danger", () => {
    expect(riskLevel(1.0, rescue, liq)).toBe("danger");
    expect(riskLevel(0.9, rescue, liq)).toBe("danger");
  });

  test("between liquidation and rescue → warn", () => {
    expect(riskLevel(1.2, rescue, liq)).toBe("warn");
    expect(riskLevel(1.05, rescue, liq)).toBe("warn");
  });

  test("above rescue → safe", () => {
    expect(riskLevel(1.82, rescue, liq)).toBe("safe");
    expect(riskLevel(2.5, rescue, liq)).toBe("safe");
  });
});

describe("risk copy + token maps", () => {
  test("copy labels", () => {
    expect(riskCopy.safe).toBe("Safe");
    expect(riskCopy.warn).toBe("Caution");
    expect(riskCopy.danger).toBe("Critical");
  });
  test("text-class tokens", () => {
    expect(riskTextClass.safe).toBe("text-safe");
    expect(riskTextClass.warn).toBe("text-warn");
    expect(riskTextClass.danger).toBe("text-danger");
  });
});
