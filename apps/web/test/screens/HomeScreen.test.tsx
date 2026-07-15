import { test, expect, describe } from "bun:test";
import { fireEvent } from "@testing-library/react";
import HomeScreen from "../../src/screens/HomeScreen";
import { renderWithData } from "../helpers";
import type { Screen } from "../../src/types";

describe("HomeScreen (mock data, Demo badge)", () => {
  test("greets the user and shows the protected hero + key stats", () => {
    const { getByText } = renderWithData(<HomeScreen onNavigate={() => {}} />);
    expect(getByText("Hi, Timo")).toBeDefined();
    expect(getByText("Protected")).toBeDefined();
    // HF count-up snaps to the mock value
    expect(getByText("1.82")).toBeDefined();
    // absent live env → Demo badge
    expect(getByText("Demo")).toBeDefined();
    // premium + collateral tiles
    expect(getByText("$0.02")).toBeDefined();
    expect(getByText("$12,480")).toBeDefined();
  });

  test("recent-activity teaser shows the newest rescue", () => {
    const { getAllByText } = renderWithData(<HomeScreen onNavigate={() => {}} />);
    expect(getAllByText("Position rescued").length).toBeGreaterThanOrEqual(1);
  });

  test("Protect Position → navigates to position; See all → activity", () => {
    const seen: Screen[] = [];
    const { getByText } = renderWithData(
      <HomeScreen onNavigate={(s) => seen.push(s)} />,
    );
    fireEvent.click(getByText("Protect Position"));
    fireEvent.click(getByText("See all"));
    expect(seen).toEqual(["position", "activity"]);
  });
});
