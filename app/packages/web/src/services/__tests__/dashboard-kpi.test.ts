import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostQueryRequest, KpiWidgetConfig } from "@infrawrench/client-core";

const runCostQuery = vi.fn();
const runUnitCostQuery = vi.fn();
const runUsageUnitCostQuery = vi.fn();
const getCostReport = vi.fn();
const getBudgetWithStatus = vi.fn();
const budgetStatusAsOf = vi.fn();
const getCommitmentsFeed = vi.fn();
const getRealizedSavingsReport = vi.fn();

vi.mock("@/services/cost-query", () => ({
  runCostQuery: (...a: unknown[]) => runCostQuery(...a),
}));
vi.mock("@/services/unit-cost-query", () => ({
  runUnitCostQuery: (...a: unknown[]) => runUnitCostQuery(...a),
  runUsageUnitCostQuery: (...a: unknown[]) => runUsageUnitCostQuery(...a),
}));
vi.mock("@/services/cost-reports", () => ({
  getCostReport: (...a: unknown[]) => getCostReport(...a),
}));
vi.mock("@/services/budgets", () => ({
  getBudgetWithStatus: (...a: unknown[]) => getBudgetWithStatus(...a),
  budgetStatusAsOf: (...a: unknown[]) => budgetStatusAsOf(...a),
}));
vi.mock("@infrawrench/server-core/commitments/feed", () => ({
  getCommitmentsFeed: (...a: unknown[]) => getCommitmentsFeed(...a),
}));
vi.mock("@infrawrench/server-core/savings/realized", () => ({
  getRealizedSavingsReport: (...a: unknown[]) => getRealizedSavingsReport(...a),
}));
vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  getOrgCurrencySettings: async () => ({ displayCurrency: null }),
}));

const { evaluateDashboardKpi, DashboardKpiError } = await import("@/services/dashboard-kpi");

const NOW = new Date("2026-10-16T12:00:00Z");
const opts = { granted: ["*"], now: NOW };

const reportConfig = {
  chartType: "stacked_bar",
  binning: "daily",
  dateRange: { kind: "absolute", from: "2026-10-01", to: "2026-10-10" },
  groupBy: "service",
  filters: [{ dimension: "provider", operator: "in", values: ["aws"] }],
  topN: 5,
  comparePreviousPeriod: false,
  showForecast: true,
  costBasis: "amortized",
};

function reportKpi(
  measure: "cost" | "usage" | "count" | "unit_cost" | "business_metric",
  extra: Partial<KpiWidgetConfig> = {},
  aggregation: "sum" | "daily_average" = "sum",
): KpiWidgetConfig {
  return {
    version: 1,
    source: { kind: "cost_report", reportId: "r1", measure, aggregation },
    comparePreviousPeriod: true,
    ...extra,
  };
}

/** A response whose total depends on which window was asked for. */
function totalsByWindow(byFrom: Record<string, Record<string, number>>) {
  runCostQuery.mockImplementation(async (_org: string, q: CostQueryRequest) => {
    const totals = byFrom[q.from] ?? {};
    return { series: [], totals, currencies: Object.keys(totals), binning: q.binning };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getCostReport.mockResolvedValue({ id: "r1", name: "AWS spend", config: reportConfig });
});

describe("saved report KPIs", () => {
  it("totals the report's scope over its own range and compares the window before", async () => {
    totalsByWindow({ "2026-10-01": { USD: 1500 }, "2026-09-21": { USD: 1000 } });
    const result = await evaluateDashboardKpi("org-1", reportKpi("cost"), opts);

    expect(result).toMatchObject({
      value: 1500,
      unit: "money",
      currency: "USD",
      previous: 1000,
      change: 500,
      changePercent: 50,
      upIsGood: false,
      from: "2026-10-01",
      to: "2026-10-10",
      previousFrom: "2026-09-21",
      previousTo: "2026-09-30",
      sourceName: "AWS spend",
    });
    const request = runCostQuery.mock.calls[0]![1] as CostQueryRequest;
    // The report's scope comes along; its grouping and overlays do not.
    expect(request).toMatchObject({
      groupBy: "none",
      forecast: false,
      comparePreviousPeriod: false,
      costBasis: "amortized",
      filters: reportConfig.filters,
    });
    expect(request).not.toHaveProperty("groupByTagKey");
  });

  it("follows the card's own range over the report's", async () => {
    totalsByWindow({});
    await evaluateDashboardKpi(
      "org-1",
      reportKpi("cost", {
        dateRange: { kind: "absolute", from: "2026-08-01", to: "2026-08-31" },
        comparePreviousPeriod: false,
      }),
      opts,
    );
    expect(runCostQuery).toHaveBeenCalledTimes(1);
    expect(runCostQuery.mock.calls[0]![1]).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("divides by the days in the window for a daily average", async () => {
    totalsByWindow({ "2026-10-01": { USD: 1000 }, "2026-09-21": { USD: 500 } });
    const result = await evaluateDashboardKpi(
      "org-1",
      reportKpi("cost", {}, "daily_average"),
      opts,
    );
    expect(result.value).toBe(100);
    expect(result.previous).toBe(50);
  });

  it("counts distinct values of the report's group-by", async () => {
    totalsByWindow({ "2026-10-01": { "": 7 }, "2026-09-21": { "": 9 } });
    const result = await evaluateDashboardKpi("org-1", reportKpi("count"), opts);
    expect(result).toMatchObject({ value: 7, unit: "count", previous: 9, change: -2 });
    expect(runCostQuery.mock.calls[0]![1]).toMatchObject({ measure: "count", groupBy: "service" });
  });

  it("asks for a usage unit the report does not carry", async () => {
    await expect(evaluateDashboardKpi("org-1", reportKpi("usage"), opts)).rejects.toThrow(
      /usage unit/,
    );
  });

  it("refuses a unit cost on a report with no business metric", async () => {
    await expect(evaluateDashboardKpi("org-1", reportKpi("unit_cost"), opts)).rejects.toThrow(
      DashboardKpiError,
    );
  });

  it("reads the unit cost and the metric itself from the attached metric", async () => {
    getCostReport.mockResolvedValue({
      id: "r1",
      name: "Cost per user",
      config: { ...reportConfig, unitCostMetricId: "m1", unitCostGroupByLabel: "plan" },
    });
    runUnitCostQuery.mockImplementation(async (_o: string, _m: string, req: { from: string }) => ({
      metric: { id: "m1", key: "users", name: "Active users", unit: "user", kind: "count" },
      mode: "unit_cost",
      scale: 1,
      series: [
        {
          currency: "USD",
          points: [],
          overallValue: req.from === "2026-10-01" ? 2 : 4,
          overallCost: 100,
          overallMetricValue: req.from === "2026-10-01" ? 50 : 25,
        },
      ],
      gapBuckets: 0,
      partialBuckets: 0,
    }));

    const unit = await evaluateDashboardKpi("org-1", reportKpi("unit_cost"), opts);
    expect(unit).toMatchObject({
      value: 2,
      unit: "money_per_unit",
      perUnit: "user",
      previous: 4,
      changePercent: -50,
    });
    // One overall ratio: the label split is dropped.
    expect(runUnitCostQuery.mock.calls[0]![2]).not.toHaveProperty("groupByLabel");

    const metric = await evaluateDashboardKpi("org-1", reportKpi("business_metric"), opts);
    expect(metric).toMatchObject({ value: 50, unit: "quantity", perUnit: "user", upIsGood: true });
  });

  it("says when the report is gone", async () => {
    getCostReport.mockResolvedValue(null);
    await expect(evaluateDashboardKpi("org-1", reportKpi("cost"), opts)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("budget KPIs", () => {
  const budget = {
    id: "b1",
    name: "Platform",
    currency: "USD",
    amountCents: 100_000,
    periodLimit: 100_000,
    actualCents: 40_000,
    forecastCents: 90_000,
    scenarioForecastCents: null,
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    period: null,
  };
  const budgetKpi = (measure: "actual" | "forecast" | "remaining" | "percent_used") =>
    ({
      version: 1,
      source: { kind: "budget", budgetId: "b1", measure },
      comparePreviousPeriod: true,
    }) as KpiWidgetConfig;

  it("compares with the same point of the previous period", async () => {
    getBudgetWithStatus.mockResolvedValue(budget);
    budgetStatusAsOf.mockResolvedValue({
      actualCents: 30_000,
      limit: 100_000,
      periodStart: "2026-09-01",
      actualUsage: null,
    });
    const result = await evaluateDashboardKpi("org-1", budgetKpi("actual"), opts);
    expect(result).toMatchObject({
      value: 400,
      unit: "money",
      currency: "USD",
      previous: 300,
      change: 100,
      limit: 1000,
      upIsGood: false,
      sourceName: "Platform",
    });
    // 16 October is day 16 of the period, so day 16 of September.
    expect((budgetStatusAsOf.mock.calls[0]![2] as Date).toISOString().slice(0, 10)).toBe(
      "2026-09-16",
    );
  });

  it("sets a projection against how the previous period ended", async () => {
    getBudgetWithStatus.mockResolvedValue(budget);
    budgetStatusAsOf.mockResolvedValue({ actualCents: 80_000, limit: 100_000, actualUsage: null });
    const result = await evaluateDashboardKpi("org-1", budgetKpi("forecast"), opts);
    expect(result).toMatchObject({ value: 900, previous: 800 });
    expect((budgetStatusAsOf.mock.calls[0]![2] as Date).toISOString().slice(0, 10)).toBe(
      "2026-09-30",
    );
  });

  it("reads headroom as good news and percent used as points", async () => {
    getBudgetWithStatus.mockResolvedValue(budget);
    budgetStatusAsOf.mockResolvedValue({ actualCents: 30_000, limit: 100_000, actualUsage: null });
    expect(await evaluateDashboardKpi("org-1", budgetKpi("remaining"), opts)).toMatchObject({
      value: 600,
      previous: 700,
      upIsGood: true,
    });
    expect(await evaluateDashboardKpi("org-1", budgetKpi("percent_used"), opts)).toMatchObject({
      value: 40,
      unit: "percent",
      previous: 30,
    });
  });

  it("needs budgets:read", async () => {
    await expect(
      evaluateDashboardKpi("org-1", budgetKpi("actual"), { granted: ["costs:read"], now: NOW }),
    ).rejects.toMatchObject({ status: 403 });
    expect(getBudgetWithStatus).not.toHaveBeenCalled();
  });
});

describe("commitment and savings KPIs", () => {
  it("reads coverage as the lower bound and states the range", async () => {
    getCommitmentsFeed.mockImplementation(async (_o: string, at: Date) => ({
      holdings: [],
      coverage: {
        available: true,
        excludedAccountIds: [],
        currencies: [
          {
            currency: "USD",
            coveredAmount: 600,
            uncoveredAmount: 400,
            uncoveredEligibleAmount: 100,
            broadRatio: at < NOW ? 0.5 : 0.6,
            narrowRatio: 0.857,
          },
        ],
      },
      utilizationWindowDays: 30,
    }));
    const result = await evaluateDashboardKpi(
      "org-1",
      {
        version: 1,
        source: { kind: "commitments", measure: "coverage" },
        comparePreviousPeriod: true,
      },
      opts,
    );
    expect(result.value).toBeCloseTo(60);
    expect(result.previous).toBeCloseTo(50);
    expect(result.note).toMatch(/86%/);
    expect(getCommitmentsFeed).toHaveBeenCalledTimes(2);
  });

  it("weights utilization by obligation", async () => {
    getCommitmentsFeed.mockResolvedValue({
      holdings: [
        { currency: "USD", utilization: { obligationAmount: 100, deliveredAmount: 90 } },
        { currency: "USD", utilization: { obligationAmount: 300, deliveredAmount: 150 } },
        { currency: "USD", utilization: { obligationAmount: null, deliveredAmount: 5 } },
      ],
      coverage: { available: false, currencies: [], excludedAccountIds: [] },
      utilizationWindowDays: 30,
    });
    const result = await evaluateDashboardKpi(
      "org-1",
      {
        version: 1,
        source: { kind: "commitments", measure: "utilization" },
        comparePreviousPeriod: false,
      },
      opts,
    );
    expect(result.value).toBeCloseTo(60);
    expect(result.previous).toBeNull();
  });

  it("totals realized savings of one kind through yesterday", async () => {
    getRealizedSavingsReport.mockResolvedValue({
      totals: [{ currency: "USD", realized: 900, projected: 1000 }],
      byKind: [
        {
          key: "commitment",
          label: "Commitments",
          currency: "USD",
          realized: 400,
          projected: 0,
          events: 1,
        },
        {
          key: "rightsizing",
          label: "Right-sizing",
          currency: "USD",
          realized: 500,
          projected: 0,
          events: 2,
        },
      ],
      unmeasuredCount: 0,
    });
    const result = await evaluateDashboardKpi(
      "org-1",
      {
        version: 1,
        source: { kind: "commitments", measure: "savings" },
        comparePreviousPeriod: false,
      },
      opts,
    );
    expect(result).toMatchObject({ value: 400, unit: "money", currency: "USD", upIsGood: true });
    const window = getRealizedSavingsReport.mock.calls[0]![1] as { to: string };
    expect(window.to).toBe("2026-10-15");
  });
});
