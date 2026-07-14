import { test, expect } from "bun:test";
import { render } from "@testing-library/react";
import { motion, useReducedMotion, MotionConfig } from "framer-motion";

test("happy-dom + RTL renders a trivial element", () => {
  const { getByText } = render(<div>harness ok</div>);
  expect(getByText("harness ok")).toBeDefined();
});

test("framer-motion is mocked: motion passes through, reduced-motion is true", () => {
  const { getByTestId } = render(
    <MotionConfig reducedMotion="user">
      <motion.div initial={{ opacity: 0 }} whileHover={{ y: -3 }} data-testid="m">
        content
      </motion.div>
    </MotionConfig>,
  );
  const el = getByTestId("m");
  expect(el.textContent).toBe("content");
  // motion-only props must not leak onto the DOM node.
  expect(el.getAttribute("whileHover")).toBeNull();
  expect(useReducedMotion()).toBe(true);
});
