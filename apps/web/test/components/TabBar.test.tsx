import { test, expect, describe } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import TabBar from "../../src/components/TabBar";
import type { Screen } from "../../src/types";

describe("TabBar", () => {
  test("renders the four tabs and marks the active one", () => {
    const { getByLabelText } = render(
      <TabBar active="home" onChange={() => {}} />,
    );
    const home = getByLabelText("Home");
    expect(home.getAttribute("aria-current")).toBe("page");
    expect(getByLabelText("Position").getAttribute("aria-current")).toBeNull();
    // all four labels present
    for (const label of ["Home", "Position", "Activity", "Account"]) {
      expect(getByLabelText(label)).toBeDefined();
    }
  });

  test("clicking a tab calls onChange with that screen id", () => {
    const seen: Screen[] = [];
    const { getByLabelText } = render(
      <TabBar active="home" onChange={(s) => seen.push(s)} />,
    );
    fireEvent.click(getByLabelText("Activity"));
    fireEvent.click(getByLabelText("Account"));
    expect(seen).toEqual(["activity", "account"]);
  });
});
