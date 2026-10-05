import { describe, expect, it } from "vitest";
import { AVERAGE_DAYS_PER_MONTH, type AllocationRule } from "@infrawrench/client-core";

import {
  aggregateRealizedSavings,
  attributeCostCentre,
  computeCommitmentRealization,
  computeRealization,
  horizonEnd,
  type RealizationInput,
} from "../savings/math";

function flat(from: string, to: string, amount: number): Array<{ day: string; amount: number }> {
  const out: Array<{ day: string; amount: number }> = [];
  const d = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (d <= end) {
    out.push({ day: d.toISOString().slice(0, 10), amount });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function input(overrides: Partial<RealizationInput> = {}): RealizationInput {
  return {
    kind: "rightsizing",
    occurredOn: "2026-06-15",
    endedOn: null,
    horizonDays: 365,
    today: "2026-06-26",
    range: { from: "2026-01-01", to: "2026-06-25" },
    baselineWindowDays: 14,
    shortfallThreshold: 0.7,
    coverage: { firstDay: "2026-01-01", lastDay: "2026-06-25" },
    series: [],
    costAddressable: true,
    periodNative: false,
    projectedMonthly: null,
    currency: "USD",
    baselineDailyEstimate: null,
    postDailyEstimate: null,
    offFraction: null,
    manual: false,
    ...overrides,
  };
}

describe("computeRealization (billing basis)", () => {
  it("accrues baseline minus actual from the day after the action", () => {
    const r = computeRealization(
      input({
        series: [
          {
            currency: "USD",
            points: [
              ...flat("2026-06-01", "2026-06-14", 10),
              ...flat("2026-06-16", "2026-06-25", 4),
            ],
          },
        ],
      }),
    );
    expect(r.basis).toBe("billing");
    expect(r.baselinePerDay).toBe(10);
    expect(r.accruedDays).toBe(10);
    expect(r.realizedToDate).toBe(60);
    expect(r.currentPerDay).toBe(4);
    expect(r.status).toBe("accruing");
  });

  it("leaves the action day out of both windows", () => {
    const r = computeRealization(
      input({
        series: [
          {
            currency: "USD",
            points: [
              ...flat("2026-06-01", "2026-06-14", 10),
              { day: "2026-06-15", amount: 1000 },
              ...flat("2026-06-16", "2026-06-25", 4),
            ],
          },
        ],
      }),
    );
    expect(r.baselinePerDay).toBe(10);
    expect(r.realizedToDate).toBe(60);
  });

  it("never accrues a day collection has not covered", () => {
    const r = computeRealization(
      input({
        coverage: { firstDay: "2026-01-01", lastDay: "2026-06-17" },
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-14", 10) }],
      }),
    );
    // 16th and 17th covered (zero spend), 18th onwards not collected yet.
    expect(r.accruedDays).toBe(2);
    expect(r.realizedToDate).toBe(20);
  });

  it("reads as pending when nothing after the action is covered yet", () => {
    const r = computeRealization(
      input({
        coverage: { firstDay: "2026-01-01", lastDay: "2026-06-15" },
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-14", 10) }],
      }),
    );
    expect(r.basis).toBe("billing");
    expect(r.accruedDays).toBe(0);
    expect(r.status).toBe("pending");
    expect(r.realizedToDate).toBe(0);
  });

  it("flags a resource that grew back above its baseline, and counts the negative days", () => {
    const r = computeRealization(
      input({
        projectedMonthly: 6 * AVERAGE_DAYS_PER_MONTH,
        series: [
          {
            currency: "USD",
            points: [
              ...flat("2026-06-01", "2026-06-14", 10),
              ...flat("2026-06-16", "2026-06-25", 12),
            ],
          },
        ],
      }),
    );
    expect(r.realizedToDate).toBe(-20);
    expect(r.shortfall?.kind).toBe("grew_back");
  });

  it("flags realization below the threshold share of the projection", () => {
    const r = computeRealization(
      input({
        projectedMonthly: 6 * AVERAGE_DAYS_PER_MONTH,
        series: [
          {
            currency: "USD",
            points: [
              ...flat("2026-06-01", "2026-06-14", 10),
              ...flat("2026-06-16", "2026-06-25", 8),
            ],
          },
        ],
      }),
    );
    // Realizing 2/day of a projected 6/day: under 70%.
    expect(r.shortfall).toEqual({
      kind: "below_projection",
      realizedPerDay: 2,
      projectedPerDay: 6,
    });
    expect(r.projectedInRange).toBe(60);
  });

  it("stops accruing at the horizon", () => {
    const r = computeRealization(
      input({
        horizonDays: 5,
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-14", 10) }],
      }),
    );
    expect(horizonEnd("2026-06-15", 5)).toBe("2026-06-20");
    expect(r.accruedDays).toBe(5);
    expect(r.realizedToDate).toBe(50);
    expect(r.status).toBe("complete");
  });

  it("refuses billing for a period-native provider and falls back to the estimate", () => {
    const r = computeRealization(
      input({
        periodNative: true,
        kind: "orphan_deletion",
        baselineDailyEstimate: 3,
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-14", 10) }],
      }),
    );
    expect(r.basis).toBe("estimate");
    expect(r.realizedToDate).toBe(30);
  });

  it("splits realized across months inside the range only", () => {
    const r = computeRealization(
      input({
        occurredOn: "2026-05-28",
        range: { from: "2026-06-01", to: "2026-06-25" },
        series: [{ currency: "USD", points: flat("2026-05-10", "2026-05-27", 10) }],
      }),
    );
    expect(r.months).toEqual([{ month: "2026-06", realized: 250, projected: 0 }]);
    // To date includes May's three days.
    expect(r.realizedToDate).toBe(280);
  });
});

describe("computeRealization (estimate and manual bases)", () => {
  it("uses hours off times the rate for a sleep schedule with no billing", () => {
    const r = computeRealization(
      input({
        kind: "sleep_schedule",
        horizonDays: null,
        costAddressable: false,
        baselineDailyEstimate: 24,
        offFraction: 0.5,
      }),
    );
    expect(r.basis).toBe("estimate");
    expect(r.realizedToDate).toBe(12 * 10);
    expect(r.horizonEndsOn).toBeNull();
  });

  it("accrues a manual entry from its own start day", () => {
    const r = computeRealization(
      input({
        kind: "manual",
        manual: true,
        costAddressable: false,
        projectedMonthly: AVERAGE_DAYS_PER_MONTH * 2,
        occurredOn: "2026-06-20",
      }),
    );
    expect(r.basis).toBe("manual");
    expect(r.accruedDays).toBe(6);
    expect(r.realizedToDate).toBe(12);
  });

  it("is unmeasured with nothing to measure against, never zero", () => {
    const r = computeRealization(input({ costAddressable: false }));
    expect(r.basis).toBe("unmeasured");
    expect(r.realizedToDate).toBeNull();
  });

  it("stops at an end date", () => {
    const r = computeRealization(
      input({
        kind: "sleep_schedule",
        horizonDays: null,
        costAddressable: false,
        baselineDailyEstimate: 10,
        offFraction: 1,
        endedOn: "2026-06-18",
      }),
    );
    expect(r.accruedDays).toBe(3);
    expect(r.status).toBe("ended");
  });
});

describe("computeCommitmentRealization", () => {
  it("nets the amortized fee against the discount, only on discount days", () => {
    const r = computeCommitmentRealization({
      discountByDay: new Map([
        ["2026-06-01", 30],
        ["2026-06-02", 30],
      ]),
      feeByDay: new Map([
        ["2026-06-01", 20],
        ["2026-06-02", 20],
        ["2026-06-03", 20],
      ]),
      range: { from: "2026-06-01", to: "2026-06-30" },
    });
    expect(r.realized).toBe(20);
    expect(r.measuredDays).toBe(2);
    expect(r.firstDay).toBe("2026-06-01");
  });
});

describe("attributeCostCentre", () => {
  const rule = (id: string, match: AllocationRule["match"]): AllocationRule => ({
    id,
    costCentreId: `cc-${id}`,
    priority: 1,
    match,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  it("takes the first matching rule and never matches a service rule", () => {
    const rules = [
      rule("svc", { service: "EC2" }),
      rule("tag", { tagKey: "team", tagValue: "search" }),
      rule("acct", { accountId: "a1" }),
    ];
    expect(
      attributeCostCentre(rules, { accountId: "a1", pluginId: "aws", tags: { team: "search" } }),
    ).toBe("cc-tag");
    expect(attributeCostCentre(rules, { accountId: "a1", pluginId: "aws", tags: null })).toBe(
      "cc-acct",
    );
    expect(attributeCostCentre(rules, { accountId: "a2", pluginId: "aws", tags: null })).toBeNull();
  });
});

describe("aggregateRealizedSavings", () => {
  it("sums per currency and leaves unmeasured events out", () => {
    const base = {
      kind: "rightsizing" as const,
      accountId: "a1",
      accountName: "Prod",
      attributedCostCentreId: null,
      attributedCostCentreName: null,
    };
    const agg = aggregateRealizedSavings(
      [
        {
          ...base,
          basis: "billing",
          realizedCurrency: "USD",
          currency: "USD",
          realizedInRange: 100,
          projectedInRange: 120,
          months: [{ month: "2026-06", realized: 100, projected: 120 }],
        },
        {
          ...base,
          basis: "unmeasured",
          realizedCurrency: null,
          currency: "USD",
          realizedInRange: null,
          projectedInRange: null,
          months: [],
        },
        {
          ...base,
          kind: "manual",
          basis: "manual",
          realizedCurrency: "EUR",
          currency: "EUR",
          realizedInRange: 50,
          projectedInRange: 50,
          months: [{ month: "2026-06", realized: 50, projected: 50 }],
        },
      ],
      (k) => k,
    );
    expect(agg.totals).toEqual([
      { currency: "USD", realized: 100, projected: 120 },
      { currency: "EUR", realized: 50, projected: 50 },
    ]);
    expect(agg.byKind.find((b) => b.key === "rightsizing")?.events).toBe(1);
    expect(agg.byCostCentre[0]?.label).toBe("Unallocated");
    expect(agg.byMonth).toHaveLength(2);
  });
});
