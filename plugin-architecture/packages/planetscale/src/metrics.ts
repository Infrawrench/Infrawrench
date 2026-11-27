/**
 * Branch metrics from PlanetScale's Metrics API
 * (`GET .../branches/{branch}/metrics`, public since August 2026; the
 * service token needs `read_branch`). Verified against the API spec,
 * October 2026.
 *
 * The response is `{ series: [{ metric, label, labels, points: [[unix, value]] }] }`
 * with one series per metric and label set (per tablet, pod or role), so a
 * metric can come back as several lines. Names not reported for a branch's
 * engine simply return no series. The names below all come from the
 * endpoint's `metrics` enum; the spec gives no units, so a unit is set only
 * where the name states one (`_bytes`, `_percentages`, `_seconds`, `_rate` on
 * a byte counter) or, for latency, where the Insights fields it mirrors are
 * documented in milliseconds.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";

/** The Metrics API defaults to the last 12 hours, and so do we. */
export const PS_METRICS_CAPABILITY = { defaultTimeRangeMs: 12 * 3_600_000 };

/** Metric name → chart label and unit. */
const METRICS: Record<string, { label: string; unit?: string }> = {
  queries: { label: "Queries" },
  query_errors: { label: "Query Errors" },
  rows_read: { label: "Rows Read" },
  rows_written: { label: "Rows Written" },
  rows_returned: { label: "Rows Returned" },
  latency_p50: { label: "Latency p50", unit: "ms" },
  latency_p95: { label: "Latency p95", unit: "ms" },
  latency_p99: { label: "Latency p99", unit: "ms" },
  connections: { label: "Connections" },
  ingress_bytes: { label: "Ingress", unit: "bytes" },
  egress_bytes: { label: "Egress", unit: "bytes" },
  traffic_control_throttled: { label: "Traffic Control Throttled" },
  traffic_control_warnings: { label: "Traffic Control Warnings" },
  planetscale_pods_cpu_util_percentages: { label: "CPU", unit: "%" },
  planetscale_pods_mem_util_percentages: { label: "Memory", unit: "%" },
  planetscale_pods_iops_total: { label: "IOPS" },
  planetscale_pods_container_restarts: { label: "Container Restarts" },
  planetscale_pods_container_ooms: { label: "Out-of-Memory Kills" },
  planetscale_storage_usage_bytes: { label: "Storage", unit: "bytes" },
  planetscale_volume_usage_percentages: { label: "Disk Used", unit: "%" },
  planetscale_volume_disk_usage_bytes: { label: "Volume Used", unit: "bytes" },
  planetscale_volume_capacity_bytes: { label: "Volume Capacity", unit: "bytes" },
  planetscale_replica_lag_seconds: { label: "Replica Lag", unit: "s" },
  // Postgres: connection pooling and the write-ahead log.
  planetscale_pgbouncer_current_connections: { label: "PgBouncer Connections" },
  planetscale_pgbouncer_current_client_connections: { label: "PgBouncer Client Connections" },
  planetscale_pgbouncer_settings_max_client_conn: { label: "PgBouncer Max Client Connections" },
  planetscale_wal_size_bytes: { label: "WAL Size", unit: "bytes" },
  planetscale_wal_archiver_lag_bytes: { label: "WAL Archive Lag", unit: "bytes" },
  planetscale_settings_max_slot_wal_keep_size_bytes: {
    label: "Max Slot WAL Keep Size",
    unit: "bytes",
  },
  planetscale_replication_slot_max_wal_retained_bytes: {
    label: "Replication Slot WAL Retained",
    unit: "bytes",
  },
  // Edge (connection proxy) throughput.
  planetscale_edge_bytes_received_rate: { label: "Edge Received", unit: "bytes/s" },
  planetscale_edge_bytes_sent_rate: { label: "Edge Sent", unit: "bytes/s" },
};

export interface ApiSeries {
  metric?: string;
  label?: string;
  labels?: Record<string, unknown>;
  points?: Array<[number, number]>;
}

export async function fetchBranchMetrics(
  fetchJson: <T>(path: string) => Promise<T>,
  branchPath: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const params = new URLSearchParams({ metrics: Object.keys(METRICS).join(",") });
  if (timeRange) {
    params.set("from", new Date(timeRange.startMs).toISOString());
    params.set("to", new Date(timeRange.endMs).toISOString());
  }
  let data: { series?: ApiSeries[] };
  try {
    data = await fetchJson<{ series?: ApiSeries[] }>(`${branchPath}/metrics?${params.toString()}`);
  } catch {
    // Older tokens lack `read_branch`, and some plans do not expose metrics.
    return [];
  }

  const out: MetricSeries[] = [];
  const all = data.series ?? [];
  for (const series of all) {
    const meta = METRICS[series.metric ?? ""];
    const points = (series.points ?? [])
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      // Unix seconds per the spec; tolerate milliseconds.
      .map(([ts, value]) => ({ timestamp: ts > 1e12 ? ts : ts * 1000, value }));
    if (points.length === 0) continue;
    const base = meta?.label ?? series.label ?? series.metric ?? "";
    const qualifier = seriesQualifier(series.labels);
    out.push({
      label: qualifier ? `${base} (${qualifier})` : base,
      ...(meta?.unit ? { unit: meta.unit } : {}),
      points,
    });
  }
  for (const ratio of CAPACITY_RATIOS) {
    const series = highestShare(all, ratio.used, ratio.limit, ratio.label);
    if (series) out.push(series);
  }
  return out;
}

/**
 * Usages the Metrics API reports beside their own ceiling, as two metrics
 * (the endpoint's `metrics` enum, PlanetScale API spec, read 2026-11-23). Each
 * becomes one percent series, the highest share across the pods, volumes or
 * slots reporting it, which is what capacity runway projects against 100%.
 */
export const CAPACITY_RATIOS = [
  {
    used: "planetscale_volume_disk_usage_bytes",
    limit: "planetscale_volume_capacity_bytes",
    label: "Volume Used (highest)",
  },
  {
    used: "planetscale_pgbouncer_current_client_connections",
    limit: "planetscale_pgbouncer_settings_max_client_conn",
    label: "PgBouncer Client Connections Used",
  },
  {
    used: "planetscale_replication_slot_max_wal_retained_bytes",
    limit: "planetscale_settings_max_slot_wal_keep_size_bytes",
    label: "Replication Slot WAL Used",
  },
] as const;

function labelKey(
  labels: Record<string, unknown> | undefined,
  ignore: ReadonlySet<string>,
): string {
  return JSON.stringify(
    Object.entries(labels ?? {})
      .filter(([key]) => !ignore.has(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function pointsOf(series: ApiSeries): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of series.points ?? []) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    out.set(p[0] > 1e12 ? p[0] : p[0] * 1000, p[1]);
  }
  return out;
}

/**
 * `used` over `limit` as a percent at each timestamp, pairing series with the
 * same identifying labels, or with the only `limit` series when the ceiling is
 * reported once for the branch. The highest share across pairs wins. Nothing
 * when either metric is missing or the ceiling is not positive (a
 * `max_slot_wal_keep_size` of -1 is unlimited).
 */
export function highestShare(
  series: readonly ApiSeries[],
  used: string,
  limit: string,
  label: string,
): MetricSeries | null {
  const ignore = new Set(["__name__", "metric"]);
  const limits = series.filter((s) => s.metric === limit);
  if (limits.length === 0) return null;
  const byKey = new Map(limits.map((s) => [labelKey(s.labels, ignore), pointsOf(s)]));
  const only = limits.length === 1 ? pointsOf(limits[0]!) : undefined;
  const highest = new Map<number, number>();
  for (const s of series) {
    if (s.metric !== used) continue;
    const caps = byKey.get(labelKey(s.labels, ignore)) ?? only;
    if (!caps) continue;
    for (const [ts, value] of pointsOf(s)) {
      const cap = caps.get(ts);
      if (cap === undefined || !(cap > 0)) continue;
      const share = (value / cap) * 100;
      highest.set(ts, Math.max(highest.get(ts) ?? share, share));
    }
  }
  if (highest.size === 0) return null;
  return {
    label,
    unit: "%",
    points: [...highest]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, value]) => ({ timestamp, value })),
  };
}

/** Distinguish several lines of one metric by the labels that identify them. */
function seriesQualifier(labels: Record<string, unknown> | undefined): string {
  if (!labels) return "";
  for (const key of ["role", "tablet_type", "keyspace", "shard", "pod"]) {
    const value = labels[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}
