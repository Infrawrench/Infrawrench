import type { MetricSeries } from "@infrawrench/plugin-base";
import type { RenderApi } from "./api.js";
import type { RenderMetricSeries } from "./types.js";

/**
 * Metrics from the `/metrics/*` endpoints (verified 2026-10). Each answers
 * an array of series, `{labels, values: [{timestamp, value}], unit}`, one per
 * instance unless an aggregation is requested. `resource` takes a service,
 * Postgres or Key Value id. HTTP metrics only exist for web services; a
 * metric a resource does not have answers an error or an empty list, and is
 * left out rather than failing the whole tab.
 */

export const DEFAULT_METRICS_WINDOW_MS = 24 * 3_600_000;

interface MetricSpec {
  path: string;
  label: string;
  query?: Record<string, string | number>;
  /** Overrides the unit the API reports (it says "bytes", "cpu", …). */
  unit?: string;
  scale?: number;
}

const CPU: MetricSpec = {
  path: "/metrics/cpu",
  label: "CPU",
  query: { aggregationMethod: "AVG" },
  unit: "cores",
};
const MEMORY: MetricSpec = {
  path: "/metrics/memory",
  label: "Memory",
  query: { aggregationMethod: "AVG" },
  unit: "MiB",
  scale: 1 / (1024 * 1024),
};
const INSTANCES: MetricSpec = {
  path: "/metrics/instance-count",
  label: "Instances",
  unit: "instances",
};
const REQUESTS: MetricSpec = {
  path: "/metrics/http-requests",
  label: "HTTP Requests",
  unit: "requests",
};
const LATENCY: MetricSpec = {
  path: "/metrics/http-latency",
  label: "HTTP Latency p95",
  query: { quantile: 0.95 },
  unit: "ms",
};
const BANDWIDTH: MetricSpec = {
  path: "/metrics/bandwidth",
  label: "Bandwidth",
  unit: "MiB",
  scale: 1 / (1024 * 1024),
};
const DISK_USAGE: MetricSpec = {
  path: "/metrics/disk-usage",
  label: "Disk Used",
  unit: "GiB",
  scale: 1 / 1024 ** 3,
};
const DISK_CAPACITY: MetricSpec = {
  path: "/metrics/disk-capacity",
  label: "Disk Capacity",
  unit: "GiB",
  scale: 1 / 1024 ** 3,
};
const CONNECTIONS: MetricSpec = {
  path: "/metrics/active-connections",
  label: "Active Connections",
  unit: "connections",
};
const REPLICATION_LAG: MetricSpec = {
  path: "/metrics/replication-lag",
  label: "Replication Lag",
  unit: "s",
};

export function metricSpecsFor(typeId: string, serviceType = ""): MetricSpec[] {
  switch (typeId) {
    case "service":
      if (serviceType === "static_site") return [BANDWIDTH, REQUESTS];
      if (serviceType === "web_service") {
        return [CPU, MEMORY, INSTANCES, REQUESTS, LATENCY, BANDWIDTH];
      }
      return [CPU, MEMORY, INSTANCES];
    case "postgres":
      return [CPU, MEMORY, DISK_USAGE, DISK_CAPACITY, CONNECTIONS, REPLICATION_LAG];
    case "key-value":
      return [CPU, MEMORY, CONNECTIONS];
    case "disk":
      return [DISK_USAGE, DISK_CAPACITY];
    default:
      return [];
  }
}

function seriesLabel(base: string, s: RenderMetricSeries, many: boolean): string {
  if (!many) return base;
  const extra = (s.labels ?? [])
    .filter((l) => l.field !== "resource" && l.field !== "service")
    .map((l) => l.value)
    .filter(Boolean)
    .join(" ");
  return extra ? `${base} (${extra})` : base;
}

export function toMetricSeries(spec: MetricSpec, rows: RenderMetricSeries[]): MetricSeries[] {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => (r.values ?? []).length > 0);
  return list.map((r) => ({
    label: seriesLabel(spec.label, r, list.length > 1),
    unit: spec.unit ?? r.unit ?? "",
    points: (r.values ?? [])
      .map((v) => ({
        timestamp: Date.parse(v.timestamp),
        value: Number(v.value) * (spec.scale ?? 1),
      }))
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value))
      .sort((a, b) => a.timestamp - b.timestamp),
  }));
}

export async function fetchRenderMetrics(
  api: RenderApi,
  specs: MetricSpec[],
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
  // Roughly 300 points per chart, never finer than a minute.
  const resolutionSeconds = Math.max(60, Math.round((endMs - startMs) / 1000 / 300));
  const results = await Promise.all(
    specs.map(async (spec) => {
      try {
        const rows = await api.request<RenderMetricSeries[]>(spec.path, {
          query: {
            resource: resourceId,
            startTime: new Date(startMs).toISOString(),
            endTime: new Date(endMs).toISOString(),
            ...(spec.path === "/metrics/bandwidth" ? {} : { resolutionSeconds }),
            ...spec.query,
          },
        });
        return toMetricSeries(spec, rows);
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}
