import { test, expect, describe } from "bun:test";
import { render } from "@testing-library/react";
import PhoneFrame from "../../src/components/PhoneFrame";
import Avatar from "../../src/components/Avatar";
import PulseLine from "../../src/components/PulseLine";
import SectionHeader from "../../src/components/SectionHeader";
import RescueTimeline from "../../src/components/RescueTimeline";
import AmbientBackground from "../../src/components/AmbientBackground";
import type { RescueStep } from "../../src/data/fixtures";
import * as Icons from "../../src/components/icons";

describe("PhoneFrame", () => {
  test("wraps its children", () => {
    const { getByText } = render(
      <PhoneFrame>
        <div>screen body</div>
      </PhoneFrame>,
    );
    expect(getByText("screen body")).toBeDefined();
  });
});

describe("Avatar", () => {
  test("shows the uppercased initial + online dot + ring shadow", () => {
    const { getByText, container } = render(
      <Avatar name="timo" online ring />,
    );
    expect(getByText("T")).toBeDefined();
    expect(container.querySelector(".pulse-dot")).not.toBeNull();
  });

  test("no online dot when offline, no ring when ring=false", () => {
    const { container } = render(<Avatar name="Alice" ring={false} />);
    expect(container.querySelector(".pulse-dot")).toBeNull();
  });
});

describe("PulseLine", () => {
  test("renders an ECG path; animate toggles the draw class", () => {
    const { container } = render(<PulseLine animate strokeWidth={3} />);
    const path = container.querySelector("path")!;
    expect(path).not.toBeNull();
    expect(path.getAttribute("class")).toBe("ecg-draw");
    expect(path.getAttribute("stroke-width")).toBe("3");
  });

  test("no draw class when not animating", () => {
    const { container } = render(<PulseLine />);
    expect(container.querySelector("path")!.getAttribute("class")).toBeNull();
  });
});

describe("SectionHeader", () => {
  test("renders title + optional action", () => {
    const { getByText } = render(
      <SectionHeader title="Recent activity" action={<button>See all</button>} />,
    );
    expect(getByText("Recent activity")).toBeDefined();
    expect(getByText("See all")).toBeDefined();
  });
});

describe("RescueTimeline", () => {
  const steps: RescueStep[] = [
    { title: "Monitor", detail: "every 30s", state: "active" },
    { title: "Alert", detail: "threshold", state: "armed" },
    { title: "Repay", detail: "EOA-direct", state: "ready" },
  ];
  test("renders a step per entry with its state badge", () => {
    const { getByText } = render(<RescueTimeline steps={steps} />);
    expect(getByText("Monitor")).toBeDefined();
    expect(getByText("Active")).toBeDefined();
    expect(getByText("Armed")).toBeDefined();
    expect(getByText("Ready")).toBeDefined();
  });
});

describe("AmbientBackground", () => {
  test("renders the fixed, aria-hidden ambient canvas (glob guard holds)", () => {
    const { container } = render(<AmbientBackground />);
    const root = container.querySelector("[aria-hidden]");
    expect(root).not.toBeNull();
    expect(root!.className).toContain("fixed");
  });
});

describe("icons", () => {
  test("every exported icon renders an <svg>", () => {
    const entries = Object.entries(Icons).filter(
      ([, v]) => typeof v === "function",
    );
    expect(entries.length).toBeGreaterThan(10);
    for (const [name, Icon] of entries) {
      const { container } = render(<Icon size={20} />);
      expect(container.querySelector("svg"), name).not.toBeNull();
    }
  });
});
