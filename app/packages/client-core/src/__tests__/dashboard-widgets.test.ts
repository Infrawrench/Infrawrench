import { describe, expect, it } from "vitest";
import {
  DASHBOARD_GRID_LIMITS,
  DASHBOARD_WIDGET_KINDS,
  clampCardSize,
  dashboardGridColumns,
  defaultKpiUpIsGood,
  defaultWidgetSize,
  formatDashboardKpiChange,
  formatDashboardKpiChangePercent,
  formatDashboardKpiValue,
  inclusiveDayCount,
  kpiAggregationApplies,
  kpiChange,
  kpiChangeTone,
  kpiSourceUsesDateRange,
  kpiUpIsGood,
  kpiWidgetConfigProblem,
  markdownToPlainLines,
  previousEqualWindow,
  resizeCardByKey,
  snapCardResize,
  type KpiWidgetConfig,
} from "../index";

const report = (
  measure: "cost" | "usage" | "count" | "unit_cost" | "business_metric",
  aggregation: "sum" | "daily_average" = "sum",
): KpiWidgetConfig => ({
  version: 1,
  source: { kind: "cost_report", reportId: "r1", measure, aggregation },
  comparePreviousPeriod: true,
});

describe("widget kinds", () => {
  it("includes the KPI and text cards", () => {
    expect(DASHBOARD_WIDGET_KINDS).toContain("kpi");
    expect(DASHBOARD_WIDGET_KINDS).toContain("text");
  });
});

describe("KPI direction", () => {
  it("reads rising spend as bad and rising savings as good", () => {
    expect(defaultKpiUpIsGood(report("cost").source)).toBe(false);
    expect(defaultKpiUpIsGood(report("unit_cost").source)).toBe(false);
    expect(defaultKpiUpIsGood(report("business_metric").source)).toBe(true);
    expect(defaultKpiUpIsGood({ kind: "budget", budgetId: "b", measure: "actual" })).toBe(false);
    expect(defaultKpiUpIsGood({ kind: "budget", budgetId: "b", measure: "remaining" })).toBe(true);
    expect(defaultKpiUpIsGood({ kind: "commitments", measure: "coverage" })).toBe(true);
    expect(defaultKpiUpIsGood({ kind: "realized_savings" })).toBe(true);
  });

  it("lets the card override the default", () => {
    expect(kpiUpIsGood({ ...report("cost"), upIsGood: true })).toBe(true);
    expect(kpiUpIsGood(report("cost"))).toBe(false);
  });

  it("colours the badge by direction and preference", () => {
    expect(kpiChangeTone({ change: 10, upIsGood: false })).toBe("bad");
    expect(kpiChangeTone({ change: -10, upIsGood: false })).toBe("good");
    expect(kpiChangeTone({ change: 10, upIsGood: true })).toBe("good");
    expect(kpiChangeTone({ change: 0, upIsGood: true })).toBe("neutral");
    expect(kpiChangeTone({ change: null, upIsGood: true })).toBe("neutral");
  });
});

describe("KPI config rules", () => {
  it("allows a daily average only for additive measures", () => {
    expect(kpiAggregationApplies(report("cost").source)).toBe(true);
    expect(kpiAggregationApplies(report("count").source)).toBe(false);
    expect(kpiAggregationApplies(report("unit_cost").source)).toBe(false);
    expect(kpiWidgetConfigProblem(report("count", "daily_average"))).toMatch(/daily average/);
    expect(kpiWidgetConfigProblem(report("usage", "daily_average"))).toBeNull();
  });

  it("refuses a date range where the source has its own window", () => {
    const budget: KpiWidgetConfig = {
      version: 1,
      source: { kind: "budget", budgetId: "b", measure: "actual" },
      comparePreviousPeriod: true,
      dateRange: { kind: "relative", preset: "30d" },
    };
    expect(kpiSourceUsesDateRange(budget.source)).toBe(false);
    expect(kpiWidgetConfigProblem(budget)).toMatch(/budget's own period/);
    expect(
      kpiWidgetConfigProblem({
        ...budget,
        source: { kind: "commitments", measure: "coverage" },
      }),
    ).toMatch(/trailing window/);
    expect(
      kpiWidgetConfigProblem({ ...budget, source: { kind: "commitments", measure: "savings" } }),
    ).toBeNull();
  });

  it("refuses a usage unit on a non-usage measure", () => {
    const config = report("cost");
    if (config.source.kind === "cost_report") config.source.usageUnit = "GB";
    expect(kpiWidgetConfigProblem(config)).toMatch(/usage unit/);
  });
});

describe("KPI change and formatting", () => {
  it("computes absolute and percent change", () => {
    expect(kpiChange(150, 100)).toEqual({ change: 50, changePercent: 50 });
    expect(kpiChange(150, 0)).toEqual({ change: 150, changePercent: null });
    expect(kpiChange(null, 100)).toEqual({ change: null, changePercent: null });
    expect(kpiChange(150, null)).toEqual({ change: null, changePercent: null });
  });

  it("formats each unit", () => {
    expect(formatDashboardKpiValue({ value: null, unit: "money" })).toBe("-");
    expect(formatDashboardKpiValue({ value: 72.4, unit: "percent" })).toBe("72%");
    expect(formatDashboardKpiValue({ value: 1200, unit: "quantity", perUnit: "GB" })).toMatch(
      /GB$/,
    );
    expect(formatDashboardKpiValue({ value: 3, unit: "count" })).toBe("3");
  });

  it("signs the absolute change and moves percentages in points", () => {
    expect(formatDashboardKpiChange({ change: -4.5, unit: "percent" })).toBe("-4.5 pts");
    expect(formatDashboardKpiChange({ change: 3, unit: "count" })).toBe("+3");
    expect(formatDashboardKpiChange({ change: null, unit: "count" })).toBeNull();
    expect(formatDashboardKpiChangePercent(12.44)).toBe("+12.4%");
    expect(formatDashboardKpiChangePercent(-3)).toBe("-3.0%");
    expect(formatDashboardKpiChangePercent(null)).toBeNull();
  });

  it("finds the same-length window before", () => {
    expect(previousEqualWindow("2026-10-01", "2026-10-10")).toEqual({
      from: "2026-09-21",
      to: "2026-09-30",
    });
    expect(inclusiveDayCount("2026-10-01", "2026-10-10")).toBe(10);
    expect(inclusiveDayCount("2026-10-01", "2026-10-01")).toBe(1);
  });
});

describe("markdownToPlainLines", () => {
  it("keeps the words and the link targets", () => {
    const lines = markdownToPlainLines(
      [
        "# Weekly notes",
        "",
        "Spend is **up** because of the [migration](https://example.com/m).",
        "It should settle.",
        "",
        "- first",
        "1. second",
        "",
        "```",
        "SELECT 1",
        "```",
        "---",
        "> quoted `code`",
      ].join("\n"),
    );
    expect(lines).toEqual([
      "Weekly notes",
      "Spend is up because of the migration (https://example.com/m). It should settle.",
      "- first",
      "1. second",
      "SELECT 1",
      "quoted code",
    ]);
  });
});

describe("grid layout", () => {
  it("gives charts double width and small cards single width", () => {
    expect(defaultWidgetSize("cost_graph")).toEqual({ w: 2, h: 1 });
    expect(defaultWidgetSize("text")).toEqual({ w: 2, h: 1 });
    expect(defaultWidgetSize("kpi")).toEqual({ w: 1, h: 1 });
    expect(defaultWidgetSize("budget")).toEqual({ w: 1, h: 1 });
  });

  it("clamps spans to the stored bounds and to the columns on screen", () => {
    expect(clampCardSize({ w: 0, h: 99 })).toEqual({ w: 1, h: DASHBOARD_GRID_LIMITS.maxHeight });
    expect(clampCardSize({ w: 6, h: 2 }, 3)).toEqual({ w: 3, h: 2 });
    expect(clampCardSize({ w: Number.NaN, h: 1 })).toEqual({ w: 1, h: 1 });
  });

  it("counts auto-fill columns the way CSS lays them out", () => {
    // minmax(220px, 1fr) with a 16px gap: n columns need n*220 + (n-1)*16.
    expect(dashboardGridColumns(220)).toBe(1);
    expect(dashboardGridColumns(455)).toBe(1);
    expect(dashboardGridColumns(456)).toBe(2);
    expect(dashboardGridColumns(1200)).toBe(5);
    expect(dashboardGridColumns(0)).toBe(1);
  });

  it("snaps a drag to the nearest track", () => {
    const grid = { columnWidth: 220, rowHeight: 150, gapPx: 16, columns: 4 };
    expect(snapCardResize({ w: 1, h: 1 }, { x: 130, y: 0 }, grid)).toEqual({ w: 2, h: 1 });
    expect(snapCardResize({ w: 1, h: 1 }, { x: 100, y: 90 }, grid)).toEqual({ w: 1, h: 2 });
    expect(snapCardResize({ w: 2, h: 2 }, { x: -1000, y: -1000 }, grid)).toEqual({ w: 1, h: 1 });
    expect(snapCardResize({ w: 1, h: 1 }, { x: 5000, y: 0 }, grid)).toEqual({ w: 4, h: 1 });
  });

  it("resizes one track per arrow key and ignores other keys", () => {
    expect(resizeCardByKey({ w: 1, h: 1 }, "ArrowRight", 4)).toEqual({ w: 2, h: 1 });
    expect(resizeCardByKey({ w: 4, h: 1 }, "ArrowRight", 4)).toEqual({ w: 4, h: 1 });
    expect(resizeCardByKey({ w: 2, h: 2 }, "ArrowUp")).toEqual({ w: 2, h: 1 });
    expect(resizeCardByKey({ w: 1, h: 1 }, "ArrowLeft")).toEqual({ w: 1, h: 1 });
    expect(resizeCardByKey({ w: 1, h: 1 }, "Enter")).toBeNull();
  });
});
