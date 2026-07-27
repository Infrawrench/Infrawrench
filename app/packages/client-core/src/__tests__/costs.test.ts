import { describe, expect, it } from "vitest";
import {
  binForecast,
  costQueryForConfig,
  failingCostAccounts,
  formatBucketLabel,
  formatBudgetMonth,
  resolveCostDateRange,
  totalPerBucket,
  type CostAccountStatus,
  type CostGraphConfig,
  type CostQuerySeries,
} from "../costs";

const series = (key: string, points: Array<[string, number]>): CostQuerySeries => ({
  key,
  label: key,
  currency: "USD",
  points: points.map(([bucket, amount]) => ({ bucket, amount })),
});

describe("totalPerBucket", () => {
  it("sums across series per bucket in order", () => {
    expect(
      totalPerBucket([
        series("a", [["2026-07-02", 1]]),
        series("b", [
          ["2026-07-01", 2],
          ["2026-07-02", 3],
        ]),
      ]),
    ).toEqual([
      { bucket: "2026-07-01", amount: 2 },
      { bucket: "2026-07-02", amount: 4 },
    ]);
  });
});

describe("binForecast", () => {
  const daily = [
    { bucket: "2026-07-30", amount: 2 },
    { bucket: "2026-07-31", amount: 3 },
    { bucket: "2026-08-01", amount: 4 },
  ];

  it("passes daily through unchanged", () => {
    expect(binForecast(daily, "daily")).toEqual(daily);
  });

  it("bins monthly onto month starts", () => {
    expect(binForecast(daily, "monthly")).toEqual([
      { bucket: "2026-07-01", amount: 5 },
      { bucket: "2026-08-01", amount: 4 },
    ]);
  });

  it("bins weekly onto Mondays", () => {
    // Thu 2026-07-30, Fri 07-31, and Sat 08-01 all fall in the week of Mon 07-27.
    expect(binForecast(daily, "weekly")).toEqual([{ bucket: "2026-07-27", amount: 9 }]);
  });

  it("accumulates for cumulative starting from the last actual", () => {
    expect(binForecast(daily, "cumulative", 100)).toEqual([
      { bucket: "2026-07-30", amount: 102 },
      { bucket: "2026-07-31", amount: 105 },
      { bucket: "2026-08-01", amount: 109 },
    ]);
  });
});

describe("resolveCostDateRange", () => {
  const today = new Date("2026-07-15T12:00:00.000Z");

  it("passes absolute ranges through", () => {
    expect(
      resolveCostDateRange({ kind: "absolute", from: "2026-01-01", to: "2026-01-31" }, today),
    ).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });

  it("anchors relative presets to today in UTC", () => {
    expect(resolveCostDateRange({ kind: "relative", preset: "7d" }, today)).toEqual({
      from: "2026-07-09",
      to: "2026-07-15",
    });
    expect(resolveCostDateRange({ kind: "relative", preset: "mtd" }, today)).toEqual({
      from: "2026-07-01",
      to: "2026-07-15",
    });
    expect(resolveCostDateRange({ kind: "relative", preset: "last_month" }, today)).toEqual({
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(resolveCostDateRange({ kind: "relative", preset: "qtd" }, today)).toEqual({
      from: "2026-07-01",
      to: "2026-07-15",
    });
  });
});

describe("costQueryForConfig", () => {
  const config: CostGraphConfig = {
    version: 1,
    chartType: "stacked_bar",
    binning: "daily",
    dateRange: { kind: "relative", preset: "7d" },
    groupBy: "service",
    filters: [],
    topN: 5,
    comparePreviousPeriod: true,
    showForecast: true,
  };

  it("resolves the range and renames showForecast to the request's field", () => {
    expect(costQueryForConfig(config, new Date("2026-07-15T12:00:00.000Z"))).toEqual({
      from: "2026-07-09",
      to: "2026-07-15",
      binning: "daily",
      groupBy: "service",
      filters: [],
      topN: 5,
      comparePreviousPeriod: true,
      forecast: true,
    });
  });

  it("omits groupByTagKey unless the config carries one", () => {
    const withTag = costQueryForConfig({ ...config, groupBy: "tag", groupByTagKey: "env" });
    expect(withTag.groupByTagKey).toBe("env");
    expect("groupByTagKey" in costQueryForConfig(config)).toBe(false);
  });
});

describe("label formatting", () => {
  it("formats month bins as month + year", () => {
    expect(formatBucketLabel("2026-07-01", "monthly")).toMatch(/Jul/);
    expect(formatBucketLabel("2026-07-01", "monthly")).toMatch(/2026/);
  });

  it("falls back to the raw bucket for malformed input", () => {
    expect(formatBucketLabel("garbage", "daily")).toBe("garbage");
  });

  it("spells out a budget's month", () => {
    expect(formatBudgetMonth("2026-07")).toMatch(/July/);
    expect(formatBudgetMonth("nonsense")).toBe("nonsense");
  });
});

describe("failingCostAccounts", () => {
  const account = (over: Partial<CostAccountStatus>): CostAccountStatus => ({
    accountId: "a",
    pluginId: "aws",
    displayName: "AWS",
    supportsCosts: true,
    periodNative: false,
    dimensions: [],
    costLastPolledAt: null,
    costBackfilledAt: null,
    costPollFailureCount: 0,
    costPollError: null,
    coverage: null,
    ...over,
  });

  it("keeps only cost-capable accounts with a stored error", () => {
    const failing = account({ costPollError: { message: "no billing export", helpLink: null } });
    expect(
      failingCostAccounts([
        account({}),
        failing,
        account({ supportsCosts: false, costPollError: { message: "x", helpLink: null } }),
      ]),
    ).toEqual([failing]);
  });
});
