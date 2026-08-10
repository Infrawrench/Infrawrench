import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusinessMetric, CostFilter } from "@infrawrench/client-core";

// `../cost-query` transitively reaches server-core's `db/client`, which throws
// at import time without this. No connection is opened — every query path this
// file touches is mocked below.
process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";

/**
 * `runUnitCostQuery` — the orchestration around the pure arithmetic.
 *
 * The bucket-level maths is exhaustively covered in server-core's
 * `unit-costs.test.ts`; what is asserted here is everything the service itself
 * decides, and every one of these is a silent wrong answer if it breaks:
 *
 * - the numerator runs the metric's **own** scope, AND-composed with whatever
 *   narrowing the request added, never replaced by it;
 * - margin is **refused** for a metric that is not revenue-shaped, rather than
 *   producing a number that computes cleanly and means nothing;
 * - margin converts to the **metric's** currency, not the org's display
 *   currency, and a currency with no rate becomes a visible gap rather than
 *   quietly dropping out of the numerator;
 * - a metric's saved filter that fails to resolve **errors** rather than
 *   widening the numerator to all spend.
 *
 * Everything stateful is mocked; the pure `computeUnitCosts` is deliberately
 * *not* mocked, so the assertions run through the real arithmetic.
 */

const mockQueryCosts = vi.fn();
vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  queryCosts: (...args: unknown[]) => mockQueryCosts(...args),
  getCostCoverage: vi.fn(async () => new Map()),
  getCostDimensionValues: vi.fn(async () => []),
  getCostTagKeys: vi.fn(async () => []),
}));

const mockGetMetricValues = vi.fn(async () => [] as Array<{ day: string; value: number }>);
vi.mock("@infrawrench/server-core/cost/metric-ingest", () => ({
  getMetricValues: (...args: unknown[]) => mockGetMetricValues(...(args as [])),
  getMetricCoverage: vi.fn(async () => null),
}));

class FakeResolutionError extends Error {}
const mockResolveSaved = vi.fn();
vi.mock("@infrawrench/server-core/cost/saved-filters", () => ({
  SavedCostFilterResolutionError: FakeResolutionError,
  resolveSavedCostFilters: (...args: unknown[]) => mockResolveSaved(...args),
}));

const mockLoadConversionContext = vi.fn(async () => ({
  displayCurrency: null as string | null,
  rates: [] as unknown[],
}));
const mockListRates = vi.fn(async () => [] as unknown[]);
vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  loadConversionContext: (...args: unknown[]) => mockLoadConversionContext(...(args as [])),
  listOrgExchangeRates: (...args: unknown[]) => mockListRates(...(args as [])),
}));

const mockGetBusinessMetric = vi.fn();
vi.mock("../business-metrics", () => ({
  getBusinessMetric: (...args: unknown[]) => mockGetBusinessMetric(...args),
}));

vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../../plugins/loader", () => ({
  getPlugin: vi.fn(async () => null),
  loadPlugins: vi.fn(async () => []),
}));

const { runUnitCostQuery, BusinessMetricNotFoundError } = await import("../unit-cost-query");
const { CostQueryError } = await import("../cost-query");

const scopeFilter: CostFilter = { dimension: "service", op: "in", values: ["AmazonEC2"] };

function metric(overrides: Partial<BusinessMetric> = {}): BusinessMetric {
  return {
    id: "m1",
    key: "active-customers",
    name: "Active customers",
    unit: "customer",
    description: null,
    kind: "count",
    currency: null,
    costScope: [scopeFilter],
    savedFilterId: null,
    createdByUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    coverage: null,
    ...overrides,
  };
}

const request = { from: "2026-07-01", to: "2026-07-02", binning: "daily" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBusinessMetric.mockResolvedValue(metric());
  mockQueryCosts.mockResolvedValue([
    {
      key: "",
      currency: "USD",
      points: [
        { bucket: "2026-07-01", amount: 100 },
        { bucket: "2026-07-02", amount: 200 },
      ],
    },
  ]);
  mockGetMetricValues.mockResolvedValue([
    { day: "2026-07-01", value: 10 },
    { day: "2026-07-02", value: 20 },
  ]);
  mockLoadConversionContext.mockResolvedValue({ displayCurrency: null, rates: [] });
  mockListRates.mockResolvedValue([]);
});

describe("runUnitCostQuery — the numerator's scope", () => {
  it("runs the metric's own cost scope", async () => {
    await runUnitCostQuery("org1", "active-customers", request);
    expect(mockQueryCosts.mock.calls[0]?.[1].filters).toEqual([scopeFilter]);
  });

  it("AND-composes a request's filters on top of the scope, never replacing it", async () => {
    const narrower: CostFilter = { dimension: "region", op: "in", values: ["us-east-1"] };
    await runUnitCostQuery("org1", "active-customers", { ...request, filters: [narrower] });
    // Both, in that order. A request that could drop the scope would answer a
    // different question under the same metric's name.
    expect(mockQueryCosts.mock.calls[0]?.[1].filters).toEqual([scopeFilter, narrower]);
  });

  it("compiles query text into the same composition", async () => {
    await runUnitCostQuery("org1", "active-customers", {
      ...request,
      query: "provider = 'aws'",
    });
    expect(mockQueryCosts.mock.calls[0]?.[1].filters).toEqual([
      scopeFilter,
      { dimension: "provider", op: "in", values: ["aws"] },
    ]);
  });

  it("refuses both spellings at once rather than picking one", async () => {
    await expect(
      runUnitCostQuery("org1", "active-customers", {
        ...request,
        filters: [scopeFilter],
        query: "provider = 'aws'",
      }),
    ).rejects.toBeInstanceOf(CostQueryError);
  });

  it("errors when the metric's saved filter cannot be resolved", async () => {
    mockGetBusinessMetric.mockResolvedValue(metric({ savedFilterId: "sf1" }));
    mockResolveSaved.mockRejectedValue(new FakeResolutionError("gone"));
    // Never a fall-through to unfiltered spend: a numerator that quietly
    // widened to the whole estate would inflate every unit cost on the chart
    // while looking entirely normal.
    await expect(runUnitCostQuery("org1", "active-customers", request)).rejects.toBeInstanceOf(
      CostQueryError,
    );
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("never asks ClickHouse to group — a per-group ratio has no denominator", async () => {
    await runUnitCostQuery("org1", "active-customers", request);
    expect(mockQueryCosts.mock.calls[0]?.[1].groupBy).toBe("none");
  });

  it("404s a metric that does not exist", async () => {
    mockGetBusinessMetric.mockResolvedValue(null);
    await expect(runUnitCostQuery("org1", "nope", request)).rejects.toBeInstanceOf(
      BusinessMetricNotFoundError,
    );
  });
});

describe("runUnitCostQuery — the ratio", () => {
  it("divides at the bucket and reports the metric alongside", async () => {
    const res = await runUnitCostQuery("org1", "active-customers", request);
    expect(res.metric.key).toBe("active-customers");
    expect(res.mode).toBe("unit_cost");
    expect(res.series[0]!.points.map((p) => p.value)).toEqual([10, 10]);
    expect(res.series[0]!.overallValue).toBe(10); // 300 / 30
  });

  it("returns a gap, not a zero, for a day with no reported value", async () => {
    mockGetMetricValues.mockResolvedValue([{ day: "2026-07-01", value: 10 }]);
    const res = await runUnitCostQuery("org1", "active-customers", request);
    const second = res.series[0]!.points[1]!;
    expect(second.value).toBeNull();
    expect(second.gap).toBe("no_metric_value");
    expect(res.gapBuckets).toBe(1);
    // And the unmatched spend stays out of the period figure.
    expect(res.series[0]!.overallValue).toBe(10);
  });
});

describe("runUnitCostQuery — margin", () => {
  const revenue = metric({
    id: "m2",
    key: "mrr",
    name: "MRR",
    unit: "USD",
    kind: "currency",
    currency: "USD",
    costScope: [],
  });

  it("refuses margin against a count metric", async () => {
    await expect(
      runUnitCostQuery("org1", "active-customers", { ...request, mode: "margin" }),
    ).rejects.toThrow(/Margin needs a revenue metric/);
  });

  it("computes margin against a revenue metric", async () => {
    mockGetBusinessMetric.mockResolvedValue(revenue);
    mockGetMetricValues.mockResolvedValue([
      { day: "2026-07-01", value: 1000 },
      { day: "2026-07-02", value: 1000 },
    ]);
    const res = await runUnitCostQuery("org1", "mrr", { ...request, mode: "margin" });
    expect(res.mode).toBe("margin");
    expect(res.series[0]!.points[0]!.value).toBeCloseTo(0.9, 10); // (1000-100)/1000
    expect(res.series[0]!.points[1]!.value).toBeCloseTo(0.8, 10);
  });

  it("converts toward the metric's currency, not the org's display currency", async () => {
    mockGetBusinessMetric.mockResolvedValue(revenue);
    // The display-currency gate would refuse anything but the org's configured
    // currency; margin has to bypass it because subtracting spend from revenue
    // is only defined in the metric's own currency.
    await runUnitCostQuery("org1", "mrr", { ...request, mode: "margin", displayCurrency: "EUR" });
    expect(mockLoadConversionContext).not.toHaveBeenCalled();
    expect(mockListRates).toHaveBeenCalledWith("org1");
  });

  it("gaps spend in a currency it has no rate for rather than dropping it", async () => {
    mockGetBusinessMetric.mockResolvedValue(revenue);
    mockGetMetricValues.mockResolvedValue([{ day: "2026-07-01", value: 1000 }]);
    mockQueryCosts.mockResolvedValue([
      { key: "", currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
      { key: "", currency: "JPY", points: [{ bucket: "2026-07-01", amount: 50_000 }] },
    ]);
    const res = await runUnitCostQuery("org1", "mrr", {
      from: "2026-07-01",
      to: "2026-07-01",
      binning: "daily",
      mode: "margin",
    });
    expect(res.series).toHaveLength(2);
    expect(res.series[0]!.points[0]!.value).toBeCloseTo(0.9, 10);
    // Silently ignoring the yen would overstate margin; folding it into the
    // dollars would invent a number. It becomes a named gap instead.
    expect(res.series[1]!.points[0]!.value).toBeNull();
    expect(res.series[1]!.points[0]!.gap).toBe("unconvertible_currency");
  });
});

describe("runUnitCostQuery — display currency for unit costs", () => {
  it("goes through the org's opt-in display-currency policy", async () => {
    await runUnitCostQuery("org1", "active-customers", { ...request, displayCurrency: "USD" });
    expect(mockLoadConversionContext).toHaveBeenCalledWith("org1", "USD");
  });

  it("leaves an unconvertible currency as its own series rather than dropping it", async () => {
    mockQueryCosts.mockResolvedValue([
      { key: "", currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
      { key: "", currency: "JPY", points: [{ bucket: "2026-07-01", amount: 50_000 }] },
    ]);
    mockGetMetricValues.mockResolvedValue([{ day: "2026-07-01", value: 10 }]);
    const res = await runUnitCostQuery("org1", "active-customers", {
      from: "2026-07-01",
      to: "2026-07-01",
      binning: "daily",
    });
    expect(res.series.map((s) => s.currency)).toEqual(["USD", "JPY"]);
    expect(res.series[0]!.points[0]!.value).toBe(10);
    expect(res.series[1]!.points[0]!.value).toBe(5000);
  });
});

describe("runUnitCostQuery — range guards", () => {
  it("refuses an inverted range", async () => {
    await expect(
      runUnitCostQuery("org1", "active-customers", { ...request, from: "2026-08-01" }),
    ).rejects.toThrow(/from must not be after to/);
  });

  it("refuses a range no chart could read", async () => {
    await expect(
      runUnitCostQuery("org1", "active-customers", {
        from: "2020-01-01",
        to: "2026-01-01",
        binning: "daily",
      }),
    ).rejects.toThrow(/Date range too large/);
  });
});
