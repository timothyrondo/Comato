import { test, expect, describe } from "bun:test";
import { render } from "@testing-library/react";
import HealthRing from "../../src/components/HealthRing";

describe("HealthRing", () => {
  test("safe zone → 'Safe', number rendered, accessible label", () => {
    const { container, getByText } = render(
      <HealthRing value={1.82} liquidationHf={1.0} rescueHf={1.2} />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe(
      "Health factor 1.82, status Safe",
    );
    // count-up snaps under reduced motion → the exact value is shown
    expect(getByText("1.82")).toBeDefined();
    expect(getByText("Safe")).toBeDefined();
  });

  test("warn zone → 'Caution'", () => {
    const { getByText, container } = render(
      <HealthRing value={1.15} liquidationHf={1.0} rescueHf={1.2} />,
    );
    expect(getByText("Caution")).toBeDefined();
    expect(container.querySelector("svg")!.getAttribute("aria-label")).toContain(
      "Caution",
    );
  });

  test("danger zone → 'Critical'", () => {
    const { getByText } = render(
      <HealthRing value={0.98} liquidationHf={1.0} rescueHf={1.2} />,
    );
    expect(getByText("Critical")).toBeDefined();
  });

  test("renders the liquidation tick label + honours a custom size", () => {
    const { getAllByText, container } = render(
      <HealthRing value={2.0} size={200} />,
    );
    // "1.00" tick label
    expect(getAllByText("1.00").length).toBeGreaterThanOrEqual(1);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 200 200");
  });
});
