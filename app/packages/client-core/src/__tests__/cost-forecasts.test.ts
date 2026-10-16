import { describe, expect, it } from "vitest";

import {
  COST_FORECAST_LIMITS,
  costForecastComparisonRows,
  costForecastInputError,
  defaultCostForecastId,
  hasForecastBand,
  isCostForecastConfidenceLevel,
  shiftForecastBand,
  shiftForecastTotal,
  sumForecastPoints,
  type CostForecast,
  type CostForecastPoint,
  type CostForecastResult,
  type CostForecastSeries,
} from "../cost-forecasts";
import { businessMetricForecastValuesError } from "../business-metrics";
import { budgetForecastRange } from "../budgets";
import { binForecast, type BudgetWithStatus } from "../costs";

const point = (day: string, expected: number, low: number | null, high: number | null) =>
  ({ day, expected, low, high }) satisfies CostForecastPoint;

describe("costForecastInputError", () => {
  const base = { name: "Plan", scenarioModelIds: ["m1"] };

  it("accepts a named forecast with a model or a driver", () => {
    expect(costForecastInputError(base)).toBeNull();
    expect(
      costForecastInputError({ name: "Driven", scenarioModelIds: [], driverMetricId: "x" }),
    ).toBeNull();
  });

  it("refuses a forecast that is just the automatic one", () => {
    expect(costForecastInputError({ name: "Nothing", scenarioModelIds: [] })).toMatch(
      /scenario model or a driver metric/,
    );
  });

  it("needs a name within bounds", () => {
    expect(costForecastInputError({ ...base, name: "  " })).toMatch(/needs a name/);
    expect(
      costForecastInputError({ ...base, name: "x".repeat(COST_FORECAST_LIMITS.maxNameLength + 1) }),
    ).toMatch(/characters or fewer/);
  });

  it("refuses duplicate, empty and too many models", () => {
    expect(costForecastInputError({ ...base, scenarioModelIds: ["a", "a"] })).toMatch(
      /appear once/,
    );
    expect(costForecastInputError({ ...base, scenarioModelIds: [""] })).toMatch(/needs an id/);
    const many = Array.from(
      { length: COST_FORECAST_LIMITS.maxScenarioModels + 1 },
      (_, i) => `m${i}`,
    );
    expect(costForecastInputError({ ...base, scenarioModelIds: many })).toMatch(/at most/);
  });
});

describe("shiftForecastBand", () => {
  it("moves each day's bounds by exactly the change in its expected value", () => {
    const start = [point("2026-11-01", 100, 80, 120), point("2026-11-02", 110, 85, 135)];
    const shifted = shiftForecastBand(start, new Map([["2026-11-02", 160]]));
    expect(shifted[0]).toEqual(start[0]);
    expect(shifted[1]).toEqual(point("2026-11-02", 160, 135, 185));
  });

  it("clamps at zero and keeps a missing band missing", () => {
    const shifted = shiftForecastBand(
      [point("2026-11-01", 10, 2, 18), point("2026-11-02", 10, null, null)],
      new Map([
        ["2026-11-01", 0],
        ["2026-11-02", 30],
      ]),
    );
    expect(shifted[0]).toEqual(point("2026-11-01", 0, 0, 8));
    expect(shifted[1]).toEqual(point("2026-11-02", 30, null, null));
  });

  it("does not mutate its input", () => {
    const start = [point("2026-11-01", 100, 80, 120)];
    shiftForecastBand(start, new Map([["2026-11-01", 50]]));
    expect(start[0]!.expected).toBe(100);
  });
});

describe("forecast totals", () => {
  it("shifts a total's interval with the scenario delta", () => {
    expect(shiftForecastTotal({ expected: 1000, low: 800, high: 1200 }, 250)).toEqual({
      expected: 1250,
      low: 1050,
      high: 1450,
    });
    expect(shiftForecastTotal({ expected: 100, low: null, high: null }, -500)).toEqual({
      expected: 0,
      low: null,
      high: null,
    });
  });

  it("sums points, and a missing bound makes the summed bound unknown", () => {
    expect(sumForecastPoints([point("a", 1, 0.5, 2), point("b", 2, 1, 3)])).toEqual({
      expected: 3,
      low: 1.5,
      high: 5,
    });
    expect(sumForecastPoints([point("a", 1, 0.5, 2), point("b", 2, null, null)]).low).toBeNull();
    expect(hasForecastBand({ expected: 1, low: null, high: 2 })).toBe(false);
  });
});

describe("comparison and defaults", () => {
  const series = (forecastId: string | null, name: string): CostForecastSeries => ({
    forecastId,
    name,
    isDefault: false,
    points: [],
    total: { expected: 0, low: null, high: null },
    deltaFromBaseline: 0,
    scenarios: [],
    driver: null,
    warnings: [],
  });

  it("puts the automatic forecast first, then every named one", () => {
    const result: CostForecastResult = {
      reportId: "r",
      reportName: "R",
      from: "2026-11-01",
      to: "2026-11-30",
      lastObservedDay: "2026-10-31",
      currency: "USD",
      confidenceLevel: 80,
      baseline: series(null, "Automatic forecast"),
      forecast: series("b", "B"),
      forecasts: [series("a", "A"), series("b", "B")],
    };
    const rows = costForecastComparisonRows(result);
    expect(rows.map((r) => [r.forecastId, r.isBaseline])).toEqual([
      [null, true],
      ["a", false],
      ["b", false],
    ]);
    // Without `all`, only the selected named forecast is compared.
    expect(costForecastComparisonRows({ ...result, forecasts: undefined })).toHaveLength(2);
  });

  it("finds the default forecast", () => {
    const f = (id: string, isDefault: boolean) => ({ id, isDefault }) as CostForecast;
    expect(defaultCostForecastId([f("a", false), f("b", true)])).toBe("b");
    expect(defaultCostForecastId([f("a", false)])).toBeNull();
  });

  it("knows the supported levels", () => {
    expect(isCostForecastConfidenceLevel(90)).toBe(true);
    expect(isCostForecastConfidenceLevel(85)).toBe(false);
  });
});

describe("businessMetricForecastValuesError", () => {
  it("accepts a clean batch", () => {
    expect(
      businessMetricForecastValuesError([
        { date: "2026-11-01", value: 1200 },
        { date: "2026-11-02", value: 0 },
      ]),
    ).toBeNull();
  });

  it("refuses bad days, negative or non-finite values and duplicates", () => {
    expect(businessMetricForecastValuesError([])).toMatch(/at least one/);
    expect(businessMetricForecastValuesError([{ date: "2026-02-30", value: 1 }])).toMatch(
      /not a real day/,
    );
    expect(businessMetricForecastValuesError([{ date: "11/01/2026", value: 1 }])).toMatch(
      /YYYY-MM-DD/,
    );
    expect(businessMetricForecastValuesError([{ date: "2026-11-01", value: -1 }])).toMatch(
      /negative/,
    );
    expect(businessMetricForecastValuesError([{ date: "2026-11-01", value: Infinity }])).toMatch(
      /finite/,
    );
    expect(
      businessMetricForecastValuesError([
        { date: "2026-11-01", value: 1 },
        { date: "2026-11-01", value: 2 },
      ]),
    ).toMatch(/twice/);
  });
});

describe("binForecast with bounds", () => {
  const daily = [
    { bucket: "2026-11-29", amount: 10, low: 8, high: 12 },
    { bucket: "2026-11-30", amount: 10, low: 7, high: 13 },
    { bucket: "2026-12-01", amount: 20, low: 15, high: 25 },
  ];

  it("keeps daily bounds as they are", () => {
    expect(binForecast(daily, "daily")).toEqual(daily);
  });

  it("sums bounds per bin", () => {
    expect(binForecast(daily, "monthly")).toEqual([
      { bucket: "2026-11-01", amount: 20, low: 15, high: 25 },
      { bucket: "2026-12-01", amount: 20, low: 15, high: 25 },
    ]);
  });

  it("accumulates bounds from the last actual for a cumulative chart", () => {
    expect(binForecast(daily.slice(0, 2), "daily", 100, true)).toEqual([
      { bucket: "2026-11-29", amount: 110, low: 108, high: 112 },
      { bucket: "2026-11-30", amount: 120, low: 115, high: 125 },
    ]);
  });

  it("drops bounds when any point lacks them", () => {
    const mixed = [daily[0]!, { bucket: "2026-11-30", amount: 10 }];
    expect(binForecast(mixed, "daily")).toEqual([
      { bucket: "2026-11-29", amount: 10 },
      { bucket: "2026-11-30", amount: 10 },
    ]);
  });
});

describe("budgetForecastRange", () => {
  const budget = (over: Partial<BudgetWithStatus>) => ({ ...over }) as BudgetWithStatus;

  it("converts the band to major units for a spend budget", () => {
    expect(
      budgetForecastRange(budget({ forecastLowCents: 9000, forecastHighCents: 15000 })),
    ).toEqual({ low: 90, high: 150 });
  });

  it("is null without both bounds, or for a usage budget", () => {
    expect(budgetForecastRange(budget({ forecastLowCents: 9000 }))).toBeNull();
    expect(
      budgetForecastRange(budget({ measure: "usage", forecastLowCents: 1, forecastHighCents: 2 })),
    ).toBeNull();
  });
});
