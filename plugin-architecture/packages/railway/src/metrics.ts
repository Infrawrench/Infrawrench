import type { MetricSeries } from "@infrawrench/plugin-base";
import type { RailwayApi } from "./api.js";
import { Q_HTTP_METRICS, Q_METRICS } from "./queries.js";

/**
 * Metrics from the `metrics` query (samples `{ts: epoch seconds, value}`) and,
 * for services with a public domain, `httpMetrics` / `httpDurationMetrics`
 * (verified against the schema, 2026-10). CPU is in vCPUs, memory, network
 * and disk in GB.
 */

export const DEFAULT_METRICS_WINDOW_MS = 24 * 3_600_000;

const SERVICE_MEASUREMENTS: Record<string, { label: string; unit: string }> = {
  CPU_USAGE: { label: "CPU", unit: "vCPU" },
  CPU_LIMIT: { label: "CPU Limit", unit: "vCPU" },
  MEMORY_USAGE_GB: { label: "Memory", unit: "GB" },
  MEMORY_LIMIT_GB: { label: "Memory Limit", unit: "GB" },
  NETWORK_RX_GB: { label: "Network In", unit: "GB" },
  NETWORK_TX_GB: { label: "Network Out", unit: "GB" },
  EPHEMERAL_DISK_USAGE_GB: { label: "Ephemeral Disk", unit: "GB" },
};

const VOLUME_MEASUREMENTS: Record<string, { label: string; unit: string }> = {
  DISK_USAGE_GB: { label: "Disk Used", unit: "GB" },
};

interface MetricsRow {
  measurement: string;
  values: Array<{ ts: number; value: number }>;
}

function window(timeRange?: { startMs: number; endMs: number }) {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
  const step = Math.max(60, Math.round((endMs - startMs) / 1000 / 300));
  return {
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
    step,
  };
}

export function toSeries(
  rows: MetricsRow[],
  labels: Record<string, { label: string; unit: string }>,
): MetricSeries[] {
  return (rows ?? [])
    .filter((r) => labels[r.measurement] && (r.values ?? []).length > 0)
    .map((r) => ({
      label: labels[r.measurement]!.label,
      unit: labels[r.measurement]!.unit,
      points: r.values
        .map((v) => ({ timestamp: v.ts * 1000, value: Number(v.value) }))
        .filter((p) => Number.isFinite(p.value))
        .sort((a, b) => a.timestamp - b.timestamp),
    }));
}

export async function fetchServiceMetrics(
  api: RailwayApi,
  environmentId: string,
  serviceId: string,
  withHttp: boolean,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const w = window(timeRange);
  const [base, http] = await Promise.all([
    api
      .gql<{ metrics: MetricsRow[] }>(Q_METRICS, {
        environmentId,
        serviceId,
        startDate: w.startDate,
        endDate: w.endDate,
        measurements: Object.keys(SERVICE_MEASUREMENTS),
        sampleRateSeconds: w.step,
      })
      .then((r) => toSeries(r.metrics, SERVICE_MEASUREMENTS))
      .catch(() => [] as MetricSeries[]),
    withHttp
      ? api
          .gql<{
            httpMetrics: { samples: Array<{ ts: number; value: number }> };
            httpDurationMetrics: {
              samples: Array<{ ts: number; p50: number; p95: number; p99: number }>;
            };
          }>(Q_HTTP_METRICS, {
            environmentId,
            serviceId,
            startDate: w.startDate,
            endDate: w.endDate,
            stepSeconds: w.step,
          })
          .then((r) =>
            httpSeries(r.httpMetrics?.samples ?? [], r.httpDurationMetrics?.samples ?? []),
          )
          .catch(() => [] as MetricSeries[])
      : Promise.resolve([] as MetricSeries[]),
  ]);
  return [...base, ...http];
}

export function httpSeries(
  requests: Array<{ ts: number; value: number }>,
  durations: Array<{ ts: number; p50: number; p95: number; p99: number }>,
): MetricSeries[] {
  const out: MetricSeries[] = [];
  if (requests.length) {
    out.push({
      label: "HTTP Requests",
      unit: "requests",
      points: requests.map((s) => ({ timestamp: s.ts * 1000, value: s.value })),
    });
  }
  for (const q of ["p50", "p95", "p99"] as const) {
    if (!durations.length) break;
    out.push({
      label: `HTTP Latency ${q}`,
      unit: "ms",
      points: durations.map((s) => ({ timestamp: s.ts * 1000, value: s[q] })),
    });
  }
  return out;
}

export async function fetchVolumeMetrics(
  api: RailwayApi,
  environmentId: string,
  volumeId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const w = window(timeRange);
  const r = await api.gql<{ metrics: MetricsRow[] }>(Q_METRICS, {
    environmentId,
    volumeId,
    startDate: w.startDate,
    endDate: w.endDate,
    measurements: Object.keys(VOLUME_MEASUREMENTS),
    sampleRateSeconds: w.step,
  });
  return toSeries(r.metrics, VOLUME_MEASUREMENTS);
}
