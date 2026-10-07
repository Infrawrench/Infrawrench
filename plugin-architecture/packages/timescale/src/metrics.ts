/**
 * Service metrics from `POST /projects/{p}/services/{s}/metrics/series`.
 *
 * The series named here are the "legacy" set tiger-cli lists in
 * `internal/common/metrics.go`: always present, and the API rejects `fn` and
 * `group_by` on them, so the request carries only the name and the window
 * (the server picks the bucket: about a minute up to an hour, an hour up to
 * thirty days). When a metric comes back as one series per role, each is
 * labelled with its role.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { TgMetricSeries } from "./types.js";

/** Default window when the host asks without a range. */
export const METRICS_WINDOW_MS = 6 * 60 * 60 * 1000;

interface MetricPick {
  name: string;
  label: string;
  unit?: string;
  scale?: number;
}

export const SERVICE_METRICS: MetricPick[] = [
  { name: "timescale_cloud_system_cpu_usage_millicores", label: "CPU used", unit: "millicores" },
  { name: "timescale_cloud_system_cpu_total_millicores", label: "CPU limit", unit: "millicores" },
  {
    name: "timescale_cloud_system_memory_usage_bytes",
    label: "Memory used",
    unit: "GB",
    scale: 1 / 1024 ** 3,
  },
  {
    name: "timescale_cloud_system_memory_total_bytes",
    label: "Memory limit",
    unit: "GB",
    scale: 1 / 1024 ** 3,
  },
  {
    name: "timescale_cloud_system_disk_usage_bytes",
    label: "Storage used",
    unit: "GB",
    scale: 1 / 1024 ** 3,
  },
  { name: "timescale_cloud_system_disk_io_read_ops", label: "Disk read ops", unit: "ops" },
  { name: "timescale_cloud_system_disk_io_write_ops", label: "Disk write ops", unit: "ops" },
  {
    name: "timescale_cloud_system_disk_io_read_bytes",
    label: "Disk read",
    unit: "MB",
    scale: 1 / 1024 ** 2,
  },
  {
    name: "timescale_cloud_system_disk_io_write_bytes",
    label: "Disk write",
    unit: "MB",
    scale: 1 / 1024 ** 2,
  },
  { name: "timescale_cloud_database_qps", label: "Queries per second", unit: "qps" },
  { name: "timescale_cloud_database_num_connections", label: "Connections", unit: "connections" },
];

/** Label of the derived CPU-utilisation series. */
export const CPU_PERCENT_LABEL = "CPU utilization";
export const MEMORY_PERCENT_LABEL = "Memory utilization";

export function toSeries(pick: MetricPick, raw: TgMetricSeries[]): MetricSeries[] {
  const multi = raw.length > 1;
  return raw.map((s) => {
    const role = s.labels?.["role"];
    const suffix = multi
      ? ` (${role ?? (Object.values(s.labels ?? {}).join(", ") || "series")})`
      : "";
    return {
      label: `${pick.label}${suffix}`,
      ...(pick.unit ? { unit: pick.unit } : {}),
      points: (s.data ?? [])
        .filter((p) => p.time && typeof p.value === "number" && Number.isFinite(p.value))
        .map((p) => ({
          timestamp: Date.parse(p.time!),
          value: round((p.value as number) * (pick.scale ?? 1)),
        }))
        .filter((p) => Number.isFinite(p.timestamp)),
    };
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** `used / limit * 100`, joined on timestamp, for the primary series of each. */
export function ratioSeries(
  label: string,
  used: MetricSeries | undefined,
  limit: MetricSeries | undefined,
): MetricSeries | null {
  if (!used || !limit) return null;
  const limits = new Map(limit.points.map((p) => [p.timestamp, p.value]));
  const points = used.points
    .map((p) => {
      const l = limits.get(p.timestamp);
      return l ? { timestamp: p.timestamp, value: round((p.value / l) * 100) } : null;
    })
    .filter((p): p is { timestamp: number; value: number } => p !== null);
  if (points.length === 0) return null;
  return { label, unit: "%", points };
}
