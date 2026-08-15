import { describe, it, expect, beforeAll, vi } from "vitest";
import { render } from "@testing-library/react";
import { SparklineChart } from "../../components/charts/SparklineChart.js";
import { MetricChart } from "../../components/charts/MetricChart.js";
import type { MetricChartNode } from "@infrawrench/plugin-base";

// recharts' ResponsiveContainer relies on element dimensions that jsdom
// reports as 0. Stub getBoundingClientRect so the charts actually render.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 400,
    height: 200,
    top: 0,
    left: 0,
    bottom: 200,
    right: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  // ResizeObserver isn't implemented in jsdom.
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

describe("SparklineChart", () => {
  it("returns null with fewer than two points", () => {
    const { container } = render(<SparklineChart points={[{ timestamp: 1, value: 1 }]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a container with two or more points", () => {
    const { container } = render(
      <SparklineChart
        points={[
          { timestamp: 2, value: 5 },
          { timestamp: 1, value: 3 },
          { timestamp: 3, value: 9 },
        ]}
        color="#ff0000"
        width={120}
        height={40}
      />,
    );
    expect(container.firstChild).not.toBeNull();
    expect((container.firstChild as HTMLElement).style.width).toBe("120px");
  });
});

describe("MetricChart", () => {
  it("returns null when there are no series", () => {
    const node = { kind: "metric-chart", series: [] } as unknown as MetricChartNode;
    const { container } = render(<MetricChart node={node} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a title and time range label", () => {
    const node = {
      kind: "metric-chart",
      title: "CPU",
      timeRangeLabel: "Last hour",
      series: [
        {
          label: "cpu",
          unit: "%",
          points: [
            { timestamp: 1000, value: 10 },
            { timestamp: 2000, value: 20 },
          ],
        },
      ],
    } as unknown as MetricChartNode;
    const { getByText } = render(<MetricChart node={node} />);
    expect(getByText("CPU")).toBeInTheDocument();
    expect(getByText("Last hour")).toBeInTheDocument();
  });

  it("merges multiple series by timestamp without crashing", () => {
    const node = {
      kind: "metric-chart",
      series: [
        { label: "a", points: [{ timestamp: 1, value: 1 }] },
        { label: "b", points: [{ timestamp: 1, value: 2 }] },
      ],
    } as unknown as MetricChartNode;
    const { container } = render(<MetricChart node={node} />);
    expect(container.querySelector(".h-64")).toBeTruthy();
  });

  it("humanizes a byte-valued series instead of printing raw byte counts", () => {
    // Regression test for #112: a droplet memory series topping out around
    // 4 GiB rendered Y-axis ticks like "4294967296bytes", clipped by the
    // 50px gutter.
    const node = {
      kind: "metric-chart",
      title: "Memory",
      series: [
        {
          label: "memory_available",
          unit: "bytes",
          points: [
            { timestamp: 1000, value: 1024 ** 3 },
            { timestamp: 2000, value: 4 * 1024 ** 3 },
          ],
        },
      ],
    } as unknown as MetricChartNode;
    const { container, getByRole } = render(<MetricChart node={node} />);
    expect(container.textContent).not.toMatch(/\d{6,}bytes/);
    expect(container.textContent).toMatch(/GiB/);
    expect(getByRole("img").getAttribute("aria-label")).toMatch(/4\.00 GiB/);
  });
});
