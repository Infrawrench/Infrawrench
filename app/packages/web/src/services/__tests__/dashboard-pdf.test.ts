import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COST_GRAPH_CONFIG,
  FORECAST_COLOR,
  OTHER_SERIES_COLOR,
} from "@infrawrench/client-core";

// The mappers under test are pure; the services they sit beside reach the
// database at import time, so those are stubbed.
vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../cost-query", () => ({ runCostQuery: vi.fn() }));
vi.mock("../unit-cost-query", () => ({ runUnitCostQuery: vi.fn() }));
vi.mock("../budgets", () => ({ getBudgetWithStatus: vi.fn() }));
vi.mock("../cost-reports", () => ({ getCostReport: vi.fn() }));
vi.mock("../custom-graphs", () => ({ renderOrgCustomGraph: vi.fn() }));
vi.mock("../../plugins/loader", () => ({ getPlugin: vi.fn() }));
vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  getOrgCurrencySettings: vi.fn(),
}));

const { costResponseBlocks, customChartBlocks } = await import("../dashboard-pdf");

describe("costResponseBlocks", () => {
  const config = { ...DEFAULT_COST_GRAPH_CONFIG, comparePreviousPeriod: true };

  it("renders a count card as a quarterly table with plain numbers", () => {
    const { blocks, total } = costResponseBlocks(
      {
        ...DEFAULT_COST_GRAPH_CONFIG,
        chartType: "table",
        binning: "quarterly",
        groupBy: "service",
        measure: "count",
      },
      {
        series: [
          {
            key: "",
            label: "Service count",
            currency: "",
            points: [
              { bucket: "2026-04-01", amount: 12 },
              { bucket: "2026-07-01", amount: 14 },
            ],
          },
        ],
        currencies: [""],
        totals: { "": 17 },
        measure: "count",
      },
    );
    expect(blocks[0]).toMatchObject({
      kind: "table",
      columns: ["Period", "Service count", "Total"],
      rows: [
        ["Q2 2026", "12", "12"],
        ["Q3 2026", "14", "14"],
      ],
    });
    expect(blocks[1]).toMatchObject({ kind: "table", columns: ["Group", "Count"] });
    // The distinct total, never 12 + 14, and no currency sign.
    expect(total).toBe("17");
  });

  it("charts the series, overlays the forecast, and tabulates totals with the change", () => {
    const { blocks, total, totalChange } = costResponseBlocks(config, {
      series: [
        {
          key: "aws",
          label: "AWS",
          currency: "USD",
          points: [
            { bucket: "2026-09-01", amount: 10 },
            { bucket: "2026-09-02", amount: 20 },
          ],
        },
        {
          key: "__other__",
          label: "",
          currency: "USD",
          points: [{ bucket: "2026-09-01", amount: 5 }],
        },
      ],
      comparison: [
        { key: "aws", label: "AWS", currency: "USD", points: [{ bucket: "x", amount: 15 }] },
      ],
      forecast: [{ bucket: "2026-09-03", amount: 25 }],
      currencies: ["USD"],
      totals: { USD: 35 },
      previousTotals: { USD: 28 },
    });

    const chart = blocks[0];
    expect(chart?.kind).toBe("chart");
    if (chart?.kind !== "chart") throw new Error("expected a chart");
    expect(chart.categories).toEqual(["Sep 1", "Sep 2", "Sep 3"]);
    expect(chart.series.map((s) => s.label)).toEqual(["AWS", "Other", "Forecast"]);
    expect(chart.series[0]?.values).toEqual([10, 20, null]);
    expect(chart.series[1]?.color).toBe(OTHER_SERIES_COLOR);
    expect(chart.series[2]).toMatchObject({ color: FORECAST_COLOR, dashed: true, overlay: true });

    const table = blocks[1];
    if (table?.kind !== "table") throw new Error("expected a table");
    expect(table.columns).toEqual(["Group", "Spend", "Previous period", "Change"]);
    expect(table.rows[0]).toEqual(["AWS", "$30.00", "$15.00", "+100.0%"]);
    expect(table.rows.at(-1)).toEqual(["Total", "$35.00", "$28.00", "+25.0%"]);
    expect(total).toBe("$35.00");
    expect(totalChange).toBe("+25.0%");
  });

  it("draws a pie for a pie config and notes conversion and mixed currencies", () => {
    const { blocks } = costResponseBlocks(
      { ...DEFAULT_COST_GRAPH_CONFIG, chartType: "pie" },
      {
        series: [
          { key: "a", label: "A", currency: "EUR", points: [{ bucket: "d", amount: 3 }] },
          { key: "b", label: "B", currency: "USD", points: [{ bucket: "d", amount: 1 }] },
        ],
        currencies: ["EUR", "USD"],
        totals: { EUR: 3, USD: 1 },
        conversion: {
          displayCurrency: "EUR",
          converted: [
            {
              currency: "USD",
              rates: [{ effectiveFrom: "2026-10-02", rate: 0.89, source: "ecb" }],
            },
          ],
          unconverted: [],
        },
      },
    );
    expect(blocks[0]).toMatchObject({ kind: "pie", slices: [{ label: "A", value: 3 }] });
    const notes = blocks
      .filter((b) => b.kind === "text")
      .map((b) => (b.kind === "text" ? b.text : ""));
    // The note names the rate source and its date, so a printed figure can be checked.
    expect(
      notes.some((n) => n.includes("USD converted to EUR at ECB reference rates (2026-10-02)")),
    ).toBe(true);
    expect(notes.some((n) => n.includes("Charted in EUR"))).toBe(true);
  });
});

describe("customChartBlocks", () => {
  it("maps a KPI stat with its unit and caption", () => {
    expect(
      customChartBlocks({ type: "stat", value: 1234, currency: "USD", caption: "+3%" }),
    ).toEqual([{ kind: "stats", items: [{ label: "Value", value: "$1,234", caption: "+3%" }] }]);
  });

  it("maps a table and right-aligns numeric columns", () => {
    const [block] = customChartBlocks({
      type: "table",
      columns: ["Service", "Cost"],
      rows: [
        ["EC2", 12],
        ["S3", null],
      ],
    });
    expect(block).toEqual({
      kind: "table",
      columns: ["Service", "Cost"],
      rows: [
        ["EC2", "12"],
        ["S3", ""],
      ],
      align: ["left", "right"],
    });
  });

  it("sorts date categories and keeps gaps as null", () => {
    const [block] = customChartBlocks({
      type: "line",
      series: [
        {
          key: "p95",
          points: [
            { x: "2026-09-02", y: 5 },
            { x: "2026-09-01", y: null },
          ],
        },
      ],
      yAxis: { unit: "ms" },
    });
    expect(block).toMatchObject({
      kind: "chart",
      categories: ["Sep 1", "Sep 2"],
      series: [{ label: "p95", values: [null, 5] }],
      format: { unit: "ms" },
    });
  });
});
