import { test, expect, describe } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import App from "../src/App";
import { setDesktop } from "./helpers";

/**
 * App wires its own ComatoDataProvider + AmbientBackground and switches layout
 * on the matchMedia breakpoint (mocked via setDesktop). liveConfig is non-null
 * in the harness but the default stub never resolves, so the UI sits on the mock
 * fixtures → the "Demo" badge is shown in both layouts.
 */

describe("App layout switch (matchMedia)", () => {
  test("desktop (≥1024px) → the glass dashboard", () => {
    setDesktop(true);
    const { getByText } = render(<App />);
    expect(getByText("Comato")).toBeDefined(); // sidebar brand (desktop only)
    expect(getByText("Rescue insurance")).toBeDefined();
    expect(getByText("Demo")).toBeDefined();
  });

  test("mobile (<1024px) → the phone app with a tab bar", () => {
    setDesktop(false);
    const { getByText, getByLabelText } = render(<App />);
    expect(getByText("Hi, Timo")).toBeDefined();
    // tab bar present
    expect(getByLabelText("Home")).toBeDefined();
    expect(getByLabelText("Position")).toBeDefined();
    // Demo badge in the mobile hero stat
    expect(getByText("Demo")).toBeDefined();
  });

  test("mobile: tab bar switches the visible screen", () => {
    setDesktop(false);
    const { getByText, getByLabelText } = render(<App />);
    fireEvent.click(getByLabelText("Account"));
    expect(getByText("@timothyrondo")).toBeDefined();
    fireEvent.click(getByLabelText("Activity"));
    expect(getByText("Your position's protection & rescue history.")).toBeDefined();
  });
});
