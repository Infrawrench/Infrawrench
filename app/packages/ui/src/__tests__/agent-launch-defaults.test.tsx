/**
 * Regression guard for issue #123 — "manifest editor renders YAML without
 * syntax highlighting".
 *
 * The editors were never the problem. Both resource-detail hosts clear the
 * agent SSH launch defaults from an effect that lists `gt` (from `useGT()`) in
 * its dependency array, and `gt` is not referentially stable, so the effect
 * re-runs on every render. Writing a fresh `{}` there made the write a real
 * state change every time, and the page re-rendered forever. A page that never
 * stops rendering never goes idle, and Monaco tokenises its viewport from
 * `requestIdleCallback` — so every editor on the page stayed at the default
 * foreground colour (`mtk1`) even though the model, the tokenizer and the
 * theme were all correct.
 *
 * The fix is a shared frozen constant: `setState` with an `Object.is`-equal
 * value is a bail-out, so the clear is idempotent no matter how unstable the
 * effect's dependencies are. These tests pin that property, and demonstrate
 * that an inline `{}` in the same shape really does run away.
 */
import { render } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it } from "vitest";

import { NO_AGENT_LAUNCH_DEFAULTS, type AgentLaunchDefaults } from "../agents/types.js";

/**
 * Stand-in for `useGT()`: a hook whose product is a new value on every render.
 * Anything in a dependency array that behaves like this turns an unconditional
 * `setState` inside the effect into an infinite loop.
 */
function useUnstableDependency(): () => void {
  return () => {};
}

/**
 * The shape of both hosts' agent-launch reset branch, reduced to the parts
 * that decide whether it terminates.
 *
 * React does not abort a passive-effect update loop — it logs "Maximum update
 * depth exceeded" and keeps going, which is exactly why the real page spun
 * forever. So the runaway case has to be bounded here or the test would hang;
 * `RENDER_LIMIT` renders is the failure signal.
 */
const RENDER_LIMIT = 50;

function ResetHost({
  clear,
  onRender,
}: {
  clear: () => AgentLaunchDefaults;
  onRender: (count: number) => void;
}) {
  const renders = useRef(0);
  renders.current += 1;
  onRender(renders.current);
  if (renders.current > RENDER_LIMIT) {
    throw new Error(`render loop: still re-rendering after ${RENDER_LIMIT} renders`);
  }

  const unstable = useUnstableDependency();
  const [defaults, setDefaults] = useState<AgentLaunchDefaults>(NO_AGENT_LAUNCH_DEFAULTS);

  useEffect(() => {
    setDefaults(clear());
  }, [clear, unstable]);

  return <span data-testid="keys">{Object.keys(defaults).length}</span>;
}

describe("NO_AGENT_LAUNCH_DEFAULTS", () => {
  it("is an empty, frozen object", () => {
    expect(NO_AGENT_LAUNCH_DEFAULTS).toEqual({});
    expect(Object.isFrozen(NO_AGENT_LAUNCH_DEFAULTS)).toBe(true);
  });

  it("is the same reference every time, so clearing twice is a no-op", () => {
    const first: AgentLaunchDefaults = NO_AGENT_LAUNCH_DEFAULTS;
    const second: AgentLaunchDefaults = NO_AGENT_LAUNCH_DEFAULTS;
    expect(Object.is(first, second)).toBe(true);
  });

  it("settles an effect that re-runs on every render", () => {
    let last = 0;
    const { getByTestId } = render(
      <ResetHost clear={() => NO_AGENT_LAUNCH_DEFAULTS} onRender={(n) => (last = n)} />,
    );
    expect(getByTestId("keys").textContent).toBe("0");
    // React may commit once more before it notices the bail-out; what matters
    // is that it stops. The loop this replaces reached React's 50-update cap
    // and then restarted, forever.
    expect(last).toBeLessThanOrEqual(3);
  });

  it("would not settle if the reset allocated a new object (the original bug)", () => {
    // Proves the constant is load-bearing rather than decorative: the same
    // component with an inline `{}` never stops re-rendering.
    expect(() => render(<ResetHost clear={() => ({})} onRender={() => {}} />)).toThrowError(
      /render loop/,
    );
  });
});
