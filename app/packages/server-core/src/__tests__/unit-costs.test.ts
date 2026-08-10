/**
 * Exhaustive tests for the pure unit-cost layer. No database, no ClickHouse,
 * no clock — every case is a function of its arguments, which is the whole
 * reason `cost/unit-costs.ts` holds no db import.
 *
 * These are organised around the four rules in that module's header, because
 * each of them is a *silent* failure if it breaks: a bucket that reads 0
 * instead of "unknown", a monthly ratio that is really an average of daily
 * ones, a period total inflated by spend whose volume was never reported, or a
 * currency quietly folded into another.
 */
import { describe, it, expect } from "vitest";

import { computeUnitCosts, type UnitCostComputeInput } from "../cost/unit-costs";

/** A minimal input with sane defaults, so each test states only what it tests. */
function input(overrides: Partial<UnitCostComputeInput> = {}): UnitCostComputeInput {
  return {
    from: "2026-07-01",
    to: "2026-07-03",
    binning: "daily",
    mode: "unit_cost",
    costGroups: [
      {
        currency: "USD",
        points: [
          { bucket: "2026-07-01", amount: 100 },
          { bucket: "2026-07-02", amount: 200 },
          { bucket: "2026-07-03", amount: 300 },
        ],
      },
    ],
    values: [
      { day: "2026-07-01", value: 10 },
      { day: "2026-07-02", value: 20 },
      { day: "2026-07-03", value: 30 },
    ],
    metricCurrency: null,
    ...overrides,
  };
}

const pointAt = (result: ReturnType<typeof computeUnitCosts>, bucket: string, series = 0) =>
  result.series[series]!.points.find((p) => p.bucket === bucket)!;

describe("computeUnitCosts — rule 2: a missing denominator is a gap, never zero", () => {
  it("renders a day with no reported value as null with a reason, not as 0", () => {
    const result = computeUnitCosts(
      input({
        values: [
          { day: "2026-07-01", value: 10 },
          { day: "2026-07-03", value: 30 },
        ],
      }),
    );

    const gap = pointAt(result, "2026-07-02");
    expect(gap.value).toBeNull();
    expect(gap.gap).toBe("no_metric_value");
    expect(gap.metricValue).toBeNull();
    // The spend is still reported — the numerator is known, it is the ratio
    // that is not — so a reader can see what was spent on the unmeasured day.
    expect(gap.cost).toBe(200);
    expect(result.gapBuckets).toBe(1);
  });

  it("treats a zero denominator as a gap rather than as infinity", () => {
    const result = computeUnitCosts(
      input({
        values: [
          { day: "2026-07-01", value: 10 },
          { day: "2026-07-02", value: 0 },
          { day: "2026-07-03", value: 30 },
        ],
      }),
    );

    const gap = pointAt(result, "2026-07-02");
    expect(gap.value).toBeNull();
    expect(gap.gap).toBe("non_positive_metric_value");
  });

  it("treats a negative denominator as a gap rather than flipping the sign", () => {
    const result = computeUnitCosts(input({ values: [{ day: "2026-07-02", value: -5 }] }));
    expect(pointAt(result, "2026-07-02").gap).toBe("non_positive_metric_value");
  });

  it("never emits a non-finite value anywhere", () => {
    const result = computeUnitCosts(
      input({
        values: [
          { day: "2026-07-01", value: 0 },
          { day: "2026-07-02", value: -1 },
        ],
      }),
    );
    for (const series of result.series) {
      for (const p of series.points) {
        expect(p.value === null || Number.isFinite(p.value)).toBe(true);
      }
      expect(series.overallValue === null || Number.isFinite(series.overallValue)).toBe(true);
    }
  });

  it("keeps a genuine zero — no spend over a real denominator costs 0 per unit", () => {
    const result = computeUnitCosts(
      input({
        costGroups: [{ currency: "USD", points: [{ bucket: "2026-07-02", amount: 0 }] }],
        values: [{ day: "2026-07-02", value: 20 }],
      }),
    );
    const point = pointAt(result, "2026-07-02");
    expect(point.value).toBe(0);
    expect(point.gap).toBeUndefined();
  });

  it("leaves an interior gap on the axis so the chart can draw a hole", () => {
    const result = computeUnitCosts(
      input({
        from: "2026-07-01",
        to: "2026-07-05",
        costGroups: [
          {
            currency: "USD",
            points: [
              { bucket: "2026-07-01", amount: 100 },
              { bucket: "2026-07-05", amount: 100 },
            ],
          },
        ],
        values: [
          { day: "2026-07-01", value: 10 },
          { day: "2026-07-05", value: 10 },
        ],
      }),
    );
    expect(result.series[0]!.points.map((p) => p.bucket)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
    expect(result.gapBuckets).toBe(3);
  });

  it("trims leading and trailing emptiness, which is a fact about the range", () => {
    const result = computeUnitCosts(
      input({
        from: "2026-06-28",
        to: "2026-07-05",
        costGroups: [{ currency: "USD", points: [{ bucket: "2026-07-02", amount: 100 }] }],
        values: [{ day: "2026-07-02", value: 10 }],
      }),
    );
    expect(result.series[0]!.points.map((p) => p.bucket)).toEqual(["2026-07-02"]);
    expect(result.gapBuckets).toBe(0);
  });
});

describe("computeUnitCosts — rule 1: the ratio is computed at the requested bucket", () => {
  it("divides summed spend by summed volume for a weekly bucket", () => {
    // Two days in one Monday-start week: 100/10 = 10 and 300/30 = 10 daily,
    // but the week is (100+300)/(10+30) = 10 either way — so use numbers where
    // the average and the ratio actually differ.
    const result = computeUnitCosts(
      input({
        from: "2026-07-06", // Monday
        to: "2026-07-07",
        binning: "weekly",
        costGroups: [{ currency: "USD", points: [{ bucket: "2026-07-06", amount: 400 }] }],
        values: [
          { day: "2026-07-06", value: 10 },
          { day: "2026-07-07", value: 30 },
        ],
      }),
    );
    expect(result.series[0]!.points).toHaveLength(1);
    expect(pointAt(result, "2026-07-06").value).toBe(10); // 400 / 40
  });

  it("is not the mean of the daily ratios", () => {
    // Daily: 100/10 = 10 and 100/100 = 1. Mean = 5.5. Correct weekly ratio is
    // 200/110 ≈ 1.818 — the day with the volume has to dominate.
    const weekly = computeUnitCosts(
      input({
        from: "2026-07-06",
        to: "2026-07-07",
        binning: "weekly",
        costGroups: [{ currency: "USD", points: [{ bucket: "2026-07-06", amount: 200 }] }],
        values: [
          { day: "2026-07-06", value: 10 },
          { day: "2026-07-07", value: 100 },
        ],
      }),
    );
    expect(pointAt(weekly, "2026-07-06").value).toBeCloseTo(200 / 110, 8);
    expect(pointAt(weekly, "2026-07-06").value).not.toBeCloseTo(5.5, 3);
  });

  it("buckets monthly on the first of the month", () => {
    const result = computeUnitCosts(
      input({
        from: "2026-07-30",
        to: "2026-08-02",
        binning: "monthly",
        costGroups: [
          {
            currency: "USD",
            points: [
              { bucket: "2026-07-01", amount: 100 },
              { bucket: "2026-08-01", amount: 900 },
            ],
          },
        ],
        values: [
          { day: "2026-07-30", value: 5 },
          { day: "2026-07-31", value: 5 },
          { day: "2026-08-01", value: 30 },
          { day: "2026-08-02", value: 60 },
        ],
      }),
    );
    expect(pointAt(result, "2026-07-01").value).toBe(10); // 100 / 10
    expect(pointAt(result, "2026-08-01").value).toBe(10); // 900 / 90
  });

  it("computes the period total from summed sides, not from the bucket ratios", () => {
    const result = computeUnitCosts(
      input({
        costGroups: [
          {
            currency: "USD",
            points: [
              { bucket: "2026-07-01", amount: 100 },
              { bucket: "2026-07-02", amount: 100 },
              { bucket: "2026-07-03", amount: 100 },
            ],
          },
        ],
        values: [
          { day: "2026-07-01", value: 1 },
          { day: "2026-07-02", value: 1 },
          { day: "2026-07-03", value: 98 },
        ],
      }),
    );
    // Bucket ratios are 100, 100, ~1.02 — their mean is ~67. The period unit
    // cost is 300/100 = 3.
    expect(result.series[0]!.overallValue).toBe(3);
    expect(result.series[0]!.overallCost).toBe(300);
    expect(result.series[0]!.overallMetricValue).toBe(100);
  });

  it("cumulative binning divides a running numerator by a running denominator", () => {
    const result = computeUnitCosts(
      input({
        binning: "cumulative",
        // `queryCosts` already returns running sums for this binning.
        costGroups: [
          {
            currency: "USD",
            points: [
              { bucket: "2026-07-01", amount: 100 },
              { bucket: "2026-07-02", amount: 300 },
              { bucket: "2026-07-03", amount: 600 },
            ],
          },
        ],
      }),
    );
    expect(pointAt(result, "2026-07-01").value).toBe(10); // 100 / 10
    expect(pointAt(result, "2026-07-02").value).toBe(10); // 300 / 30
    expect(pointAt(result, "2026-07-03").value).toBe(10); // 600 / 60
  });
});

describe("computeUnitCosts — rule 3: numerator and denominator cover the same days", () => {
  it("excludes an unreported bucket's spend from the period total", () => {
    const result = computeUnitCosts(
      input({
        // Every day has spend, but only two days have volume.
        values: [
          { day: "2026-07-01", value: 10 },
          { day: "2026-07-03", value: 30 },
        ],
      }),
    );
    // 100 + 300 over 10 + 30 = 10. Folding the unmatched 200 in would give 15,
    // a 50% overstatement with nothing on screen to explain it.
    expect(result.series[0]!.overallValue).toBe(10);
    expect(result.series[0]!.overallCost).toBe(400);
    expect(result.series[0]!.overallMetricValue).toBe(40);
  });

  it("reports a period with no usable denominator at all as null, not zero", () => {
    const result = computeUnitCosts(input({ values: [] }));
    expect(result.series[0]!.overallValue).toBeNull();
    expect(result.series[0]!.overallMetricValue).toBeNull();
    expect(result.gapBuckets).toBe(3);
  });

  it("flags a bucket whose denominator covers only part of it", () => {
    const result = computeUnitCosts(
      input({
        from: "2026-07-06",
        to: "2026-07-12", // a full Monday-start week
        binning: "weekly",
        costGroups: [{ currency: "USD", points: [{ bucket: "2026-07-06", amount: 700 }] }],
        values: [
          { day: "2026-07-06", value: 10 },
          { day: "2026-07-07", value: 10 },
        ],
      }),
    );
    const point = pointAt(result, "2026-07-06");
    expect(point.reportedDays).toBe(2);
    expect(point.bucketDays).toBe(7);
    // Still computed — throwing away two real days of volume is its own
    // distortion — but counted so every surface can say the ratio reads high.
    expect(point.value).toBe(35); // 700 / 20
    expect(result.partialBuckets).toBe(1);
  });

  it("counts a fully reported bucket as complete", () => {
    const result = computeUnitCosts(input());
    expect(result.partialBuckets).toBe(0);
    for (const p of result.series[0]!.points) {
      expect(p.reportedDays).toBe(1);
      expect(p.bucketDays).toBe(1);
    }
  });

  it("clips bucketDays to the queried range, not the calendar bucket", () => {
    const result = computeUnitCosts(
      input({
        from: "2026-07-08", // Wednesday — 5 days of that week are in range
        to: "2026-07-12",
        binning: "weekly",
        costGroups: [{ currency: "USD", points: [{ bucket: "2026-07-06", amount: 500 }] }],
        values: [
          { day: "2026-07-08", value: 1 },
          { day: "2026-07-09", value: 1 },
          { day: "2026-07-10", value: 1 },
          { day: "2026-07-11", value: 1 },
          { day: "2026-07-12", value: 1 },
        ],
      }),
    );
    const point = pointAt(result, "2026-07-06");
    expect(point.bucketDays).toBe(5);
    expect(point.reportedDays).toBe(5);
    expect(result.partialBuckets).toBe(0);
  });

  it("ignores values outside the queried range", () => {
    const result = computeUnitCosts(
      input({ values: [...input().values, { day: "2026-06-30", value: 9999 }] }),
    );
    expect(result.series[0]!.overallMetricValue).toBe(60);
  });
});

describe("computeUnitCosts — rule 4: currencies are never merged", () => {
  it("emits one series per currency, each dividing the same denominator", () => {
    const result = computeUnitCosts(
      input({
        costGroups: [
          { currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
          { currency: "JPY", points: [{ bucket: "2026-07-01", amount: 5000 }] },
        ],
        values: [{ day: "2026-07-01", value: 10 }],
      }),
    );
    expect(result.series.map((s) => s.currency)).toEqual(["USD", "JPY"]);
    expect(result.series[0]!.points[0]!.value).toBe(10);
    expect(result.series[1]!.points[0]!.value).toBe(500);
  });

  it("counts a bucket once even when several currencies gap on it", () => {
    const result = computeUnitCosts(
      input({
        from: "2026-07-01",
        to: "2026-07-01",
        costGroups: [
          { currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
          { currency: "EUR", points: [{ bucket: "2026-07-01", amount: 90 }] },
        ],
        values: [],
      }),
    );
    expect(result.gapBuckets).toBe(1);
  });

  it("returns no series at all when there is no spend to divide", () => {
    const result = computeUnitCosts(input({ costGroups: [] }));
    expect(result.series).toEqual([]);
    expect(result.gapBuckets).toBe(0);
  });
});

describe("computeUnitCosts — margin", () => {
  it("computes (revenue − cost) / revenue as a fraction", () => {
    const result = computeUnitCosts(
      input({
        mode: "margin",
        metricCurrency: "USD",
        from: "2026-07-01",
        to: "2026-07-01",
        costGroups: [{ currency: "USD", points: [{ bucket: "2026-07-01", amount: 400 }] }],
        values: [{ day: "2026-07-01", value: 1000 }],
      }),
    );
    expect(pointAt(result, "2026-07-01").value).toBeCloseTo(0.6, 10);
  });

  it("goes negative when cost exceeds revenue rather than clamping", () => {
    const result = computeUnitCosts(
      input({
        mode: "margin",
        metricCurrency: "USD",
        from: "2026-07-01",
        to: "2026-07-01",
        costGroups: [{ currency: "USD", points: [{ bucket: "2026-07-01", amount: 1500 }] }],
        values: [{ day: "2026-07-01", value: 1000 }],
      }),
    );
    expect(pointAt(result, "2026-07-01").value).toBeCloseTo(-0.5, 10);
  });

  it("gaps a currency it cannot express the revenue in, rather than guessing", () => {
    const result = computeUnitCosts(
      input({
        mode: "margin",
        metricCurrency: "USD",
        from: "2026-07-01",
        to: "2026-07-01",
        costGroups: [
          { currency: "USD", points: [{ bucket: "2026-07-01", amount: 400 }] },
          // Left unconverted because the org states no JPY rate. Silently
          // ignoring it would overstate margin; adding it to the dollars would
          // invent a number.
          { currency: "JPY", points: [{ bucket: "2026-07-01", amount: 50_000 }] },
        ],
        values: [{ day: "2026-07-01", value: 1000 }],
      }),
    );
    expect(pointAt(result, "2026-07-01", 0).value).toBeCloseTo(0.6, 10);
    const foreign = pointAt(result, "2026-07-01", 1);
    expect(foreign.value).toBeNull();
    expect(foreign.gap).toBe("unconvertible_currency");
    expect(result.series[1]!.overallValue).toBeNull();
  });

  it("takes the period margin from summed sides, not from the bucket margins", () => {
    const result = computeUnitCosts(
      input({
        mode: "margin",
        metricCurrency: "USD",
        costGroups: [
          {
            currency: "USD",
            points: [
              { bucket: "2026-07-01", amount: 90 },
              { bucket: "2026-07-02", amount: 10 },
              { bucket: "2026-07-03", amount: 10 },
            ],
          },
        ],
        values: [
          { day: "2026-07-01", value: 100 },
          { day: "2026-07-02", value: 100 },
          { day: "2026-07-03", value: 100 },
        ],
      }),
    );
    // Bucket margins are 0.1, 0.9, 0.9 (mean 0.633); the period margin is
    // (300 − 110) / 300 ≈ 0.633 here by coincidence of equal revenue, so check
    // the sums directly rather than trusting the quotient alone.
    expect(result.series[0]!.overallCost).toBe(110);
    expect(result.series[0]!.overallMetricValue).toBe(300);
    expect(result.series[0]!.overallValue).toBeCloseTo(190 / 300, 8);
  });
});

describe("computeUnitCosts — restatement is invisible here by construction", () => {
  it("uses the last value given for a day, never their sum", () => {
    // The store's (metric, day) unique index means the reader can never see two
    // rows for one day; this pins the behaviour anyway, because summing would
    // be the failure that restatement exists to prevent.
    const result = computeUnitCosts(
      input({
        from: "2026-07-01",
        to: "2026-07-01",
        costGroups: [{ currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] }],
        values: [
          { day: "2026-07-01", value: 5 },
          { day: "2026-07-01", value: 10 },
        ],
      }),
    );
    expect(pointAt(result, "2026-07-01").metricValue).toBe(10);
    expect(pointAt(result, "2026-07-01").value).toBe(10);
  });
});
