import type { MetricSeries } from "@infrawrench/plugin-base";
import type { AnyscaleContext } from "./api.js";
import { anyscaleFetch, anyscalePaged } from "./api.js";
import type { AsUsageGroup, AsUtilizationTimeseries } from "./types.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 3600_000;
export const SPEND_METRICS_WINDOW_MS = 30 * 24 * 3600_000;
/** The utilization endpoint keeps 90 days of customer metrics. */
const MAX_WINDOW_MS = 90 * 24 * 3600_000;

export function rangeOrDefault(
  timeRange: { startMs: number; endMs: number } | undefined,
  defaultMs: number,
): { startMs: number; endMs: number } {
  if (timeRange && timeRange.endMs > timeRange.startMs) {
    const startMs = Math.max(timeRange.startMs, timeRange.endMs - MAX_WINDOW_MS);
    return { startMs, endMs: timeRange.endMs };
  }
  const endMs = Date.now();
  return { startMs: endMs - defaultMs, endMs };
}

/** Utilization metrics charted for a cloud (and, filtered, for a project). */
const UTILIZATION_METRICS = [
  "node_count_by_market_type",
  "cpu_count",
  "gpu_count",
  "cpu_utilization",
  "gpu_utilization",
  "memory_utilization",
  "gram_utilization",
  "spot_preemptions",
] as const;

const LABELS: Record<string, { label: string; unit?: string; percent?: boolean }> = {
  cpu_count: { label: "CPUs", unit: "CPUs" },
  gpu_count: { label: "GPUs", unit: "GPUs" },
  cpu_utilization: { label: "CPU utilization", unit: "%", percent: true },
  gpu_utilization: { label: "GPU utilization", unit: "%", percent: true },
  memory_utilization: { label: "Memory utilization", unit: "%", percent: true },
  gram_utilization: { label: "GPU memory utilization", unit: "%", percent: true },
  spot_preemptions: { label: "Spot preemptions", unit: "preemptions" },
};

/** Grouped `node_count_by_market_type` series are named by market type. */
function marketLabel(name: string): string {
  switch (name.toUpperCase()) {
    case "ON_DEMAND":
      return "Nodes (on-demand)";
    case "SPOT":
      return "Nodes (spot)";
    default:
      return `Nodes (${name.toLowerCase().replace(/_/g, "-")})`;
  }
}

/**
 * Normalise the utilization response into chartable series. Utilization comes
 * back either as a 0-1 fraction or as a percentage depending on the metric
 * source, so a series whose values never exceed 1 is scaled to percent.
 */
export function toUtilizationSeries(res: AsUtilizationTimeseries): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const s of res.result?.series ?? []) {
    const name = s.name ?? "";
    const points = (s.points ?? [])
      .filter((p) => typeof p.timestamp === "number" && typeof p.value === "number")
      .map((p) => ({ timestamp: (p.timestamp as number) * 1000, value: p.value as number }));
    const known = LABELS[name];
    if (known) {
      const scale = known.percent && points.every((p) => p.value <= 1) ? 100 : 1;
      out.push({
        label: known.label,
        ...(known.unit ? { unit: known.unit } : {}),
        points: scale === 1 ? points : points.map((p) => ({ ...p, value: p.value * scale })),
      });
    } else {
      out.push({ label: marketLabel(name || "unknown"), unit: "nodes", points });
    }
  }
  return out;
}

export async function utilizationSeries(
  ctx: AnyscaleContext,
  cloudId: string,
  range: { startMs: number; endMs: number },
  projectId?: string,
): Promise<MetricSeries[]> {
  if (!cloudId) return [];
  const windowS = Math.max(60, Math.floor((range.endMs - range.startMs) / 1000));
  const res = await anyscaleFetch<AsUtilizationTimeseries>(
    ctx,
    `/api/v2/clouds/${encodeURIComponent(cloudId)}/cluster-utilization/timeseries`,
    {
      query: {
        metrics: [...UTILIZATION_METRICS],
        start: Math.floor(range.startMs / 1000),
        end: Math.floor(range.endMs / 1000),
        // About 300 points across the window; the server coarsens further.
        step_seconds: Math.max(60, Math.ceil(windowS / 300)),
        project_id: projectId,
      },
    },
  );
  return toUtilizationSeries(res);
}

/** Node-hours across a set of node-count series (trapezoid over the step grid). */
export function nodeHours(series: MetricSeries[]): number {
  let total = 0;
  for (const s of series) {
    if (s.unit !== "nodes") continue;
    const pts = s.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      total += ((a.value + b.value) / 2) * ((b.timestamp - a.timestamp) / 3600_000);
    }
  }
  return total;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Daily Anyscale spend by workload type, from the usage data. */
export async function dailySpendSeries(
  ctx: AnyscaleContext,
  range: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const rows = await anyscalePaged<AsUsageGroup>(
    ctx,
    "/api/v2/aggregated_instance_usage/cluster_type",
    {
      body: {
        start_date: isoDay(range.startMs),
        end_date: isoDay(range.endMs),
        group_by_date: true,
        asc: true,
      },
      count: 1000,
      maxPages: 10,
    },
  );
  const byType = new Map<string, Map<number, number>>();
  for (const r of rows) {
    if (!r.date) continue;
    const ts = Date.parse(`${r.date.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(ts)) continue;
    const type = r.cluster_type ?? "Other";
    const m = byType.get(type) ?? new Map<number, number>();
    m.set(ts, (m.get(ts) ?? 0) + Number(r.dollar_value ?? 0));
    byType.set(type, m);
  }
  return [...byType.entries()].map(([type, m]) => ({
    label: `Spend: ${type}`,
    unit: "USD",
    points: [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, value]) => ({ timestamp, value })),
  }));
}
