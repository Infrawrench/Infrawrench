import { describe, expect, it } from "vitest";

import { computeCommitmentCoverage, type CoverageCell } from "../commitments/coverage";
import { computeCommitmentUtilization } from "../commitments/utilization";
import {
  nearestRankPercentile,
  planCommitmentRecommendations,
  PLANNER_MIN_WINDOW_DAYS,
  type PlannerCellInput,
} from "../commitments/planner";

// ─── Coverage ───────────────────────────────────────────────────────────────

function cell(overrides: Partial<CoverageCell>): CoverageCell {
  return {
    accountId: "acc-1",
    pluginId: "aws",
    service: "AmazonEC2",
    region: "us-east-1",
    currency: "USD",
    coveredAmount: 0,
    uncoveredAmount: 0,
    ...overrides,
  };
}

describe("computeCommitmentCoverage", () => {
  it("reports a range: broad over everything, narrow over eligible cells", () => {
    const cells = [
      // EC2 in us-east-1 carried commitments — eligible.
      cell({ coveredAmount: 60, uncoveredAmount: 20 }),
      // Data transfer never carried one — in the broad denominator only.
      cell({ service: "AWSDataTransfer", coveredAmount: 0, uncoveredAmount: 20 }),
    ];
    const report = computeCommitmentCoverage(cells, [
      { accountId: "acc-1", chargeTypesDeclared: true },
    ]);
    expect(report.available).toBe(true);
    const usd = report.currencies[0]!;
    // broad: 60 / (60 + 40); narrow: 60 / (60 + 20)
    expect(usd.broadRatio).toBeCloseTo(0.6);
    expect(usd.narrowRatio).toBeCloseTo(0.75);
    // The bounds must bracket, in this order — swapping them would present
    // the over-count as the optimistic number.
    expect(usd.broadRatio!).toBeLessThanOrEqual(usd.narrowRatio!);
  });

  it("eligibility pools across accounts within a (plugin, service, region) cell", () => {
    const cells = [
      cell({ accountId: "acc-1", coveredAmount: 50, uncoveredAmount: 0 }),
      // Sibling account, same cell, no commitment of its own: still eligible.
      cell({ accountId: "acc-2", coveredAmount: 0, uncoveredAmount: 50 }),
    ];
    const report = computeCommitmentCoverage(cells, [
      { accountId: "acc-1", chargeTypesDeclared: true },
      { accountId: "acc-2", chargeTypesDeclared: true },
    ]);
    expect(report.currencies[0]!.narrowRatio).toBeCloseTo(0.5);
  });

  it("excludes accounts whose plugin can't tell charge types, and names them", () => {
    const cells = [
      cell({ coveredAmount: 60, uncoveredAmount: 20 }),
      // Rows from a plugin that stamps everything "usage": excluded, or its
      // spend drags coverage down for reasons unrelated to purchasing.
      cell({ accountId: "acc-blind", pluginId: "hetzner", uncoveredAmount: 1000 }),
    ];
    const report = computeCommitmentCoverage(cells, [
      { accountId: "acc-1", chargeTypesDeclared: true },
      { accountId: "acc-blind", chargeTypesDeclared: false },
    ]);
    expect(report.excludedAccountIds).toEqual(["acc-blind"]);
    expect(report.currencies[0]!.broadRatio).toBeCloseTo(0.75);
  });

  it("an all-excluded scope is unavailable, not 0%", () => {
    const report = computeCommitmentCoverage(
      [cell({ accountId: "acc-blind", uncoveredAmount: 100 })],
      [{ accountId: "acc-blind", chargeTypesDeclared: false }],
    );
    expect(report.available).toBe(false);
    expect(report.currencies).toEqual([]);
    expect(report.excludedAccountIds).toEqual(["acc-blind"]);
  });

  it("never merges currencies", () => {
    const report = computeCommitmentCoverage(
      [
        cell({ coveredAmount: 50, uncoveredAmount: 50 }),
        cell({ currency: "EUR", coveredAmount: 10, uncoveredAmount: 0 }),
      ],
      [{ accountId: "acc-1", chargeTypesDeclared: true }],
    );
    expect(report.currencies.map((c) => c.currency)).toEqual(["EUR", "USD"]);
    expect(report.currencies.find((c) => c.currency === "USD")!.broadRatio).toBeCloseTo(0.5);
    expect(report.currencies.find((c) => c.currency === "EUR")!.broadRatio).toBeCloseTo(1);
  });
});

// ─── Utilization ────────────────────────────────────────────────────────────

describe("computeCommitmentUtilization", () => {
  const window = { from: "2026-07-01", to: "2026-07-30" };

  it("five days of data, fully used each day → 100%, not 50%", () => {
    // Commitment of $1/hour, active all window, but collection only ever ran
    // on five days. Delivered exactly $24 on each of them.
    const result = computeCommitmentUtilization({
      hourlyCommitmentAmount: 1,
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2027-01-01T00:00:00Z",
      window,
      daysWithData: ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"],
      deliveredAmount: 5 * 24,
    });
    expect(result.utilization).toBeCloseTo(1);
    expect(result.measuredDays).toBe(5);
    expect(result.activeDays).toBe(30);
    expect(result.missingDays).toBe(25);
    expect(result.obligationAmount).toBeCloseTo(120);
  });

  it("reports above 1 unclamped", () => {
    const result = computeCommitmentUtilization({
      hourlyCommitmentAmount: 1,
      startDate: "2026-01-01T00:00:00Z",
      window,
      daysWithData: ["2026-07-01"],
      deliveredAmount: 48,
    });
    expect(result.utilization).toBeCloseTo(2);
  });

  it("clips the obligation to the term inside the window", () => {
    // Term starts mid-window: only the active tail is obligated.
    const result = computeCommitmentUtilization({
      hourlyCommitmentAmount: 1,
      startDate: "2026-07-21T00:00:00Z",
      window,
      daysWithData: Array.from(
        { length: 30 },
        (_, i) => `2026-07-${String(i + 1).padStart(2, "0")}`,
      ),
      deliveredAmount: 10 * 24,
    });
    expect(result.activeDays).toBe(10);
    expect(result.utilization).toBeCloseTo(1);
  });

  it("unit-denominated → null with a reason, never 0%", () => {
    const result = computeCommitmentUtilization({
      hourlyCommitmentAmount: null,
      startDate: "2026-01-01T00:00:00Z",
      window,
      daysWithData: ["2026-07-01"],
      deliveredAmount: 0,
    });
    expect(result.utilization).toBeNull();
    expect(result.reason).toBe("unit_denominated");
  });

  it("no data on any active day → null, not 0%", () => {
    const result = computeCommitmentUtilization({
      hourlyCommitmentAmount: 1,
      startDate: "2026-01-01T00:00:00Z",
      window,
      daysWithData: [],
      deliveredAmount: 0,
    });
    expect(result.utilization).toBeNull();
    expect(result.reason).toBe("no_data_days");
    expect(result.missingDays).toBe(30);
  });

  it("a term entirely outside the window → null with no_active_days", () => {
    const result = computeCommitmentUtilization({
      hourlyCommitmentAmount: 1,
      startDate: "2020-01-01T00:00:00Z",
      endDate: "2021-01-01T00:00:00Z",
      window,
      daysWithData: ["2026-07-01"],
      deliveredAmount: 0,
    });
    expect(result.utilization).toBeNull();
    expect(result.reason).toBe("no_active_days");
  });
});

// ─── Planner ────────────────────────────────────────────────────────────────

const WINDOW_DAYS = Array.from({ length: 90 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 4, 1) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
});

function plannerCell(
  spendByDay: (day: string, index: number) => number | undefined,
): PlannerCellInput {
  const dailySpend = new Map<string, number>();
  WINDOW_DAYS.forEach((day, index) => {
    const value = spendByDay(day, index);
    if (value !== undefined) dailySpend.set(day, value);
  });
  return {
    pluginId: "aws",
    service: "AmazonEC2",
    region: "us-east-1",
    currency: "USD",
    dailySpend,
  };
}

describe("nearestRankPercentile", () => {
  it("is nearest-rank, not interpolated", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = ceil(0.10 × 10) = 1 → first element, no averaging.
    expect(nearestRankPercentile(sorted, 10)).toBe(1);
    expect(nearestRankPercentile(sorted, 50)).toBe(5);
  });
});

describe("planCommitmentRecommendations", () => {
  it("recommends p10 of a steady material workload with break-even arithmetic", () => {
    // $100/day ± a dip to $90 on 9 of 90 days: present, flat, tight floor.
    const result = planCommitmentRecommendations(
      [plannerCell((_, i) => (i % 10 === 0 ? 90 : 100))],
      WINDOW_DAYS,
    );
    expect(result.available).toBe(true);
    expect(result.recommendations).toHaveLength(1);
    const rec = result.recommendations[0]!;
    expect(rec.recommendedDailyCommitment).toBe(90);
    expect(rec.annualCommitment).toBeCloseTo(90 * 365);
    // AWS publishes "up to 66%": basis upper_bound, break-even exact at 1−d.
    expect(rec.savingBasis).toBe("upper_bound");
    expect(rec.discountRateMax).toBeCloseTo(0.66);
    expect(rec.breakEvenUtilization).toBeCloseTo(0.34);
    // No published floor → shallow end 0 → the loss bound is the ceiling on
    // regret: half the annual commitment.
    expect(rec.annualLossIfUsageHalves).toBeCloseTo(90 * 365 * 0.5);
  });

  it("gates absent workloads on PRESENCE first", () => {
    // Spend on only half the days.
    const result = planCommitmentRecommendations(
      [plannerCell((_, i) => (i % 2 === 0 ? 100 : undefined))],
      WINDOW_DAYS,
    );
    expect(result.recommendations).toHaveLength(0);
    expect(result.rejected[0]!.gate).toBe("presence");
  });

  it("reports a halved workload as declining, not spiky — trend before floor", () => {
    // First 60 days at $100, last 30 at $40. p10 (40) < 0.6×p50 too, so the
    // floor gate would also fail — the decline gate must win.
    const result = planCommitmentRecommendations(
      [plannerCell((_, i) => (i < 60 ? 100 : 40))],
      WINDOW_DAYS,
    );
    expect(result.rejected[0]!.gate).toBe("not_in_decline");
  });

  it("gates spiky floors", () => {
    // Mostly $170 with a deep dip to $30 every 8th day, evenly spread so the
    // trend gate passes: p10 = 30 < 0.6 × p50 (170).
    const result = planCommitmentRecommendations(
      [plannerCell((_, i) => (i % 8 === 0 ? 30 : 170))],
      WINDOW_DAYS,
    );
    expect(result.rejected[0]!.gate).toBe("floor");
  });

  it("gates immaterial workloads", () => {
    // $2/day → p10×365 = $730 < $1,000.
    const result = planCommitmentRecommendations([plannerCell(() => 2)], WINDOW_DAYS);
    expect(result.rejected[0]!.gate).toBe("materiality");
  });

  it("Azure carries a published range, rendered as a range", () => {
    const result = planCommitmentRecommendations(
      [{ ...plannerCell(() => 100), pluginId: "azure" }],
      WINDOW_DAYS,
    );
    const rec = result.recommendations[0]!;
    expect(rec.savingBasis).toBe("range");
    expect(rec.discountRateMin).toBeCloseTo(0.36);
    expect(rec.discountRateMax).toBeCloseTo(0.72);
    expect(rec.estimatedAnnualSavingMin).toBeCloseTo(100 * 365 * 0.36);
    // Shallow end published → loss if halved uses it.
    expect(rec.annualLossIfUsageHalves).toBeCloseTo(100 * 365 * (0.5 - 0.36));
  });

  it("skips providers with no published discount", () => {
    const result = planCommitmentRecommendations(
      [{ ...plannerCell(() => 100), pluginId: "hetzner" }],
      WINDOW_DAYS,
    );
    expect(result.recommendations).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it("declares itself unavailable under the minimum window", () => {
    const shortWindow = WINDOW_DAYS.slice(0, PLANNER_MIN_WINDOW_DAYS - 1);
    const result = planCommitmentRecommendations([plannerCell(() => 100)], shortWindow);
    expect(result.available).toBe(false);
    expect(result.recommendations).toHaveLength(0);
  });
});
