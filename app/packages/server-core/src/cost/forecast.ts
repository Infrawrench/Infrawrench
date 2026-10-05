/**
 * Trend forecasting over daily cost totals. Deliberately simple: a
 * least-squares linear fit over the trailing window, clamped at zero. The UI
 * and docs present forecasts as trend estimates, not billing predictions.
 */
import { addDays } from "./dates";

export interface DailyPoint {
  /** YYYY-MM-DD */
  day: string;
  amount: number;
}

const MIN_FIT_POINTS = 7;
export const FORECAST_WINDOW_DAYS = 30;

interface LinearFit {
  slope: number;
  intercept: number;
  /** x-index of the last observed day (fit domain is 0..lastX). */
  lastX: number;
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
