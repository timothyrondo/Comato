import { test, expect, describe } from "bun:test";
import { renderHook, render } from "@testing-library/react";
import {
  useCountUp,
  MoneyCount,
  HfCount,
  CountUp,
  staggerContainer,
  fadeRise,
  screenFade,
  EASE_OUT,
  EASE_SOFT,
  hoverLift,
  hoverPop,
  tapPress,
} from "../../src/lib/motion";
import { setReducedMotion } from "../helpers";

describe("useCountUp", () => {
  test("snaps to target under reduced motion", () => {
    const { result } = renderHook(() => useCountUp(1.82));
    expect(result.current).toBe(1.82);
  });

  test("animated path also resolves to target (mocked animate is immediate)", () => {
    setReducedMotion(false);
    const { result } = renderHook(() => useCountUp(42, { duration: 0.5, delay: 0.1 }));
    expect(result.current).toBe(42);
  });
});

describe("count-up wrappers render final formatted values", () => {
  test("MoneyCount — integer", () => {
    const { getByText } = render(<MoneyCount value={12480} />);
    expect(getByText("$12,480")).toBeDefined();
  });
  test("MoneyCount — cents preserved", () => {
    const { getByText } = render(<MoneyCount value={0.02} />);
    expect(getByText("$0.02")).toBeDefined();
  });
  test("HfCount — two decimals", () => {
    const { getByText } = render(<HfCount value={1.8} />);
    expect(getByText("1.80")).toBeDefined();
  });
  test("CountUp — custom formatter", () => {
    const { getByText } = render(
      <CountUp value={3} format={(n) => `${Math.round(n)} rescues`} />,
    );
    expect(getByText("3 rescues")).toBeDefined();
  });
});

describe("variant + token factories", () => {
  test("staggerContainer builds visible transition", () => {
    const v = staggerContainer(0.05, 0.02) as {
      visible: { transition: { staggerChildren: number; delayChildren: number } };
    };
    expect(v.visible.transition.staggerChildren).toBe(0.05);
    expect(v.visible.transition.delayChildren).toBe(0.02);
  });
  test("defaults", () => {
    const v = staggerContainer() as {
      visible: { transition: { staggerChildren: number } };
    };
    expect(v.visible.transition.staggerChildren).toBe(0.07);
  });
  test("static variants + easing + interaction presets are defined", () => {
    expect(fadeRise.hidden).toEqual({ opacity: 0, y: 14 });
    expect(screenFade.initial).toEqual({ opacity: 0 });
    expect(EASE_OUT).toHaveLength(4);
    expect(EASE_SOFT).toHaveLength(4);
    expect(hoverLift.y).toBe(-3);
    expect(hoverPop.scale).toBe(1.02);
    expect(tapPress.scale).toBe(0.97);
  });
});
