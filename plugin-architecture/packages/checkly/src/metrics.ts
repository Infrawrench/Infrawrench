/**
 * Metric series for checks, from raw check results
 * (`GET /v2/check-results/{checkId}`, kept for 30 days, cursor-paged with
 * `nextId`, rate-limited to 60 requests a minute): response time per run
 * location and failed runs per time bucket. Aggregates for the whole window
 * (availability, p95) come from the Analytics API, whose per-type endpoint
 * and metric names differ (`ANALYTICS` below, from the OpenAPI document).
 */
import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { ChecklyContext } from "./api.js";
import { ckFetch } from "./api.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 10;
const RESULTS_RETENTION_MS = 30 * 86400_000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

interface CheckResult {
  startedAt?: string;
  created_at?: string;
  responseTime?: number;
  runLocation?: string;
  hasFailures?: boolean;
  hasErrors?: boolean;
}

/** Bucket size giving about 100 points, at least a minute. */
export function bucketMs(range: TimeRange): number {
  return Math.max(60_000, Math.round((range.endMs - range.startMs) / 100 / 60_000) * 60_000);
}

export function resultsToSeries(results: CheckResult[], range: TimeRange): MetricSeries[] {
  const bucket = bucketMs(range);
  const perLocation = new Map<string, Map<number, { sum: number; count: number }>>();
  const failures = new Map<number, number>();
  const runs = new Map<number, number>();
  for (const r of results) {
    const ts = Date.parse(r.startedAt ?? r.created_at ?? "");
    if (!Number.isFinite(ts)) continue;
    const b = Math.floor(ts / bucket) * bucket;
    runs.set(b, (runs.get(b) ?? 0) + 1);
    if (r.hasFailures || r.hasErrors) failures.set(b, (failures.get(b) ?? 0) + 1);
    if (typeof r.responseTime === "number" && Number.isFinite(r.responseTime)) {
      const loc = r.runLocation ?? "unknown";
      const m = perLocation.get(loc) ?? new Map<number, { sum: number; count: number }>();
      const cell = m.get(b) ?? { sum: 0, count: 0 };
      cell.sum += r.responseTime;
      cell.count += 1;
      m.set(b, cell);
      perLocation.set(loc, m);
    }
  }
  const sorted = (entries: Array<[number, number]>): MetricSeriesPoint[] =>
    entries.sort((a, b) => a[0] - b[0]).map(([timestamp, value]) => ({ timestamp, value }));
  const out: MetricSeries[] = [...perLocation.entries()].map(([loc, m]) => ({
    label: `Response time (${loc})`,
    unit: "ms",
    points: sorted([...m.entries()].map(([t, c]) => [t, c.sum / c.count])),
  }));
  if (runs.size > 0) {
    out.push({
      label: "Failed runs",
      unit: "runs",
      points: sorted([...runs.keys()].map((t) => [t, failures.get(t) ?? 0])),
    });
  }
  return out;
}

export async function checkResultSeries(
  ctx: ChecklyContext,
  checkId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const from = Math.max(range.startMs, Date.now() - RESULTS_RETENTION_MS);
  const results: CheckResult[] = [];
  let nextId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ckFetch<{ entries?: CheckResult[]; nextId?: string | null }>(
      ctx,
      `/v2/check-results/${encodeURIComponent(checkId)}`,
      {
        query: {
          from: Math.floor(from / 1000),
          to: Math.floor(range.endMs / 1000),
          limit: 100,
          resultType: "FINAL",
          ...(nextId ? { nextId } : {}),
        },
      },
    );
    results.push(...(res.entries ?? []));
    nextId = res.nextId ?? undefined;
    if (!nextId) break;
  }
  return resultsToSeries(results, { startMs: from, endMs: range.endMs });
}

/** Analytics endpoint and the window aggregates worth showing, per check type. */
export const ANALYTICS: Record<string, { path: string; metrics: string[] }> = {
  API: { path: "api-checks", metrics: ["availability", "responseTime_avg", "responseTime_p95"] },
  URL: { path: "url-monitors", metrics: ["availability", "responseTime_avg", "responseTime_p95"] },
  BROWSER: { path: "browser-checks", metrics: ["availability", "responseTime_avg", "LCP_p95"] },
  MULTI_STEP: {
    path: "multistep-checks",
    metrics: ["availability", "responseTime_avg", "responseTime_p95"],
  },
  PLAYWRIGHT: {
    path: "playwright-checks",
    metrics: ["availability", "responseTime_avg", "responseTime_p95"],
  },
  TCP: { path: "tcp-checks", metrics: ["availability", "total_avg", "total_p95"] },
  DNS: { path: "dns", metrics: ["availability", "total_avg", "total_p95"] },
  ICMP: { path: "icmp", metrics: ["availability", "latencyAvg_avg", "packetLoss_avg"] },
  SSL: { path: "ssl", metrics: ["availability", "daysUntilExpiry_avg"] },
  HEARTBEAT: { path: "heartbeat-checks", metrics: ["availability"] },
};

/** Window aggregates (one row, no interval) for the detail page. */
export async function checkAnalytics(
  ctx: ChecklyContext,
  checkId: string,
  checkType: string,
  quickRange = "last7Days",
): Promise<Record<string, number>> {
  const spec = ANALYTICS[checkType];
  if (!spec) return {};
  const res = await ckFetch<{
    series?: Array<{ data?: Array<Record<string, unknown>> | Record<string, unknown> }>;
  }>(ctx, `/v1/analytics/${spec.path}/${encodeURIComponent(checkId)}`, {
    query: { quickRange, metrics: spec.metrics },
  });
  const out: Record<string, number> = {};
  for (const s of res.series ?? []) {
    const rows = Array.isArray(s.data) ? s.data : s.data ? [s.data] : [];
    for (const row of rows) {
      for (const m of spec.metrics) {
        const v = row[m];
        if (typeof v === "number" && Number.isFinite(v) && out[m] === undefined) out[m] = v;
      }
    }
  }
  return out;
}

export async function privateLocationSeries(
  ctx: ChecklyContext,
  id: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  // The API only answers for the last 15 days.
  const from = Math.max(range.startMs, Date.now() - 15 * 86400_000 + 60_000);
  const res = await ckFetch<{
    timestamps?: string[];
    queueSize?: number[];
    oldestScheduledCheckRun?: number[];
  }>(ctx, `/v1/private-locations/${encodeURIComponent(id)}/metrics`, {
    query: { from: String(Math.floor(from / 1000)), to: String(Math.floor(range.endMs / 1000)) },
  });
  const ts = (res.timestamps ?? []).map((t) =>
    /^\d+$/.test(String(t)) ? Number(t) * 1000 : Date.parse(String(t)),
  );
  const series = (label: string, unit: string, values: number[] | undefined): MetricSeries => ({
    label,
    unit,
    points: (values ?? [])
      .map((value, i) => ({ timestamp: ts[i] ?? NaN, value }))
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value)),
  });
  return [
    series("Queued check runs", "runs", res.queueSize),
    series("Oldest scheduled run (s)", "s", res.oldestScheduledCheckRun),
  ].filter((s) => s.points.length > 0);
}
