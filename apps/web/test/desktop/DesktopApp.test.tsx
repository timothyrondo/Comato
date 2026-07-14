import { test, expect, describe } from "bun:test";
import { fireEvent } from "@testing-library/react";
import DesktopApp from "../../src/desktop/DesktopApp";
import { renderWithData } from "../helpers";
import type { Screen } from "../../src/types";

function renderDesktop(screen: Screen, onNavigate: (s: Screen) => void = () => {}) {
  return renderWithData(<DesktopApp screen={screen} onNavigate={onNavigate} />);
}

describe("DesktopApp shell", () => {
  test("sidebar brand + nav render, Demo badge shown (mock mode)", () => {
    const { getByText, getByRole, getAllByText } = renderDesktop("home");
    expect(getByText("Comato")).toBeDefined();
    expect(getByText("Rescue insurance")).toBeDefined();
    // nav buttons (labels also appear as panel titles → target the button role)
    expect(getByRole("button", { name: "Overview" })).toBeDefined();
    expect(getByRole("button", { name: "Positions" })).toBeDefined();
    // live/demo badge
    expect(getByText("Demo")).toBeDefined();
    // sidebar user identity
    expect(getAllByText("Timo").length).toBeGreaterThanOrEqual(1);
  });

  test("sidebar navigation calls onNavigate with the screen id", () => {
    const seen: Screen[] = [];
    const { getByRole } = renderDesktop("home", (s) => seen.push(s));
    fireEvent.click(getByRole("button", { name: "Positions" }));
    fireEvent.click(getByRole("button", { name: "Activity" }));
    fireEvent.click(getByRole("button", { name: "Settings" }));
    expect(seen).toEqual(["position", "activity", "account"]);
  });
});

describe("DesktopApp views", () => {
  test("Overview: hero + HF trace + position row + rails", () => {
    const { getByText, getAllByText } = renderDesktop("home");
    expect(getAllByText("Protected").length).toBeGreaterThanOrEqual(1);
    expect(getByText("Health Factor trace")).toBeDefined();
    expect(getByText("Your position")).toBeDefined();
    // "Protection premium" is both the rail heading and an activity row
    expect(getAllByText("Protection premium").length).toBeGreaterThanOrEqual(1);
    // AlertRail 'All clear' (mock HF 1.82 is safe)
    expect(getByText("All clear")).toBeDefined();
  });

  test("Overview: Protect position button + Open position link navigate", () => {
    const seen: Screen[] = [];
    const { getByText } = renderDesktop("home", (s) => seen.push(s));
    fireEvent.click(getByText("Protect position"));
    fireEvent.click(getByText("Open"));
    expect(seen).toEqual(["position", "position"]);
  });

  test("Positions view: thresholds + rescue plan", () => {
    const { getByText, getAllByText } = renderDesktop("position");
    expect(getByText("Thresholds")).toBeDefined();
    expect(getAllByText("Rescue plan").length).toBeGreaterThanOrEqual(1);
    expect(getByText("Monitor Health Factor")).toBeDefined();
  });

  test("Activity view: totals + filter chips narrow the list", () => {
    const { getByText, queryByText, getAllByText } = renderDesktop("activity");
    expect(getByText("Total saved")).toBeDefined();
    expect(getAllByText("Protection premium").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(getByText("Rescues"));
    expect(queryByText("Protection premium")).toBeNull();
  });

  test("Settings view: profile + rows", () => {
    const { getByText, getAllByText } = renderDesktop("account");
    expect(getAllByText("Timo").length).toBeGreaterThanOrEqual(1);
    expect(getByText("Security & vouchers")).toBeDefined();
    expect(getByText("EIP-3009")).toBeDefined();
  });

  test("top bar refresh + notifications buttons are wired (no crash)", () => {
    const { getByLabelText } = renderDesktop("home");
    fireEvent.click(getByLabelText("Refresh data"));
    fireEvent.click(getByLabelText("Notifications"));
    expect(getByLabelText("Refresh data")).toBeDefined();
  });
});
