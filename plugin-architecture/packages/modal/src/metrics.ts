/**
 * Metric series for the Metrics tab.
 *
 * - Workspace, environment and app: cost over time from the billing report,
 *   filtered server-side by `environment_ids` / `app_ids`, as a total and by
 *   resource type, plus GPU hours where the workspace rate card prices the
 *   same GPU the report names (hours = cost / hourly rate; nothing is shown
 *   for a GPU the rate card does not name, rather than a guess).
 * - Functions: `FunctionGetTimeRangeStats` per time bucket: inputs by outcome,
 *   cold starts (containers started), container errors, execution time and
 *   end-to-end latency percentiles, and container CPU, memory and GPU
 *   utilization. Modal says the percentile metric names may change, so only
 *   the ones present are charted.
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { BillingRates, ModalPercentiles, ModalTimeRangeStats } from "./api.js";
import { billingReport, getFunctionTimeRangeStats } from "./api.js";
import type { ModalContext } from "./grpc.js";

export const COST_METRICS_WINDOW_MS = 30 * 86_400_000;
export const FUNCTION_METRICS_WINDOW_MS = 86_400_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_RESOURCE_SERIES = 6;
const FUNCTION_BUCKETS = 24;
const BUCKET_CONCURRENCY = 6;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The hourly rate the card states for a report resource name, when it names the same thing. */
export function gpuHourlyRate(
  resource: string,
  rates: BillingRates | undefined,
): number | undefined {
  if (!rates || !/gpu/i.test(resource)) return undefined;
  const target = normalize(resource);
  for (const [key, rate] of Object.entries(rates.rates)) {
    if (rate > 0 && normalize(key) === target) return rate;
  }
  return undefined;
}

export async function costSeries(
  ctx: ModalContext,
  range: TimeRange,
  filter: { environmentIds?: string[]; appIds?: string[] },
  rates?: BillingRates,
): Promise<MetricSeries[]> {
  const hourly = range.endMs - range.startMs <= 3 * DAY_MS;
  const step = hourly ? HOUR_MS : DAY_MS;
  const startMs = Math.floor(range.startMs / step) * step;
  const items = await billingReport(ctx, {
    startMs,
    endMs: range.endMs,
    resolution: hourly ? "h" : "d",
    ...(filter.environmentIds ? { environmentIds: filter.environmentIds } : {}),
    ...(filter.appIds ? { appIds: filter.appIds } : {}),
  });
  const total = new Map<number, number>();
  const byResource = new Map<string, Map<number, number>>();
  const resourceTotals = new Map<string, number>();
  for (const item of items) {
    const t = item.intervalStartMs;
    total.set(t, (total.get(t) ?? 0) + item.cost);
    for (const [resource, amount] of Object.entries(item.costByResource)) {
      const series = byResource.get(resource) ?? new Map<number, number>();
      series.set(t, (series.get(t) ?? 0) + amount);
      byResource.set(resource, series);
      resourceTotals.set(resource, (resourceTotals.get(resource) ?? 0) + amount);
    }
  }
  const toPoints = (m: Map<number, number>, scale = 1): MetricSeriesPoint[] =>
    [...m.entries()]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, value]) => ({ timestamp, value: Math.round(value * scale * 1e4) / 1e4 }));
  const out: MetricSeries[] = [];
  if (total.size > 0) out.push({ label: "Cost", unit: "USD", points: toPoints(total) });
  const ranked = [...resourceTotals.entries()]
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([k]) => k);
  for (const resource of ranked.slice(0, MAX_RESOURCE_SERIES)) {
    out.push({
      label: `Cost: ${resource}`,
      unit: "USD",
      points: toPoints(byResource.get(resource)!),
    });
  }
  const gpuCost = new Map<number, number>();
  const gpuHours = new Map<number, number>();
  for (const resource of ranked) {
    if (!/gpu/i.test(resource)) continue;
    const rate = gpuHourlyRate(resource, rates);
    for (const [t, v] of byResource.get(resource)!) {
      gpuCost.set(t, (gpuCost.get(t) ?? 0) + v);
      if (rate) gpuHours.set(t, (gpuHours.get(t) ?? 0) + v / rate);
    }
  }
  if (gpuCost.size > 0) out.push({ label: "GPU cost", unit: "USD", points: toPoints(gpuCost) });
  if (gpuHours.size > 0) out.push({ label: "GPU hours", unit: "h", points: toPoints(gpuHours) });
  return out;
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const PERCENTILE_LABELS: Array<[number, string]> = [
  [5000, "p50"],
  [9500, "p95"],
  [9900, "p99"],
];

const INPUT_METRICS: Array<[string, string]> = [
  ["execution_time", "Execution time"],
  ["end_to_end_latency", "End-to-end latency"],
];

const CONTAINER_METRICS: Array<[string, string]> = [
  ["cpu_usage", "CPU usage"],
  ["memory_usage", "Memory usage"],
  ["gpu_utilization", "GPU utilization"],
];

function unitLabel(unit: string): string | undefined {
  switch (unit) {
    case "seconds":
      return "s";
    case "fraction":
      return "%";
    case "gibibytes":
      return "GiB";
    case "cores":
      return "cores";
    default:
      return unit || undefined;
  }
}

export async function functionSeries(
  ctx: ModalContext,
  functionId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const span = Math.max(60_000, range.endMs - range.startMs);
  const step = Math.ceil(span / FUNCTION_BUCKETS);
  const buckets: TimeRange[] = [];
  for (let s = range.startMs; s < range.endMs; s += step) {
    buckets.push({ startMs: s, endMs: Math.min(range.endMs, s + step) });
  }
  const settled = await mapLimited(buckets, BUCKET_CONCURRENCY, async (b) => {
    try {
      return { b, stats: await getFunctionTimeRangeStats(ctx, functionId, b.startMs, b.endMs) };
    } catch (err) {
      return { b, err };
    }
  });
  const ok = settled.filter((s): s is { b: TimeRange; stats: ModalTimeRangeStats } => "stats" in s);
  if (ok.length === 0) {
    const first = settled[0];
    if (first && "err" in first) throw first.err;
    return [];
  }
  const counter = (label: string, pick: (s: ModalTimeRangeStats) => number): MetricSeries => ({
    label,
    points: ok.map(({ b, stats }) => ({ timestamp: b.startMs, value: pick(stats) })),
  });
  const out: MetricSeries[] = [
    counter("Successful inputs", (s) => s.succeeded),
    counter("Failed inputs", (s) => s.failed),
    counter("Timed-out inputs", (s) => s.timedOut),
    counter("Cold starts", (s) => s.containersStarted),
    counter("Container errors", (s) => s.containerErrors),
  ];
  const percentileSeries = (
    pick: (s: ModalTimeRangeStats) => Record<string, ModalPercentiles>,
    metrics: Array<[string, string]>,
  ) => {
    for (const [key, label] of metrics) {
      for (const [bp, name] of PERCENTILE_LABELS) {
        const points: MetricSeriesPoint[] = [];
        let unit = "";
        for (const { b, stats } of ok) {
          const dist = pick(stats)[key];
          const value = dist?.values[bp];
          if (dist && typeof value === "number" && Number.isFinite(value)) {
            unit = dist.unit;
            points.push({
              timestamp: b.startMs,
              value: unit === "fraction" ? Math.round(value * 10000) / 100 : value,
            });
          }
        }
        if (points.length === 0) continue;
        const u = unitLabel(unit);
        out.push({ label: `${label} ${name}`, ...(u ? { unit: u } : {}), points });
      }
    }
  };
  percentileSeries((s) => s.inputPercentiles, INPUT_METRICS);
  percentileSeries((s) => s.containerPercentiles, CONTAINER_METRICS);
  return out;
}
