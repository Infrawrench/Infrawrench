import type { MetricSeries } from "@infrawrench/plugin-base";
import { isStatus, type BasetenApi } from "./api.js";
import type {
  MetricDescriptor,
  MetricsResponse,
  ModelApiUsageResponse,
  TrainingJobMetrics,
  TrainingMetricPoint,
} from "./types.js";

/**
 * Metrics from the management API (verified against the published spec,
 * 2026-10):
 *
 * - Deployments and environments: `GET .../metrics?mode=SERIES` with the
 *   metric names from Baseten's supported-metrics reference. The response is
 *   columnar: `metric_descriptors[i]` describes metric i and its
 *   `label_sets` (one per quantile for histograms, one per status for
 *   by-status counters), and each `metric_values[t].values[i][j]` is that
 *   series' value at step t. Windows are capped at 7 days. Unknown names are
 *   rejected with a 4xx, so on any 4xx the request is repeated with Baseten's
 *   default set (replicas, requests, latency) rather than showing nothing.
 * - Model APIs: `GET /v1/model_apis/usage` token and request buckets.
 * - Training jobs: `GET /v1/training_projects/{p}/jobs/{j}/metrics`.
 */

export const DEFAULT_METRICS_WINDOW_MS = 6 * 3_600_000;
const MAX_WINDOW_MS = 7 * 86_400_000;

export const DEPLOYMENT_METRICS = [
  "baseten_replicas_active",
  "baseten_replicas_desired",
  "baseten_replicas_starting",
  "baseten_inference_requests_total",
  "baseten_end_to_end_response_time_seconds",
  "baseten_time_to_first_byte_seconds",
  "baseten_concurrent_requests",
  "baseten_async_queue_size",
  "baseten_gpu_utilization",
  "baseten_gpu_memory_used",
  "baseten_container_cpu_usage_seconds_total",
  "baseten_container_cpu_memory_working_set_bytes",
  "baseten_container_restarts_total",
  "baseten_llm_input_tokens_total",
  "baseten_llm_output_tokens_total",
];

interface MetricLabel {
  label: string;
  unit?: string;
  /** Multiply raw values (e.g. ratio → percent, seconds → ms). */
  scale?: number;
}

const LABELS: Record<string, MetricLabel> = {
  baseten_replicas_active: { label: "Active Replicas", unit: "replicas" },
  baseten_replicas_desired: { label: "Desired Replicas", unit: "replicas" },
  baseten_replicas_starting: { label: "Starting Replicas", unit: "replicas" },
  baseten_inference_requests_total: { label: "Inference Requests", unit: "requests" },
  baseten_end_to_end_response_time_seconds: { label: "Latency", unit: "ms", scale: 1000 },
  baseten_time_to_first_byte_seconds: { label: "Time to First Byte", unit: "ms", scale: 1000 },
  baseten_concurrent_requests: { label: "Concurrent Requests", unit: "requests" },
  baseten_async_queue_size: { label: "Async Queue Size", unit: "requests" },
  baseten_gpu_utilization: { label: "GPU Utilization", unit: "%", scale: 100 },
  baseten_gpu_memory_used: { label: "GPU Memory Used", unit: "MiB" },
  baseten_container_cpu_usage_seconds_total: { label: "CPU Usage", unit: "core-seconds" },
  baseten_container_cpu_memory_working_set_bytes: { label: "Memory Used", unit: "bytes" },
  baseten_container_restarts_total: { label: "Container Restarts", unit: "restarts" },
  baseten_llm_input_tokens_total: { label: "Input Tokens", unit: "tokens" },
  baseten_llm_output_tokens_total: { label: "Output Tokens", unit: "tokens" },
};

function unitFromHint(d: MetricDescriptor): string | undefined {
  switch (d.unit_hint) {
    case "PER_SECOND":
      return "/s";
    case "SECONDS":
      return "s";
    case "BYTES":
      return "bytes";
    case "MEBIBYTES":
      return "MiB";
    case "RATIO":
      return "ratio";
    default:
      return undefined;
  }
}

function titleFromName(name: string): string {
  return name
    .replace(/^baseten_/, "")
    .replace(/_total$/, "")
    .split("_")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function quantileLabel(q: string): string {
  const n = Number(q);
  return Number.isFinite(n) ? `p${Math.round(n * 100)}` : q;
}

/**
 * Columnar metrics response → host series. A metric with one label set is
 * one series; histograms become one series per quantile plus the average; a
 * by-label breakdown (status codes, ...) becomes a total plus one series per
 * label value.
 */
export function parseMetricsResponse(res: MetricsResponse | undefined): MetricSeries[] {
  const descriptors = res?.metric_descriptors ?? [];
  const steps = res?.metric_values ?? [];
  const out: MetricSeries[] = [];
  descriptors.forEach((d, i) => {
    const fallbackUnit = unitFromHint(d);
    const meta: MetricLabel = LABELS[d.name] ?? {
      label: titleFromName(d.name),
      ...(fallbackUnit ? { unit: fallbackUnit } : {}),
    };
    const scale = meta.scale ?? 1;
    const labelSets = d.label_sets?.length ? d.label_sets : [{}];
    const pointsFor = (j: number | "sum") =>
      steps
        .map((s) => {
          const row = s.values?.[i];
          if (!row) return null;
          let v: number | null;
          if (j === "sum") {
            const nums = row.filter((x): x is number => typeof x === "number");
            v = nums.length ? nums.reduce((a, b) => a + b, 0) : null;
          } else {
            const raw = row[j];
            v = typeof raw === "number" ? raw : null;
          }
          if (v === null || !Number.isFinite(v)) return null;
          return { timestamp: s.start_epoch_millis, value: v * scale };
        })
        .filter((p): p is { timestamp: number; value: number } => p !== null);
    const push = (label: string, points: Array<{ timestamp: number; value: number }>) => {
      if (points.length) out.push({ label, ...(meta.unit ? { unit: meta.unit } : {}), points });
    };

    if (labelSets.length === 1) {
      push(meta.label, pointsFor(0));
      return;
    }
    const isHistogram = labelSets.some((ls) => "quantile" in ls || "stat" in ls);
    if (isHistogram) {
      labelSets.forEach((ls, j) => {
        const suffix =
          ls["quantile"] !== undefined
            ? quantileLabel(ls["quantile"])
            : ls["stat"] === "avg"
              ? "avg"
              : Object.values(ls).join(" ");
        push(`${meta.label} ${suffix}`, pointsFor(j));
      });
      return;
    }
    push(meta.label, pointsFor("sum"));
    labelSets.forEach((ls, j) => {
      const suffix = Object.values(ls).join(" ");
      if (suffix) push(`${meta.label} (${suffix})`, pointsFor(j));
    });
  });
  return out;
}

export function clampWindow(timeRange?: { startMs: number; endMs: number }): {
  startMs: number;
  endMs: number;
} {
  const endMs = timeRange?.endMs ?? Date.now();
  let startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
  if (endMs - startMs > MAX_WINDOW_MS) startMs = endMs - MAX_WINDOW_MS;
  return { startMs, endMs };
}

/** Deployment (`/deployments/{id}/metrics`) or environment (`/environments/{name}/metrics`). */
export async function fetchModelMetrics(
  api: BasetenApi,
  path: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const { startMs, endMs } = clampWindow(timeRange);
  const base = {
    mode: "SERIES",
    start_epoch_millis: Math.floor(startMs),
    end_epoch_millis: Math.floor(endMs),
  };
  try {
    const res = await api.request<MetricsResponse>(path, {
      query: { ...base, metrics: DEPLOYMENT_METRICS },
    });
    return parseMetricsResponse(res);
  } catch (e) {
    if (!isStatus(e, 400, 422)) throw e;
    const res = await api.request<MetricsResponse>(path, { query: base });
    return parseMetricsResponse(res);
  }
}

/** Token and request series for one Model API from the usage buckets. */
export async function fetchModelApiMetrics(
  api: BasetenApi,
  model: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - 7 * 86_400_000;
  const spanH = (endMs - startMs) / 3_600_000;
  // 1h buckets allow 168 per page; longer ranges use daily buckets (max 31).
  const bucket = spanH <= 168 ? "1h" : "1d";
  const limit = bucket === "1h" ? Math.min(168, Math.max(1, Math.ceil(spanH))) : 31;
  const series: Record<string, MetricSeries> = {
    input: { label: "Input Tokens", unit: "tokens", points: [] },
    cached: { label: "Cached Input Tokens", unit: "tokens", points: [] },
    output: { label: "Output Tokens", unit: "tokens", points: [] },
    requests: { label: "Requests", unit: "requests", points: [] },
  };
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res: ModelApiUsageResponse | undefined = await api.request<ModelApiUsageResponse>(
      "/v1/model_apis/usage",
      {
        query: cursor
          ? { cursor }
          : {
              start_time: new Date(startMs).toISOString(),
              end_time: new Date(endMs).toISOString(),
              bucket_width: bucket,
              group_by: ["model"],
              models: [model],
              limit,
            },
      },
    );
    for (const b of res?.items ?? []) {
      const ts = Date.parse(b.start_time);
      if (!Number.isFinite(ts)) continue;
      const r = (b.results ?? []).find((x) => !x.model || x.model === model);
      series["input"]!.points.push({ timestamp: ts, value: r?.input_tokens ?? 0 });
      series["cached"]!.points.push({ timestamp: ts, value: r?.cached_input_tokens ?? 0 });
      series["output"]!.points.push({ timestamp: ts, value: r?.output_tokens ?? 0 });
      series["requests"]!.points.push({ timestamp: ts, value: r?.request_count ?? 0 });
    }
    if (!res?.pagination?.has_more || !res.pagination.cursor) break;
    cursor = res.pagination.cursor;
  }
  return Object.values(series).filter((s) => s.points.length > 0);
}

function toPoints(list: TrainingMetricPoint[] | null | undefined, scale = 1) {
  return (list ?? [])
    .map((p) => ({ timestamp: Date.parse(p.timestamp), value: p.value * scale }))
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
}

export async function fetchTrainingJobMetrics(
  api: BasetenApi,
  projectId: string,
  jobId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const res = await api.request<TrainingJobMetrics>(
    `/v1/training_projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/metrics`,
    {
      query: timeRange
        ? {
            start_epoch_millis: Math.floor(timeRange.startMs),
            end_epoch_millis: Math.floor(timeRange.endMs),
          }
        : {},
    },
  );
  const out: MetricSeries[] = [];
  for (const [rank, list] of Object.entries(res?.gpu_utilization ?? {})) {
    const points = toPoints(list, 100);
    if (points.length) out.push({ label: `GPU ${rank} Utilization`, unit: "%", points });
  }
  for (const [rank, list] of Object.entries(res?.gpu_memory_usage_bytes ?? {})) {
    const points = toPoints(list);
    if (points.length) out.push({ label: `GPU ${rank} Memory Used`, unit: "bytes", points });
  }
  const cpu = toPoints(res?.cpu_usage);
  if (cpu.length) out.push({ label: "CPU Usage", points: cpu });
  const mem = toPoints(res?.cpu_memory_usage_bytes);
  if (mem.length) out.push({ label: "Memory Used", unit: "bytes", points: mem });
  return out;
}
