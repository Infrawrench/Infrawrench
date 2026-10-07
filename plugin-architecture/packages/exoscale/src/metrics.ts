/**
 * Metric series. Exoscale's API has no instance metrics; DBaaS services do:
 * `POST /v2/dbaas-service-metrics/{name}` with `{ period: hour|day|week|month|year }`
 * returns `metrics`, charts in the same `{ data: { cols, rows } }` shape
 * Aiven-based services use (one column per node; the first node column is
 * used). Fails soft to `[]`.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { ExoscaleApi } from "./api.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

const CHARTS: Array<[string, string, string]> = [
  ["cpu_usage", "CPU Utilization", "%"],
  ["mem_usage", "Memory Used", "%"],
  ["disk_usage", "Disk Used", "%"],
  ["load_average", "Load Average", ""],
  ["diskio_read", "Disk Reads", "IOPS"],
  ["diskio_writes", "Disk Writes", "IOPS"],
  ["net_receive", "Network In", "bytes/s"],
  ["net_send", "Network Out", "bytes/s"],
];

export function periodFor(window: { startMs: number; endMs: number }): string {
  const span = window.endMs - window.startMs;
  if (span <= 2 * 3600_000) return "hour";
  if (span <= 2 * 86_400_000) return "day";
  if (span <= 10 * 86_400_000) return "week";
  if (span <= 40 * 86_400_000) return "month";
  return "year";
}

type Chart = { data?: { cols?: Array<{ label?: string }>; rows?: unknown[][] } };

export function chartSeries(metrics: Record<string, Chart>): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const [key, label, unit] of CHARTS) {
    const chart = metrics[key];
    const rows = chart?.data?.rows ?? [];
    if (!rows.length) continue;
    const points = rows
      .map((r) => ({ timestamp: Date.parse(String(r[0])), value: Number(r[1]) }))
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
    if (points.length) out.push({ label, ...(unit ? { unit } : {}), points });
  }
  return out;
}

export async function fetchDbaasMetrics(
  api: ExoscaleApi,
  zone: string,
  name: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const window = timeRange ?? { startMs: now - DEFAULT_METRICS_WINDOW_MS, endMs: now };
  try {
    const res = await api.send<{ metrics?: Record<string, Chart> }>(
      zone,
      "POST",
      `/dbaas-service-metrics/${name}`,
      {
        period: periodFor(window),
      },
    );
    return chartSeries(res.metrics ?? {});
  } catch {
    return [];
  }
}
