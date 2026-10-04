import type { MetricSeries } from "@infrawrench/plugin-base";
import type { CoreWeaveContext } from "./api.js";
import { OBSERVE_BASE, bearerFetch, promLabel, promRegexLiteral } from "./api.js";
import type { FocusRow } from "./focus.js";
import { dayOf, fetchFocusRows, toApiTime } from "./focus.js";
import { gpuHoursOf } from "./cost-data.js";

/**
 * GPU metrics from CoreWeave's Prometheus-compatible query API
 * (`observe.coreweave.com/api/v1/query_range`, Bearer token, needs the
 * Observability Viewer role; "Query logs and metrics", 2026-10).
 *
 * CoreWeave exposes NVIDIA DCGM exporter metrics labelled with `cluster`
 * (the cluster name), `node` and `gpu`. `DCGM_FI_DEV_GPU_UTIL` and
 * `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE` are the two CoreWeave documents and
 * builds its own alerting examples on; the framebuffer and power series are
 * dcgm-exporter defaults that CoreWeave does not list by name, so either
 * one missing just leaves that chart empty. The `cw-hpc-verification`
 * namespace is CoreWeave's own burn-in jobs and is excluded the way
 * CoreWeave's examples exclude it.
 */

export const DEFAULT_METRICS_WINDOW_MS = 24 * 3600_000;
export const USAGE_METRICS_WINDOW_MS = 30 * 86_400_000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range && range.endMs > range.startMs) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

interface PromMatrix {
  status?: string;
  data?: {
    resultType?: string;
    result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]> }>;
  };
}

/** Step that keeps a chart around 240 points, never finer than a minute. */
export function stepFor(range: TimeRange): number {
  return Math.max(60, Math.ceil((range.endMs - range.startMs) / 1000 / 240 / 60) * 60);
}

async function promRange(
  ctx: CoreWeaveContext,
  query: string,
  range: TimeRange,
): Promise<Array<{ timestamp: number; value: number }>> {
  const res = await bearerFetch<PromMatrix>(ctx, `${OBSERVE_BASE}/api/v1/query_range`, {
    query: {
      query,
      start: Math.floor(range.startMs / 1000),
      end: Math.floor(range.endMs / 1000),
      step: stepFor(range),
    },
  });
  const first = res?.data?.result?.[0];
  return (first?.values ?? [])
    .map(([ts, v]) => ({ timestamp: Math.round(Number(ts) * 1000), value: Number(v) }))
    .filter((p) => Number.isFinite(p.value));
}

interface SeriesSpec {
  label: string;
  unit: string;
  query: string;
}

/** Series names are stable keys in the metrics warehouse; do not reword them. */
export function gpuSeriesSpecs(selector: string): SeriesSpec[] {
  const workload = `${selector}, namespace!~"cw-hpc-verification"`;
  return [
    {
      label: "GPU utilization",
      unit: "%",
      query: `avg(DCGM_FI_DEV_GPU_UTIL{${workload}})`,
    },
    {
      label: "Tensor core activity",
      unit: "%",
      query: `avg(DCGM_FI_PROF_PIPE_TENSOR_ACTIVE{${workload}}) * 100`,
    },
    {
      label: "GPUs reporting",
      unit: "GPUs",
      query: `count(DCGM_FI_DEV_GPU_UTIL{${selector}})`,
    },
    {
      label: "Idle GPUs",
      unit: "GPUs",
      query: `count(DCGM_FI_DEV_GPU_UTIL{${selector}} == 0) or vector(0)`,
    },
    {
      label: "GPU memory used",
      unit: "GiB",
      query: `sum(DCGM_FI_DEV_FB_USED{${selector}}) / 1024`,
    },
    {
      label: "GPU power draw",
      unit: "W",
      query: `sum(DCGM_FI_DEV_POWER_USAGE{${selector}})`,
    },
  ];
}

export function clusterSelector(clusterName: string): string {
  return `cluster="${promLabel(clusterName)}"`;
}

export function nodesSelector(clusterName: string, nodes: string[]): string {
  const alternatives = nodes.map(promRegexLiteral).join("|");
  return `cluster="${promLabel(clusterName)}", node=~"${alternatives}"`;
}

export async function gpuSeries(
  ctx: CoreWeaveContext,
  selector: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const specs = gpuSeriesSpecs(selector);
  const results = await Promise.all(
    specs.map((s) => promRange(ctx, s.query, range).catch(() => [])),
  );
  return specs
    .map((s, i) => ({ label: s.label, unit: s.unit, points: results[i] ?? [] }))
    .filter((s) => s.points.length > 0);
}

/** One point per UTC day at midnight. */
function dailyPoints(byDay: Map<string, number>): Array<{ timestamp: number; value: number }> {
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({
      timestamp: Date.parse(`${day}T00:00:00Z`),
      value: Math.round(value * 100) / 100,
    }));
}

/** Billable GPU-hours per day from the FOCUS export, optionally for one cluster. */
export async function gpuHourSeries(
  ctx: CoreWeaveContext,
  range: TimeRange,
  clusterId?: string,
): Promise<MetricSeries[]> {
  const rows = await fetchFocusRows(ctx, {
    startTime: toApiTime(Math.floor(range.startMs / 86_400_000) * 86_400_000),
    endTime: toApiTime(Math.floor(range.endMs / 3_600_000) * 3_600_000),
    groupBy: "location",
    productFamily: "GPU Compute",
    ...(clusterId ? { cluster: clusterId } : {}),
  }).catch(() => [] as FocusRow[]);
  return gpuHourSeriesFromRows(rows);
}

export function gpuHourSeriesFromRows(rows: FocusRow[]): MetricSeries[] {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = dayOf(r);
    const h = gpuHoursOf(r);
    if (!day || h === 0) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + h);
  }
  if (byDay.size === 0) return [];
  return [{ label: "Billable GPU-hours per day", unit: "GPU-h", points: dailyPoints(byDay) }];
}

/** Estimated spend per day, from cost rows already priced by `cost-data.ts`. */
export function spendSeries(rows: Array<{ date: string; amount: number }>): MetricSeries[] {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amount);
  if (byDay.size === 0) return [];
  return [{ label: "Estimated spend per day", unit: "USD", points: dailyPoints(byDay) }];
}
