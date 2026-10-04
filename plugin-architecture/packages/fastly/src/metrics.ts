/**
 * Traffic metrics from Fastly's Historical Stats API (`/stats/...`) and the
 * real-time analytics API (`rt.fastly.com`). Field names are the ones in the
 * stats `Results` model of Fastly's published OpenAPI clients (2026-10).
 */
import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { FastlyContext } from "./api.js";
import { REALTIME_BASE, fastlyFetch } from "./api.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One stats bucket. Every field is optional; Fastly omits zero-valued ones. */
export type StatsResult = Record<string, number | string | undefined> & {
  start_time?: number;
};

/**
 * Bucket width for a window: Fastly keeps minutely data for a short while,
 * hourly for longer, daily beyond that. Picking by span keeps every chart
 * between roughly 24 and 200 points.
 */
export function bucketFor(spanMs: number): "minute" | "hour" | "day" {
  if (spanMs <= 3 * 60 * 60 * 1000) return "minute";
  if (spanMs <= 8 * 24 * 60 * 60 * 1000) return "hour";
  return "day";
}

export function rangeOrDefault(
  timeRange: { startMs: number; endMs: number } | undefined,
  windowMs = DEFAULT_METRICS_WINDOW_MS,
): { startMs: number; endMs: number } {
  if (timeRange && timeRange.endMs > timeRange.startMs) return timeRange;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** `GET /stats/service/{id}` for a window; `data` is one bucket per period. */
export async function serviceStats(
  ctx: FastlyContext,
  serviceId: string,
  range: { startMs: number; endMs: number },
  region?: string,
): Promise<StatsResult[]> {
  const res = await fastlyFetch<{ status?: string; msg?: string; data?: StatsResult[] }>(
    ctx,
    `/stats/service/${encodeURIComponent(serviceId)}`,
    {
      query: {
        from: Math.floor(range.startMs / 1000),
        to: Math.floor(range.endMs / 1000),
        by: bucketFor(range.endMs - range.startMs),
        ...(region ? { region } : {}),
      },
    },
  );
  return Array.isArray(res?.data) ? res.data : [];
}

/** `GET /stats/aggregate`: every service on the account, summed per bucket. */
export async function aggregateStats(
  ctx: FastlyContext,
  range: { startMs: number; endMs: number },
): Promise<StatsResult[]> {
  const res = await fastlyFetch<{ data?: StatsResult[] }>(ctx, "/stats/aggregate", {
    query: {
      from: Math.floor(range.startMs / 1000),
      to: Math.floor(range.endMs / 1000),
      by: bucketFor(range.endMs - range.startMs),
    },
  });
  return Array.isArray(res?.data) ? res.data : [];
}

function series(
  label: string,
  rows: readonly StatsResult[],
  value: (r: StatsResult) => number | undefined,
  unit?: string,
): MetricSeries {
  const points: MetricSeriesPoint[] = [];
  for (const r of rows) {
    const ts = n(r.start_time);
    if (!ts) continue;
    const v = value(r);
    if (v === undefined || !Number.isFinite(v)) continue;
    points.push({ timestamp: ts * 1000, value: v });
  }
  points.sort((a, b) => a.timestamp - b.timestamp);
  return { label, ...(unit ? { unit } : {}), points };
}

/** Hit ratio as a percentage: hits over hits + misses, the same as Fastly's dashboard. */
export function hitRatioPct(r: StatsResult): number | undefined {
  const hits = n(r["hits"]);
  const miss = n(r["miss"]);
  if (hits + miss > 0) return (hits / (hits + miss)) * 100;
  if (r["hit_ratio"] !== undefined) return n(r["hit_ratio"]) * 100;
  return undefined;
}

function hasAny(rows: readonly StatsResult[], key: string): boolean {
  return rows.some((r) => n(r[key]) > 0);
}

/**
 * The service chart set: requests, bandwidth, hit ratio, 4xx and 5xx, origin
 * offload, plus Compute, Image Optimizer, Next-Gen WAF and log streaming when
 * the service generated any of them in the window.
 */
export function serviceSeriesFrom(rows: readonly StatsResult[]): MetricSeries[] {
  const out: MetricSeries[] = [
    series("Requests", rows, (r) => n(r["requests"]), "requests"),
    series("Bandwidth", rows, (r) => n(r["bandwidth"]), "bytes"),
    series("Cache hit ratio", rows, hitRatioPct, "%"),
    series("4xx responses", rows, (r) => n(r["status_4xx"]), "responses"),
    series("5xx responses", rows, (r) => n(r["status_5xx"]), "responses"),
    series("Errors", rows, (r) => n(r["errors"]), "requests"),
    series(
      "Origin offload",
      rows,
      (r) => (r["origin_offload"] === undefined ? undefined : n(r["origin_offload"]) * 100),
      "%",
    ),
  ];
  if (hasAny(rows, "compute_requests")) {
    out.push(
      series("Compute requests", rows, (r) => n(r["compute_requests"]), "requests"),
      series(
        "Compute billed request time",
        rows,
        (r) => n(r["compute_request_time_billed_ms"]),
        "ms",
      ),
      series("Compute CPU time", rows, (r) => n(r["compute_execution_time_ms"]), "ms"),
    );
  }
  if (hasAny(rows, "imgopto")) {
    out.push(series("Image Optimizer responses", rows, (r) => n(r["imgopto"]), "responses"));
  }
  if (hasAny(rows, "ngwaf_requests_total_count")) {
    out.push(
      series("Next-Gen WAF inspected", rows, (r) => n(r["ngwaf_requests_total_count"]), "requests"),
      series("Next-Gen WAF blocked", rows, (r) => n(r["ngwaf_requests_blocked_count"]), "requests"),
    );
  }
  if (hasAny(rows, "attack_blocked_req_body_bytes") || hasAny(rows, "waf_blocked")) {
    out.push(
      series(
        "WAF blocked request bytes",
        rows,
        (r) => n(r["attack_blocked_req_body_bytes"]) + n(r["attack_blocked_req_header_bytes"]),
        "bytes",
      ),
    );
  }
  if (hasAny(rows, "log")) {
    out.push(series("Log lines streamed", rows, (r) => n(r["log"]), "lines"));
  }
  return out;
}

export interface StatsTotals {
  requests: number;
  bandwidth: number;
  hitRatio?: number;
  status4xx: number;
  status5xx: number;
  errors: number;
}

export function totalsOf(rows: readonly StatsResult[]): StatsTotals {
  let requests = 0;
  let bandwidth = 0;
  let hits = 0;
  let miss = 0;
  let status4xx = 0;
  let status5xx = 0;
  let errors = 0;
  for (const r of rows) {
    requests += n(r["requests"]);
    bandwidth += n(r["bandwidth"]);
    hits += n(r["hits"]);
    miss += n(r["miss"]);
    status4xx += n(r["status_4xx"]);
    status5xx += n(r["status_5xx"]);
    errors += n(r["errors"]);
  }
  return {
    requests,
    bandwidth,
    ...(hits + miss > 0 ? { hitRatio: (hits / (hits + miss)) * 100 } : {}),
    status4xx,
    status5xx,
    errors,
  };
}

/** One second of real-time data, already summed across every POP. */
interface RealtimeEntry {
  recorded?: number;
  aggregated?: Record<string, number>;
}

/**
 * `GET rt.fastly.com/v1/channel/{id}/ts/h`: the last 120 seconds, one record
 * per second. Returned as totals per second over that window.
 */
export async function realtimeSnapshot(
  ctx: FastlyContext,
  serviceId: string,
): Promise<
  | {
      seconds: number;
      requestsPerSecond: number;
      bytesPerSecond: number;
      hitRatio?: number;
      errorsPerSecond: number;
      status5xxPerSecond: number;
    }
  | undefined
> {
  const res = await fastlyFetch<{ data?: RealtimeEntry[] }>(
    ctx,
    `/v1/channel/${encodeURIComponent(serviceId)}/ts/h`,
    { base: REALTIME_BASE },
  );
  const entries = (res?.data ?? []).filter((e) => e.aggregated);
  if (entries.length === 0) return undefined;
  let requests = 0;
  let bytes = 0;
  let hits = 0;
  let miss = 0;
  let errors = 0;
  let s5xx = 0;
  for (const e of entries) {
    const a = e.aggregated ?? {};
    requests += n(a["requests"]);
    bytes += n(a["resp_header_bytes"]) + n(a["resp_body_bytes"]);
    hits += n(a["hits"]);
    miss += n(a["miss"]);
    errors += n(a["errors"]);
    s5xx += n(a["status_5xx"]);
  }
  const seconds = entries.length;
  return {
    seconds,
    requestsPerSecond: requests / seconds,
    bytesPerSecond: bytes / seconds,
    ...(hits + miss > 0 ? { hitRatio: (hits / (hits + miss)) * 100 } : {}),
    errorsPerSecond: errors / seconds,
    status5xxPerSecond: s5xx / seconds,
  };
}
