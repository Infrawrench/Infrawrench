import type { MetricSeries } from "@infrawrench/plugin-base";
import type { CrusoeApi } from "./api.js";

/**
 * VM metrics from Crusoe's Prometheus-compatible query API
 * (`GET /projects/{id}/metrics/timeseries/api/v1/query-range`). Series exist
 * only for VMs running the Crusoe Watch Agent (installed by default on new
 * VMs), are scraped every 60 s and kept for 30 days. Metric names and the
 * `vm_id` label are from Crusoe's VM telemetry docs and the agent's vector
 * configs (`crusoecloud/crusoe-watch-agent`, `vm/config/*.yaml` tag every
 * series with `vm_id`), 2026-10.
 *
 * Crusoe documents a monitoring token (`crusoe monitoring tokens create`) as
 * the credential for this API. When the account has one it is sent as a
 * Bearer token; otherwise the request is HMAC-signed like every other call.
 * A refusal yields no series rather than an error: the Metrics tab's empty
 * state is the right answer.
 */

export const DEFAULT_METRICS_WINDOW_MS = 3 * 3_600_000;

interface PromResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]> }>;
  };
}

interface Query {
  label: string;
  unit: string;
  promql: (vmId: string) => string;
}

const sel = (vmId: string) => `vm_id="${vmId.replace(/["\\]/g, "")}"`;

export const VM_QUERIES: Query[] = [
  {
    label: "CPU Utilization",
    unit: "%",
    promql: (id) =>
      `(sum(rate(crusoe_vm_cpu_seconds_total{${sel(id)},mode!="idle"}[2m])) / sum(rate(crusoe_vm_cpu_seconds_total{${sel(id)}}[2m]))) * 100`,
  },
  {
    label: "Memory Utilization",
    unit: "%",
    promql: (id) =>
      `(sum(crusoe_vm_memory_used_bytes{${sel(id)}}) / sum(crusoe_vm_memory_total_bytes{${sel(id)}})) * 100`,
  },
  {
    label: "Network In",
    unit: "bytes/s",
    promql: (id) => `sum(rate(crusoe_vm_network_receive_bytes_total{${sel(id)}}[2m]))`,
  },
  {
    label: "Network Out",
    unit: "bytes/s",
    promql: (id) => `sum(rate(crusoe_vm_network_transmit_bytes_total{${sel(id)}}[2m]))`,
  },
  {
    label: "GPU Utilization",
    unit: "%",
    promql: (id) => `avg(DCGM_FI_DEV_GPU_UTIL{${sel(id)}})`,
  },
  {
    label: "GPU Memory Utilization",
    unit: "%",
    promql: (id) =>
      `(sum(DCGM_FI_DEV_FB_USED{${sel(id)}}) / (sum(DCGM_FI_DEV_FB_FREE{${sel(id)}}) + sum(DCGM_FI_DEV_FB_USED{${sel(id)}}))) * 100`,
  },
  {
    label: "Tensor Core Activity",
    unit: "%",
    promql: (id) => `avg(DCGM_FI_PROF_PIPE_TENSOR_ACTIVE{${sel(id)}}) * 100`,
  },
  {
    label: "GPU Power",
    unit: "W",
    promql: (id) => `sum(DCGM_FI_DEV_POWER_USAGE{${sel(id)}})`,
  },
  {
    label: "GPU Temperature",
    unit: "°C",
    promql: (id) => `max(DCGM_FI_DEV_GPU_TEMP{${sel(id)}})`,
  },
];

/** Step that keeps a range under ~300 points, never finer than the 60 s scrape. */
export function stepSeconds(startMs: number, endMs: number): number {
  return Math.max(60, Math.ceil((endMs - startMs) / 1000 / 300 / 60) * 60);
}

export function toSeries(res: PromResponse | undefined, q: Query): MetricSeries | null {
  const values = res?.data?.result?.[0]?.values;
  if (!values || values.length === 0) return null;
  const points = values
    .map(([t, v]) => ({ timestamp: Math.round(t * 1000), value: Number(v) }))
    .filter((p) => Number.isFinite(p.value));
  if (points.length === 0) return null;
  return { label: q.label, unit: q.unit, points };
}

export async function fetchVmMetrics(
  api: CrusoeApi,
  projectId: string,
  vmId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
  const step = stepSeconds(startMs, endMs);
  const token = api.monitoringToken;
  const results = await Promise.all(
    VM_QUERIES.map(async (q) => {
      try {
        const res = await api.request<PromResponse>(
          `/projects/${projectId}/metrics/timeseries/api/v1/query-range`,
          {
            query: {
              query: q.promql(vmId),
              start: String(Math.floor(startMs / 1000)),
              end: String(Math.floor(endMs / 1000)),
              step: `${step}s`,
            },
            ...(token ? { bearerToken: token } : {}),
          },
        );
        return toSeries(res, q);
      } catch {
        return null;
      }
    }),
  );
  return results.filter((s): s is MetricSeries => s !== null);
}
