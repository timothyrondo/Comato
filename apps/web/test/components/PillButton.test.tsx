import { test, expect, describe } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import PillButton from "../../src/components/PillButton";

describe("PillButton", () => {
  test("renders children + fires onClick", () => {
    let clicked = 0;
    const { getByRole } = render(
      <PillButton onClick={() => (clicked += 1)}>Protect Position</PillButton>,
    );
    const btn = getByRole("button");
    expect(btn.textContent).toContain("Protect Position");
    fireEvent.click(btn);
    expect(clicked).toBe(1);
  });

  test("dark variant (default) → btn-primary", () => {
    const { getByRole } = render(<PillButton>Go</PillButton>);
    expect(getByRole("button").className).toContain("btn-primary");
  });

  test("light + ghost variants + leading/trailing slots", () => {
    const { getByRole, getByText } = render(
      <PillButton
        variant="light"
        block={false}
        leading={<span>L</span>}
        trailing={<span>R</span>}
      >
        Mid
      </PillButton>,
    );
    const btn = getByRole("button");
    expect(btn.className).toContain("glass-soft");
    expect(btn.className).not.toContain("w-full"); // block=false
    expect(getByText("L")).toBeDefined();
    expect(getByText("R")).toBeDefined();
  });

  test("ghost variant", () => {
    const { getByRole } = render(<PillButton variant="ghost">G</PillButton>);
    expect(getByRole("button").className).toContain("bg-transparent");
  });
});
