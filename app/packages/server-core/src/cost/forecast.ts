/**
 * Trend forecasting over daily cost totals. Deliberately simple — a
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
  const monthPoints = points.filter((p) => p.day.startsWith(`${month}-`));
  if (monthPoints.length === 0) return null;
  const mtd = monthPoints.reduce((sum, p) => sum + p.amount, 0);

  const lastDay = monthPoints[monthPoints.length - 1]!.day;
  const d = new Date(`${lastDay}T00:00:00.000Z`);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const remaining = daysInMonth - d.getUTCDate();
  if (remaining <= 0) return mtd;

  const projected = forecastDaily(points, remaining);
  if (projected.length > 0) {
    return mtd + projected.reduce((sum, p) => sum + p.amount, 0);
  }
  const dailyAvg = mtd / monthPoints.length;
  return mtd + dailyAvg * remaining;
}
