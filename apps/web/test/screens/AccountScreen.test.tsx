import { test, expect, describe } from "bun:test";
import { fireEvent } from "@testing-library/react";
import AccountScreen from "../../src/screens/AccountScreen";
import { renderWithData } from "../helpers";

describe("AccountScreen", () => {
  test("renders the profile, wallet and settings rows", () => {
    const { getByText } = renderWithData(<AccountScreen />);
    expect(getByText("Account")).toBeDefined();
    expect(getByText("Timo")).toBeDefined();
    expect(getByText("@timothyrondo")).toBeDefined();
    // wallet chip
    expect(getByText("0x71C2…9a2E")).toBeDefined();
    // settings rows
    expect(getByText("Protection")).toBeDefined();
    expect(getByText("Active")).toBeDefined();
    expect(getByText("Security & vouchers")).toBeDefined();
    expect(getByText("EIP-3009")).toBeDefined();
    expect(getByText("Comato · anti-liquidation insurance on Celo")).toBeDefined();
  });

  test("settings rows are interactive (no crash on click)", () => {
    const { getByText } = renderWithData(<AccountScreen />);
    fireEvent.click(getByText("Preferences"));
    expect(getByText("Preferences")).toBeDefined();
  });
});
