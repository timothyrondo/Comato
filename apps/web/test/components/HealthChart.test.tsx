import { test, expect, describe } from "bun:test";
import { render } from "@testing-library/react";
import HealthChart, {
  buildHealthSeries,
} from "../../src/components/HealthChart";
import type { ActivityItem } from "../../src/data/fixtures";

function rescue(hfBefore: number, hfAfter: number, id: string): ActivityItem {
  return {
    id,
    kind: "rescue",
    title: "Position rescued",
    subtitle: "",
    amountUsd: 100,
    timeAgo: "",
    day: "Today",
    hfBefore,
    hfAfter,
  };
}
const premium: ActivityItem = {
  id: "p",
  kind: "premium",
  title: "Premium",
  subtitle: "",
  amountUsd: 0.02,
  timeAgo: "",
  day: "Today",
};

describe("buildHealthSeries (pure)", () => {
  test("no rescues → calm 5-point lead up to current HF, no dips", () => {
    const s = buildHealthSeries([premium], 1.82);
    expect(s.dips).toEqual([]);
    expect(s.points).toHaveLength(5);
    expect(s.points.at(-1)).toBe(1.82);
  });

  test("rescues (newest-first input) → dip markers per rescue + current HF tail", () => {
    // context feeds newest-first; builder reverses to oldest-first internally.
    const activity = [
      rescue(1.12, 1.61, "r2"), // newest
      rescue(1.2, 1.7, "r1"), // oldest
    ];
    const s = buildHealthSeries(activity, 1.9);
    // lead-in + (before,after)*2 + current = 6 points
    expect(s.points).toHaveLength(6);
    expect(s.points.at(-1)).toBe(1.9);
    // two dips, one per rescue, at the hfBefore indices (1 and 3)
    expect(s.dips).toEqual([1, 3]);
    // oldest rescue processed first → its hfBefore (1.20) sits at index 1
    expect(s.points[1]).toBe(1.2);
    expect(s.points[2]).toBe(1.7);
  });

  test("ignores rescues missing hfBefore/hfAfter", () => {
    const partial: ActivityItem = { ...rescue(1.1, 1.5, "x"), hfAfter: undefined };
    const s = buildHealthSeries([partial], 1.8);
    expect(s.dips).toEqual([]); // treated as 'no rescues'
    expect(s.points).toHaveLength(5);
  });
});

describe("HealthChart render", () => {
  test("draws an accessible SVG trace with threshold guide labels", () => {
    const series = buildHealthSeries(
      [rescue(1.14, 1.66, "a")],
      1.82,
    );
    const { container, getByText } = render(
      <HealthChart series={series} rescueHf={1.2} liquidationHf={1.0} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-label")).toContain("1.82");
    expect(getByText("Rescue 1.20")).toBeDefined();
    expect(getByText("Liquidation 1.00")).toBeDefined();
  });

  test("renders a marker per dip + the current-value dot", () => {
    const series = buildHealthSeries(
      [rescue(1.14, 1.66, "a"), rescue(1.1, 1.6, "b")],
      1.8,
    );
    const { container } = render(<HealthChart series={series} rescueHf={1.2} />);
    // dips (2) + current outer + current inner circles present
    expect(container.querySelectorAll("circle").length).toBeGreaterThanOrEqual(3);
  });
});
