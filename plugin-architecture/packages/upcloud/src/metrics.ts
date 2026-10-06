/**
 * Metric series.
 *
 * - Managed Databases: `GET /database/{uuid}/metrics?period=hour|day|week|month`
 *   returns charts (`cpu_usage`, `disk_usage`, `load_average`,
 *   `mem_usage`, `diskio_reads`, `diskio_writes`, `net_receive`,
 *   `net_send`), each `{ data: { cols, rows }, hints: { title } }` with one
 *   column per node. The primary node's column is used.
 * - Servers: the API has no CPU or memory graphs; outbound public transfer
 *   per day comes from `GET /account/resource_network_usage` (31-day window
 *   max), which is what the network transfer pool is billed on.
 * - Managed Object Storage: `GET /object-storage-2/{uuid}/metrics` is the
 *   current object count and stored bytes, a single reading.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { UpCloudApi } from "./api.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

const CHARTS: Array<[string, string, string]> = [
  ["cpu_usage", "CPU Utilization", "%"],
  ["mem_usage", "Memory Used", "%"],
  ["disk_usage", "Disk Used", "%"],
  ["load_average", "Load Average", ""],
  ["diskio_reads", "Disk Reads", "IOPS"],
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

export function databaseSeries(body: Record<string, Chart>): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const [key, label, unit] of CHARTS) {
    const chart = body[key];
    const cols = chart?.data?.cols ?? [];
    const rows = chart?.data?.rows ?? [];
    if (!rows.length || cols.length < 2) continue;
    // Prefer the master/primary node's column.
    let idx = cols.findIndex((c, i) => i > 0 && /master|primary/i.test(c.label ?? ""));
    if (idx < 1) idx = 1;
    const points = rows
      .map((r) => ({ timestamp: Date.parse(String(r[0])), value: Number(r[idx]) }))
      .filter((p) => Number.isFinite(p.timestamp) && r0ok(p.value));
    if (points.length) out.push({ label, ...(unit ? { unit } : {}), points });
  }
  return out;
}

function r0ok(v: number): boolean {
  return Number.isFinite(v);
}

export async function fetchDatabaseMetrics(
  api: UpCloudApi,
  id: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const window = timeRange ?? { startMs: now - DEFAULT_METRICS_WINDOW_MS, endMs: now };
  try {
    const body = await api.get<Record<string, Chart>>(
      `/database/${id}/metrics?period=${periodFor(window)}`,
    );
    return databaseSeries(body);
  } catch {
    return [];
  }
}

export async function fetchServerTransfer(
  api: UpCloudApi,
  id: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const end = timeRange?.endMs ?? now;
  // The JSON form allows at most 31 days.
  const start = Math.max(
    timeRange?.startMs ?? end - 30 * 86_400_000,
    end - 31 * 86_400_000 + 3600_000,
  );
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const accumulate = end - start <= 2 * 86_400_000 ? "hour" : "day";
  try {
    const res = await api.get<{
      stats?: { stat?: Array<{ start_time?: string; sent_bytes?: number }> };
    }>(
      `/account/resource_network_usage/?from=${iso(start)}&to=${iso(end)}&accumulate=${accumulate}&resource_id=${id}`,
    );
    const points = (res.stats?.stat ?? [])
      .map((s) => ({
        timestamp: Date.parse(s.start_time ?? ""),
        value: Number(s.sent_bytes ?? 0) / 1e9,
      }))
      .filter((p) => Number.isFinite(p.timestamp));
    return points.length ? [{ label: "Outbound Public Transfer", unit: "GB", points }] : [];
  } catch {
    return [];
  }
}

export async function fetchObjectStorageMetrics(
  api: UpCloudApi,
  id: string,
): Promise<MetricSeries[]> {
  try {
    const m = await api.get<{ total_objects?: number; total_size_bytes?: number }>(
      `/object-storage-2/${id}/metrics`,
    );
    const now = Date.now();
    return [
      { label: "Objects", points: [{ timestamp: now, value: Number(m.total_objects ?? 0) }] },
      {
        label: "Stored",
        unit: "GB",
        points: [{ timestamp: now, value: Number(m.total_size_bytes ?? 0) / 1e9 }],
      },
    ];
  } catch {
    return [];
  }
}
