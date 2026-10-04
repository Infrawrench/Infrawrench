/**
 * Metric series for the Metrics tab, from Insights (aggregated daily by
 * CircleCI, at most 90 days back; hourly job data is kept 48 hours).
 *
 * - A workflow charts its own runs (`GET /insights/{slug}/workflows/{name}`):
 *   per day (per hour for windows up to two days), the p50 and p95 run
 *   duration, the success rate, credits used and run count.
 * - A project charts credits, job runs and failed job runs per day, summed
 *   over its busiest workflows' job time series
 *   (`GET /insights/time-series/{slug}/workflows/{name}/jobs`).
 *
 * Queue time is not in any Insights response; the runner resource class shows
 * how many tasks are waiting instead.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { CircleContext } from "./api.js";
import { circleFetch, circlePaged } from "./api.js";
import type { WorkflowMetrics, WorkflowRun } from "./mappers.js";

export const DEFAULT_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Insights keeps 90 days. */
export const MAX_INSIGHTS_DAYS = 90;
/** Workflows charted on a project's tab, busiest by credits first. */
const PROJECT_WORKFLOW_LIMIT = 10;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

/** Clamp to Insights' reach and pick a bucket size. */
export function insightsWindow(range: TimeRange, nowMs = Date.now()) {
  const floor = nowMs - (MAX_INSIGHTS_DAYS - 1) * DAY_MS;
  const startMs = Math.max(range.startMs, floor);
  const endMs = Math.max(startMs + 60_000, Math.min(range.endMs, nowMs));
  const bucketMs = endMs - startMs <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
  return {
    startMs,
    endMs,
    bucketMs,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

const bucketOf = (ms: number, bucketMs: number) => Math.floor(ms / bucketMs) * bucketMs;

/** Series out of a workflow's individual runs. */
export function workflowRunSeries(runs: WorkflowRun[], bucketMs: number): MetricSeries[] {
  const buckets = new Map<number, WorkflowRun[]>();
  for (const run of runs) {
    if (run.is_approval) continue;
    const t = Date.parse(run.created_at);
    if (!Number.isFinite(t)) continue;
    const b = bucketOf(t, bucketMs);
    buckets.set(b, [...(buckets.get(b) ?? []), run]);
  }
  const times = [...buckets.keys()].sort((a, b) => a - b);
  const p50: MetricSeries = { label: "Duration p50", unit: "s", points: [] };
  const p95: MetricSeries = { label: "Duration p95", unit: "s", points: [] };
  const success: MetricSeries = { label: "Success rate", unit: "%", points: [] };
  const credits: MetricSeries = { label: "Credits used", unit: "credits", points: [] };
  const count: MetricSeries = { label: "Runs", unit: "runs", points: [] };
  for (const timestamp of times) {
    const group = buckets.get(timestamp) ?? [];
    const durations = group
      .map((r) => r.duration)
      .filter((d): d is number => typeof d === "number");
    const a = percentile(durations, 50);
    const b = percentile(durations, 95);
    if (a !== undefined) p50.points.push({ timestamp, value: a });
    if (b !== undefined) p95.points.push({ timestamp, value: b });
    const finished = group.filter((r) => r.status !== "canceled");
    if (finished.length > 0) {
      const ok = finished.filter((r) => r.status === "success").length;
      success.points.push({ timestamp, value: Math.round((ok / finished.length) * 1000) / 10 });
    }
    credits.points.push({
      timestamp,
      value: group.reduce((sum, r) => sum + (r.credits_used ?? 0), 0),
    });
    count.points.push({ timestamp, value: group.length });
  }
  return [p50, p95, success, credits, count].filter((s) => s.points.length > 0);
}

const enc = encodeURIComponent;

export async function workflowSeries(
  ctx: CircleContext,
  projectSlug: string,
  workflow: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const w = insightsWindow(range);
  const runs = await circlePaged<WorkflowRun>(
    ctx,
    `/insights/${projectSlug}/workflows/${enc(workflow)}`,
    { "all-branches": true, "start-date": w.start, "end-date": w.end },
    20,
  );
  return workflowRunSeries(runs, w.bucketMs);
}

interface JobTimeSeriesItem {
  name: string;
  timestamp: string;
  metrics?: {
    total_runs?: number;
    failed_runs?: number;
    total_credits_used?: number;
  };
}

/** Credits, job runs and failed job runs per bucket, summed over job time series. */
export function projectSeriesFrom(items: JobTimeSeriesItem[]): MetricSeries[] {
  const credits = new Map<number, number>();
  const runs = new Map<number, number>();
  const failed = new Map<number, number>();
  const bump = (m: Map<number, number>, t: number, v: number | undefined) =>
    m.set(t, (m.get(t) ?? 0) + (v ?? 0));
  for (const item of items) {
    const t = Date.parse(item.timestamp);
    if (!Number.isFinite(t)) continue;
    bump(credits, t, item.metrics?.total_credits_used);
    bump(runs, t, item.metrics?.total_runs);
    bump(failed, t, item.metrics?.failed_runs);
  }
  const toSeries = (label: string, unit: string, m: Map<number, number>): MetricSeries => ({
    label,
    unit,
    points: [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, value]) => ({ timestamp, value })),
  });
  return [
    toSeries("Credits used", "credits", credits),
    toSeries("Job runs", "runs", runs),
    toSeries("Failed job runs", "runs", failed),
  ].filter((s) => s.points.length > 0);
}

export async function projectSeries(
  ctx: CircleContext,
  projectSlug: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const w = insightsWindow(range);
  const granularity = w.bucketMs === HOUR_MS ? "hourly" : "daily";
  const workflows = await circlePaged<WorkflowMetrics>(
    ctx,
    `/insights/${projectSlug}/workflows`,
    { "all-branches": true, "reporting-window": "last-90-days" },
    3,
  );
  const busiest = workflows
    .sort((a, b) => (b.metrics?.total_credits_used ?? 0) - (a.metrics?.total_credits_used ?? 0))
    .slice(0, PROJECT_WORKFLOW_LIMIT);
  const items: JobTimeSeriesItem[] = [];
  for (const wf of busiest) {
    const res = await circleFetch<{ items?: JobTimeSeriesItem[] }>(
      ctx,
      `/insights/time-series/${projectSlug}/workflows/${enc(wf.name)}/jobs`,
      { query: { granularity, "start-date": w.start, "end-date": w.end } },
    ).catch(() => undefined);
    items.push(...(res?.items ?? []));
  }
  return projectSeriesFrom(items);
}
