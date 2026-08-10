import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CostFilter } from "@infrawrench/client-core";

/**
 * `runCostQuery`'s saved-filter semantics — the two properties the feature
 * hangs on:
 *
 * 1. a `savedFilterId` is resolved server-side and **AND-composed** with the
 *    inline filters (structured or query text), so "the saved prod scope,
 *    narrowed to one service" is one reference plus one row; and
 * 2. a reference that fails to resolve **errors the query** — it must never
 *    fall through to unfiltered spend, because unfiltered totals silently
 *    standing in for "prod only" is the one failure the feature exists to
 *    prevent.
 *
 * Everything stateful is mocked; what is asserted is the exact filter list
 * handed to the ClickHouse reader, which is the only place filters take
 * effect.
 */

const mockQueryCosts = vi.fn();
vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  queryCosts: (...args: unknown[]) => mockQueryCosts(...args),
  getCostCoverage: vi.fn(async () => new Map()),
  getCostDimensionValues: vi.fn(async () => []),
  getCostTagKeys: vi.fn(async () => []),
}));

class FakeResolutionError extends Error {
  constructor(readonly savedFilterId: string) {
    super(`Saved cost filter ${savedFilterId} not found`);
  }
}
const mockResolve = vi.fn();
// The billing-rule resolver reaches Postgres at import time. None of these
// cases asks for an adjusted query, so it is never called — it only has to
// exist for the module graph to load.
vi.mock("@infrawrench/server-core/cost/billing-rules", () => ({
  resolveBillingAdjustments: vi.fn(),
}));

vi.mock("@infrawrench/server-core/cost/saved-filters", () => ({
  SavedCostFilterResolutionError: FakeResolutionError,
  resolveSavedCostFilters: (...args: unknown[]) => mockResolve(...args),
}));

// Kept out of these tests' import graph: the scenario resolver reaches
// Postgres, and none of these cases apply a scenario.
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
vi.mock("@infrawrench/server-core/cost/forecast", () => ({
  forecastDaily: vi.fn(() => []),
}));
vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../../plugins/loader", () => ({
  getPlugin: vi.fn(async () => null),
  loadPlugins: vi.fn(async () => []),
}));

const { runCostQuery, CostQueryError } = await import("../cost-query");

const savedFilters: CostFilter[] = [
  { dimension: "tag", op: "in", values: ["prod"], tagKey: "env" },
];
const inlineFilter: CostFilter = { dimension: "service", op: "in", values: ["AmazonEC2"] };

const baseRequest = {
  from: "2026-07-01",
  to: "2026-07-31",
  binning: "daily" as const,
  groupBy: "none" as const,
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  forecast: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryCosts.mockResolvedValue([]);
  mockResolve.mockResolvedValue(savedFilters);
});

describe("runCostQuery with a savedFilterId", () => {
  it("resolves the reference and runs its filters", async () => {
    await runCostQuery("org-1", { ...baseRequest, savedFilterId: "sf-1" });
    expect(mockResolve).toHaveBeenCalledWith("org-1", "sf-1");
    expect(mockQueryCosts).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ filters: savedFilters }),
    );
  });

  it("AND-composes the saved filter with inline structured filters", async () => {
    await runCostQuery("org-1", {
      ...baseRequest,
      filters: [inlineFilter],
      savedFilterId: "sf-1",
    });
    expect(mockQueryCosts).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ filters: [...savedFilters, inlineFilter] }),
    );
  });

  it("AND-composes the saved filter with a text query too", async () => {
    await runCostQuery("org-1", {
      ...baseRequest,
      query: "service = 'AmazonEC2'",
      savedFilterId: "sf-1",
    });
    expect(mockQueryCosts).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ filters: [...savedFilters, inlineFilter] }),
    );
  });

  it("fits the forecast on the composed filters, not the raw request's", async () => {
    // A projection fitted on unfiltered spend would trend money the chart
    // excludes; the fit query must see exactly what the main query saw.
    mockQueryCosts.mockResolvedValue([
      {
        key: "",
        currency: "USD",
        points: [{ bucket: "2026-07-30", amount: 10 }],
      },
    ]);
    await runCostQuery("org-1", { ...baseRequest, forecast: true, savedFilterId: "sf-1" });
    for (const call of mockQueryCosts.mock.calls) {
      expect((call[1] as { filters: unknown }).filters).toEqual(savedFilters);
    }
  });

  it("errors — and never queries — when the reference does not resolve", async () => {
    mockResolve.mockRejectedValue(new FakeResolutionError("sf-gone"));
    await expect(
      runCostQuery("org-1", { ...baseRequest, savedFilterId: "sf-gone" }),
    ).rejects.toBeInstanceOf(CostQueryError);
    // The load-bearing half of the assertion: no fallback query ran, so a
    // broken reference can never silently answer with unfiltered spend.
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("leaves requests without a savedFilterId exactly as before", async () => {
    await runCostQuery("org-1", { ...baseRequest, filters: [inlineFilter] });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockQueryCosts).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ filters: [inlineFilter] }),
    );
  });
});
