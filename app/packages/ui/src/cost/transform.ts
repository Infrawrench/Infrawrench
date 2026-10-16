/**
 * Recharts-shaped data helpers for cost charts: pivot grouped series into
 * rows, align previous-period comparisons onto the current axis, and splice
 * forecast rows onto the end. No React, no fetching: unit-test target.
 *
 * The binning and formatting helpers these build on are platform-neutral and
 * live in `@infrawrench/client-core` (mobile draws the same charts with SVG);
 * they are re-exported here so recharts callers still import one module.
 */
import { binForecast, costCategoryChart, totalPerBucket } from "@infrawrench/client-core";
import type { CostBinningId, CostQueryResponse, CostQuerySeries } from "./config.js";

export {
  binForecast,
  totalPerBucket,
  formatMoney,
  formatBucketLabel,
  formatBudgetMonth,
} from "@infrawrench/client-core";

export interface ChartSeriesDef {
  /** recharts dataKey: group key made collision-safe. */
  dataKey: string;
  /** The series' group key as the API returned it: what a drill narrows to. */
  key: string;
  label: string;
  currency: string;
  isOther: boolean;
}

export interface PivotedChart {
  /**
   * One row per bucket: { bucket: "2026-07-01", s0: 12.3, s1: 4.5, ... }. On a
   * dimension X axis `bucket` is the dimension value and {@link LABEL_KEY}
   * carries its display label.
   */
  rows: Array<Record<string, string | number | null>>;
  series: ChartSeriesDef[];
}

export const COMPARISON_KEY = "__previous__";
export const FORECAST_KEY = "__forecast__";
export const SCENARIO_KEY = "__scenario__";
/** A dimension-axis row's display label (its `bucket` is the raw value). */
export const LABEL_KEY = "__label__";

/**
 * Rows for a dimension-X-axis response: one per value in the server's order
 * (ranked by spend, "Other" last), a column per segment, and the previous
 * period paired by value. The layout itself is client-core's
 * `costCategoryChart`, shared with mobile and the PDF.
 */
export function pivotDimensionAxis(
  response: CostQueryResponse,
  binning: CostBinningId,
): PivotedChart {
  const chart = costCategoryChart(response, binning);
  const series: ChartSeriesDef[] = chart.series.map((s, i) => ({
    dataKey: `s${i}`,
    key: s.key,
    label: s.label,
    currency: s.currency,
    isOther: s.isOther,
  }));
  const rows = chart.categories.map((c, at) => {
    const row: Record<string, string | number | null> = { bucket: c.key, [LABEL_KEY]: c.label };
    chart.series.forEach((s, i) => {
      const v = s.values[at];
      if (v !== null && v !== undefined) row[`s${i}`] = v;
    });
    if (chart.previous) row[COMPARISON_KEY] = chart.previous[at] ?? null;
    return row;
  });
  return { rows, series };
}

/** The forecast band's bounds, as plain numbers per row (the axis reads them). */
export const FORECAST_LOW_KEY = "__forecast_low__";
export const FORECAST_HIGH_KEY = "__forecast_high__";
/** The range area's series name: never a row key, `forecastBandOf` builds its value. */
export const FORECAST_BAND_KEY = "__forecast_band__";

/**
 * Pivot per-group series into recharts rows keyed by bucket. Series order is
 * preserved from the API (ranked by period total, "Other" last) so
 * categorical colors follow entities, not ranks, across refreshes with the
 * same grouping.
 */
export function pivotSeries(series: CostQuerySeries[]): PivotedChart {
  const defs: ChartSeriesDef[] = series.map((s, i) => ({
    dataKey: `s${i}`,
    key: s.key,
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

/**
 * Append forecast rows after the observed rows. The forecast series connects
 * visually by also stamping the last observed row with the observed total.
 */
export function spliceForecast(
  pivot: PivotedChart,
  response: CostQueryResponse,
  binning: CostBinningId,
  cumulative = binning === "cumulative",
): void {
  const forecast = response.forecast;
  if (!forecast || forecast.length === 0 || pivot.rows.length === 0) return;

  const actualTotals = totalPerBucket(response.series);
  const lastActual = actualTotals[actualTotals.length - 1];
  const binned = binForecast(
    forecast,
    binning,
    cumulative ? lastActual?.amount : undefined,
    cumulative,
  );

  const lastRow = pivot.rows[pivot.rows.length - 1];
  const bounded = binned.length > 0 && binned.every((p) => p.low !== undefined);
  if (lastRow && lastActual) {
    lastRow[FORECAST_KEY] = lastActual.amount;
    // The band leaves the actuals from the same point the line does: zero
    // width on the last observed bucket, then fanning out.
    if (bounded) {
      lastRow[FORECAST_LOW_KEY] = lastActual.amount;
      lastRow[FORECAST_HIGH_KEY] = lastActual.amount;
    }
  }

  for (const p of binned) {
    const existing = pivot.rows.find((r) => r["bucket"] === p.bucket);
    if (existing) {
      // Partial current bucket: forecast merges into it rather than duplicating.
      const prior = (existing[FORECAST_KEY] as number) ?? 0;
      existing[FORECAST_KEY] = prior + p.amount;
      if (bounded) {
        existing[FORECAST_LOW_KEY] = prior + (p.low ?? p.amount);
        existing[FORECAST_HIGH_KEY] = prior + (p.high ?? p.amount);
      }
    } else {
      pivot.rows.push({
        bucket: p.bucket,
        [FORECAST_KEY]: p.amount,
        ...(bounded ? { [FORECAST_LOW_KEY]: p.low!, [FORECAST_HIGH_KEY]: p.high! } : {}),
      });
    }
  }
}

/**
 * The band for a row, as recharts' range-area value: `[low, high]`, or null
 * where the row has no projection (so the area does not reach back over the
 * observed buckets).
 */
export function forecastBandOf(
  row: Record<string, string | number | null>,
): [number, number] | null {
  const low = row[FORECAST_LOW_KEY];
  const high = row[FORECAST_HIGH_KEY];
  return typeof low === "number" && typeof high === "number" ? [low, high] : null;
}

/**
 * Append the scenario-adjusted projection as a **second** overlay series,
 * alongside the trend rather than in place of it.
 *
 * Deliberately a separate function and a separate data key from
 * {@link spliceForecast}, because that separation is the feature's central
 * rule: a reader must always be able to see what the trend said before
 * somebody's assumptions touched it. Two lines on one chart is the whole point.
 *
 * Called after `spliceForecast`, so the rows the scenario needs already exist;
 * it only ever writes {@link SCENARIO_KEY}, never a series value, so the stacks
 * and the totals are identical whether or not a scenario is applied. Buckets
 * outside the drawn range are ignored rather than appended: the scenario
 * covers exactly the forecast's days, so this can only fire on a mismatch, and
 * quietly widening the axis would be the wrong repair.
 */
export function spliceScenario(
  pivot: PivotedChart,
  response: CostQueryResponse,
  binning: CostBinningId,
  cumulative = binning === "cumulative",
): void {
  const scenario = response.scenario;
  if (!scenario || scenario.points.length === 0 || pivot.rows.length === 0) return;

  const actualTotals = totalPerBucket(response.series);
  const lastActual = actualTotals[actualTotals.length - 1];
  const binned = binForecast(
    scenario.points,
    binning,
    cumulative ? lastActual?.amount : undefined,
    cumulative,
  );

  // Anchor on the last observed bucket so the dashed line leaves the actuals
  // from the same point the trend line does, rather than floating.
  const lastRow = pivot.rows[pivot.rows.length - 1];
  const anchorBucket = String(lastRow?.["bucket"] ?? "");

  for (const p of binned) {
    const existing = pivot.rows.find((r) => r["bucket"] === p.bucket);
    if (existing) {
      existing[SCENARIO_KEY] = ((existing[SCENARIO_KEY] as number) ?? 0) + p.amount;
    } else {
      pivot.rows.push({ bucket: p.bucket, [SCENARIO_KEY]: p.amount });
    }
  }

  const anchor = pivot.rows.find((r) => r["bucket"] === anchorBucket);
  if (anchor && lastActual && anchor[SCENARIO_KEY] === undefined) {
    anchor[SCENARIO_KEY] = lastActual.amount;
  }
}
