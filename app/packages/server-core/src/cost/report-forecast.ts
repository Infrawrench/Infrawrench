/**
 * The pure halves of a cost report's forecasts: the trend baseline with its
 * band, and the driver-metric baseline ("projected unit cost times forecast
 * volume"). No database, no ClickHouse: the web service fetches the observed
 * spend, the metric's actuals and its forecasted values, then hands them here,
 * and applies scenario models on top of whichever baseline this returns.
 *
 * Every function works on the **full horizon** (each day from the one after the
 * last observed day through `to`) and reports totals over a **slice** of it
 * (the window the caller asked for). Scenario models need the full horizon,
 * because their scoped baselines are projected from the last observed day;
 * the slice is only ever applied to what is returned.
 *
 * Statistics are in `forecast.ts`; this module only arranges them.
 */
import type { CostForecastPoint, CostForecastTotal } from "@infrawrench/client-core";

import { addDays, daysBetween } from "./dates";
import {
  fitTrend,
  forecastWeightedSum,
  tQuantile,
  type DailyPoint,
  type ForecastConfidenceLevel,
  type LinearFitStats,
} from "./forecast";

/** The days a forecast covers, and the window its totals are reported over. */
export interface ForecastHorizon {
  /** Last observed day; the horizon starts the day after. */
  lastObserved: string;
  /** Last projected day (inclusive). */
  to: string;
  /** First day of the reported window (inclusive), at or after the horizon start. */
  sliceFrom: string;
  level: ForecastConfidenceLevel;
}

/** Every projected day of the horizon, in order. */
export function horizonDays(h: ForecastHorizon): string[] {
  const count = daysBetween(h.lastObserved, h.to);
  return Array.from({ length: Math.max(0, count) }, (_, i) => addDays(h.lastObserved, i + 1));
}

/** Whether `day` is in the reported window. */
export function inSlice(h: ForecastHorizon, day: string): boolean {
  return day >= h.sliceFrom && day <= h.to;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function halfWidthAt(f: LinearFitStats, t: number, offset: number): number {
  const x0 = f.lastX + offset;
  return t * f.residualSd * Math.sqrt(1 + 1 / f.n + (x0 - f.meanX) ** 2 / f.sxx);
}

function predictAt(f: LinearFitStats, offset: number): number {
  return f.intercept + f.slope * (f.lastX + offset);
}

/** A baseline over the full horizon, with its total over the slice. */
export interface ForecastBaseline {
  points: CostForecastPoint[];
  sliceTotal: CostForecastTotal;
}

/**
 * The automatic forecast: the trend fit on `observed` (which must end on
 * `h.lastObserved`), each day with its prediction interval, and the slice
 * total's interval computed from the one fit rather than by summing days.
 * Null when there is too little history to fit (fewer than 7 days).
 */
export function trendBaseline(observed: DailyPoint[], h: ForecastHorizon): ForecastBaseline | null {
  const f = fitTrend(observed);
  if (!f) return null;
  const t = tQuantile(h.level, f.n - 2);
  const days = horizonDays(h);
  const points: CostForecastPoint[] = days.map((day, i) => {
    const projected = predictAt(f, i + 1);
    const hw = halfWidthAt(f, t, i + 1);
    return {
      day,
      expected: round6(Math.max(0, projected)),
      low: round6(Math.max(0, projected - hw)),
      high: round6(Math.max(0, projected + hw)),
    };
  });
  const terms = days.flatMap((day, i) => (inSlice(h, day) ? [{ offset: i + 1, weight: 1 }] : []));
  return { points, sliceTotal: totalWithHalfWidth(points, h, sliceHalfWidth(f, terms, h.level)) };
}

function sliceHalfWidth(
  f: LinearFitStats,
  terms: Array<{ offset: number; weight: number }>,
  level: ForecastConfidenceLevel,
): number {
  return terms.length === 0 ? 0 : forecastWeightedSum(f, terms, level).halfWidth;
}

/** The slice's expected total (the sum of its clamped days) with a half-width around it. */
function totalWithHalfWidth(
  points: CostForecastPoint[],
  h: ForecastHorizon,
  halfWidth: number,
): CostForecastTotal {
  const expected = points.filter((p) => inSlice(h, p.day)).reduce((s, p) => s + p.expected, 0);
  return {
    expected: round6(expected),
    low: round6(Math.max(0, expected - halfWidth)),
    high: round6(expected + halfWidth),
  };
}

/** The driver baseline, or why there is none. */
export type DriverBaselineResult =
  | {
      ok: true;
      baseline: ForecastBaseline;
      /** Spend per unit averaged over the slice's driven days; null with none. */
      unitCost: number | null;
      /** Sum of forecasted metric values over the slice. */
      metricTotal: number;
      /** Slice days with a forecasted value, and the slice's length. */
      coveredDays: number;
      totalDays: number;
    }
  | { ok: false; reason: string };

/**
 * "Projected unit cost times forecast volume".
 *
 * The unit cost is the report's own daily spend divided by the metric's daily
 * actual (days where both exist and the actual is positive), fit with the same
 * least-squares trend as spend, so a unit cost that is falling keeps falling.
 * Each horizon day with a forecasted metric value projects `unitCost(day) *
 * value` with the unit cost's interval scaled by the value; a day with no
 * forecasted value falls back to the trend baseline's day (the caller warns).
 *
 * The slice total's interval combines the two sources in quadrature: the
 * driven days' weighted-sum interval from the unit-cost fit and the remaining
 * days' interval from the spend fit, treated as independent.
 */
export function driverBaseline(args: {
  observed: DailyPoint[];
  /** The metric's actual daily values (labels summed). */
  metricActuals: ReadonlyMap<string, number>;
  /** The metric's forecasted daily values. */
  metricForecast: ReadonlyMap<string, number>;
  trend: ForecastBaseline;
  h: ForecastHorizon;
}): DriverBaselineResult {
  const { observed, metricActuals, metricForecast, trend, h } = args;
  const unitCosts: DailyPoint[] = [];
  for (const p of observed) {
    const volume = metricActuals.get(p.day);
    if (volume === undefined || !(volume > 0)) continue;
    unitCosts.push({ day: p.day, amount: p.amount / volume });
  }
  const f = fitTrend(unitCosts);
  if (!f) {
    return {
      ok: false,
      reason:
        "The driver metric needs at least 7 days in the last 60 that have both spend and a " +
        "positive reported value, to project a unit cost from.",
    };
  }
  const t = tQuantile(h.level, f.n - 2);
  const lastUnitCostDay = unitCosts[unitCosts.length - 1]!.day;
  const trendByDay = new Map(trend.points.map((p) => [p.day, p]));
  const fSpend = fitTrend(observed);

  const drivenTerms: Array<{ offset: number; weight: number }> = [];
  const trendTerms: Array<{ offset: number; weight: number }> = [];
  let drivenExpected = 0;
  let metricTotal = 0;
  let coveredDays = 0;
  let totalDays = 0;

  const points: CostForecastPoint[] = horizonDays(h).map((day, i) => {
    const volume = metricForecast.get(day);
    const sliced = inSlice(h, day);
    if (sliced) totalDays++;
    if (volume === undefined) {
      if (sliced) trendTerms.push({ offset: i + 1, weight: 1 });
      return { ...(trendByDay.get(day) ?? { day, expected: 0, low: null, high: null }) };
    }
    const offset = daysBetween(lastUnitCostDay, day);
    const unitCost = predictAt(f, offset);
    const hw = halfWidthAt(f, t, offset);
    const expected = Math.max(0, unitCost * volume);
    if (sliced) {
      drivenTerms.push({ offset, weight: volume });
      drivenExpected += expected;
      metricTotal += volume;
      coveredDays++;
    }
    return {
      day,
      expected: round6(expected),
      low: round6(Math.max(0, (unitCost - hw) * volume)),
      high: round6(Math.max(0, (unitCost + hw) * volume)),
    };
  });

  const drivenHw = sliceHalfWidth(f, drivenTerms, h.level);
  const trendHw = fSpend ? sliceHalfWidth(fSpend, trendTerms, h.level) : 0;
  return {
    ok: true,
    baseline: {
      points,
      sliceTotal: totalWithHalfWidth(points, h, Math.sqrt(drivenHw ** 2 + trendHw ** 2)),
    },
    unitCost: metricTotal > 0 ? round6(drivenExpected / metricTotal) : null,
    metricTotal: round6(metricTotal),
    coveredDays,
    totalDays,
  };
}
