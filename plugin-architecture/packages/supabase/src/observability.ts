import type {
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  QuotaUsage,
} from "@infrawrench/plugin-base";
import type { SupabaseContext } from "./api.js";
import { enc, sbFetch, sbFetchText } from "./api.js";
import type { SbApiCounts, SbDiskUtil, SbProject } from "./types.js";

/**
 * Metrics, logs and quotas.
 *
 * - Request volume per service comes from `analytics/endpoints/usage.api-counts`,
 *   a bucketed series over a fixed window (15min … 7day).
 * - Disk, memory, load and connections are point-in-time readings from the
 *   Prometheus scrape (`analytics/endpoints/metrics`) and `config/disk/util`;
 *   the host builds their trend by sampling pinned resources.
 * - Logs use the unified ClickHouse `logs` table (`analytics/endpoints/logs`,
 *   the replacement for `logs.all` since September 2026): one table, a
 *   `source` column, a `log_attributes` string map, at most a 24 hour window.
 */

export const DEFAULT_METRICS_WINDOW_MS = 24 * 3_600_000;

const INTERVALS: Array<[number, string]> = [
  [15 * 60_000, "15min"],
  [30 * 60_000, "30min"],
  [3_600_000, "1hr"],
  [3 * 3_600_000, "3hr"],
  [24 * 3_600_000, "1day"],
  [3 * 24 * 3_600_000, "3day"],
  [7 * 24 * 3_600_000, "7day"],
];

/** The smallest window the API offers that covers the requested range. */
export function intervalFor(rangeMs: number): string {
  for (const [ms, label] of INTERVALS) if (rangeMs <= ms) return label;
  return "7day";
}

export async function fetchProjectMetrics(
  ctx: SupabaseContext,
  ref: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const rangeMs = timeRange ? timeRange.endMs - timeRange.startMs : DEFAULT_METRICS_WINDOW_MS;
  const base = `/v1/projects/${enc(ref)}`;
  const [counts, disk, scrape] = await Promise.all([
    sbFetch<SbApiCounts>(ctx, "GET", `${base}/analytics/endpoints/usage.api-counts`, undefined, {
      interval: intervalFor(rangeMs),
    }).catch(() => undefined),
    sbFetch<SbDiskUtil>(ctx, "GET", `${base}/config/disk/util`).catch(() => undefined),
    sbFetchText(ctx, `${base}/analytics/endpoints/metrics`).catch(() => ""),
  ]);

  const series: MetricSeries[] = [];
  const rows = counts?.result ?? [];
  const requestSeries: Array<[string, keyof NonNullable<SbApiCounts["result"]>[number]]> = [
    ["REST requests", "total_rest_requests"],
    ["Auth requests", "total_auth_requests"],
    ["Storage requests", "total_storage_requests"],
    ["Realtime requests", "total_realtime_requests"],
  ];
  for (const [label, key] of requestSeries) {
    const points = rows
      .map((r) => ({ timestamp: Date.parse(r.timestamp), value: Number(r[key]) }))
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value))
      .filter(
        (p) => !timeRange || (p.timestamp >= timeRange.startMs && p.timestamp <= timeRange.endMs),
      );
    if (points.length > 0) series.push({ label, unit: "requests", points });
  }

  const now = Date.now();
  if (disk?.metrics && disk.metrics.fs_size_bytes > 0) {
    const ts = Date.parse(disk.timestamp) || now;
    series.push({
      label: "Disk used",
      unit: "%",
      points: [
        { timestamp: ts, value: (disk.metrics.fs_used_bytes / disk.metrics.fs_size_bytes) * 100 },
      ],
    });
  }

  if (scrape) {
    const samples = parsePrometheus(scrape);
    const total = sumOf(samples, "node_memory_MemTotal_bytes");
    const available = sumOf(samples, "node_memory_MemAvailable_bytes");
    if (total && available !== undefined) {
      series.push({
        label: "Memory used",
        unit: "%",
        points: [{ timestamp: now, value: ((total - available) / total) * 100 }],
      });
    }
    const load = sumOf(samples, "node_load1");
    if (load !== undefined) {
      series.push({ label: "Load (1m)", points: [{ timestamp: now, value: load }] });
    }
    const backends = sumOf(samples, "pg_stat_database_num_backends");
    if (backends !== undefined) {
      series.push({
        label: "Database connections",
        unit: "connections",
        points: [{ timestamp: now, value: backends }],
      });
    }
    const dbSize = sumOf(samples, "pg_database_size_bytes");
    if (dbSize !== undefined) {
      series.push({
        label: "Database size",
        unit: "MB",
        points: [{ timestamp: now, value: dbSize / 1_048_576 }],
      });
    }
  }
  return series;
}

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parse the Prometheus text exposition format (comments and timestamps ignored). */
export function parsePrometheus(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const value = Number(m[4]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    for (const pair of (m[3] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1]!] = pair[2]!;
    }
    out.push({ name: m[1]!, labels, value });
  }
  return out;
}

function sumOf(samples: PromSample[], name: string): number | undefined {
  const matching = samples.filter((s) => s.name === name);
  if (matching.length === 0) return undefined;
  return matching.reduce((sum, s) => sum + s.value, 0);
}

/** Function invocation stats (`functions.combined-stats`): one series per numeric column. */
export async function fetchFunctionMetrics(
  ctx: SupabaseContext,
  ref: string,
  functionId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const rangeMs = timeRange ? timeRange.endMs - timeRange.startMs : DEFAULT_METRICS_WINDOW_MS;
  const interval =
    rangeMs <= 15 * 60_000
      ? "15min"
      : rangeMs <= 3_600_000
        ? "1hr"
        : rangeMs <= 3 * 3_600_000
          ? "3hr"
          : "1day";
  const data = await sbFetch<{ result?: Array<Record<string, unknown>> }>(
    ctx,
    "GET",
    `/v1/projects/${enc(ref)}/analytics/endpoints/functions.combined-stats`,
    undefined,
    { interval, function_id: functionId },
  );
  const rows = data?.result ?? [];
  const byLabel = new Map<string, MetricSeries>();
  const LABELS: Record<string, [string, string | undefined]> = {
    requests_count: ["Invocations", "requests"],
    count: ["Invocations", "requests"],
    avg_execution_time: ["Average execution time", "ms"],
    max_execution_time: ["Max execution time", "ms"],
    avg_cpu_time_used: ["Average CPU time", "ms"],
    avg_memory_used: ["Average memory", "MB"],
    server_err_count: ["Server errors", "requests"],
    client_err_count: ["Client errors", "requests"],
    redirect_count: ["Redirects", "requests"],
    success_count: ["Successful", "requests"],
  };
  for (const row of rows) {
    const ts = Date.parse(String(row["timestamp"] ?? ""));
    if (!Number.isFinite(ts)) continue;
    for (const [key, raw] of Object.entries(row)) {
      if (key === "timestamp") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const [label, unit] = LABELS[key] ?? [key, undefined];
      const s = byLabel.get(label) ?? { label, ...(unit ? { unit } : {}), points: [] };
      s.points.push({ timestamp: ts, value });
      byLabel.set(label, s);
    }
  }
  return [...byLabel.values()];
}

/** Log sources of the unified logs table, in the order the dropdown shows them. */
export const LOG_SOURCES: Array<[string, string]> = [
  ["edge_logs", "API gateway"],
  ["postgres_logs", "Postgres"],
  ["auth_logs", "Auth"],
  ["postgrest_logs", "Data API (PostgREST)"],
  ["storage_logs", "Storage"],
  ["realtime_logs", "Realtime"],
  ["function_edge_logs", "Edge Function requests"],
  ["function_logs", "Edge Function console"],
  ["supavisor_logs", "Connection pooler"],
  ["pg_cron_logs", "Cron"],
];

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function queryLogs(
  ctx: SupabaseContext,
  ref: string,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3_600_000 + 60_000);
  const data = await sbFetch<{ result?: Array<Record<string, unknown>>; error?: unknown }>(
    ctx,
    "GET",
    `/v1/projects/${enc(ref)}/analytics/endpoints/logs`,
    undefined,
    { sql, iso_timestamp_start: start.toISOString(), iso_timestamp_end: end.toISOString() },
  );
  if (data?.error) {
    const message =
      typeof data.error === "string" ? data.error : JSON.stringify(data.error).slice(0, 300);
    throw new Error(`Supabase logs query failed: ${message}`);
  }
  return data?.result ?? [];
}

function formatTimestamp(raw: unknown): string {
  if (typeof raw === "number") {
    // The logs backend reports microseconds since the epoch.
    const ms = raw > 1e14 ? raw / 1000 : raw > 1e11 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  return String(raw ?? "");
}

function toText(rows: Array<Record<string, unknown>>): string {
  return rows
    .slice()
    .reverse()
    .map(
      (r) => `${formatTimestamp(r["timestamp"])} ${String(r["event_message"] ?? "").trimEnd()}\n`,
    )
    .join("");
}

/** Project Logs tab: one dropdown entry per log source. */
export async function fetchProjectLogs(
  ctx: SupabaseContext,
  ref: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const containers = LOG_SOURCES.map(([id]) => id);
  const source =
    params.container && containers.includes(params.container) ? params.container : "edge_logs";
  const limit = Math.min(Math.max(params.tailLines ?? 200, 1), 1000);
  const rows = await queryLogs(
    ctx,
    ref,
    `select timestamp, event_message from logs where source = ${sqlString(source)} order by timestamp desc limit ${limit}`,
  );
  return { text: toText(rows), containers, activeContainer: source };
}

/** Edge Function Logs tab: console output or request log for one function. */
export async function fetchFunctionLogs(
  ctx: SupabaseContext,
  ref: string,
  functionId: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const containers = ["function_logs", "function_edge_logs"];
  const source =
    params.container && containers.includes(params.container) ? params.container : "function_logs";
  const limit = Math.min(Math.max(params.tailLines ?? 200, 1), 1000);
  const rows = await queryLogs(
    ctx,
    ref,
    `select timestamp, event_message from logs where source = ${sqlString(source)} and log_attributes['function_id'] = ${sqlString(functionId)} order by timestamp desc limit ${limit}`,
  );
  return { text: toText(rows), containers, activeContainer: source };
}

/**
 * Disk usage against the provisioned size, per running project. Both halves
 * come from `config/disk/util`. A full disk puts a Supabase project into
 * read-only mode, which is why this is worth an exhaustion alert even with
 * autoscaling on.
 */
export async function fetchDiskQuotas(
  ctx: SupabaseContext,
  projects: SbProject[],
): Promise<QuotaUsage[]> {
  const running = projects.filter(
    (p) => p.status === "ACTIVE_HEALTHY" || p.status === "ACTIVE_UNHEALTHY",
  );
  const readings = await Promise.all(
    running.map(async (p) => {
      const util = await sbFetch<SbDiskUtil>(
        ctx,
        "GET",
        `/v1/projects/${enc(p.ref)}/config/disk/util`,
      );
      const m = util?.metrics;
      if (!m || !(m.fs_size_bytes > 0)) return null;
      const reading: QuotaUsage = {
        id: `disk/${p.ref}`,
        service: "database",
        name: `Database disk (${p.name})`,
        region: p.region,
        limit: m.fs_size_bytes / 1_073_741_824,
        used: m.fs_used_bytes / 1_073_741_824,
        unit: "GB",
        adjustable: true,
        docsUrl: "https://supabase.com/docs/guides/platform/database-size",
      };
      return reading;
    }),
  );
  return readings.filter((r): r is QuotaUsage => r !== null);
}
