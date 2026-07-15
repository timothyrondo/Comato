import { test, expect, describe } from "bun:test";
import {
  user,
  position,
  rescuePlan,
  activity,
  activitySummary,
} from "../../src/data/fixtures";

describe("fixture shapes", () => {
  test("demo user carries a product handle, no personal identity", () => {
    expect(user.name).toBe("Timo");
    expect(user.handle).toBe("comato");
    expect(user.walletShort).toMatch(/^0x/);
  });

  test("position is a safe, above-liquidation sample", () => {
    expect(position.healthFactor).toBeGreaterThan(position.rescueHf);
    expect(position.rescueHf).toBeGreaterThan(position.liquidationHf);
    expect(position.liquidationHf).toBe(1.0);
    expect(position.collateralUsd).toBeGreaterThan(position.debtUsd);
  });

  test("rescue plan starts active, ends ready", () => {
    expect(rescuePlan).toHaveLength(4);
    expect(rescuePlan[0].state).toBe("active");
    expect(rescuePlan.at(-1)!.state).toBe("ready");
    // the alert-threshold step echoes the live rescue HF
    expect(rescuePlan[1].title).toContain(position.rescueHf.toFixed(2));
  });
});

describe("activity + summary", () => {
  test("every item has a signed amount and a day bucket", () => {
    for (const a of activity) {
      expect(["rescue", "premium", "swap"]).toContain(a.kind);
      expect(["Today", "Yesterday", "This week"]).toContain(a.day);
      expect(typeof a.amountUsd).toBe("number");
    }
  });

  test("rescues carry hfBefore/hfAfter, premiums do not", () => {
    const rescues = activity.filter((a) => a.kind === "rescue");
    const premiums = activity.filter((a) => a.kind === "premium");
    expect(rescues.every((r) => r.hfAfter! > r.hfBefore!)).toBe(true);
    expect(premiums.every((p) => p.hfBefore === undefined)).toBe(true);
  });

  test("summary totals are derived from the rescue rows", () => {
    const rescues = activity.filter((a) => a.kind === "rescue");
    const total = rescues.reduce((s, r) => s + r.amountUsd, 0);
    expect(activitySummary.rescueCount).toBe(rescues.length);
    expect(activitySummary.totalSavedUsd).toBe(total);
    expect(activitySummary.premiumPaidUsd).toBeGreaterThan(0);
  });
});
