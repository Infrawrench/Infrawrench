import type { MetricSeries } from "@infrawrench/plugin-base";
import type { KoyebApi } from "./api.js";

/**
 * Service metrics from `GET /v1/streams/metrics?service_id&name&start&end&step`
 * (verified 2026-10). One call per metric; each answers series labelled by
 * instance (and region), which are averaged into one line here. HTTP metrics
 * only exist for web services.
 */

export const DEFAULT_METRICS_WINDOW_MS = 24 * 3_600_000;

const SERVICE_METRICS: Array<{
  name: string;
  label: string;
  unit: string;
  scale?: number;
  web?: boolean;
  sum?: boolean;
}> = [
  { name: "CPU_TOTAL_PERCENT", label: "CPU", unit: "%" },
  { name: "MEM_RSS", label: "Memory", unit: "MiB", scale: 1 / 1_048_576 },
  { name: "HTTP_THROUGHPUT", label: "HTTP Requests", unit: "req/s", web: true, sum: true },
  { name: "HTTP_RESPONSE_TIME_50P", label: "Response Time p50", unit: "ms", web: true },
  { name: "HTTP_RESPONSE_TIME_90P", label: "Response Time p90", unit: "ms", web: true },
  { name: "HTTP_RESPONSE_TIME_99P", label: "Response Time p99", unit: "ms", web: true },
  { name: "PUBLIC_DATA_TRANSFER_IN", label: "Data In", unit: "bytes/s", web: true, sum: true },
  { name: "PUBLIC_DATA_TRANSFER_OUT", label: "Data Out", unit: "bytes/s", web: true, sum: true },
];

interface Raw {
  metrics?: Array<{
    labels?: Record<string, string>;
    samples?: Array<{ timestamp?: string; value?: number }>;
  }>;
}

/** Combine per-instance series: summed for rates, averaged otherwise. */
export function combine(
  raw: Raw,
  sum: boolean,
  scale = 1,
): Array<{ timestamp: number; value: number }> {
  const buckets = new Map<number, { total: number; n: number }>();
  for (const m of raw.metrics ?? []) {
    for (const s of m.samples ?? []) {
      const t = Date.parse(s.timestamp ?? "");
      const v = Number(s.value);
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
      const b = buckets.get(t) ?? { total: 0, n: 0 };
      b.total += v;
      b.n += 1;
      buckets.set(t, b);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, b]) => ({ timestamp, value: (sum ? b.total : b.total / b.n) * scale }));
}

export async function fetchKoyebMetrics(
  api: KoyebApi,
  serviceId: string,
  isWeb: boolean,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
  const stepMin = Math.max(1, Math.round((endMs - startMs) / 60_000 / 300));
  const results = await Promise.all(
    SERVICE_METRICS.filter((m) => isWeb || !m.web).map(async (m) => {
      try {
        const raw = await api.request<Raw>("/v1/streams/metrics", {
          query: {
            service_id: serviceId,
            name: m.name,
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            step: `${stepMin}m`,
          },
        });
        const points = combine(raw, m.sum === true, m.scale ?? 1);
        return points.length ? [{ label: m.label, unit: m.unit, points }] : [];
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}
