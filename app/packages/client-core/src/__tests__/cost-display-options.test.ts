import { describe, expect, it } from "vitest";
import {
  binForecast,
  costBucketStart,
  costDisplayProblem,
  costQueryForConfig,
  costSeriesTotal,
  effectiveCostBinning,
  formatBucketLabel,
  formatCostMeasureValue,
  hourlyCostBinningAvailable,
  isCostTotalsChart,
  DEFAULT_COST_GRAPH_CONFIG,
  type CostAccountStatus,
  type CostGraphConfig,
} from "../costs";
import { applyCostReportRunOverrides } from "../cost-reports";

const base: CostGraphConfig = { ...DEFAULT_COST_GRAPH_CONFIG };

describe("quarterly bins", () => {
  it("bucket a day onto the first day of its quarter", () => {
    expect(costBucketStart("2026-01-01", "quarterly")).toBe("2026-01-01");
    expect(costBucketStart("2026-03-31", "quarterly")).toBe("2026-01-01");
    expect(costBucketStart("2026-05-15", "quarterly")).toBe("2026-04-01");
    expect(costBucketStart("2026-09-30", "quarterly")).toBe("2026-07-01");
    expect(costBucketStart("2026-12-31", "quarterly")).toBe("2026-10-01");
  });

  it("label as Qn YYYY", () => {
    expect(formatBucketLabel("2026-07-01", "quarterly")).toBe("Q3 2026");
    expect(formatBucketLabel("2026-01-01", "quarterly")).toBe("Q1 2026");
  });

  it("label an hourly bucket with its time", () => {
    expect(formatBucketLabel("2026-07-05T14:00", "hourly")).toMatch(/14:00$/);
  });
});

describe("effectiveCostBinning", () => {
  it("folds the legacy cumulative binning into daily + the toggle", () => {
    expect(effectiveCostBinning({ binning: "cumulative" })).toEqual({
      bin: "daily",
      cumulative: true,
    });
  });

  it("reads the toggle at any bin size", () => {
    expect(effectiveCostBinning({ binning: "quarterly", cumulative: true })).toEqual({
      bin: "quarterly",
      cumulative: true,
    });
    expect(effectiveCostBinning({ binning: "weekly" })).toEqual({
      bin: "weekly",
      cumulative: false,
    });
  });
});

describe("binForecast with the cumulative toggle", () => {
  it("bins first, then runs the sum from the last actual total", () => {
    const daily = [
      { bucket: "2026-06-30", amount: 1 },
      { bucket: "2026-07-01", amount: 2 },
      { bucket: "2026-07-02", amount: 3 },
    ];
    expect(binForecast(daily, "quarterly", 10, true)).toEqual([
      { bucket: "2026-04-01", amount: 11 },
      { bucket: "2026-07-01", amount: 16 },
    ]);
  });

  it("keeps the legacy cumulative behaviour by default", () => {
    expect(binForecast([{ bucket: "2026-07-01", amount: 2 }], "cumulative", 5)).toEqual([
      { bucket: "2026-07-01", amount: 7 },
    ]);
  });
});

describe("costDisplayProblem", () => {
  it("accepts every config written before measures existed", () => {
    expect(costDisplayProblem({ ...base, forecast: true })).toBeNull();
  });

  it("requires a unit for usage", () => {
    expect(costDisplayProblem({ ...base, measure: "usage" })).toMatch(/usage unit/i);
    expect(costDisplayProblem({ ...base, measure: "usage", usageUnit: "Hrs" })).toBeNull();
  });

  it("refuses a unit on any other measure", () => {
    expect(costDisplayProblem({ ...base, usageUnit: "Hrs" })).toMatch(/usage measure/);
    expect(costDisplayProblem({ ...base, measure: "count", usageUnit: "Hrs" })).toMatch(
      /usage measure/,
    );
  });

  it("requires a group-by for count and refuses cumulative counts", () => {
    expect(costDisplayProblem({ ...base, measure: "count", groupBy: "none" })).toMatch(/group-by/);
    expect(costDisplayProblem({ ...base, measure: "count", cumulative: true })).toMatch(
      /cumulative/,
    );
    expect(costDisplayProblem({ ...base, measure: "count", binning: "cumulative" })).toMatch(
      /cumulative/,
    );
    expect(costDisplayProblem({ ...base, measure: "count" })).toBeNull();
  });

  it("refuses money-only overlays on usage and count", () => {
    const usage = { ...base, measure: "usage" as const, usageUnit: "Hrs" };
    expect(costDisplayProblem({ ...usage, forecast: true })).toMatch(/Forecast/);
    expect(costDisplayProblem({ ...usage, scenarioModelId: "s" })).toMatch(/Scenario/);
    expect(costDisplayProblem({ ...usage, adjusted: true })).toMatch(/Billing rules/);
    expect(costDisplayProblem({ ...usage, unitCostMetricId: "m" })).toMatch(/Unit costs/);
  });

  it("refuses the cumulative toggle on a unit-cost chart but keeps the legacy bin", () => {
    expect(costDisplayProblem({ ...base, unitCostMetricId: "m", cumulative: true })).toMatch(
      /ratio/,
    );
    expect(
      costDisplayProblem({ ...base, unitCostMetricId: "m", binning: "cumulative" }),
    ).toBeNull();
  });
});

describe("costQueryForConfig display options", () => {
  const today = new Date("2026-07-15T12:00:00Z");

  it("sends nothing new for a config that never set them", () => {
    const q = costQueryForConfig(base, today);
    expect(q).not.toHaveProperty("measure");
    expect(q).not.toHaveProperty("usageUnit");
    expect(q).not.toHaveProperty("cumulative");
  });

  it("omits measure: cost and a stray unit", () => {
    const q = costQueryForConfig({ ...base, measure: "cost", usageUnit: "Hrs" }, today);
    expect(q).not.toHaveProperty("measure");
    expect(q).not.toHaveProperty("usageUnit");
  });

  it("carries usage, its unit and the toggle", () => {
    const q = costQueryForConfig(
      { ...base, measure: "usage", usageUnit: "GB-Mo", cumulative: true, binning: "quarterly" },
      today,
    );
    expect(q).toMatchObject({
      measure: "usage",
      usageUnit: "GB-Mo",
      cumulative: true,
      binning: "quarterly",
    });
  });
});

describe("formatting and totals", () => {
  it("formats each measure", () => {
    expect(formatCostMeasureValue(12, { measure: "count" })).toBe("12");
    expect(formatCostMeasureValue(1500, { measure: "usage", usageUnit: "Hrs" })).toMatch(/Hrs$/);
    expect(formatCostMeasureValue(5, { currency: "USD" })).toMatch(/5/);
  });

  it("totals a cumulative series by its last point", () => {
    const points = [
      { bucket: "a", amount: 1 },
      { bucket: "b", amount: 3 },
    ];
    expect(costSeriesTotal(points, true)).toBe(3);
    expect(costSeriesTotal(points, false)).toBe(4);
  });

  it("knows which charts draw totals", () => {
    expect(isCostTotalsChart("pie")).toBe(true);
    expect(isCostTotalsChart("donut")).toBe(true);
    expect(isCostTotalsChart("table")).toBe(false);
  });

  it("offers hourly bins only where some account stores hourly rows", () => {
    const status = { supportsCosts: true } as CostAccountStatus;
    expect(hourlyCostBinningAvailable([{ ...status, granularity: "daily" }])).toBe(false);
    expect(hourlyCostBinningAvailable([{ ...status }])).toBe(false);
    expect(hourlyCostBinningAvailable([{ ...status, granularity: "hourly" }])).toBe(true);
  });
});

describe("applyCostReportRunOverrides", () => {
  const saved: CostGraphConfig = {
    ...base,
    showForecast: true,
    scenarioModelId: "s",
    adjusted: true,
  };

  it("drops money-only overlays when switching to usage or count", () => {
    const next = applyCostReportRunOverrides(saved, { measure: "count" });
    expect(next.measure).toBe("count");
    expect(next.showForecast).toBe(false);
    expect(next.scenarioModelId).toBeUndefined();
    expect(next.adjusted).toBeUndefined();
    expect(costDisplayProblem({ ...next, forecast: next.showForecast })).toBeNull();
  });

  it("changes the bin without touching the saved config", () => {
    const next = applyCostReportRunOverrides(saved, { binning: "quarterly" });
    expect(next.binning).toBe("quarterly");
    expect(saved.binning).toBe("daily");
    expect(next.showForecast).toBe(true);
  });

  it("turns a legacy cumulative report back into daily bins", () => {
    const next = applyCostReportRunOverrides(
      { ...base, binning: "cumulative" },
      { cumulative: false },
    );
    expect(next.binning).toBe("daily");
    expect(effectiveCostBinning(next).cumulative).toBe(false);
  });
});
