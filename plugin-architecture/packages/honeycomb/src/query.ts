/**
 * Honeycomb's Query Data API, as the Metrics tab uses it.
 *
 * Running a query is three calls: `POST /1/queries/{dataset}` validates a
 * query spec and returns its id, `POST /1/query_results/{dataset}` starts a
 * run, and `GET /1/query_results/{dataset}/{id}` is polled until `complete`.
 * The documented restrictions shape everything here:
 *
 * - results only cover the last 7 days, so ranges are clamped to that;
 * - creating a result is limited to 10 per minute per key, so each chart is
 *   one query carrying several calculations, never one query per series;
 * - a run may take up to 10 seconds, so polling stops after ~12.
 *
 * The key needs the Run Queries and Manage Queries and Columns permissions.
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { HoneycombContext } from "./api.js";
import { ds, v1 } from "./api.js";
import type { HnyQueryResult, HnyQuerySpec } from "./types.js";

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_QUERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const POLL_ATTEMPTS = 24;
const MAX_GROUPS = 8;

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

/** Clamp a range to the 7 days the Query Data API can read. */
export function clampQueryRange(range: TimeRange, now = Date.now()): TimeRange {
  const endMs = Math.min(range.endMs, now);
  const startMs = Math.max(range.startMs, now - MAX_QUERY_WINDOW_MS + 60_000);
  return { startMs: Math.min(startMs, endMs - 60_000), endMs };
}

/**
 * A granularity (seconds) giving roughly 120 points, which the API accepts as
 * long as it lies between range/1000 and the range itself.
 */
export function granularityFor(range: TimeRange): number {
  const seconds = Math.max(60, Math.floor((range.endMs - range.startMs) / 1000));
  const g = Math.max(60, Math.round(seconds / 120 / 60) * 60);
  return Math.min(g, seconds);
}

/** The key a calculation's value appears under in a result's `data`. */
export function calculationKey(c: {
  op?: string;
  column?: string | null;
  name?: string | null;
}): string {
  if (c.name) return c.name;
  const op = c.op ?? "COUNT";
  return c.column ? `${op}(${c.column})` : op;
}

/**
 * Give a stored query spec a fixed absolute window: Honeycomb rejects specs
 * carrying both `time_range` and both ends, and `id` is read-only.
 */
export function respec(spec: HnyQuerySpec, range: TimeRange): HnyQuerySpec {
  const { id: _id, time_range: _tr, start_time: _s, end_time: _e, granularity: _g, ...rest } = spec;
  return {
    ...rest,
    start_time: Math.floor(range.startMs / 1000),
    end_time: Math.floor(range.endMs / 1000),
    granularity: granularityFor(range),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Create the query, start a run and poll it to completion. */
export async function runQuery(
  ctx: HoneycombContext,
  key: string,
  dataset: string,
  spec: HnyQuerySpec,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<HnyQueryResult> {
  const query = await v1<HnyQuerySpec>(ctx, key, `/1/queries/${ds(dataset)}`, {
    method: "POST",
    body: JSON.stringify(spec),
  });
  if (!query?.id) throw new Error("Honeycomb did not return a query id");
  return runSavedQuery(ctx, key, dataset, query.id, wait);
}

/** Start a run of an existing query id and poll it to completion. */
export async function runSavedQuery(
  ctx: HoneycombContext,
  key: string,
  dataset: string,
  queryId: string,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<HnyQueryResult> {
  const started = await v1<HnyQueryResult>(ctx, key, `/1/query_results/${ds(dataset)}`, {
    method: "POST",
    body: JSON.stringify({ query_id: queryId, disable_series: false, limit: 1000 }),
  });
  let result = started;
  for (let i = 0; i < POLL_ATTEMPTS && !result.complete; i++) {
    if (!result.id) break;
    await wait(POLL_INTERVAL_MS);
    result = await v1<HnyQueryResult>(
      ctx,
      key,
      `/1/query_results/${ds(dataset)}/${encodeURIComponent(result.id)}`,
    );
  }
  if (result.error) throw new Error(`Honeycomb query failed: ${result.error}`);
  if (!result.complete) {
    throw new Error("Honeycomb query did not finish within the API's 10-second limit");
  }
  return result;
}

export interface SeriesSpec {
  /** Key under which the value appears in `data` (see {@link calculationKey}). */
  key: string;
  label: string;
  unit?: string;
}

/**
 * Turn a result's time series into chart series: one per requested
 * calculation, and per breakdown group when the query has breakdowns (the
 * busiest {@link MAX_GROUPS} groups by total).
 */
export function resultSeries(
  result: HnyQueryResult,
  wanted: SeriesSpec[],
  breakdowns: string[] = [],
): MetricSeries[] {
  const rows = result.data?.series ?? [];
  const byLabel = new Map<
    string,
    { spec: SeriesSpec; total: number; points: MetricSeriesPoint[] }
  >();
  for (const row of rows) {
    const ts = row.time ? Date.parse(row.time) : NaN;
    if (!Number.isFinite(ts)) continue;
    const data = row.data ?? {};
    const group = breakdowns
      .map((b) => data[b])
      .filter((v) => v !== undefined && v !== null && v !== "")
      .map(String)
      .join(", ");
    for (const spec of wanted) {
      const raw = data[spec.key];
      const value = typeof raw === "number" ? raw : raw === null ? NaN : Number(raw);
      if (!Number.isFinite(value)) continue;
      const label = group ? `${spec.label} (${group})` : spec.label;
      let entry = byLabel.get(label);
      if (!entry) {
        entry = { spec, total: 0, points: [] };
        byLabel.set(label, entry);
      }
      entry.total += Math.abs(value);
      entry.points.push({ timestamp: ts, value });
    }
  }
  let entries = [...byLabel.entries()];
  if (breakdowns.length > 0) {
    entries = entries.sort((a, b) => b[1].total - a[1].total).slice(0, MAX_GROUPS * wanted.length);
  }
  return entries.map(([label, e]) => ({
    label,
    ...(e.spec.unit ? { unit: e.spec.unit } : {}),
    points: e.points.sort((a, b) => a.timestamp - b.timestamp),
  }));
}

/** Series for every calculation of a stored query spec. */
export function specSeries(spec: HnyQuerySpec): SeriesSpec[] {
  const calcs = spec.calculations?.length ? spec.calculations : [{ op: "COUNT" }];
  return calcs
    .filter((c) => c.op !== "HEATMAP")
    .map((c) => ({ key: calculationKey(c), label: calculationKey(c) }));
}
