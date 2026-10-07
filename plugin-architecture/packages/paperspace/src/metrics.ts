import type { MetricSeries } from "@infrawrench/plugin-base";
import type { PaperspaceApi } from "./api.js";

/**
 * Deployment metrics from `GET /deployments/{id}/metrics?metric=&timeframe=`
 * (verified in the OpenAPI document, 2026-10). Timeframes are fixed
 * (`hour`, `12_hours`, `day`, `1_week`, `2_weeks`), so the requested range is
 * rounded up to the nearest one and trimmed back. Responses come in three
 * shapes: a single point, an array of points (with `instanceId`/`gpu` tags),
 * or an array of `{instanceId, values}` per replica. Per-replica series are
 * summed for request metrics and averaged for resource metrics.
 */

export const DEFAULT_METRICS_WINDOW_MS = 12 * 3_600_000;

interface Point {
  timestamp: string;
  value: string;
  instanceId?: string;
  gpu?: string;
}

type MetricsResponse = Point | Point[] | Array<{ instanceId: string; values: Point[] }>;

export const METRICS: Array<{
  metric: string;
  label: string;
  unit: string;
  combine: "sum" | "avg";
}> = [
  { metric: "requests_per_second", label: "Requests per Second", unit: "req/s", combine: "sum" },
  {
    metric: "requests_duration_seconds_1m",
    label: "Request Duration (1m avg)",
    unit: "s",
    combine: "avg",
  },
  { metric: "cpu", label: "CPU", unit: "cores", combine: "avg" },
  { metric: "memory", label: "Memory", unit: "bytes", combine: "avg" },
  { metric: "gpu", label: "GPU Utilization", unit: "%", combine: "avg" },
];

const TIMEFRAMES: Array<[string, number]> = [
  ["hour", 3_600_000],
  ["12_hours", 12 * 3_600_000],
  ["day", 24 * 3_600_000],
  ["1_week", 7 * 24 * 3_600_000],
  ["2_weeks", 14 * 24 * 3_600_000],
];

export function timeframeFor(spanMs: number): string {
  return (TIMEFRAMES.find(([, ms]) => ms >= spanMs) ?? TIMEFRAMES[TIMEFRAMES.length - 1]!)[0];
}

export function toSeries(
  res: MetricsResponse | undefined,
  def: (typeof METRICS)[number],
  startMs: number,
  endMs: number,
): MetricSeries | null {
  const groups: Point[][] = [];
  if (!res) return null;
  if (Array.isArray(res)) {
    if (res.length && "values" in (res[0] as object)) {
      for (const r of res as Array<{ values: Point[] }>) groups.push(r.values ?? []);
    } else {
      const byInstance = new Map<string, Point[]>();
      for (const p of res as Point[]) {
        const k = `${p.instanceId ?? ""}/${p.gpu ?? ""}`;
        byInstance.set(k, [...(byInstance.get(k) ?? []), p]);
      }
      groups.push(...byInstance.values());
    }
  } else {
    groups.push([res]);
  }
  const byTime = new Map<number, number[]>();
  for (const g of groups) {
    for (const p of g) {
      const t = Date.parse(p.timestamp);
      const v = Number(p.value);
      if (!Number.isFinite(t) || !Number.isFinite(v) || t < startMs || t > endMs) continue;
      byTime.set(t, [...(byTime.get(t) ?? []), v]);
    }
  }
  const points = [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timestamp, vs]) => ({
      timestamp,
      value:
        def.combine === "sum"
          ? vs.reduce((a, b) => a + b, 0)
          : vs.reduce((a, b) => a + b, 0) / vs.length,
    }));
  return points.length ? { label: def.label, unit: def.unit, points } : null;
}

export async function fetchDeploymentMetrics(
  api: PaperspaceApi,
  deploymentId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
  const timeframe = timeframeFor(endMs - startMs);
  const series = await Promise.all(
    METRICS.map(async (def) => {
      try {
        const res = await api.request<MetricsResponse>(
          `/deployments/${encodeURIComponent(deploymentId)}/metrics`,
          { query: { metric: def.metric, timeframe } },
        );
        return toSeries(res, def, startMs, endMs);
      } catch {
        return null;
      }
    }),
  );
  return series.filter((s): s is MetricSeries => s !== null);
}
