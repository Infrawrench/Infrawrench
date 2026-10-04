/**
 * Metric series for the Metrics tab. Every chart is one NRQL query run in
 * the entity's own account through NerdGraph, with `TIMESERIES` buckets
 * chosen by New Relic (`TIMESERIES AUTO`).
 *
 * Event types and attributes are New Relic's documented defaults:
 * `Transaction` (APM, `duration` in seconds, `error`), `PageView` (browser,
 * `duration` in seconds), `SystemSample` / `NetworkSample` (infrastructure
 * agent), `SyntheticCheck` (`duration` in milliseconds, `result`), and the
 * usage events for accounts.
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { NewRelicContext, NrqlRow } from "./api.js";
import { nrqlString, runNrql } from "./api.js";

export const DEFAULT_METRICS_WINDOW_MS = 6 * 60 * 60 * 1000;
export const USAGE_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

const sinceUntil = (r: TimeRange) => `SINCE ${Math.floor(r.startMs)} UNTIL ${Math.floor(r.endMs)}`;

/**
 * Series out of a TIMESERIES result. `metrics` maps each alias in the query
 * to a label and unit. Rows from a FACET query carry a `facet`; each facet
 * gets its own series per metric.
 */
export function seriesFromRows(
  rows: NrqlRow[],
  metrics: Array<{ alias: string; label: string; unit?: string }>,
): MetricSeries[] {
  const out = new Map<string, MetricSeries>();
  for (const row of rows) {
    const begin = row["beginTimeSeconds"];
    if (typeof begin !== "number") continue;
    const facetRaw = row["facet"];
    const facet = Array.isArray(facetRaw)
      ? facetRaw.join(", ")
      : facetRaw === undefined || facetRaw === null
        ? ""
        : String(facetRaw);
    for (const m of metrics) {
      const value = row[m.alias];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const label = facet ? `${m.label} (${facet})` : m.label;
      let series = out.get(label);
      if (!series) {
        series = { label, ...(m.unit ? { unit: m.unit } : {}), points: [] };
        out.set(label, series);
      }
      (series.points as MetricSeriesPoint[]).push({ timestamp: begin * 1000, value });
    }
  }
  return [...out.values()].filter((s) => s.points.length > 0);
}

async function timeseries(
  ctx: NewRelicContext,
  nrAccountId: number,
  select: string,
  range: TimeRange,
  metrics: Array<{ alias: string; label: string; unit?: string }>,
  bucket = "AUTO",
): Promise<MetricSeries[]> {
  const rows = await runNrql(
    ctx,
    nrAccountId,
    `${select} ${sinceUntil(range)} TIMESERIES ${bucket}`,
  );
  return seriesFromRows(rows, metrics);
}

export function apmSeries(
  ctx: NewRelicContext,
  nrAccountId: number,
  guid: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  return timeseries(
    ctx,
    nrAccountId,
    `SELECT average(duration) * 1000 AS 'rt', rate(count(*), 1 minute) AS 'tp', percentage(count(*), WHERE error IS true) AS 'err' FROM Transaction WHERE entityGuid = ${nrqlString(guid)}`,
    range,
    [
      { alias: "rt", label: "Response time", unit: "ms" },
      { alias: "tp", label: "Throughput", unit: "rpm" },
      { alias: "err", label: "Error rate", unit: "%" },
    ],
  );
}

export function browserSeries(
  ctx: NewRelicContext,
  nrAccountId: number,
  guid: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  return timeseries(
    ctx,
    nrAccountId,
    `SELECT average(duration) AS 'load', rate(count(*), 1 minute) AS 'views' FROM PageView WHERE entityGuid = ${nrqlString(guid)}`,
    range,
    [
      { alias: "load", label: "Page load time", unit: "s" },
      { alias: "views", label: "Page views", unit: "ppm" },
    ],
  );
}

export async function hostSeries(
  ctx: NewRelicContext,
  nrAccountId: number,
  guid: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const [system, network] = await Promise.all([
    timeseries(
      ctx,
      nrAccountId,
      `SELECT average(cpuPercent) AS 'cpu', average(memoryUsedPercent) AS 'mem', average(diskUsedPercent) AS 'disk', average(loadAverageFiveMinute) AS 'load' FROM SystemSample WHERE entityGuid = ${nrqlString(guid)}`,
      range,
      [
        { alias: "cpu", label: "CPU", unit: "%" },
        { alias: "mem", label: "Memory", unit: "%" },
        { alias: "disk", label: "Disk", unit: "%" },
        { alias: "load", label: "Load (5m)" },
      ],
    ),
    timeseries(
      ctx,
      nrAccountId,
      `SELECT sum(receiveBytesPerSecond) AS 'rx', sum(transmitBytesPerSecond) AS 'tx' FROM NetworkSample WHERE entityGuid = ${nrqlString(guid)}`,
      range,
      [
        { alias: "rx", label: "Network in", unit: "B/s" },
        { alias: "tx", label: "Network out", unit: "B/s" },
      ],
    ).catch(() => [] as MetricSeries[]),
  ]);
  return [...system, ...network];
}

export function syntheticSeries(
  ctx: NewRelicContext,
  nrAccountId: number,
  monitorId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  return timeseries(
    ctx,
    nrAccountId,
    `SELECT average(duration) AS 'duration', percentage(count(*), WHERE result = 'FAILED') AS 'failed' FROM SyntheticCheck WHERE monitorId = ${nrqlString(monitorId)}`,
    range,
    [
      { alias: "duration", label: "Duration", unit: "ms" },
      { alias: "failed", label: "Failure rate", unit: "%" },
    ],
  );
}

/**
 * Chart the query an NRQL condition evaluates. Condition queries may not
 * carry SINCE, UNTIL or TIMESERIES (NerdGraph rejects them on save), so the
 * window is appended; a query with a FACET charts one series per facet.
 */
export function conditionSeries(
  ctx: NewRelicContext,
  nrAccountId: number,
  query: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const trimmed = query.trim().replace(/;$/, "");
  if (!trimmed) return Promise.resolve([]);
  return runNrql(ctx, nrAccountId, `${trimmed} ${sinceUntil(range)} TIMESERIES AUTO`).then(
    (rows) => {
      const skip = new Set(["beginTimeSeconds", "endTimeSeconds", "facet"]);
      const aliases = new Set<string>();
      for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
          if (!skip.has(k) && typeof v === "number") aliases.add(k);
        }
      }
      return seriesFromRows(
        rows,
        [...aliases].map((a) => ({ alias: a, label: a })),
      );
    },
  );
}

/** Daily data ingest by source and daily compute, from the usage account. */
export async function usageSeries(
  ctx: NewRelicContext,
  nrAccountId: number,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const [ingest, compute] = await Promise.all([
    timeseries(
      ctx,
      nrAccountId,
      `SELECT sum(GigabytesIngested) AS 'gb' FROM NrConsumption WHERE productLine = 'DataPlatform' FACET usageMetric LIMIT 10`,
      range,
      [{ alias: "gb", label: "Data ingested", unit: "GB" }],
      "1 day",
    ),
    timeseries(
      ctx,
      nrAccountId,
      `SELECT sum(consumption) AS 'ccu' FROM NrConsumption WHERE metric IN ('CoreCCU', 'AdvancedCCU') FACET metric`,
      range,
      [{ alias: "ccu", label: "Compute", unit: "CCU" }],
      "1 day",
    ).catch(() => [] as MetricSeries[]),
  ]);
  return [...ingest, ...compute];
}
