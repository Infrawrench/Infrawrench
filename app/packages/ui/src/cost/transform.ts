/**
 * Pure data-shaping helpers for cost charts: pivot grouped series into
 * recharts rows, align previous-period comparisons onto the current axis,
 * bin daily forecast points, and format money. No React, no fetching —
 * unit-test target.
 */
import type {
  CostBinningId,
  CostQueryResponse,
  CostQuerySeries,
  CostSeriesPoint,
} from "./config.js";

export interface ChartSeriesDef {
  /** recharts dataKey — group key made collision-safe. */
  dataKey: string;
  label: string;
  currency: string;
  isOther: boolean;
}

export interface PivotedChart {
  /** One row per bucket: { bucket: "2026-07-01", s0: 12.3, s1: 4.5, ... } */
  rows: Array<Record<string, string | number | null>>;
  series: ChartSeriesDef[];
}

export const COMPARISON_KEY = "__previous__";
export const FORECAST_KEY = "__forecast__";

/**
 * Pivot per-group series into recharts rows keyed by bucket. Series order is
 * preserved from the API (ranked by period total, "Other" last) so
 * categorical colors follow entities, not ranks, across refreshes with the
 * same grouping.
 */
export function pivotSeries(series: CostQuerySeries[]): PivotedChart {
  const defs: ChartSeriesDef[] = series.map((s, i) => ({
    dataKey: `s${i}`,
    label:
      s.currency && new Set(series.map((x) => x.currency)).size > 1
        ? `${s.label} (${s.currency})`
        : s.label,
    currency: s.currency,
    isOther: s.key === "__other__",
  }));

  const rowByBucket = new Map<string, Record<string, string | number | null>>();
  series.forEach((s, i) => {
    for (const p of s.points) {
      const row = rowByBucket.get(p.bucket) ?? { bucket: p.bucket };
      row[`s${i}`] = p.amount;
      rowByBucket.set(p.bucket, row);
    }
  });

  const rows = [...rowByBucket.values()].sort((a, b) =>
    String(a["bucket"]) < String(b["bucket"]) ? -1 : 1,
  );
  return { rows, series: defs };
}

/** Sum every series in a response bucket-wise into one total-per-bucket list. */
export function totalPerBucket(series: CostQuerySeries[]): CostSeriesPoint[] {
  const totals = new Map<string, number>();
  for (const s of series) {
    for (const p of s.points) totals.set(p.bucket, (totals.get(p.bucket) ?? 0) + p.amount);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, amount]) => ({ bucket, amount }));
}

/**
 * Overlay the previous period's bucket totals onto the current rows by
 * position: previous bucket #n lands on current bucket #n, rendered as one
 * muted dashed "Previous period" line.
 */
export function alignComparison(
  rows: Array<Record<string, string | number | null>>,
  comparison: CostQuerySeries[],
): void {
  const prev = totalPerBucket(comparison);
  rows.forEach((row, i) => {
    row[COMPARISON_KEY] = prev[i]?.amount ?? null;
  });
}

/** Bucket daily forecast points to match the chart binning. */
export function binForecast(
  forecast: CostSeriesPoint[],
  binning: CostBinningId,
  lastActualCumulative?: number,
): CostSeriesPoint[] {
  if (binning === "daily") return forecast;
  if (binning === "cumulative") {
    let running = lastActualCumulative ?? 0;
    return forecast.map((p) => {
      running += p.amount;
      return { bucket: p.bucket, amount: running };
    });
  }
  const bucketOf = (day: string): string => {
    if (binning === "monthly") return `${day.slice(0, 7)}-01`;
    // Weekly, Monday-start — matches toStartOfWeek(day, 1) server-side.
    const d = new Date(`${day}T00:00:00.000Z`);
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  };
  const map = new Map<string, number>();
  for (const p of forecast)
    map.set(bucketOf(p.bucket), (map.get(bucketOf(p.bucket)) ?? 0) + p.amount);
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, amount]) => ({ bucket, amount }));
}

/**
 * Append forecast rows after the observed rows. The forecast series connects
 * visually by also stamping the last observed row with the observed total.
 */
export function spliceForecast(
  pivot: PivotedChart,
  response: CostQueryResponse,
  binning: CostBinningId,
): void {
  const forecast = response.forecast;
  if (!forecast || forecast.length === 0 || pivot.rows.length === 0) return;

  const actualTotals = totalPerBucket(response.series);
  const lastActual = actualTotals[actualTotals.length - 1];
  const binned = binForecast(
    forecast,
    binning,
    binning === "cumulative" ? lastActual?.amount : undefined,
  );

  const lastRow = pivot.rows[pivot.rows.length - 1];
  if (lastRow && lastActual) lastRow[FORECAST_KEY] = lastActual.amount;

  for (const p of binned) {
    const existing = pivot.rows.find((r) => r["bucket"] === p.bucket);
    if (existing) {
      // Partial current bucket: forecast merges into it rather than duplicating.
      existing[FORECAST_KEY] = ((existing[FORECAST_KEY] as number) ?? 0) + p.amount;
    } else {
      pivot.rows.push({ bucket: p.bucket, [FORECAST_KEY]: p.amount });
    }
  }
}

const formatterCache = new Map<string, Intl.NumberFormat>();

export function formatMoney(amount: number, currency: string): string {
  const key = `${currency}:${Math.abs(amount) < 10 ? 2 : 0}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
        maximumFractionDigits: Math.abs(amount) < 10 ? 2 : 0,
      });
    } catch {
      fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    }
    formatterCache.set(key, fmt);
  }
  return fmt.format(amount);
}

/** Short bucket label for axes: "Jul 5", "Jul 2026" for monthly bins. */
export function formatBucketLabel(bucket: string, binning: CostBinningId): string {
  const d = new Date(`${bucket}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return bucket;
  if (binning === "monthly") {
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
