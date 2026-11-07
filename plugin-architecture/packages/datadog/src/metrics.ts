/**
 * Metric series for the Metrics tab. Every chart here reads an endpoint the
 * account's keys already have to be able to call for the type to list, plus
 * `timeseries_query` for the host and monitor charts.
 *
 * - Hosts and metric monitors: `GET /api/v1/query` (`from`/`to` in epoch
 *   seconds, a metric query, `series[].pointlist` of `[ms, value]` pairs).
 * - SLOs: `GET /api/v1/slo/{id}/history` (`from_ts`/`to_ts` in seconds).
 *   Metric SLOs return numerator/denominator series; monitor and time-slice
 *   SLOs return an uptime history of `[seconds, 0|1]` pairs per monitor.
 * - Synthetic tests: `GET /api/v1/synthetics/tests/{id}/results`, the last
 *   results per location with timings and a pass flag. Browser tests have their
 *   own route, whose results carry a duration, an error count and step counts.
 * - Organizations: `GET /api/v2/usage/hourly_usage` by product family.
 */

import { pathEncode, type MetricSeries, type MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { DatadogContext } from "./api.js";
import type { components } from "./api-types.v1.gen.js";
import { productLabel } from "./products.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const USAGE_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

/** Run one metric query and return its series, labelled `label` (+ scope when grouped). */
export async function querySeries(
  ctx: DatadogContext,
  query: string,
  label: string,
  range: TimeRange,
  unit?: string,
): Promise<MetricSeries[]> {
  const res = await ctx.v1.get("/api/v1/query", {
    query: {
      from: Math.floor(range.startMs / 1000),
      to: Math.floor(range.endMs / 1000),
      query,
    },
  });
  const series = res.series ?? [];
  return series
    .map((s): MetricSeries => {
      const points: MetricSeriesPoint[] = [];
      for (const [ts, value] of s.pointlist ?? []) {
        if (typeof ts === "number" && typeof value === "number" && Number.isFinite(value)) {
          points.push({ timestamp: ts, value });
        }
      }
      const resolvedUnit = unit ?? s.unit?.[0]?.short_name ?? s.unit?.[0]?.name;
      const grouped = series.length > 1 && s.scope ? ` (${s.scope})` : "";
      return {
        label: `${label}${grouped}`,
        ...(resolvedUnit ? { unit: resolvedUnit } : {}),
        points,
      };
    })
    .filter((s) => s.points.length > 0);
}

/** Datadog tag values may not contain spaces or commas; a host name never should. */
function hostScope(host: string): string {
  return `host:${host.replace(/[\s,{}]/g, "_")}`;
}

export async function hostSeries(
  ctx: DatadogContext,
  host: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const scope = hostScope(host);
  const charts: Array<[string, string, string?]> = [
    [`avg:system.cpu.user{${scope}}`, "CPU user", "%"],
    [`avg:system.cpu.system{${scope}}`, "CPU system", "%"],
    [`avg:system.cpu.iowait{${scope}}`, "CPU I/O wait", "%"],
    [`avg:system.load.1{${scope}}`, "Load (1m)"],
    [`avg:system.mem.pct_usable{${scope}}*100`, "Memory usable", "%"],
    [`max:system.disk.in_use{${scope}}*100`, "Disk in use (fullest)", "%"],
    [`sum:system.net.bytes_rcvd{${scope}}`, "Network in", "B/s"],
    [`sum:system.net.bytes_sent{${scope}}`, "Network out", "B/s"],
  ];
  const settled = await Promise.allSettled(
    charts.map(([q, label, unit]) => querySeries(ctx, q, label, range, unit)),
  );
  // A single denied query must not blank the tab, but if every one failed
  // (no `timeseries_query`), surface the first error rather than "no data".
  const ok = settled.filter((s) => s.status === "fulfilled");
  if (ok.length === 0 && settled[0]?.status === "rejected") throw settled[0].reason;
  return ok.flatMap((s) => s.value);
}

const COMPARATOR = /\s*(>=|<=|>|<|==|!=)\s*-?\d+(?:\.\d+)?\s*$/;
const EVAL_WINDOW = /^\s*[a-z_]+\([^)]*\)\s*:/i;

/**
 * The chartable part of a metric/query alert query: drop the evaluation
 * window prefix (`avg(last_5m):`) and the trailing comparison (`> 90`).
 * Returns undefined for monitor types whose query is not a metric query.
 */
export function chartableMonitorQuery(type: string, query: string): string | undefined {
  if (type !== "metric alert" && type !== "query alert") return undefined;
  if (!EVAL_WINDOW.test(query) || !COMPARATOR.test(query)) return undefined;
  const inner = query.replace(EVAL_WINDOW, "").replace(COMPARATOR, "").trim();
  return inner || undefined;
}

export async function monitorSeries(
  ctx: DatadogContext,
  type: string,
  query: string,
  thresholdsJson: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const chartable = chartableMonitorQuery(type, query);
  if (!chartable) return [];
  const series = await querySeries(ctx, chartable, "Value", range);
  if (series.length === 0) return series;
  let thresholds: Record<string, number | null> = {};
  try {
    thresholds = JSON.parse(thresholdsJson || "{}");
  } catch {
    thresholds = {};
  }
  const first = series[0]!.points;
  const flat = (label: string, value: number | null | undefined): MetricSeries[] =>
    typeof value === "number" && first.length > 0
      ? [
          {
            label,
            points: [
              { timestamp: first[0]!.timestamp, value },
              { timestamp: first[first.length - 1]!.timestamp, value },
            ],
          },
        ]
      : [];
  return [
    ...series,
    ...flat("Critical threshold", thresholds["critical"]),
    ...flat("Warning threshold", thresholds["warning"]),
  ];
}

export async function sloSeries(
  ctx: DatadogContext,
  sloId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const res = await ctx.v1.get(`/api/v1/slo/${pathEncode(sloId)}/history`, {
    query: {
      from_ts: Math.floor(range.startMs / 1000),
      to_ts: Math.floor(range.endMs / 1000),
    },
  });
  const data = res.data ?? {};
  const out: MetricSeries[] = [];
  const times = data.series?.times ?? [];
  const num = data.series?.numerator?.values ?? [];
  const den = data.series?.denominator?.values ?? [];
  if (times.length > 0 && den.length > 0) {
    // Metric SLO: good / total per interval, as a percentage.
    const sli: MetricSeriesPoint[] = [];
    const good: MetricSeriesPoint[] = [];
    const bad: MetricSeriesPoint[] = [];
    times.forEach((t, i) => {
      const n = num[i];
      const d = den[i];
      if (typeof n !== "number" || typeof d !== "number") return;
      // `times` are epoch milliseconds in the metric history.
      if (d > 0) sli.push({ timestamp: t, value: (n / d) * 100 });
      good.push({ timestamp: t, value: n });
      bad.push({ timestamp: t, value: Math.max(0, d - n) });
    });
    if (sli.length > 0) out.push({ label: "SLI", unit: "%", points: sli });
    if (good.length > 0) out.push({ label: "Good events", points: good });
    if (bad.length > 0) out.push({ label: "Bad events", points: bad });
  }
  const history = data.overall?.history ?? [];
  if (history.length > 0) {
    // Monitor / time-slice SLO: `[epoch seconds, state]` transitions, where
    // 0 is uptime, 1 downtime and 2 no data. No-data transitions are left
    // out rather than guessed at: whether they count as uptime depends on
    // the monitor's own settings.
    out.push({
      label: "Up",
      unit: "%",
      points: history.flatMap(([t, v]) =>
        typeof t === "number" && (v === 0 || v === 1)
          ? [{ timestamp: t * 1000, value: v === 0 ? 100 : 0 }]
          : [],
      ),
    });
  }
  return out;
}

type SyntheticsApiResult = components["schemas"]["SyntheticsAPITestResultShort"];
type SyntheticsBrowserResult = components["schemas"]["SyntheticsBrowserTestResultShort"];

const byTime = (points: MetricSeriesPoint[]) => points.sort((a, b) => a.timestamp - b.timestamp);

/** One series per location, in the order the locations first appear. */
function perLocation(label: string, runs: Map<string, MetricSeriesPoint[]>): MetricSeries[] {
  return [...runs].map(([loc, points]) => ({
    label: `${label} (${loc})`,
    unit: "ms",
    points: byTime(points),
  }));
}

function addRun(
  runs: Map<string, MetricSeriesPoint[]>,
  location: string | undefined,
  point: MetricSeriesPoint,
): void {
  const loc = location ?? "all";
  runs.set(loc, [...(runs.get(loc) ?? []), point]);
}

/** A series that is all zeros says nothing, so it is left out. */
function whenNonZero(label: string, points: MetricSeriesPoint[]): MetricSeries[] {
  return points.some((p) => p.value > 0) ? [{ label, points: byTime(points) }] : [];
}

function apiTestSeries(results: SyntheticsApiResult[]): MetricSeries[] {
  const times = new Map<string, MetricSeriesPoint[]>();
  const failures: MetricSeriesPoint[] = [];
  for (const { check_time: timestamp, probe_dc, result } of results) {
    if (typeof timestamp !== "number") continue;
    const total = result?.timings?.total;
    if (typeof total === "number") addRun(times, probe_dc, { timestamp, value: total });
    failures.push({ timestamp, value: result?.passed === false ? 1 : 0 });
  }
  return [...perLocation("Response time", times), ...whenNonZero("Failed runs", failures)];
}

/**
 * A browser test's result has no pass flag. `stepCountCompleted` is documented as the
 * steps completed before failing, so a run that stops short of `stepCountTotal` failed.
 * `errorCount` is charted on its own: a run can collect errors and still pass.
 */
function browserTestSeries(results: SyntheticsBrowserResult[]): MetricSeries[] {
  const durations = new Map<string, MetricSeriesPoint[]>();
  const errors: MetricSeriesPoint[] = [];
  const failures: MetricSeriesPoint[] = [];
  for (const { check_time: timestamp, probe_dc, result } of results) {
    if (typeof timestamp !== "number") continue;
    if (typeof result?.duration === "number") {
      addRun(durations, probe_dc, { timestamp, value: result.duration });
    }
    if (typeof result?.errorCount === "number") {
      errors.push({ timestamp, value: result.errorCount });
    }
    const { stepCountCompleted: completed, stepCountTotal: total } = result ?? {};
    const failed = typeof completed === "number" && typeof total === "number" && completed < total;
    failures.push({ timestamp, value: failed ? 1 : 0 });
  }
  return [
    ...perLocation("Duration", durations),
    ...whenNonZero("Errors", errors),
    ...whenNonZero("Failed runs", failures),
  ];
}

export async function syntheticsSeries(
  ctx: DatadogContext,
  publicId: string,
  type: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const query = { from_ts: range.startMs, to_ts: range.endMs };
  const id = pathEncode(publicId);
  if (type === "browser") {
    const res = await ctx.v1.get(`/api/v1/synthetics/tests/browser/${id}/results`, { query });
    return browserTestSeries(res.results ?? []);
  }
  const res = await ctx.v1.get(`/api/v1/synthetics/tests/${id}/results`, { query });
  return apiTestSeries(res.results ?? []);
}

/** Product families charted on an organization; the ones most bills are made of. */
const USAGE_FAMILIES = [
  "infra_hosts",
  "indexed_logs",
  "logs",
  "indexed_spans",
  "ingested_spans",
  "timeseries",
  "synthetics_api",
  "synthetics_browser",
  "rum",
  "serverless",
];

const MAX_USAGE_SERIES = 16;
const MAX_USAGE_PAGES = 10;

export async function usageSeries(
  ctx: DatadogContext,
  publicId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const hour = (ms: number) => new Date(ms).toISOString().slice(0, 13);
  const byType = new Map<string, Map<number, number>>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_USAGE_PAGES; page++) {
    const res = await ctx.v2.get("/api/v2/usage/hourly_usage", {
      query: {
        "filter[timestamp][start]": hour(range.startMs),
        "filter[timestamp][end]": hour(range.endMs),
        "filter[product_families]": USAGE_FAMILIES.join(","),
        "filter[include_descendants]": true,
        "page[limit]": 500,
        ...(cursor ? { "page[next_record_id]": cursor } : {}),
      },
    });
    for (const row of res.data ?? []) {
      const a = row.attributes ?? {};
      if (publicId && a.public_id && a.public_id !== publicId) continue;
      const ts = Date.parse(a.timestamp ?? "");
      if (!Number.isFinite(ts)) continue;
      for (const m of a.measurements ?? []) {
        if (!m.usage_type || typeof m.value !== "number") continue;
        const points = byType.get(m.usage_type) ?? new Map<number, number>();
        points.set(ts, (points.get(ts) ?? 0) + m.value);
        byType.set(m.usage_type, points);
      }
    }
    cursor = res.meta?.pagination?.next_record_id ?? undefined;
    if (!cursor) break;
  }
  return [...byType.entries()]
    .map(([usageType, points]) => {
      const sorted = [...points.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, value]) => ({ timestamp, value }));
      const peak = sorted.reduce((m, p) => Math.max(m, p.value), 0);
      return { usageType, sorted, peak };
    })
    .filter((s) => s.peak > 0)
    .sort((a, b) => b.peak - a.peak)
    .slice(0, MAX_USAGE_SERIES)
    .map((s): MetricSeries => ({
      label: productLabel(s.usageType),
      ...(/bytes/.test(s.usageType) ? { unit: "bytes" } : {}),
      points: s.sorted,
    }));
}
