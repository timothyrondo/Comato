import { test, expect, describe } from "bun:test";
import { render } from "@testing-library/react";
import StatTile from "../../src/components/StatTile";

describe("StatTile", () => {
  test("light tone (default) → glass-soft surface, label + value + sub", () => {
    const { getByText, container } = render(
      <StatTile label="Premium / hr" value="$0,02" sub="Gasless via x402" />,
    );
    expect(getByText("Premium / hr")).toBeDefined();
    expect(getByText("$0,02")).toBeDefined();
    expect(getByText("Gasless via x402")).toBeDefined();
    expect(container.querySelector(".glass-soft")).not.toBeNull();
  });

  test("dark tone → glass-deep surface", () => {
    const { container } = render(
      <StatTile tone="dark" label="Health Factor" value="1.82" />,
    );
    expect(container.querySelector(".glass-deep")).not.toBeNull();
  });

  test("accent tone → glass-accent surface", () => {
    const { container } = render(
      <StatTile tone="accent" label="Rescue at" value="1.20" />,
    );
    expect(container.querySelector(".glass-accent")).not.toBeNull();
  });

  test("size lg → large value type + badge slot renders", () => {
    const { container, getByText } = render(
      <StatTile
        size="lg"
        label="Total saved"
        value="$1.284"
        badge={<span>Live</span>}
      />,
    );
    expect(container.querySelector(".text-4xl")).not.toBeNull();
    expect(getByText("Live")).toBeDefined();
  });

  test("md size (default) → text-2xl", () => {
    const { container } = render(<StatTile label="x" value="1" />);
    expect(container.querySelector(".text-2xl")).not.toBeNull();
  });
});
