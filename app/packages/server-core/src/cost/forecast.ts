/**
 * Trend forecasting over daily cost totals. Deliberately simple: a
 * least-squares linear fit over the trailing window, clamped at zero. The UI
 * and docs present forecasts as trend estimates, not billing predictions.
 *
 * ## Confidence bounds
 *
 * Every projection can carry a low/high band: the classical **prediction
 * interval** of ordinary least squares, not a quantile of the history and not
 * a fixed percentage. For a projected day at index `x0` the half-width is
 *
 *     t(level, n - 2) * s * sqrt(1 + 1/n + (x0 - mean(x))^2 / Sxx)
 *
 * where `s` is the residual standard error of the fit (`sqrt(SSE / (n - 2))`),
 * `Sxx` the spread of the fitted day indexes, and `t` Student's t quantile
 * with `n - 2` degrees of freedom. The three terms under the root are the
 * day's own noise, the uncertainty in the level, and the uncertainty in the
 * slope; the last one is why the band fans out the further ahead it reaches.
 *
 * A **total over several projected days** (a month-end figure, a budget
 * period, a forecast's horizon) is not the sum of the daily bounds. The days
 * share one fitted line, so its error is computed once, from the variance of
 * a weighted sum of predictions:
 *
 *     Var = s^2 * (sum(w^2) + sum(w)^2 / n + (sum(w * (x - mean(x))))^2 / Sxx)
 *
 * with every weight 1 for a plain total, and the driver metric's forecast
 * values as the weights when a forecast multiplies a projected unit cost by
 * them ({@link forecastWeightedSum}).
 *
 * The interval assumes independent, evenly spread residuals. Daily cloud spend
 * is neither (weekday/weekend cycles, step changes), so the band is an honest
 * indication of how well a straight line explains the last 30 days rather than
 * a calibrated probability, and the docs say so. Lower bounds are clamped at
 * zero, as the point forecast is, and a window total's low never drops below
 * what has already been spent.
 */
import { addDays } from "./dates";

export interface DailyPoint {
  /** YYYY-MM-DD */
  day: string;
  amount: number;
}

const MIN_FIT_POINTS = 7;
export const FORECAST_WINDOW_DAYS = 30;

/**
 * Two-sided confidence levels a band can be drawn at, in percent. A closed
 * set because the t quantiles are tabulated (see {@link tQuantile}); 80 is the
 * default because it is the conventional forecast fan, and a 95% band over 30
 * noisy days is usually too wide to say anything.
 */
export const FORECAST_CONFIDENCE_LEVELS = [80, 90, 95] as const;
export type ForecastConfidenceLevel = (typeof FORECAST_CONFIDENCE_LEVELS)[number];
export const DEFAULT_FORECAST_CONFIDENCE_LEVEL: ForecastConfidenceLevel = 80;

/** A projected day with its prediction interval. */
export interface BoundedDailyPoint extends DailyPoint {
  low: number;
  high: number;
}

/** A projected total with its interval; the bounds are null when no fit exists. */
export interface ForecastRange {
  expected: number;
  low: number | null;
  high: number | null;
}

interface LinearFit {
  slope: number;
  intercept: number;
  /** x-index of the last observed day (fit domain is 0..lastX). */
  lastX: number;
}

/** A fit plus what its prediction intervals need. */
export interface LinearFitStats extends LinearFit {
  /** Points the fit used. */
  n: number;
  meanX: number;
  /** Sum of squared deviations of x from its mean. */
  sxx: number;
  /** Residual standard error, sqrt(SSE / (n - 2)). */
  residualSd: number;
}

/*
 * Student's t quantiles for the one-sided probabilities behind each two-sided
 * level (80% is 0.90, 90% is 0.95, 95% is 0.975), by degrees of freedom 1..30.
 * Standard table values; past 30 the normal quantile is within 2%.
 */
const T_TABLE: Record<ForecastConfidenceLevel, number[]> = {
  80: [
    3.078, 1.886, 1.638, 1.533, 1.476, 1.44, 1.415, 1.397, 1.383, 1.372, 1.363, 1.356, 1.35, 1.345,
    1.341, 1.337, 1.333, 1.33, 1.328, 1.325, 1.323, 1.321, 1.319, 1.318, 1.316, 1.315, 1.314, 1.313,
    1.311, 1.31,
  ],
  90: [
    6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761,
    1.753, 1.746, 1.74, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701,
    1.699, 1.697,
  ],
  95: [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16,
    2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052,
    2.048, 2.045, 2.042,
  ],
};
const Z_TABLE: Record<ForecastConfidenceLevel, number> = { 80: 1.2816, 90: 1.6449, 95: 1.96 };

/** Whether `level` is one of the supported two-sided confidence levels. */
export function isForecastConfidenceLevel(level: unknown): level is ForecastConfidenceLevel {
  return (FORECAST_CONFIDENCE_LEVELS as readonly unknown[]).includes(level);
}

/** Student's t quantile for a two-sided `level` with `df` degrees of freedom. */
export function tQuantile(level: ForecastConfidenceLevel, df: number): number {
  if (!Number.isFinite(df) || df < 1) return Number.POSITIVE_INFINITY;
  const row = T_TABLE[level];
  const i = Math.floor(df);
  return i <= row.length ? row[i - 1]! : Z_TABLE[level];
}

/**
 * The trailing-window fit with the statistics its intervals need, or null with
 * too little history (fewer than 7 points) or a degenerate x spread.
 */
export function fitTrend(points: DailyPoint[]): LinearFitStats | null {
  const f = fit(points);
  if (!f) return null;
  const window = points.slice(-FORECAST_WINDOW_DAYS);
  const n = window.length;
  const meanX = (n - 1) / 2;
  let sxx = 0;
  let sse = 0;
  for (let x = 0; x < n; x++) {
    sxx += (x - meanX) ** 2;
    const residual = window[x]!.amount - (f.intercept + f.slope * x);
    sse += residual * residual;
  }
  return { ...f, n, meanX, sxx, residualSd: Math.sqrt(sse / (n - 2)) };
}

function fit(points: DailyPoint[]): LinearFit | null {
  const window = points.slice(-FORECAST_WINDOW_DAYS);
  const n = window.length;
  if (n < MIN_FIT_POINTS) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let x = 0; x < n; x++) {
    const y = window[x]!.amount;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept, lastX: n - 1 };
}

/**
 * Project daily amounts `horizonDays` past the last observed day. Returns []
 * when there's too little history to fit (fewer than 7 daily points).
 */
export function forecastDaily(points: DailyPoint[], horizonDays: number): DailyPoint[] {
  const f = fit(points);
  if (!f || horizonDays <= 0) return [];
  const lastDay = points[points.length - 1]!.day;
  const result: DailyPoint[] = [];
  for (let i = 1; i <= horizonDays; i++) {
    const projected = f.intercept + f.slope * (f.lastX + i);
    result.push({ day: addDays(lastDay, i), amount: Math.max(0, projected) });
  }
  return result;
}

/**
 * {@link forecastDaily} with each day's prediction interval at `level`.
 *
 * `amount` is exactly what `forecastDaily` returns for the same input, so a
 * chart that gains a band keeps the line it already drew. Bounds are clamped
 * at zero like the point forecast.
 */
export function forecastDailyWithBounds(
  points: DailyPoint[],
  horizonDays: number,
  level: ForecastConfidenceLevel = DEFAULT_FORECAST_CONFIDENCE_LEVEL,
): BoundedDailyPoint[] {
  const f = fitTrend(points);
  if (!f || horizonDays <= 0) return [];
  const t = tQuantile(level, f.n - 2);
  const lastDay = points[points.length - 1]!.day;
  const result: BoundedDailyPoint[] = [];
  for (let i = 1; i <= horizonDays; i++) {
    const x0 = f.lastX + i;
    const projected = f.intercept + f.slope * x0;
    const halfWidth = t * f.residualSd * Math.sqrt(1 + 1 / f.n + (x0 - f.meanX) ** 2 / f.sxx);
    result.push({
      day: addDays(lastDay, i),
      amount: Math.max(0, projected),
      low: Math.max(0, projected - halfWidth),
      high: Math.max(0, projected + halfWidth),
    });
  }
  return result;
}

/**
 * The expected value and interval half-width of a weighted sum of projected
 * days, `sum(w_i * y(lastX + offset_i))`, from one fit.
 *
 * `offset` is 1 for the first day after the last observed one. With every
 * weight 1 this is the interval of a plain total; with a driver metric's
 * forecast values as weights it is the interval of "projected unit cost times
 * forecast volume" summed over the horizon. `expected` is unclamped; callers
 * clamp what they display.
 */
export function forecastWeightedSum(
  f: LinearFitStats,
  terms: ReadonlyArray<{ offset: number; weight: number }>,
  level: ForecastConfidenceLevel = DEFAULT_FORECAST_CONFIDENCE_LEVEL,
): { expected: number; halfWidth: number } {
  let expected = 0;
  let sumW = 0;
  let sumW2 = 0;
  let sumWdx = 0;
  for (const { offset, weight } of terms) {
    const x0 = f.lastX + offset;
    expected += weight * (f.intercept + f.slope * x0);
    sumW += weight;
    sumW2 += weight * weight;
    sumWdx += weight * (x0 - f.meanX);
  }
  const variance = f.residualSd ** 2 * (sumW2 + (sumW * sumW) / f.n + (sumWdx * sumWdx) / f.sxx);
  return { expected, halfWidth: tQuantile(level, f.n - 2) * Math.sqrt(variance) };
}

/**
 * {@link forecastWindowTotal} with its interval. `expected` is identical to
 * `forecastWindowTotal` for the same input (budgets keep the number they have
 * always judged); `low`/`high` are the interval of the projected remainder
 * added to the spend already observed, so `low` never drops below it. Null
 * bounds mean there was no fit to take an interval of (the period-to-date
 * average fallback); a period with nothing left to project has both bounds
 * equal to the observed total.
 */
export function forecastWindowRange(
  points: DailyPoint[],
  start: string,
  end: string,
  level: ForecastConfidenceLevel = DEFAULT_FORECAST_CONFIDENCE_LEVEL,
): ForecastRange | null {
  const expected = forecastWindowTotal(points, start, end);
  if (expected === null) return null;
  const windowPoints = points.filter((p) => p.day >= start && p.day <= end);
  const toDate = windowPoints.reduce((sum, p) => sum + p.amount, 0);
  const remaining = remainingDaysInWindow(windowPoints, end);
  if (remaining <= 0) return { expected, low: expected, high: expected };
  const f = fitTrend(points);
  if (!f) return { expected, low: null, high: null };
  const { halfWidth } = forecastWeightedSum(
    f,
    Array.from({ length: remaining }, (_, i) => ({ offset: i + 1, weight: 1 })),
    level,
  );
  return {
    expected,
    low: Math.max(toDate, expected - halfWidth),
    high: expected + halfWidth,
  };
}

/**
 * Forecast a calendar month's total: observed month-to-date spend plus the
 * projected daily amounts for the remaining days. `month` is "YYYY-MM";
 * `points` should span at least the trailing fit window. Falls back to a
 * simple MTD daily-average extrapolation when there's too little history for
 * a fit, and null when the month has no observed data at all.
 */
export function forecastMonthTotal(points: DailyPoint[], month: string): number | null {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return forecastWindowTotal(points, `${month}-01`, end);
}

/**
 * Forecast the total of an arbitrary inclusive window `[start, end]`: observed
 * period-to-date plus the projection for the days after the last observed one.
 * The calendar month is the special case {@link forecastMonthTotal} asks for;
 * custom budget periods (a fortnight, a quarter, an explicit range) ask for
 * the rest. Same fallbacks: the period-to-date daily average when the history
 * is too short to fit, and null when the window has no observed data at all.
 */
export function forecastWindowTotal(
  points: DailyPoint[],
  start: string,
  end: string,
): number | null {
  const windowPoints = points.filter((p) => p.day >= start && p.day <= end);
  if (windowPoints.length === 0) return null;
  const toDate = windowPoints.reduce((sum, p) => sum + p.amount, 0);

  const remaining = remainingDaysInWindow(windowPoints, end);
  if (remaining <= 0) return toDate;

  const projected = forecastDaily(points, remaining);
  if (projected.length > 0) {
    return toDate + projected.reduce((sum, p) => sum + p.amount, 0);
  }
  const dailyAvg = toDate / windowPoints.length;
  return toDate + dailyAvg * remaining;
}

/** Days of the window still to come after its last observed point. */
export function remainingDaysInWindow(windowPoints: DailyPoint[], end: string): number {
  const lastDay = windowPoints[windowPoints.length - 1]?.day;
  if (!lastDay) return 0;
  const a = Date.parse(`${lastDay}T00:00:00.000Z`);
  const b = Date.parse(`${end}T00:00:00.000Z`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}
