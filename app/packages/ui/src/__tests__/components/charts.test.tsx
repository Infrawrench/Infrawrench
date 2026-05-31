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
});
