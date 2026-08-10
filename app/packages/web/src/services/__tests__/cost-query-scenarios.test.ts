import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CostScenarioAdjustment, CostScenarioModel } from "@infrawrench/client-core";

/**
 * `runCostQuery`'s scenario semantics — the properties the feature hangs on,
 * asserted against the real composition engine and the real orchestration, with
 * only the stores mocked:
 *
 * 1. **history is never modified** — the drawn series come back byte-identical
 *    whether or not a scenario is applied;
 * 2. **both projections are retrievable** — `forecast` stays the unadjusted
 *    trend and `scenario.points` is the adjusted one, always side by side;
 * 3. **overlapping adjustments compose in the defined order** — rate changes
 *    against the trend first, absolute amounts added afterwards;
 * 4. **a scoped scenario does not touch out-of-scope spend**; and
 * 5. a scenario with no forecast, or one that fails to resolve, is an **error**
 *    rather than a silently unadjusted answer.
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
  loadConversionContext: vi.fn(async () => ({ displayCurrency: null, rates: [] })),
}));

// The one piece of the scenario path that needs Postgres. Everything else —
// the sub-scope fits, the currency resolution, the composition — runs for real.
const mockResolveModel = vi.fn();
vi.mock("@infrawrench/server-core/db/client", () => ({ db: {} }));
vi.mock("@infrawrench/server-core/cost/scenario-forecast", async () => {
  const actual = await vi.importActual<
    typeof import("@infrawrench/server-core/cost/scenario-forecast")
  >("@infrawrench/server-core/cost/scenario-forecast");
  return { ...actual, resolveCostScenarioModel: (...args: unknown[]) => mockResolveModel(...args) };
});

vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../../plugins/loader", () => ({
  getPlugin: vi.fn(async () => null),
  loadPlugins: vi.fn(async () => []),
}));

const { runCostQuery, CostQueryError } = await import("../cost-query");

const FROM = "2026-08-01";
const TO = "2026-08-30";
/** The horizon `runCostQuery` picks for a 30-day range with data through `TO`. */
const FORECAST_DAYS = 8;

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** The drawn series — flat $10/day of AWS spend and $10/day of GCP. */
const drawnSeries = [
  {
    key: "aws",
    currency: "USD",
    points: daysBetween(FROM, TO).map((bucket) => ({ bucket, amount: 4 })),
  },
  {
    key: "gcp",
    currency: "USD",
    points: daysBetween(FROM, TO).map((bucket) => ({ bucket, amount: 6 })),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryCosts.mockImplementation(
    (_org: string, q: { groupBy: string; from: string; to: string; filters?: unknown[] }) => {
      // The drawn query.
      if (q.groupBy === "provider") return drawnSeries;
      // A fit — the whole chart, or one adjustment's scope. Flat, so the
      // least-squares trend is exactly the daily amount and the arithmetic
      // below is readable rather than approximate.
      const scoped = (q.filters ?? []).length > 0;
      return [
        {
          key: "",
          currency: "USD",
          points: daysBetween(q.from, q.to).map((bucket) => ({
            bucket,
            amount: scoped ? 4 : 10,
          })),
        },
      ];
    },
  );
});

function adjustment(over: Partial<CostScenarioAdjustment>): CostScenarioAdjustment {
  return {
    id: "a1",
    label: "Adjustment",
    kind: "one_off",
    startDate: "2026-09-01",
    endDate: null,
    amountCents: 10_000,
    currency: "USD",
    period: null,
    percent: null,
    scope: [],
    ...over,
  };
}

function model(adjustments: CostScenarioAdjustment[]): CostScenarioModel {
  return {
    id: "model-1",
    name: "Q4 plan",
    description: null,
    currency: "USD",
    adjustments,
    createdByUserId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

const baseRequest = {
  from: FROM,
  to: TO,
  binning: "daily" as const,
  groupBy: "provider" as const,
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  forecast: true,
};

describe("runCostQuery with a scenario model", () => {
  it("leaves recorded history untouched and returns both projections", async () => {
    mockResolveModel.mockResolvedValue(model([adjustment({ amountCents: 50_000 })]));

    const withScenario = await runCostQuery("org1", {
      ...baseRequest,
      scenarioModelId: "model-1",
    });
    const withoutScenario = await runCostQuery("org1", baseRequest);

    // 1. The drawn series are identical with and without the scenario. A
    //    scenario only ever extends or modifies the *projected* region.
    expect(withScenario.series).toEqual(withoutScenario.series);
    expect(withScenario.totals).toEqual(withoutScenario.totals);

    // 2. The trend is still the trend, and the adjusted line is beside it.
    expect(withScenario.forecast).toEqual(withoutScenario.forecast);
    expect(withScenario.forecast).toHaveLength(FORECAST_DAYS);
    expect(withScenario.scenario?.points).toHaveLength(FORECAST_DAYS);
    expect(withScenario.scenario?.modelName).toBe("Q4 plan");

    // The $500 lands on its own day only; every other projected day is the
    // untouched trend of $10.
    const byDay = new Map(withScenario.scenario!.points.map((p) => [p.bucket, p.amount]));
    expect(byDay.get("2026-09-01")).toBe(510);
    expect(byDay.get("2026-09-02")).toBe(10);
    expect(withScenario.scenario!.totalDelta).toBe(500);
  });

  it("ignores an adjustment that falls entirely inside recorded history", async () => {
    // Dated in the middle of the drawn range: a real thing to describe, and it
    // must not restate a single day of collected spend.
    mockResolveModel.mockResolvedValue(
      model([adjustment({ startDate: "2026-08-15", amountCents: 500_000 })]),
    );
    const response = await runCostQuery("org1", { ...baseRequest, scenarioModelId: "model-1" });
    const plain = await runCostQuery("org1", baseRequest);

    expect(response.series).toEqual(plain.series);
    expect(response.scenario!.totalDelta).toBe(0);
    expect(response.scenario!.points.every((p) => p.amount === 10)).toBe(true);
  });

  it("applies rate changes to the trend before adding absolute amounts", async () => {
    // −50% of the $10/day trend is $5; the $200 one-off is added on top of the
    // re-rated day, not discounted by it. Amounts-first would give $105.
    mockResolveModel.mockResolvedValue(
      model([
        adjustment({ id: "buy", label: "Licence", amountCents: 20_000, startDate: "2026-09-01" }),
        adjustment({
          id: "cut",
          label: "Migration",
          kind: "rate_change",
          percent: -50,
          amountCents: null,
          currency: null,
          startDate: "2026-08-31",
        }),
      ]),
    );
    const response = await runCostQuery("org1", { ...baseRequest, scenarioModelId: "model-1" });
    const byDay = new Map(response.scenario!.points.map((p) => [p.bucket, p.amount]));
    expect(byDay.get("2026-08-31")).toBe(5);
    expect(byDay.get("2026-09-01")).toBe(205);
  });

  it("measures a scoped rate change against its own sub-baseline only", async () => {
    // The chart trends at $10/day; the AWS slice trends at $4. −50% on AWS
    // takes $2 off, never $5 — the other $6 is out of scope.
    mockResolveModel.mockResolvedValue(
      model([
        adjustment({
          id: "aws-cut",
          label: "AWS migration",
          kind: "rate_change",
          percent: -50,
          amountCents: null,
          currency: null,
          startDate: "2026-08-31",
          scope: [{ dimension: "provider", op: "in", values: ["aws"] }],
        }),
      ]),
    );
    const response = await runCostQuery("org1", { ...baseRequest, scenarioModelId: "model-1" });
    expect(response.scenario!.points.every((p) => p.amount === 8)).toBe(true);

    // The sub-baseline was fetched with the scope AND-composed onto the
    // chart's own filters, not in place of them.
    const scopedFit = mockQueryCosts.mock.calls
      .map(([, q]) => q as { filters?: unknown[]; groupBy: string })
      .find((q) => q.groupBy === "none" && (q.filters ?? []).length > 0);
    expect(scopedFit?.filters).toEqual([{ dimension: "provider", op: "in", values: ["aws"] }]);
  });

  it("leaves an amount out when the chart's filters exclude its scope, and says so", async () => {
    mockResolveModel.mockResolvedValue(
      model([
        adjustment({
          label: "GCP commitment",
          amountCents: 4_000_000,
          scope: [{ dimension: "provider", op: "in", values: ["gcp"] }],
        }),
      ]),
    );
    const response = await runCostQuery("org1", {
      ...baseRequest,
      filters: [{ dimension: "provider", op: "in", values: ["aws"] }],
      scenarioModelId: "model-1",
    });

    expect(response.scenario!.totalDelta).toBe(0);
    expect(response.scenario!.outOfScope).toEqual(["GCP commitment"]);
  });

  it("refuses a scenario with no forecast to adjust", async () => {
    await expect(
      runCostQuery("org1", { ...baseRequest, forecast: false, scenarioModelId: "model-1" }),
    ).rejects.toBeInstanceOf(CostQueryError);
    // The model is never even loaded — the request is wrong before that matters.
    expect(mockResolveModel).not.toHaveBeenCalled();
  });

  it("errors rather than quietly returning an unadjusted projection", async () => {
    const { CostScenarioResolutionError } =
      await import("@infrawrench/server-core/cost/scenario-forecast");
    mockResolveModel.mockRejectedValue(new CostScenarioResolutionError("model-1"));
    await expect(
      runCostQuery("org1", { ...baseRequest, scenarioModelId: "model-1" }),
    ).rejects.toBeInstanceOf(CostQueryError);
  });
});
