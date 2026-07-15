import { test, expect, describe } from "bun:test";
import { fireEvent } from "@testing-library/react";
import PositionScreen from "../../src/screens/PositionScreen";
import { renderWithData } from "../helpers";
import type { Screen } from "../../src/types";

describe("PositionScreen", () => {
  test("renders the gauge, legend, position stats and rescue plan", () => {
    const { getByText, getAllByText } = renderWithData(
      <PositionScreen onNavigate={() => {}} />,
    );
    expect(getAllByText("Position").length).toBeGreaterThanOrEqual(1);
    // legend zones ("Safe" also appears as the ring status → allow multiple)
    expect(getByText("Critical")).toBeDefined();
    expect(getByText("Caution")).toBeDefined();
    expect(getAllByText("Safe").length).toBeGreaterThanOrEqual(1);
    // stats (mock)
    expect(getByText("$12,480")).toBeDefined();
    expect(getByText("$6,850")).toBeDefined();
    // rescue plan timeline present
    expect(getByText("Rescue plan")).toBeDefined();
    expect(getByText("Monitor Health Factor")).toBeDefined();
    // agent card
    expect(getByText("Comato agent")).toBeDefined();
  });

  test("back button navigates home; refresh button is wired (no crash)", () => {
    const seen: Screen[] = [];
    const { getByLabelText } = renderWithData(
      <PositionScreen onNavigate={(s) => seen.push(s)} />,
    );
    fireEvent.click(getByLabelText("Refresh data")); // triggers context.refresh()
    fireEvent.click(getByLabelText("Back to home"));
    expect(seen).toEqual(["home"]);
  });
});
