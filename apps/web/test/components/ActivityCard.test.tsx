import { test, expect, describe } from "bun:test";
import { render } from "@testing-library/react";
import ActivityCard from "../../src/components/ActivityCard";
import type { ActivityItem } from "../../src/data/fixtures";

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: "x",
    kind: "premium",
    title: "Item",
    subtitle: "subtitle",
    amountUsd: 10,
    timeAgo: "1h ago",
    day: "Today",
    ...over,
  };
}

describe("ActivityCard", () => {
  test("rescue → prominent dark card with +amount", () => {
    const { getByText, container } = render(
      <ActivityCard item={item({ kind: "rescue", title: "Position rescued", amountUsd: 312 })} />,
    );
    expect(getByText("Position rescued")).toBeDefined();
    expect(getByText("+$312")).toBeDefined();
    expect(container.querySelector(".glass-deep")).not.toBeNull();
  });

  test("premium → quiet light card with −amount", () => {
    const { getByText, container } = render(
      <ActivityCard item={item({ kind: "premium", title: "Protection premium", amountUsd: 0.02 })} />,
    );
    expect(getByText("Protection premium")).toBeDefined();
    expect(getByText("−$0.02")).toBeDefined();
    expect(container.querySelector(".glass-soft")).not.toBeNull();
  });

  test("swap → light card with unsigned amount", () => {
    const { getByText } = render(
      <ActivityCard item={item({ kind: "swap", title: "Collateral rebalanced", amountUsd: 420 })} />,
    );
    expect(getByText("Collateral rebalanced")).toBeDefined();
    expect(getByText("$420")).toBeDefined();
  });
});
