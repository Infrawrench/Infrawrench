import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `runCostQuery` with a dimension on the X axis: the reader is asked for the
 * same scan with the axis in the group key, the answer comes back keyed by
 * value and ranked, and the previous period is folded onto the current
 * period's values. Everything stateful is mocked.
 */

const mockQueryCosts = vi.fn();
const mockQueryCostCounts = vi.fn();
const mockUsageUnits = vi.fn();
vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  COST_STORE_GRANULARITY: "daily",
  queryCosts: (...args: unknown[]) => mockQueryCosts(...args),
  queryCostCounts: (...args: unknown[]) => mockQueryCostCounts(...args),
  getCostUsageUnits: (...args: unknown[]) => mockUsageUnits(...args),
  getCostCoverage: vi.fn(async () => new Map()),
  getCostDimensionValues: vi.fn(async () => []),
  getCostTagKeys: vi.fn(async () => []),
}));
vi.mock("@infrawrench/server-core/cost/tag-key-settings", () => ({
  getOrgTagKeySettings: vi.fn(async () => ({ hidden: [], preferred: [] })),
}));
vi.mock("@infrawrench/server-core/cost/billing-rules", () => ({
  resolveBillingAdjustments: vi.fn(),
}));
vi.mock("@infrawrench/server-core/cost/saved-filters", () => ({
  SavedCostFilterResolutionError: class extends Error {},
  resolveSavedCostFilters: vi.fn(async () => []),
}));
vi.mock("@infrawrench/server-core/cost/scenario-forecast", () => ({
  CostScenarioResolutionError: class extends Error {},
  CostScenarioApplicationError: class extends Error {},
  resolveCostScenarioModel: vi.fn(),
  forecastWithScenario: vi.fn(),
  toCostScenarioModel: vi.fn(),
}));
const mockLoadConversion = vi.fn(async () => ({ displayCurrency: null, rates: [] }));
vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  loadConversionContext: (...args: unknown[]) => mockLoadConversion(...(args as [])),
}));
vi.mock("@infrawrench/server-core/cost/forecast", () => ({
  forecastDaily: vi.fn(() => []),
}));
vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../../plugins/loader", () => ({
  getPlugin: vi.fn(async () => null),
  loadPlugins: vi.fn(async () => []),
}));

const { runCostQuery, CostQueryError } = await import("../cost-query");

const SEP = "\u001f";
const baseRequest = {
  from: "2026-07-01",
  to: "2026-07-31",
  binning: "monthly" as const,
  groupBy: "none" as const,
  filters: [],
  topN: 2,
  comparePreviousPeriod: false,
  forecast: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryCosts.mockResolvedValue([]);
});

describe("dimension X axis", () => {
  it("asks the reader for the axis in the group key and ranks the values", async () => {
    mockQueryCosts.mockResolvedValueOnce([
      { key: "ec2", currency: "USD", points: [{ bucket: "2026-07-01", amount: 50 }] },
      { key: "s3", currency: "USD", points: [{ bucket: "2026-07-01", amount: 5 }] },
      { key: "rds", currency: "USD", points: [{ bucket: "2026-07-01", amount: 20 }] },
    ]);
    const res = await runCostQuery("org", { ...baseRequest, xAxis: "service" });

    expect(mockQueryCosts.mock.calls[0]![1]).toMatchObject({ xAxis: "service", groupBy: "none" });
    expect(res.xAxis).toEqual({
      dimension: "service",
      segment: "none",
      values: [
        { key: "ec2", label: "ec2" },
        { key: "rds", label: "rds" },
        { key: "__other__", label: "Other" },
      ],
    });
    expect(res.series).toHaveLength(1);
    expect(res.series[0]!.points).toEqual([
      { bucket: "ec2", amount: 50 },
      { bucket: "rds", amount: 20 },
      { bucket: "__other__", amount: 5 },
    ]);
    expect(res.totals).toEqual({ USD: 75 });
    expect(res.forecast).toBeUndefined();
  });

  it("segments by a second dimension split out of the composite key", async () => {
    mockQueryCosts.mockResolvedValueOnce([
      {
        key: `ec2${SEP}us-east-1`,
        currency: "USD",
        points: [{ bucket: "2026-07-01", amount: 30 }],
      },
      {
        key: `ec2${SEP}eu-west-1`,
        currency: "USD",
        points: [{ bucket: "2026-07-01", amount: 10 }],
      },
      { key: `s3${SEP}us-east-1`, currency: "USD", points: [{ bucket: "2026-07-01", amount: 4 }] },
    ]);
    const res = await runCostQuery("org", {
      ...baseRequest,
      xAxis: "service",
      groupBy: "region",
    });
    expect(mockQueryCosts.mock.calls[0]![1]).toMatchObject({ xAxis: "service", groupBy: "region" });
    expect(res.xAxis?.segment).toBe("dimension");
    expect(res.series.map((s) => s.key)).toEqual(["us-east-1", "eu-west-1"]);
    expect(res.series[0]!.points).toEqual([
      { bucket: "ec2", amount: 30 },
      { bucket: "s3", amount: 4 },
    ]);
  });

  it("segments by date bin with each bin a series", async () => {
    mockQueryCosts.mockResolvedValueOnce([
      {
        key: "ec2",
        currency: "USD",
        points: [
          { bucket: "2026-07-01", amount: 3 },
          { bucket: "2026-08-01", amount: 4 },
        ],
      },
    ]);
    const res = await runCostQuery("org", {
      ...baseRequest,
      xAxis: "service",
      segmentByDate: true,
    });
    expect(mockQueryCosts.mock.calls[0]![1]).toMatchObject({ segmentByDate: true });
    expect(res.xAxis?.segment).toBe("date");
    expect(res.series.map((s) => [s.key, s.label])).toEqual([
      ["2026-07-01", "2026-07-01"],
      ["2026-08-01", "2026-08-01"],
    ]);
  });

  it("folds the previous period onto the current period's values", async () => {
    mockQueryCosts
      .mockResolvedValueOnce([
        { key: "ec2", currency: "USD", points: [{ bucket: "2026-07-01", amount: 50 }] },
        { key: "s3", currency: "USD", points: [{ bucket: "2026-07-01", amount: 5 }] },
      ])
      .mockResolvedValueOnce([
        // Last period lambda outranked s3; it is still compared value by value.
        { key: "lambda", currency: "USD", points: [{ bucket: "2026-06-01", amount: 9 }] },
        { key: "s3", currency: "USD", points: [{ bucket: "2026-06-01", amount: 8 }] },
      ]);
    const res = await runCostQuery("org", {
      ...baseRequest,
      xAxis: "service",
      comparePreviousPeriod: true,
    });
    expect(mockQueryCosts.mock.calls[1]![1]).toMatchObject({
      xAxis: "service",
      from: "2026-05-31",
      to: "2026-06-30",
    });
    expect(res.comparison![0]!.points).toEqual([
      { bucket: "s3", amount: 8 },
      { bucket: "__other__", amount: 9 },
    ]);
    expect(res.previousTotals).toEqual({ USD: 17 });
  });

  it("compares each value's own total when the bars are also segmented", async () => {
    mockQueryCosts
      .mockResolvedValueOnce([
        {
          key: `ec2${SEP}us-east-1`,
          currency: "USD",
          points: [{ bucket: "2026-07-01", amount: 30 }],
        },
        {
          key: `s3${SEP}us-east-1`,
          currency: "USD",
          points: [{ bucket: "2026-07-01", amount: 4 }],
        },
      ])
      .mockResolvedValueOnce([
        {
          key: `ec2${SEP}us-east-1`,
          currency: "USD",
          points: [{ bucket: "2026-06-01", amount: 20 }],
        },
        {
          key: `ec2${SEP}eu-west-1`,
          currency: "USD",
          points: [{ bucket: "2026-06-01", amount: 5 }],
        },
        {
          key: `s3${SEP}us-east-1`,
          currency: "USD",
          points: [{ bucket: "2026-06-01", amount: 6 }],
        },
      ]);
    const res = await runCostQuery("org", {
      ...baseRequest,
      xAxis: "service",
      groupBy: "region",
      comparePreviousPeriod: true,
    });
    expect(res.comparison).toHaveLength(1);
    expect(res.comparison![0]!.points).toEqual([
      { bucket: "ec2", amount: 25 },
      { bucket: "s3", amount: 6 },
    ]);
    expect(res.previousTotals).toEqual({ USD: 31 });
  });

  it("labels an empty value instead of printing nothing", async () => {
    mockQueryCosts.mockResolvedValueOnce([
      { key: "", currency: "USD", points: [{ bucket: "2026-07-01", amount: 1 }] },
    ]);
    const res = await runCostQuery("org", { ...baseRequest, xAxis: "region" });
    expect(res.xAxis?.values).toEqual([{ key: "", label: "(no value)" }]);
  });

  it("refuses what needs a date axis before reading anything", async () => {
    await expect(
      runCostQuery("org", { ...baseRequest, xAxis: "service", forecast: true }),
    ).rejects.toThrow(CostQueryError);
    await expect(
      runCostQuery("org", { ...baseRequest, xAxis: "service", cumulative: true }),
    ).rejects.toThrow(/date X axis/);
    await expect(runCostQuery("org", { ...baseRequest, xAxis: "tag" })).rejects.toThrow(/key/);
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });
});
