import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CostScenarioModel } from "@infrawrench/client-core";

/**
 * `runCostReportForecast` against the real fit, the real scenario engine and
 * the real band arithmetic, with only the stores mocked. The properties:
 *
 * 1. the automatic forecast is always returned, with a band around it;
 * 2. scenario models apply **in priority order**, each to the line the
 *    previous ones produced, and the band shifts with the line;
 * 3. the default forecast is what an unqualified request returns;
 * 4. a driver metric replaces the trend with unit cost times planned volume;
 * 5. a report's own filters plus the provider/service narrowing reach the fit.
 */

const mockQueryCosts = vi.fn();
vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  queryCosts: (...args: unknown[]) => mockQueryCosts(...args),
  getCostCoverage: vi.fn(async () => new Map()),
  getCostDimensionValues: vi.fn(async () => []),
  getCostTagKeys: vi.fn(async () => []),
}));
vi.mock("@infrawrench/server-core/cost/saved-filters", () => ({
  SavedCostFilterResolutionError: class extends Error {},
  resolveSavedCostFilters: vi.fn(async () => []),
}));
vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  getOrgCurrencySettings: vi.fn(async () => ({ displayCurrency: null })),
  loadConversionContext: vi.fn(async () => ({ displayCurrency: null, rates: [] })),
}));
vi.mock("@infrawrench/server-core/cost/billing-rules", () => ({
  resolveBillingAdjustments: vi.fn(async () => ({ adjustments: {}, rules: [] })),
}));
const mockMetricValues = vi.fn();
vi.mock("@infrawrench/server-core/cost/metric-ingest", () => ({
  getMetricValues: (...args: unknown[]) => mockMetricValues(...args),
}));
const mockResolveModel = vi.fn();
vi.mock("@infrawrench/server-core/db/client", () => ({ db: {} }));
vi.mock("@infrawrench/server-core/cost/scenario-forecast", async () => {
  const actual = await vi.importActual<
    typeof import("@infrawrench/server-core/cost/scenario-forecast")
  >("@infrawrench/server-core/cost/scenario-forecast");
  return { ...actual, resolveCostScenarioModel: (...args: unknown[]) => mockResolveModel(...args) };
});

// The forecast rows: the one Postgres read the run makes itself.
let storedRows: Array<Record<string, unknown>> = [];
const chain = {
  from: () => chain,
  where: () => chain,
  orderBy: async () => storedRows,
};
vi.mock("../../db/client", () => ({ db: { select: () => chain } }));
vi.mock("../../plugins/loader", () => ({
  getPlugin: vi.fn(async () => null),
  loadPlugins: vi.fn(async () => []),
}));

const mockLoadReport = vi.fn();
vi.mock("../cost-reports", () => ({
  loadAccessibleCostReport: (...args: unknown[]) => mockLoadReport(...args),
}));
const mockGetMetric = vi.fn();
vi.mock("../business-metrics", () => ({
  getBusinessMetric: (...args: unknown[]) => mockGetMetric(...args),
}));
const mockPlanned = vi.fn();
vi.mock("../business-metric-forecast-values", () => ({
  getBusinessMetricForecastMap: (...args: unknown[]) => mockPlanned(...args),
}));

const { runCostReportForecast, CostForecastError } = await import("../cost-forecasts");

const TODAY = new Date("2026-10-15T12:00:00Z");

function dayList(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
  );
}

// 30 observed days ending today, alternating 90/110: a flat trend at 100 with
// real noise, so the band is a real band.
const OBSERVED = dayList("2026-09-16", 30).map((bucket, i) => ({
  bucket,
  amount: i % 2 ? 110 : 90,
}));

function model(id: string, name: string, adjustments: CostScenarioModel["adjustments"]) {
  return {
    id,
    name,
    description: null,
    currency: "USD",
    adjustments,
    createdByUserId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } satisfies CostScenarioModel;
}

const PURCHASE = model("m-purchase", "Licence", [
  {
    id: "a1",
    label: "Licence",
    kind: "one_off",
    startDate: "2026-10-20",
    endDate: null,
    amountCents: 30_000,
    currency: "USD",
    period: null,
    percent: null,
    scope: [],
  },
]);
const HALVE = model("m-halve", "Halve everything", [
  {
    id: "a2",
    label: "Migration",
    kind: "rate_change",
    startDate: "2026-10-16",
    endDate: null,
    amountCents: null,
    currency: null,
    period: null,
    percent: -50,
    scope: [],
  },
]);

function row(over: Record<string, unknown>) {
  return {
    id: "f-1",
    organizationId: "org-1",
    costReportId: "r-1",
    name: "Plan",
    description: null,
    scenarioModelIds: [],
    driverMetricId: null,
    isDefault: false,
    position: 0,
    createdByUserId: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storedRows = [];
  mockQueryCosts.mockResolvedValue([{ currency: "USD", points: OBSERVED }]);
  mockLoadReport.mockResolvedValue({
    id: "r-1",
    name: "Platform spend",
    config: {
      version: 1,
      dateRange: { kind: "relative", preset: "30d" },
      binning: "daily",
      groupBy: "none",
      filters: [{ dimension: "account", op: "in", values: ["acct-1"] }],
      topN: 5,
      chartType: "stacked_bar",
      showForecast: true,
      comparePreviousPeriod: false,
    },
  });
  mockResolveModel.mockImplementation(async (_org: string, id: string) =>
    id === PURCHASE.id ? PURCHASE : HALVE,
  );
});

describe("runCostReportForecast", () => {
  it("returns the automatic forecast with a band, from the day after the last spend", async () => {
    const result = (await runCostReportForecast("org-1", "r-1", { to: "2026-10-31" }, TODAY))!;
    expect(result.from).toBe("2026-10-16");
    expect(result.to).toBe("2026-10-31");
    expect(result.lastObservedDay).toBe("2026-10-15");
    expect(result.currency).toBe("USD");
    expect(result.forecast.forecastId).toBeNull();
    expect(result.baseline.points).toHaveLength(16);
    const total = result.baseline.total;
    expect(total.expected).toBeGreaterThan(1500);
    expect(total.expected).toBeLessThan(1700);
    expect(total.low!).toBeLessThan(total.expected);
    expect(total.high!).toBeGreaterThan(total.expected);
  });

  it("narrows the fit by the report's filters plus providers and services", async () => {
    await runCostReportForecast(
      "org-1",
      "r-1",
      { providers: ["aws"], services: ["Amazon EC2"] },
      TODAY,
    );
    const fit = mockQueryCosts.mock.calls[0]![1] as { filters: unknown[]; to: string };
    expect(fit.to).toBe("2026-10-15");
    expect(fit.filters).toEqual([
      { dimension: "account", op: "in", values: ["acct-1"] },
      { dimension: "provider", op: "in", values: ["aws"] },
      { dimension: "service", op: "in", values: ["Amazon EC2"] },
    ]);
  });

  it("applies scenario models in priority order and shifts the band with them", async () => {
    storedRows = [
      row({
        id: "first-purchase",
        name: "Buy then halve",
        scenarioModelIds: [PURCHASE.id, HALVE.id],
      }),
      row({
        id: "first-halve",
        name: "Halve then buy",
        position: 1,
        scenarioModelIds: [HALVE.id, PURCHASE.id],
      }),
    ];
    const result = (await runCostReportForecast(
      "org-1",
      "r-1",
      { to: "2026-10-31", all: true },
      TODAY,
    ))!;
    const [buyThenHalve, halveThenBuy] = result.forecasts!;
    const base = result.baseline.points.find((p) => p.day === "2026-10-20")!;
    const day = (s: typeof buyThenHalve) => s!.points.find((p) => p.day === "2026-10-20")!;

    // The later org-wide percentage also halves the earlier purchase...
    expect(day(buyThenHalve).expected).toBeCloseTo((base.expected + 300) / 2, 4);
    // ...and the purchase added after the halving stays whole.
    expect(day(halveThenBuy).expected).toBeCloseTo(base.expected / 2 + 300, 4);

    // The band moves with the line, by exactly as much.
    const shift = day(halveThenBuy).expected - base.expected;
    expect(day(halveThenBuy).low!).toBeCloseTo(Math.max(0, base.low! + shift), 4);
    expect(day(halveThenBuy).high!).toBeCloseTo(base.high! + shift, 4);

    expect(halveThenBuy!.scenarios.map((s) => s.modelName)).toEqual([
      "Halve everything",
      "Licence",
    ]);
    expect(halveThenBuy!.scenarios[1]!.totalDelta).toBeCloseTo(300, 4);
    expect(halveThenBuy!.deltaFromBaseline).toBeCloseTo(
      halveThenBuy!.total.expected - result.baseline.total.expected,
      4,
    );
  });

  it("returns the default forecast when none is named, and the trend on request", async () => {
    storedRows = [
      row({ id: "a", name: "A", scenarioModelIds: [PURCHASE.id] }),
      row({ id: "b", name: "B", scenarioModelIds: [HALVE.id], isDefault: true }),
    ];
    const byDefault = (await runCostReportForecast("org-1", "r-1", {}, TODAY))!;
    expect(byDefault.forecast.forecastId).toBe("b");
    expect(byDefault.forecast.isDefault).toBe(true);

    const trend = (await runCostReportForecast("org-1", "r-1", { forecastId: "baseline" }, TODAY))!;
    expect(trend.forecast.forecastId).toBeNull();

    await expect(
      runCostReportForecast("org-1", "r-1", { forecastId: "missing" }, TODAY),
    ).rejects.toBeInstanceOf(CostForecastError);
  });

  it("drives the baseline from planned metric values", async () => {
    storedRows = [row({ id: "d", name: "Growth plan", driverMetricId: "m-1", isDefault: true })];
    mockGetMetric.mockResolvedValue({ id: "m-1", name: "Customers", unit: "customer" });
    // 50 customers every observed day: $2 per customer on average.
    mockMetricValues.mockResolvedValue(OBSERVED.map((p) => ({ day: p.bucket, value: 50 })));
    mockPlanned.mockResolvedValue(
      new Map([
        ["2026-10-16", 100],
        ["2026-10-17", 100],
      ]),
    );
    const result = (await runCostReportForecast("org-1", "r-1", { to: "2026-10-18" }, TODAY))!;
    const f = result.forecast;
    expect(f.driver).toMatchObject({
      metricId: "m-1",
      metricName: "Customers",
      coveredDays: 2,
      totalDays: 3,
      metricTotal: 200,
    });
    expect(f.driver!.unitCost!).toBeCloseTo(2, 1);
    // Twice the customers, roughly twice the spend, on the driven days.
    expect(f.points[0]!.expected).toBeGreaterThan(180);
    expect(f.points[0]!.expected).toBeLessThan(220);
    // The undriven day is the trend's, and says so.
    expect(f.points[2]).toEqual(result.baseline.points[2]);
    expect(f.warnings.join(" ")).toMatch(/1 of 3 days/);
  });

  it("refuses a usage report, an out-of-range window and a missing driver metric", async () => {
    mockLoadReport.mockResolvedValueOnce({
      id: "r-1",
      name: "Usage",
      config: { measure: "usage", filters: [], dateRange: { kind: "relative", preset: "30d" } },
    });
    await expect(runCostReportForecast("org-1", "r-1", {}, TODAY)).rejects.toThrow(
      /measures usage/,
    );

    await expect(
      runCostReportForecast("org-1", "r-1", { to: "2028-01-01" }, TODAY),
    ).rejects.toThrow(/at most 366 days/);

    storedRows = [row({ id: "d", driverMetricId: "gone", isDefault: true })];
    mockGetMetric.mockResolvedValue(null);
    await expect(runCostReportForecast("org-1", "r-1", {}, TODAY)).rejects.toThrow(
      /no longer exists/,
    );
  });

  it("is null for a report the caller cannot see", async () => {
    mockLoadReport.mockResolvedValueOnce(null);
    expect(await runCostReportForecast("org-1", "r-1", {}, TODAY)).toBeNull();
  });
});
