import { pathEncode, type ApiResponse, type MetricSeries } from "@infrawrench/plugin-base";
import type { PaperspaceApi } from "./api.js";
import type { operations } from "./api-types.gen.js";

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

type MetricsOperation = operations["deploymentMetrics-get"];
type MetricsResponse = ApiResponse<MetricsOperation>;
type MetricsQuery = NonNullable<MetricsOperation["parameters"]["query"]>;
type Timeframe = NonNullable<MetricsQuery["timeframe"]>;
type MetricRows = Extract<MetricsResponse, readonly object[]>;
type ReplicaRows = Extract<MetricRows, ReadonlyArray<{ values: object }>>;
type Point = { timestamp: string; value: string; instanceId?: string; gpu?: string };

/** The document's third shape, told apart as the first row says. */
function isPerReplica(rows: MetricRows): rows is ReplicaRows {
  const [first] = rows;
  return first !== undefined && "values" in first;
}

export const METRICS: Array<{
  metric: MetricsQuery["metric"];
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

const TIMEFRAMES: Array<[Timeframe, number]> = [
  ["hour", 3_600_000],
  ["12_hours", 12 * 3_600_000],
  ["day", 24 * 3_600_000],
  ["1_week", 7 * 24 * 3_600_000],
  ["2_weeks", 14 * 24 * 3_600_000],
];

export function timeframeFor(spanMs: number): Timeframe {
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
    if (isPerReplica(res)) {
      for (const r of res) groups.push(r.values ?? []);
    } else {
      const byInstance = new Map<string, Point[]>();
      for (const p of res) {
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
        const res = await api.get(`/deployments/${pathEncode(deploymentId)}/metrics`, {
          query: { metric: def.metric, timeframe },
        });
        return toSeries(res, def, startMs, endMs);
      } catch {
        return null;
      }
    }),
  );
  return series.filter((s): s is MetricSeries => s !== null);
}
