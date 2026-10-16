import { describe, expect, it } from "vitest";

import { addDays } from "../cost/dates";
import { fitTrend, forecastDailyWithBounds, type DailyPoint } from "../cost/forecast";
import {
  driverBaseline,
  horizonDays,
  inSlice,
  trendBaseline,
  type ForecastHorizon,
} from "../cost/report-forecast";

function days(start: string, amounts: number[]): DailyPoint[] {
  return amounts.map((amount, i) => ({ day: addDays(start, i), amount }));
}

const NOISY = [10, 12, 9, 14, 13, 15, 12, 16, 18, 15];
// Observed 2026-10-01 .. 2026-10-10.
const observed = days("2026-10-01", NOISY);
const horizon = (sliceFrom: string, to: string): ForecastHorizon => ({
  lastObserved: "2026-10-10",
  to,
  sliceFrom,
  level: 80,
});

describe("horizon helpers", () => {
  it("lists every projected day after the last observed one", () => {
    expect(horizonDays(horizon("2026-10-11", "2026-10-13"))).toEqual([
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
    ]);
    expect(horizonDays(horizon("2026-10-11", "2026-10-10"))).toEqual([]);
  });

  it("knows which days are in the reported window", () => {
    const h = horizon("2026-10-12", "2026-10-13");
    expect(inSlice(h, "2026-10-11")).toBe(false);
    expect(inSlice(h, "2026-10-12")).toBe(true);
    expect(inSlice(h, "2026-10-14")).toBe(false);
  });
});

describe("trendBaseline", () => {
  it("projects the trend with each day's band, over the whole horizon", () => {
    const h = horizon("2026-10-11", "2026-10-15");
    const base = trendBaseline(observed, h)!;
    const reference = forecastDailyWithBounds(observed, 5);
    expect(base.points.map((p) => p.day)).toEqual(reference.map((p) => p.day));
    base.points.forEach((p, i) => {
      expect(p.expected).toBeCloseTo(reference[i]!.amount, 5);
      expect(p.low).toBeCloseTo(reference[i]!.low, 5);
      expect(p.high).toBeCloseTo(reference[i]!.high, 5);
    });
  });

  it("totals only the slice, with one interval for the slice", () => {
    const h = horizon("2026-10-11", "2026-10-13");
    const base = trendBaseline(observed, h)!;
    // Independently derived: 54.145455 +/- 7.375541 (see cost-forecast.test.ts).
    expect(base.sliceTotal.expected).toBeCloseTo(54.145455, 4);
    expect(base.sliceTotal.low).toBeCloseTo(54.145455 - 7.375541, 4);
    expect(base.sliceTotal.high).toBeCloseTo(54.145455 + 7.375541, 4);

    const later = trendBaseline(observed, horizon("2026-10-12", "2026-10-13"))!;
    expect(later.points).toHaveLength(3);
    expect(later.sliceTotal.expected).toBeCloseTo(
      later.points[1]!.expected + later.points[2]!.expected,
      5,
    );
  });

  it("is null without enough history", () => {
    expect(trendBaseline(days("2026-10-08", [1, 2, 3]), horizon("2026-10-11", "2026-10-12"))).toBe(
      null,
    );
  });
});

describe("driverBaseline", () => {
  // Spend is exactly 2 per unit, every day: the unit-cost fit is flat at 2 with
  // no residuals, so a driven day is exactly 2 x the planned volume.
  const volumes = [5, 6, 4.5, 7, 6.5, 7.5, 6, 8, 9, 7.5];
  const spend = days(
    "2026-10-01",
    volumes.map((v) => v * 2),
  );
  const actuals = new Map(spend.map((p, i) => [p.day, volumes[i]!]));
  const h = horizon("2026-10-11", "2026-10-14");
  const trend = trendBaseline(spend, h)!;

  it("multiplies the projected unit cost by the planned volume", () => {
    const planned = new Map([
      ["2026-10-11", 100],
      ["2026-10-12", 50],
      ["2026-10-13", 0],
    ]);
    const result = driverBaseline({
      observed: spend,
      metricActuals: actuals,
      metricForecast: planned,
      trend,
      h,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [d1, d2, d3, d4] = result.baseline.points;
    expect(d1!.expected).toBeCloseTo(200, 6);
    expect(d2!.expected).toBeCloseTo(100, 6);
    expect(d3!.expected).toBeCloseTo(0, 6);
    // No planned value on the 14th: the trend's day stands in.
    expect(d4).toEqual(trend.points[3]);
    expect(result.unitCost).toBeCloseTo(2, 6);
    expect(result.metricTotal).toBe(150);
    expect(result.coveredDays).toBe(3);
    expect(result.totalDays).toBe(4);
    // A perfect unit-cost fit has no band of its own on driven days.
    expect(d1!.low).toBeCloseTo(200, 6);
    expect(d1!.high).toBeCloseTo(200, 6);
  });

  it("scales the unit cost's interval by the volume", () => {
    const noisyActuals = new Map(spend.map((p, i) => [p.day, volumes[i]! * (i % 2 ? 1.1 : 0.9)]));
    const result = driverBaseline({
      observed: spend,
      metricActuals: noisyActuals,
      metricForecast: new Map([
        ["2026-10-11", 10],
        ["2026-10-12", 20],
      ]),
      trend,
      h: horizon("2026-10-11", "2026-10-12"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [a, b] = result.baseline.points;
    const widthPerUnitA = (a!.high! - a!.low!) / 10;
    const widthPerUnitB = (b!.high! - b!.low!) / 20;
    // Day two is one step further out, so per unit it is a little wider.
    expect(widthPerUnitB).toBeGreaterThan(widthPerUnitA);
    expect(result.baseline.sliceTotal.low!).toBeLessThan(result.baseline.sliceTotal.expected);
    expect(result.baseline.sliceTotal.high!).toBeGreaterThan(result.baseline.sliceTotal.expected);
  });

  it("refuses with too little overlapping history", () => {
    const sparse = new Map([...actuals].slice(0, 4));
    const result = driverBaseline({
      observed: spend,
      metricActuals: sparse,
      metricForecast: new Map([["2026-10-11", 10]]),
      trend,
      h,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/at least 7 days/) });
  });

  it("ignores days where the metric is zero rather than dividing by it", () => {
    const withZero = new Map(actuals);
    withZero.set("2026-10-05", 0);
    const result = driverBaseline({
      observed: spend,
      metricActuals: withZero,
      metricForecast: new Map([["2026-10-11", 10]]),
      trend,
      h,
    });
    expect(result.ok).toBe(true);
    expect(fitTrend(spend)).not.toBeNull();
  });
});
