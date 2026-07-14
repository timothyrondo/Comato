import { test, expect, describe } from "bun:test";
import { fireEvent } from "@testing-library/react";
import ActivityScreen from "../../src/screens/ActivityScreen";
import { renderWithData } from "../helpers";

describe("ActivityScreen", () => {
  test("shows the summary + grouped activity by day", () => {
    const { getByText, getAllByText } = renderWithData(<ActivityScreen />);
    expect(getByText("Activity")).toBeDefined();
    expect(getByText("Total saved")).toBeDefined();
    // day group headers from the mock fixture
    expect(getByText("Today")).toBeDefined();
    expect(getByText("Yesterday")).toBeDefined();
    // rescue rows present
    expect(getAllByText("Position rescued").length).toBeGreaterThanOrEqual(1);
  });

  test("filter chips narrow the list (Rescues hides premiums/swaps)", () => {
    const { getByText, queryByText, getAllByText } = renderWithData(
      <ActivityScreen />,
    );
    // 'all' shows premium rows
    expect(getAllByText("Protection premium").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(getByText("Rescues"));
    // premiums filtered out
    expect(queryByText("Protection premium")).toBeNull();
    expect(getAllByText("Position rescued").length).toBeGreaterThanOrEqual(1);
    // switch to premiums & swaps → rescues hidden
    fireEvent.click(getByText("Premiums & swaps"));
    expect(queryByText("Position rescued")).toBeNull();
    expect(getAllByText("Protection premium").length).toBeGreaterThanOrEqual(1);
  });
});
