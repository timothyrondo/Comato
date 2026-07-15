import { test, expect, describe } from "bun:test";
import { fireEvent } from "@testing-library/react";
import DesktopApp from "../../src/desktop/DesktopApp";
import { renderWithData } from "../helpers";
import type { Screen } from "../../src/types";

function renderDesktop(screen: Screen, onNavigate: (s: Screen) => void = () => {}) {
  return renderWithData(<DesktopApp screen={screen} onNavigate={onNavigate} />);
}

describe("DesktopApp shell", () => {
  test("sidebar brand + nav render (mock mode)", () => {
    const { getByText, getByRole } = renderDesktop("home");
    expect(getByText("Comato")).toBeDefined();
    expect(getByText("Rescue insurance")).toBeDefined();
    // nav buttons (labels also appear as panel titles → target the button role)
    expect(getByRole("button", { name: "Overview" })).toBeDefined();
    expect(getByRole("button", { name: "Positions" })).toBeDefined();
    // sidebar footer status card (the fake user card was removed)
    expect(getByText("Monitored non-stop")).toBeDefined();
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

  test("Overview: Open position link navigates", () => {
    const seen: Screen[] = [];
    const { getByText } = renderDesktop("home", (s) => seen.push(s));
    fireEvent.click(getByText("Open"));
    expect(seen).toEqual(["position"]);
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
    const { getByText } = renderDesktop("account");
    expect(getByText("Comato protection")).toBeDefined();
    expect(getByText("Security & vouchers")).toBeDefined();
    expect(getByText("EIP-3009")).toBeDefined();
  });

  test("top bar: refresh wired, no notification bell, wallet-connect button present", () => {
    const { getByLabelText, queryByLabelText, getByText } = renderDesktop("home");
    fireEvent.click(getByLabelText("Refresh data"));
    expect(getByLabelText("Refresh data")).toBeDefined();
    // notification bell removed
    expect(queryByLabelText("Notifications")).toBeNull();
    // the top-right button is now the primary wallet-connect action
    expect(getByText("Connect wallet")).toBeDefined();
  });
});
