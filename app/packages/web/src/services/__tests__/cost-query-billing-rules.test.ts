import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `runCostQuery`'s raw-vs-adjusted contract — the properties every surface
 * relies on to label a number honestly.
 *
 * 1. **Absent `adjusted` is byte-identical to before billing rules existed.**
 *    The rules table is not even read, the reader gets no `adjustments`, and no
 *    `adjustment` field comes back. Every unattended reader (budgets, anomaly
 *    detection, change alerts, the digest, cost exports) lives on this path.
 * 2. **`adjusted` always produces an `adjustment` block**, even for an
 *    organisation with no rules — its absence must mean "collected" and nothing
 *    else, so an org with no rules must not be able to fake it.
 * 3. **`rawTotals` is the collected figure for the same rows**, carried out of
 *    the same scan, so nothing can render an adjusted total without it.
 * 4. **`totals` stays the sum of the series.** Fixed-amount charges are
 *    reported separately, because they have no series behind them and every
 *    existing client sums the series to get the total.
 */

const mockQueryCosts = vi.fn();
vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  queryCosts: (...args: unknown[]) => mockQueryCosts(...args),
  getCostCoverage: vi.fn(async () => new Map()),
  getCostDimensionValues: vi.fn(async () => []),
  getCostTagKeys: vi.fn(async () => []),
}));

const mockResolveBilling = vi.fn();
vi.mock("@infrawrench/server-core/cost/billing-rules", () => ({
  resolveBillingAdjustments: (...args: unknown[]) => mockResolveBilling(...args),
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
vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  loadConversionContext: vi.fn(async () => ({ displayCurrency: null, rates: [] })),
}));
vi.mock("@infrawrench/server-core/cost/forecast", () => ({ forecastDaily: vi.fn(() => []) }));
vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../../plugins/loader", () => ({
  getPlugin: vi.fn(async () => null),
  loadPlugins: vi.fn(async () => []),
}));

const { runCostQuery } = await import("../cost-query");

const baseRequest = {
  from: "2026-09-01",
  to: "2026-09-30",
  binning: "daily" as const,
  groupBy: "none" as const,
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  forecast: false,
};

/** One ungrouped USD series: $120 adjusted over $100 collected. */
const adjustedGroups = [
  {
    key: "",
    currency: "USD",
    points: [
      { bucket: "2026-09-01", amount: 60 },
      { bucket: "2026-09-02", amount: 60 },
    ],
    rawPoints: [
      { bucket: "2026-09-01", amount: 50 },
      { bucket: "2026-09-02", amount: 50 },
    ],
  },
];

const MARKUP = {
  adjustments: {
    factors: [{ ruleId: "r1", name: "Overhead", match: {}, factor: 1.2 }],
    reallocations: [],
    fixed: [],
  },
  rules: [
    { id: "r1", name: "Overhead", kind: "percentage" as const, summary: "+20% on all spend" },
  ],
};

const EMPTY = { adjustments: { factors: [], reallocations: [], fixed: [] }, rules: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryCosts.mockResolvedValue([]);
  mockResolveBilling.mockResolvedValue(MARKUP);
});

describe("an unadjusted query", () => {
  it("never reads the rules table and returns no adjustment block", async () => {
    mockQueryCosts.mockResolvedValue([
      { key: "", currency: "USD", points: [{ bucket: "2026-09-01", amount: 50 }] },
    ]);
    const res = await runCostQuery("org-1", baseRequest);

    expect(mockResolveBilling).not.toHaveBeenCalled();
    expect(mockQueryCosts.mock.calls[0]![1]).not.toHaveProperty("adjustments");
    expect(res.adjustment).toBeUndefined();
    expect(res.totals).toEqual({ USD: 50 });
  });
});

describe("an adjusted query", () => {
  it("compiles the rules into the reader's query rather than post-processing", async () => {
    mockQueryCosts.mockResolvedValue(adjustedGroups);
    await runCostQuery("org-1", { ...baseRequest, adjusted: true });

    expect(mockResolveBilling).toHaveBeenCalledWith("org-1");
    expect(mockQueryCosts.mock.calls[0]![1]).toMatchObject({
      adjustments: MARKUP.adjustments,
    });
  });

  it("returns the collected totals beside the adjusted ones, and names the rules", async () => {
    mockQueryCosts.mockResolvedValue(adjustedGroups);
    const res = await runCostQuery("org-1", { ...baseRequest, adjusted: true });

    expect(res.totals).toEqual({ USD: 120 });
    expect(res.adjustment?.rawTotals).toEqual({ USD: 100 });
    expect(res.adjustment?.rules.map((r) => r.name)).toEqual(["Overhead"]);
  });

  it("still returns an adjustment block when the org has no rules", async () => {
    // The absence of this field is the only signal that a figure is collected,
    // so "adjusted, but nothing applied" must be distinguishable from
    // "unadjusted" — and the raw totals are then simply the totals.
    mockResolveBilling.mockResolvedValue(EMPTY);
    mockQueryCosts.mockResolvedValue([
      { key: "", currency: "USD", points: [{ bucket: "2026-09-01", amount: 42 }] },
    ]);
    const res = await runCostQuery("org-1", { ...baseRequest, adjusted: true });

    expect(mockQueryCosts.mock.calls[0]![1]).not.toHaveProperty("adjustments");
    expect(res.adjustment).toEqual({ rules: [], rawTotals: { USD: 42 }, fixedTotals: {} });
  });

  it("keeps totals equal to the sum of the series, reporting fixed charges apart", async () => {
    // $2,000/month over a whole 30-day September, plus a marked-up series. The
    // total must stay the sum of the bars drawn; the internal figure is the
    // total plus fixedTotals, and saying so is cheaper than a total nobody can
    // add up from the chart.
    mockResolveBilling.mockResolvedValue({
      adjustments: {
        factors: [],
        reallocations: [],
        fixed: [
          {
            ruleId: "f1",
            name: "Platform overhead",
            amount: 2000,
            currency: "USD",
            period: "monthly",
            targetKind: null,
            targetId: null,
          },
        ],
      },
      rules: [
        { id: "f1", name: "Platform overhead", kind: "fixed" as const, summary: "2000 USD/month" },
      ],
    });
    mockQueryCosts.mockResolvedValue([
      {
        key: "",
        currency: "USD",
        points: [{ bucket: "2026-09-01", amount: 500 }],
        rawPoints: [{ bucket: "2026-09-01", amount: 500 }],
      },
    ]);
    const res = await runCostQuery("org-1", { ...baseRequest, adjusted: true });

    expect(res.totals).toEqual({ USD: 500 });
    expect(res.adjustment?.fixedTotals).toEqual({ USD: 2000 });
  });

  it("pro-rates a monthly fixed charge over a partial range", async () => {
    mockResolveBilling.mockResolvedValue({
      adjustments: {
        factors: [],
        reallocations: [],
        fixed: [
          {
            ruleId: "f1",
            name: "Platform overhead",
            amount: 3000,
            currency: "USD",
            period: "monthly",
            targetKind: null,
            targetId: null,
          },
        ],
      },
      rules: [],
    });
    const res = await runCostQuery("org-1", {
      ...baseRequest,
      to: "2026-09-10",
      adjusted: true,
    });
    expect(res.adjustment?.fixedTotals["USD"]).toBeCloseTo(1000, 6);
  });

  it("measures the comparison period on the same basis", async () => {
    // A previous period judged on collected spend against a current one judged
    // on adjusted spend would report a spend change that is really a policy
    // change.
    mockQueryCosts.mockResolvedValue(adjustedGroups);
    await runCostQuery("org-1", {
      ...baseRequest,
      adjusted: true,
      comparePreviousPeriod: true,
    });
    expect(mockQueryCosts).toHaveBeenCalledTimes(2);
    expect(mockQueryCosts.mock.calls[1]![1]).toMatchObject({ adjustments: MARKUP.adjustments });
  });

  it("fits the forecast on the line it is drawn under", async () => {
    mockQueryCosts.mockResolvedValue(adjustedGroups);
    await runCostQuery("org-1", { ...baseRequest, adjusted: true, forecast: true });
    const fitCall = mockQueryCosts.mock.calls.at(-1)![1];
    expect(fitCall).toMatchObject({ adjustments: MARKUP.adjustments });
  });
});
