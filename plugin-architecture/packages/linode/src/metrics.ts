/**
 * Metric series.
 *
 * - Linodes: `GET /linode/instances/{id}/stats` (the last 24 hours) and
 *   `/stats/{year}/{month}` for older windows. Series are
 *   `[timestampMs, value]` pairs. CPU is reported per core, so a busy
 *   4-vCPU Linode reads 400; it is divided by the vCPU count to give the 0 to
 *   100% utilisation right-sizing expects. Network is bits per second.
 * - NodeBalancers: `GET /nodebalancers/{id}/stats` (connections and traffic
 *   in bits per second, last 24 hours).
 * - Managed Databases: Akamai Cloud Pulse (limited availability, verified
 *   2026-10): a short-lived token from `POST /monitor/services/dbaas/token`,
 *   then `POST monitor-api.linode.com/v2beta/monitor/services/dbaas/metrics`.
 *   Metric names from the "Databases metrics" reference: `cpu_usage`,
 *   `memory_usage`, `disk_usage` (percent), `read_iops`, `write_iops`.
 *
 * Every fetch fails soft to `[]`: a chart with no data is the host's empty
 * state, not an error.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { LinodeApi } from "./api.js";
import type { LinodeInstance } from "./types.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

type Pair = [number, number];

interface LinodeStats {
  cpu?: Pair[];
  io?: { io?: Pair[]; swap?: Pair[] };
  netv4?: { in?: Pair[]; out?: Pair[]; private_in?: Pair[]; private_out?: Pair[] };
  netv6?: { in?: Pair[]; out?: Pair[] };
}

function series(
  label: string,
  unit: string,
  pairs: Pair[] | undefined,
  window: { startMs: number; endMs: number },
  scale = 1,
): MetricSeries | null {
  if (!pairs || pairs.length === 0) return null;
  const points = pairs
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(Number(p[1])))
    .map(([t, v]) => ({ timestamp: t < 1e12 ? t * 1000 : t, value: Number(v) * scale }))
    .filter((p) => p.timestamp >= window.startMs && p.timestamp <= window.endMs)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (points.length === 0) return null;
  return { label, unit, points };
}

function mergeStats(all: LinodeStats[]): LinodeStats {
  const cat = (pick: (s: LinodeStats) => Pair[] | undefined) => all.flatMap((s) => pick(s) ?? []);
  return {
    cpu: cat((s) => s.cpu),
    io: { io: cat((s) => s.io?.io), swap: cat((s) => s.io?.swap) },
    netv4: {
      in: cat((s) => s.netv4?.in),
      out: cat((s) => s.netv4?.out),
      private_in: cat((s) => s.netv4?.private_in),
      private_out: cat((s) => s.netv4?.private_out),
    },
    netv6: { in: cat((s) => s.netv6?.in), out: cat((s) => s.netv6?.out) },
  };
}

/** Year/month pairs (UTC) a window touches, oldest first. */
export function monthsInWindow(
  startMs: number,
  endMs: number,
): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  const d = new Date(
    Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1),
  );
  while (d.getTime() <= endMs && out.length < 13) {
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

export async function fetchLinodeMetrics(
  api: LinodeApi,
  linodeId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const window = timeRange ?? { startMs: now - DEFAULT_METRICS_WINDOW_MS, endMs: now };
  const recent = window.startMs >= now - DEFAULT_METRICS_WINDOW_MS - 5 * 60_000;
  let stats: LinodeStats;
  let vcpus = 0;
  try {
    const [loaded, linode] = await Promise.all([
      recent
        ? api.get<LinodeStats>(`/linode/instances/${linodeId}/stats`).then((s) => [s])
        : Promise.all(
            monthsInWindow(window.startMs, window.endMs).map(({ year, month }) =>
              api
                .get<LinodeStats>(`/linode/instances/${linodeId}/stats/${year}/${month}`)
                .catch(() => ({})),
            ),
          ),
      api.get<LinodeInstance>(`/linode/instances/${linodeId}`).catch(() => null),
    ]);
    stats = mergeStats(loaded);
    vcpus = linode?.specs?.vcpus ?? 0;
  } catch {
    return [];
  }
  const out: MetricSeries[] = [];
  const push = (s: MetricSeries | null) => {
    if (s) out.push(s);
  };
  push(series("CPU Utilization", "%", stats.cpu, window, vcpus > 1 ? 1 / vcpus : 1));
  push(series("Disk IO", "blocks/s", stats.io?.io, window));
  push(series("Swap IO", "blocks/s", stats.io?.swap, window));
  push(series("Public In (IPv4)", "bits/s", stats.netv4?.in, window));
  push(series("Public Out (IPv4)", "bits/s", stats.netv4?.out, window));
  push(series("Private In (IPv4)", "bits/s", stats.netv4?.private_in, window));
  push(series("Private Out (IPv4)", "bits/s", stats.netv4?.private_out, window));
  push(series("In (IPv6)", "bits/s", stats.netv6?.in, window));
  push(series("Out (IPv6)", "bits/s", stats.netv6?.out, window));
  return out;
}

interface NodeBalancerStats {
  data?: { connections?: Pair[]; traffic?: { in?: Pair[]; out?: Pair[] } };
}

export async function fetchNodeBalancerMetrics(
  api: LinodeApi,
  nbId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const window = timeRange ?? { startMs: now - DEFAULT_METRICS_WINDOW_MS, endMs: now };
  let stats: NodeBalancerStats;
  try {
    stats = await api.get<NodeBalancerStats>(`/nodebalancers/${nbId}/stats`);
  } catch {
    return [];
  }
  return [
    series("Connections", "connections/s", stats.data?.connections, window),
    series("Traffic In", "bits/s", stats.data?.traffic?.in, window),
    series("Traffic Out", "bits/s", stats.data?.traffic?.out, window),
  ].filter((s): s is MetricSeries => s !== null);
}

interface CloudPulseResponse {
  data?: { result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]> }> };
}

const DB_METRICS: Array<{ name: string; label: string; unit: string }> = [
  { name: "cpu_usage", label: "CPU Utilization", unit: "%" },
  { name: "memory_usage", label: "Memory Usage", unit: "%" },
  { name: "disk_usage", label: "Disk Usage", unit: "%" },
  { name: "read_iops", label: "Disk Read", unit: "iops" },
  { name: "write_iops", label: "Disk Write", unit: "iops" },
];

export async function fetchDatabaseMetrics(
  api: LinodeApi,
  databaseId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const window = timeRange ?? { startMs: now - DEFAULT_METRICS_WINDOW_MS, endMs: now };
  // Cloud Pulse answers at most 31 days per query.
  const startMs = Math.max(window.startMs, window.endMs - 31 * DEFAULT_METRICS_WINDOW_MS);
  const id = Number(databaseId);
  let token: string;
  try {
    const res = await api.send<{ token?: string }>("POST", "/monitor/services/dbaas/token", {
      entity_ids: [id],
    });
    if (!res.token) return [];
    token = res.token;
  } catch {
    return [];
  }
  const spanMs = window.endMs - startMs;
  const granularity =
    spanMs <= 6 * 3_600_000
      ? { unit: "min", value: 5 }
      : spanMs <= 2 * 86_400_000
        ? { unit: "min", value: 30 }
        : { unit: "hr", value: 3 };
  const results = await Promise.all(
    DB_METRICS.map(async (m) => {
      try {
        const res = await api.monitor<CloudPulseResponse>(
          "/monitor/services/dbaas/metrics",
          token,
          {
            entity_ids: [id],
            metrics: [{ name: m.name, aggregate_function: "avg" }],
            absolute_time_duration: {
              start: new Date(startMs).toISOString().slice(0, 19) + "Z",
              end: new Date(window.endMs).toISOString().slice(0, 19) + "Z",
            },
            time_granularity: granularity,
          },
        );
        const values = res.data?.result?.[0]?.values ?? [];
        const pairs: Pair[] = values.map(([t, v]) => [t * 1000, Number(v)]);
        return series(m.label, m.unit, pairs, { startMs, endMs: window.endMs });
      } catch {
        return null;
      }
    }),
  );
  return results.filter((s): s is MetricSeries => s !== null);
}
