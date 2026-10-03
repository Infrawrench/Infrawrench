/**
 * Branch metrics from PlanetScale's Metrics API
 * (`GET .../branches/{branch}/metrics`, public since August 2026; the
 * service token needs `read_branch`). Verified against the API spec,
 * October 2026.
 *
 * The response is `{ series: [{ metric, label, labels, points: [[unix, value]] }] }`
 * with one series per metric and label set (per tablet, pod or role), so a
 * metric can come back as several lines. Names not reported for a branch's
 * engine simply return no series.
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
  latency_p50: { label: "Latency p50", unit: "ms" },
  latency_p99: { label: "Latency p99", unit: "ms" },
  connections: { label: "Connections" },
  planetscale_pods_cpu_util_percentages: { label: "CPU", unit: "%" },
  planetscale_pods_mem_util_percentages: { label: "Memory", unit: "%" },
  planetscale_storage_usage_bytes: { label: "Storage", unit: "bytes" },
  planetscale_replica_lag_seconds: { label: "Replica Lag", unit: "s" },
};

interface ApiSeries {
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
  for (const series of data.series ?? []) {
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
  return out;
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
