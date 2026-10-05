import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `runCostQuery`'s display options: the measure (cost / usage / count), the
 * quarterly and hourly bins, and the cumulative toggle. Everything stateful is
 * mocked; what is asserted is what reaches the ClickHouse readers and the
 * shape that comes back.
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

const { runCostQuery, listCostDimensionValues, CostQueryError } = await import("../cost-query");

const baseRequest = {
  from: "2026-07-01",
  to: "2026-07-31",
  binning: "daily" as const,
  groupBy: "service" as const,
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  forecast: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryCosts.mockResolvedValue([]);
  mockQueryCostCounts.mockResolvedValue({ series: [], total: 0 });
});

describe("count", () => {
  it("answers from the count reader with a distinct-count total", async () => {
    mockQueryCostCounts
      .mockResolvedValueOnce({
        series: [
          {
            key: "",
            currency: "",
            points: [
              { bucket: "2026-07-01", amount: 3 },
              { bucket: "2026-07-02", amount: 4 },
            ],
          },
        ],
        total: 5,
      })
      .mockResolvedValueOnce({
        series: [{ key: "", currency: "", points: [{ bucket: "2026-06-01", amount: 2 }] }],
        total: 2,
      });

    const res = await runCostQuery("org", {
      ...baseRequest,
      measure: "count",
      comparePreviousPeriod: true,
    });

    expect(mockQueryCosts).not.toHaveBeenCalled();
    expect(mockQueryCostCounts.mock.calls[0]![1]).toMatchObject({ measure: "count" });
    expect(res.measure).toBe("count");
    // The range total is the reader's distinct count, not 3 + 4.
    expect(res.totals).toEqual({ "": 5 });
    expect(res.previousTotals).toEqual({ "": 2 });
    expect(res.series[0]!.label).toBe("Service count");
    expect(res.series[0]!.currency).toBe("");
  });

  it("refuses a count with no group-by", async () => {
    await expect(
      runCostQuery("org", { ...baseRequest, groupBy: "none", measure: "count" }),
    ).rejects.toBeInstanceOf(CostQueryError);
  });

  it("refuses a cumulative count", async () => {
    await expect(
      runCostQuery("org", { ...baseRequest, measure: "count", cumulative: true }),
    ).rejects.toThrow(/cumulative/);
  });
});

describe("usage", () => {
  it("passes the unit to the reader and skips currency conversion", async () => {
    mockQueryCosts.mockResolvedValueOnce([
      { key: "AmazonEC2", currency: "", points: [{ bucket: "2026-07-01", amount: 720 }] },
    ]);
    const res = await runCostQuery("org", {
      ...baseRequest,
      measure: "usage",
      usageUnit: "Hrs",
      displayCurrency: "EUR",
    });
    expect(mockQueryCosts.mock.calls[0]![1]).toMatchObject({ measure: "usage", usageUnit: "Hrs" });
    expect(mockLoadConversion).not.toHaveBeenCalled();
    expect(res).toMatchObject({ measure: "usage", usageUnit: "Hrs", totals: { "": 720 } });
  });

  it("refuses usage without a unit, and a forecast on usage", async () => {
    await expect(runCostQuery("org", { ...baseRequest, measure: "usage" })).rejects.toThrow(/unit/);
    await expect(
      runCostQuery("org", { ...baseRequest, measure: "usage", usageUnit: "Hrs", forecast: true }),
    ).rejects.toThrow(/Forecast/);
  });

  it("lists the usage units through the dimensions endpoint", async () => {
    mockUsageUnits.mockResolvedValueOnce(["Hrs", "GB-Mo"]);
    expect(await listCostDimensionValues("org", "usage-units")).toEqual([
      { value: "Hrs", label: "Hrs" },
      { value: "GB-Mo", label: "GB-Mo" },
    ]);
  });
});

describe("bins and the cumulative toggle", () => {
  it("refuses hourly bins while cost rows are stored per day", async () => {
    await expect(runCostQuery("org", { ...baseRequest, binning: "hourly" })).rejects.toThrow(
      /Hourly/,
    );
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("totals a cumulative quarterly series by its last point", async () => {
    mockQueryCosts.mockResolvedValueOnce([
      {
        key: "AmazonEC2",
        currency: "USD",
        points: [
          { bucket: "2026-04-01", amount: 10 },
          { bucket: "2026-07-01", amount: 25 },
        ],
      },
    ]);
    const res = await runCostQuery("org", {
      ...baseRequest,
      binning: "quarterly",
      cumulative: true,
    });
    expect(mockQueryCosts.mock.calls[0]![1]).toMatchObject({
      binning: "quarterly",
      cumulative: true,
    });
    expect(res.totals).toEqual({ USD: 25 });
    expect(res.measure).toBeUndefined();
  });

  it("sends a plain cost query unchanged", async () => {
    await runCostQuery("org", baseRequest);
    const sent = mockQueryCosts.mock.calls[0]![1] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("measure");
    expect(sent).not.toHaveProperty("cumulative");
  });
});
