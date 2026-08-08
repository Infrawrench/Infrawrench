import { describe, expect, it } from "vitest";
import {
  binForecast,
  costAnomalyDeltaPercent,
  costQueryForConfig,
  emptyCostAccounts,
  estimatedCostAccounts,
  failingCostAccounts,
  formatBucketLabel,
  formatBudgetMonth,
  resolveCostDateRange,
  totalPerBucket,
  COST_BASES,
  COST_BASIS_LABELS,
  COST_CHARGE_TYPES,
  COST_CHARGE_TYPE_LABELS,
  COST_DIMENSIONS,
  COST_DIMENSION_LABELS,
  type CostAccountStatus,
  type CostAnomaly,
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

  it("omits costBasis when the config has none, and carries whichever it has", () => {
    // A widget authored before the basis existed must keep sending the exact
    // request it always sent, so an unset basis is absent rather than "cash".
    expect("costBasis" in costQueryForConfig(config)).toBe(false);
    // A basis the author actually chose is sent, cash included.
    expect(costQueryForConfig({ ...config, costBasis: "cash" }).costBasis).toBe("cash");
    expect(costQueryForConfig({ ...config, costBasis: "amortized" }).costBasis).toBe("amortized");
  });
});

describe("charge types and cost bases", () => {
  it("labels every charge type and every basis", () => {
    for (const t of COST_CHARGE_TYPES) {
      expect(COST_CHARGE_TYPE_LABELS[t]).toBeTruthy();
    }
    for (const b of COST_BASES) {
      expect(COST_BASIS_LABELS[b]).toBeTruthy();
    }
    expect(Object.keys(COST_CHARGE_TYPE_LABELS).sort()).toEqual([...COST_CHARGE_TYPES].sort());
    expect(Object.keys(COST_BASIS_LABELS).sort()).toEqual([...COST_BASES].sort());
  });

  it("keeps usage first — it is the default every untyped row reads as", () => {
    expect(COST_CHARGE_TYPES[0]).toBe("usage");
    expect(COST_BASES[0]).toBe("cash");
  });

  it("exposes charge type and commitment as groupable dimensions, with labels", () => {
    expect(COST_DIMENSIONS).toContain("charge_type");
    expect(COST_DIMENSIONS).toContain("commitment");
    // Every dimension is labelled: the pickers render straight off this map, so
    // a missing entry is a blank option rather than a type error at the call.
    for (const d of COST_DIMENSIONS) {
      expect(COST_DIMENSION_LABELS[d]).toBeTruthy();
    }
    expect(COST_DIMENSION_LABELS.charge_type).toBe("Charge type");
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
    chargeTypes: false,
    amortization: false,
    estimated: false,
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

  describe("emptyCostAccounts", () => {
    const polled = { costLastPolledAt: "2026-07-28T00:00:00.000Z" };

    it("keeps an account that collected cleanly and ingested nothing", () => {
      const waiting = account({ ...polled });
      expect(emptyCostAccounts([waiting])).toEqual([waiting]);
    });

    it("drops an account that has data", () => {
      const covered = account({
        ...polled,
        coverage: { firstDay: "2026-07-01", lastDay: "2026-07-27" },
      });
      expect(emptyCostAccounts([covered])).toEqual([]);
    });

    it("drops an account that has never been polled", () => {
      expect(emptyCostAccounts([account({})])).toEqual([]);
    });

    it("drops accounts that are failing or have no cost support", () => {
      expect(
        emptyCostAccounts([
          account({ ...polled, costPollError: { message: "denied", helpLink: null } }),
          account({ ...polled, supportsCosts: false }),
        ]),
      ).toEqual([]);
    });
  });

  describe("estimatedCostAccounts", () => {
    it("keeps cost-capable accounts whose spend was computed, not billed", () => {
      const priced = account({ estimated: true });
      expect(
        estimatedCostAccounts([
          account({}),
          priced,
          // No cost capability contributes no spend at all, estimated or not.
          account({ supportsCosts: false, estimated: true }),
        ]),
      ).toEqual([priced]);
    });

    it("says nothing about an account whose provider reports real spend", () => {
      expect(estimatedCostAccounts([account({}), account({ amortization: true })])).toEqual([]);
    });

    it("flags an estimating account that is otherwise perfectly healthy", () => {
      // The point of the notice: this account has coverage, no error, and a
      // recent poll, so nothing else on any surface would mention it.
      const healthy = account({
        estimated: true,
        costLastPolledAt: "2026-07-28T00:00:00.000Z",
        coverage: { firstDay: "2026-07-01", lastDay: "2026-07-28" },
      });
      expect(estimatedCostAccounts([healthy])).toEqual([healthy]);
      expect(failingCostAccounts([healthy])).toEqual([]);
      expect(emptyCostAccounts([healthy])).toEqual([]);
    });
  });
});

describe("costAnomalyDeltaPercent", () => {
  const anomaly = (over: Partial<CostAnomaly>): CostAnomaly => ({
    id: "a1",
    day: "2026-07-28",
    kind: "spike",
    dimension: "provider",
    dimensionKey: "aws",
    currency: "USD",
    actualCents: 3000,
    baselineCents: 1000,
    thresholdCents: 2000,
    detectedAt: "2026-07-29T02:00:00.000Z",
    notifiedAt: null,
    ...over,
  });

  it("reports the rise over the baseline for a spike", () => {
    expect(costAnomalyDeltaPercent(anomaly({}))).toBe("+200%");
  });

  it("never reports a percentage for a new spend source", () => {
    // Even with a non-zero stored baseline: a window of sub-cent trial usage
    // rounds to a cent, and 5000/1 is a meaningless six-figure percentage.
    expect(costAnomalyDeltaPercent(anomaly({ kind: "new_source", baselineCents: 1 }))).toBeNull();
    expect(costAnomalyDeltaPercent(anomaly({ kind: "new_source", baselineCents: 0 }))).toBeNull();
  });

  it("returns null rather than Infinity or NaN for a zero or negative baseline", () => {
    expect(costAnomalyDeltaPercent(anomaly({ baselineCents: 0 }))).toBeNull();
    expect(costAnomalyDeltaPercent(anomaly({ baselineCents: -100 }))).toBeNull();
    expect(costAnomalyDeltaPercent(anomaly({ baselineCents: Number.NaN }))).toBeNull();
  });
});
