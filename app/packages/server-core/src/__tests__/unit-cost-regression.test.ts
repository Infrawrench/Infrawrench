import { describe, expect, it } from "vitest";

import {
  detectUnitCostRegression,
  summarizeUnitCostWindow,
  unitCostWindows,
  type UnitCostMetricDay,
  type UnitCostRegressionInput,
  type UnitCostRegressionOptions,
} from "../cost/unit-cost-regression";

const DAY_MS = 86_400_000;

function daysIn(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let t = new Date(`${from}T00:00:00Z`).valueOf();
    t <= new Date(`${to}T00:00:00Z`).valueOf();
    t += DAY_MS
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

const WINDOWS = unitCostWindows("2026-08-10", 14);
const CURRENT = WINDOWS.current; // 2026-07-28 … 2026-08-10
const PREVIOUS = WINDOWS.previous; // 2026-07-14 … 2026-07-27

const OPTIONS: UnitCostRegressionOptions = {
  thresholdPercent: 20,
  minReportedDays: 10,
  minCurrentSpend: 100,
};

/** A flat daily series over a window. */
function flat(window: { from: string; to: string }, amount: number) {
  return daysIn(window.from, window.to).map((day) => ({ day, amount }));
}

function values(window: { from: string; to: string }, value: number): UnitCostMetricDay[] {
  return daysIn(window.from, window.to).map((day) => ({ day, value }));
}

/**
 * A metric reported every day of both windows, at `previousCost` per day
 * before and `currentCost` per day after, over a flat volume.
 */
function input(
  previousCost: number,
  currentCost: number,
  over: Partial<UnitCostRegressionInput> = {},
): UnitCostRegressionInput {
  return {
    current: CURRENT,
    previous: PREVIOUS,
    costs: [
      {
        currency: "USD",
        daily: [...flat(PREVIOUS, previousCost), ...flat(CURRENT, currentCost)],
      },
    ],
    values: [...values(PREVIOUS, 100), ...values(CURRENT, 100)],
    ...over,
  };
}

describe("unitCostWindows", () => {
  it("builds two adjacent, non-overlapping windows ending on the newest complete day", () => {
    expect(CURRENT).toEqual({ from: "2026-07-28", to: "2026-08-10" });
    expect(PREVIOUS).toEqual({ from: "2026-07-14", to: "2026-07-27" });
  });
});

describe("summarizeUnitCostWindow — gap semantics", () => {
  it("excludes an unreported day from BOTH sides, not just the denominator", () => {
    const costByDay = new Map(daysIn(CURRENT.from, CURRENT.to).map((day) => [day, 100]));
    // Twelve of fourteen days reported.
    const reported = daysIn(CURRENT.from, CURRENT.to).slice(0, 12);
    const valuesByDay = new Map(reported.map((day) => [day, 50]));

    const summary = summarizeUnitCostWindow(CURRENT, costByDay, valuesByDay);
    expect(summary.reportedDays).toBe(12);
    expect(summary.gapDays).toBe(2);
    // 12 × 100 — the two gap days' $200 is NOT folded in. Folding it in would
    // put the unit cost at 1400/600 = 2.33 instead of the true 2.00.
    expect(summary.cost).toBe(1200);
    expect(summary.metricValue).toBe(600);
    expect(summary.unitCost).toBe(2);
  });

  it("treats a zero or negative reported value as a gap", () => {
    const costByDay = new Map(daysIn(CURRENT.from, CURRENT.to).map((day) => [day, 100]));
    const valuesByDay = new Map(daysIn(CURRENT.from, CURRENT.to).map((day) => [day, 0]));
    const summary = summarizeUnitCostWindow(CURRENT, costByDay, valuesByDay);
    expect(summary.reportedDays).toBe(0);
    expect(summary.unitCost).toBeNull();
  });

  it("does not treat a zero numerator over real volume as a gap", () => {
    // Spend of nothing over 300 customers genuinely is 0 per customer.
    const costByDay = new Map<string, number>();
    const valuesByDay = new Map(daysIn(CURRENT.from, CURRENT.to).map((day) => [day, 300]));
    const summary = summarizeUnitCostWindow(CURRENT, costByDay, valuesByDay);
    expect(summary.reportedDays).toBe(14);
    expect(summary.unitCost).toBe(0);
  });
});

describe("detectUnitCostRegression — a gap never produces a regression", () => {
  it("declines when the current window has too few reported days", () => {
    // Spend doubled, but only 9 of 14 days carry a metric value. The ratio it
    // would compute is not a regression, it is a missing measurement.
    const reported = daysIn(CURRENT.from, CURRENT.to).slice(0, 9);
    const { findings, skipped } = detectUnitCostRegression(
      input(100, 200, {
        values: [...values(PREVIOUS, 100), ...reported.map((day) => ({ day, value: 100 }))],
      }),
      OPTIONS,
    );
    expect(findings).toHaveLength(0);
    expect(skipped).toEqual([{ currency: "USD", reason: "insufficient_current_history" }]);
  });

  it("declines when the PRIOR window has too few reported days", () => {
    const reported = daysIn(PREVIOUS.from, PREVIOUS.to).slice(0, 4);
    const { findings, skipped } = detectUnitCostRegression(
      input(100, 200, {
        values: [...reported.map((day) => ({ day, value: 100 })), ...values(CURRENT, 100)],
      }),
      OPTIONS,
    );
    expect(findings).toHaveLength(0);
    expect(skipped).toEqual([{ currency: "USD", reason: "insufficient_previous_history" }]);
  });

  it("declines when the metric was never reported at all", () => {
    const { findings, skipped } = detectUnitCostRegression(
      input(100, 500, { values: [] }),
      OPTIONS,
    );
    expect(findings).toHaveLength(0);
    expect(skipped[0]!.reason).toBe("insufficient_current_history");
  });

  it("does not let gap days in one window inflate the comparison", () => {
    // Spend is flat at $100/day and volume is flat at 100/day, so the unit
    // cost is 1.00 on both sides — but four days of the *current* window have
    // no reported value. Counting their spend would read 1400/1000 = 1.40, a
    // 40% "regression" invented entirely by a broken metric ingest.
    const reported = daysIn(CURRENT.from, CURRENT.to).slice(0, 10);
    const { findings, skipped } = detectUnitCostRegression(
      input(100, 100, {
        values: [...values(PREVIOUS, 100), ...reported.map((day) => ({ day, value: 100 }))],
      }),
      OPTIONS,
    );
    expect(findings).toHaveLength(0);
    // Not "insufficient history" — 10 days clears the bar — but genuinely
    // unchanged, because the gap days sat out of both sums.
    expect(skipped).toEqual([{ currency: "USD", reason: "improved" }]);
  });
});

describe("detectUnitCostRegression — thresholds", () => {
  it("fires when the unit cost clears the threshold", () => {
    const { findings } = detectUnitCostRegression(input(100, 130), OPTIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.changePercent).toBeCloseTo(30, 5);
    expect(findings[0]!.previous.unitCost).toBeCloseTo(1, 5);
    expect(findings[0]!.current.unitCost).toBeCloseTo(1.3, 5);
  });

  it("stays quiet just under the threshold", () => {
    const { skipped } = detectUnitCostRegression(input(100, 119), OPTIONS);
    expect(skipped).toEqual([{ currency: "USD", reason: "below_threshold" }]);
  });

  it("does not fire when spend rises but the unit cost falls", () => {
    // The case the change-alert family gets wrong: spend doubled because
    // volume tripled. This is the best week the business has had.
    const { findings, skipped } = detectUnitCostRegression(
      input(100, 200, {
        values: [...values(PREVIOUS, 100), ...values(CURRENT, 300)],
      }),
      OPTIONS,
    );
    expect(findings).toHaveLength(0);
    expect(skipped[0]!.reason).toBe("improved");
  });

  it("fires when spend is flat but volume halved", () => {
    // The case no spend-versus-spend alert can see at all.
    const { findings } = detectUnitCostRegression(
      input(100, 100, {
        values: [...values(PREVIOUS, 100), ...values(CURRENT, 50)],
      }),
      OPTIONS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.changePercent).toBeCloseTo(100, 5);
  });

  it("stays quiet when the scope's spend is below the floor", () => {
    const { skipped } = detectUnitCostRegression(input(1, 5), OPTIONS);
    expect(skipped).toEqual([{ currency: "USD", reason: "spend_below_floor" }]);
  });

  it("declines a rise from a prior unit cost of exactly zero", () => {
    const { findings, skipped } = detectUnitCostRegression(input(0, 100), OPTIONS);
    expect(findings).toHaveLength(0);
    expect(skipped[0]!.reason).toBe("no_previous_unit_cost");
  });

  it("judges each currency on its own, never merged", () => {
    const { findings } = detectUnitCostRegression(
      {
        current: CURRENT,
        previous: PREVIOUS,
        costs: [
          { currency: "USD", daily: [...flat(PREVIOUS, 100), ...flat(CURRENT, 200)] },
          { currency: "EUR", daily: [...flat(PREVIOUS, 100), ...flat(CURRENT, 100)] },
        ],
        values: [...values(PREVIOUS, 100), ...values(CURRENT, 100)],
      },
      OPTIONS,
    );
    expect(findings.map((f) => f.currency)).toEqual(["USD"]);
    expect(findings[0]!.changePercent).toBeCloseTo(100, 5);
  });
});
