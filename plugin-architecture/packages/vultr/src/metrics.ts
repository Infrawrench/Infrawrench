/**
 * Metric series. Vultr's public API has no CPU or memory time series for
 * instances (the control panel's graphs are not exposed); what it does
 * expose is:
 *
 * - `GET /v2/instances/{id}/bandwidth` and `/v2/bare-metals/{id}/bandwidth`:
 *   daily `incoming_bytes` / `outgoing_bytes` keyed by `YYYY-MM-DD`, covering
 *   roughly the last month. Outbound transfer is what Vultr bills against the
 *   bandwidth pool, so it is the series that matters for cost.
 * - `GET /v2/databases/{id}/usage`: the current CPU, memory and disk
 *   percentages of a Managed Database, a single reading. It is returned as a
 *   one-point series so the chart shows today's value and the host's
 *   metrics store builds the history from successive readings.
 *
 * Every fetch fails soft to `[]`: an empty chart is the host's empty state.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { VultrApi } from "./api.js";

export const DEFAULT_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type Bandwidth = Record<string, { incoming_bytes?: number; outgoing_bytes?: number }>;

export function bandwidthSeries(
  bandwidth: Bandwidth,
  window: { startMs: number; endMs: number },
): MetricSeries[] {
  const days = Object.keys(bandwidth)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const inbound: MetricSeries = { label: "Inbound Transfer", unit: "GB", points: [] };
  const outbound: MetricSeries = { label: "Outbound Transfer", unit: "GB", points: [] };
  for (const day of days) {
    const ts = Date.parse(`${day}T00:00:00Z`);
    if (ts < window.startMs - 86_400_000 || ts > window.endMs) continue;
    const row = bandwidth[day]!;
    inbound.points.push({ timestamp: ts, value: (row.incoming_bytes ?? 0) / 1e9 });
    outbound.points.push({ timestamp: ts, value: (row.outgoing_bytes ?? 0) / 1e9 });
  }
  return [inbound, outbound].filter((s) => s.points.length > 0);
}

export async function fetchBandwidthMetrics(
  api: VultrApi,
  path: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const window = timeRange ?? { startMs: now - DEFAULT_METRICS_WINDOW_MS, endMs: now };
  try {
    const res = await api.get<{ bandwidth?: Bandwidth }>(path);
    return bandwidthSeries(res.bandwidth ?? {}, window);
  } catch {
    return [];
  }
}

export async function fetchDatabaseMetrics(
  api: VultrApi,
  databaseId: string,
): Promise<MetricSeries[]> {
  try {
    const res = await api.get<{
      usage?: {
        cpu?: { percentage?: number };
        memory?: { percentage?: number };
        disk?: { percentage?: number };
      };
    }>(`/databases/${databaseId}/usage`);
    const u = res.usage;
    if (!u) return [];
    const now = Date.now();
    const out: MetricSeries[] = [];
    const push = (label: string, value: number | undefined) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        out.push({ label, unit: "%", points: [{ timestamp: now, value }] });
      }
    };
    push("CPU Utilization", u.cpu?.percentage);
    push("Memory Used", u.memory?.percentage);
    push("Disk Used", u.disk?.percentage);
    return out;
  } catch {
    return [];
  }
}
