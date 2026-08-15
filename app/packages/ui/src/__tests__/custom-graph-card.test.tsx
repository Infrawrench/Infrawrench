import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { CustomGraphCard } from "../custom-graphs/CustomGraphCard.js";
import type {
  CustomGraphRenderResult,
  CustomGraphWidgetConfig,
  CustomGraphsClient,
} from "../custom-graphs/types.js";

const config: CustomGraphWidgetConfig = { version: 1, graphId: "graph-1" };

function renderResult(): CustomGraphRenderResult {
  return {
    ok: true,
    spec: {
      version: 1,
      title: "Spend by service",
      chart: { type: "stat", value: 42, unit: "USD" },
      controls: [],
    },
    error: null,
    logs: [],
    renderedAt: new Date().toISOString(),
    durationMs: 3,
  };
}

function clientWith(render: CustomGraphsClient["render"]): CustomGraphsClient {
  return {
    list: () => Promise.resolve([]),
    get: () => Promise.reject(new Error("not used")),
    render,
  };
}

describe("CustomGraphCard", () => {
  /**
   * Regression test for #122. The card's `run` callback is a dependency of its
   * mount effect, so anything unstable in `run`'s own dependency list turns one
   * card into an unbounded stream of render requests: the response sets state,
   * the re-render rebuilds `run`, the effect re-fires. `gt` from gt-react's
   * `useGT()` was exactly that — a fresh identity every render — which is why
   * the card sat on "refreshing…" forever at ~270 POSTs a second.
   */
  it("renders the graph once per mount, not once per re-render", async () => {
    const renderFn = vi.fn(() => Promise.resolve(renderResult()));
    const client = clientWith(renderFn);

    render(<CustomGraphCard title="Spend" config={config} client={client} />);

    await screen.findByText("Spend by service");
    // Give any runaway effect chain a generous number of macrotask turns to
    // show itself; a single render call must survive all of them.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("refreshing…")).not.toBeInTheDocument();
  });

  it("does not re-render the graph when its parent re-renders", async () => {
    const renderFn = vi.fn(() => Promise.resolve(renderResult()));
    const client = clientWith(renderFn);
    let bump: () => void = () => {};

    function Host() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return (
        <div>
          <span data-testid="renders">{n}</span>
          <CustomGraphCard title="Spend" config={config} client={client} />
        </div>
      );
    }

    render(<Host />);
    await screen.findByText("Spend by service");
    expect(renderFn).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) bump();
    await waitFor(() => expect(screen.getByTestId("renders").textContent).toBe("5"));
    expect(renderFn).toHaveBeenCalledTimes(1);
  });
});
