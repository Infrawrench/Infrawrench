/**
 * Metric series for checks, from raw check results
 * (`GET /v2/check-results/{checkId}`, kept for 30 days, cursor-paged with
 * `nextId`, rate-limited to 60 requests a minute): response time per run
 * location and failed runs per time bucket. Aggregates for the whole window
 * (availability, p95) come from the Analytics API, whose per-type endpoint
 * and metric names differ (`ANALYTICS` below, from the OpenAPI document).
 */
import type {
  ApiListItem,
  ApiResponse,
  MetricSeries,
  MetricSeriesPoint,
  NoSlashString,
} from "@infrawrench/plugin-base";
import { pathEncode } from "@infrawrench/plugin-base";
import type { ChecklyApi } from "./api.js";
import { ckEntries } from "./api.js";
import type { operations } from "./api-types.gen.js";

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

type CheckResult = Partial<ApiListItem<operations["getV2CheckresultsCheckid"], "entries">>;

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
  api: ChecklyApi,
  checkId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const from = Math.max(range.startMs, Date.now() - RESULTS_RETENTION_MS);
  const results = await ckEntries(
    (cursor) =>
      api.get(`/v2/check-results/${pathEncode(checkId)}`, {
        query: {
          from: Math.floor(from / 1000),
          to: Math.floor(range.endMs / 1000),
          limit: 100,
          resultType: "FINAL",
          ...cursor,
        },
      }),
    MAX_PAGES,
  );
  return resultsToSeries(results, { startMs: from, endMs: range.endMs });
}

type AnalyticsAnswer =
  | ApiResponse<operations["getV1AnalyticsApichecksId"]>
  | ApiResponse<operations["getV1AnalyticsUrlmonitorsId"]>
  | ApiResponse<operations["getV1AnalyticsBrowserchecksId"]>
  | ApiResponse<operations["getV1AnalyticsMultistepchecksId"]>
  | ApiResponse<operations["getV1AnalyticsPlaywrightchecksId"]>
  | ApiResponse<operations["getV1AnalyticsTcpchecksId"]>
  | ApiResponse<operations["getV1AnalyticsDnsId"]>
  | ApiResponse<operations["getV1AnalyticsIcmpId"]>
  | ApiResponse<operations["getV1AnalyticsSslId"]>
  | ApiResponse<operations["getV1AnalyticsHeartbeatchecksId"]>;

interface AnalyticsSpec {
  metrics: readonly string[];
  load: (api: ChecklyApi, id: NoSlashString) => Promise<AnalyticsAnswer>;
}

/** One type's window aggregates worth showing, with the query its route takes. */
const analytics = <const Metric extends string>(
  metrics: readonly Metric[],
  load: (
    api: ChecklyApi,
    id: NoSlashString,
    query: { quickRange: "last7Days"; metrics: Metric[] },
  ) => Promise<AnalyticsAnswer>,
): AnalyticsSpec => ({
  metrics,
  load: (api, id) => load(api, id, { quickRange: "last7Days", metrics: [...metrics] }),
});

/** Analytics endpoint and the window aggregates worth showing, per check type. */
export const ANALYTICS: Record<string, AnalyticsSpec> = {
  API: analytics(["availability", "responseTime_avg", "responseTime_p95"], (api, id, query) =>
    api.get(`/v1/analytics/api-checks/${id}`, { query }),
  ),
  URL: analytics(["availability", "responseTime_avg", "responseTime_p95"], (api, id, query) =>
    api.get(`/v1/analytics/url-monitors/${id}`, { query }),
  ),
  BROWSER: analytics(["availability", "responseTime_avg", "LCP_p95"], (api, id, query) =>
    api.get(`/v1/analytics/browser-checks/${id}`, { query }),
  ),
  MULTI_STEP: analytics(
    ["availability", "responseTime_avg", "responseTime_p95"],
    (api, id, query) => api.get(`/v1/analytics/multistep-checks/${id}`, { query }),
  ),
  PLAYWRIGHT: analytics(
    ["availability", "responseTime_avg", "responseTime_p95"],
    (api, id, query) => api.get(`/v1/analytics/playwright-checks/${id}`, { query }),
  ),
  TCP: analytics(["availability", "total_avg", "total_p95"], (api, id, query) =>
    api.get(`/v1/analytics/tcp-checks/${id}`, { query }),
  ),
  DNS: analytics(["availability", "total_avg", "total_p95"], (api, id, query) =>
    api.get(`/v1/analytics/dns/${id}`, { query }),
  ),
  ICMP: analytics(["availability", "latencyAvg_avg", "packetLoss_avg"], (api, id, query) =>
    api.get(`/v1/analytics/icmp/${id}`, { query }),
  ),
  SSL: analytics(["availability", "daysUntilExpiry_avg"], (api, id, query) =>
    api.get(`/v1/analytics/ssl/${id}`, { query }),
  ),
  HEARTBEAT: analytics(["availability"], (api, id, query) =>
    api.get(`/v1/analytics/heartbeat-checks/${id}`, { query }),
  ),
};

/** Window aggregates (one row, no interval) for the detail page. */
export async function checkAnalytics(
  api: ChecklyApi,
  checkId: string,
  checkType: string,
): Promise<Record<string, number>> {
  const spec = ANALYTICS[checkType];
  if (!spec) return {};
  const res = await spec.load(api, pathEncode(checkId));
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
  api: ChecklyApi,
  id: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  // The API only answers for the last 15 days.
  const from = Math.max(range.startMs, Date.now() - 15 * 86400_000 + 60_000);
  const res = await api.get(`/v1/private-locations/${pathEncode(id)}/metrics`, {
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
