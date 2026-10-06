/**
 * Metric series, bucketed here from the raw lists (Bitbucket has no
 * time-series API):
 *
 * - Repository: pipelines started, failed and successful per day, success
 *   rate, build minutes (`build_seconds_used`, what Bitbucket bills against
 *   the plan's minutes) and duration p50/p95, from
 *   `GET /repositories/{ws}/{repo}/pipelines?sort=-created_on`, read newest
 *   first until older than the window (bounded).
 * - Environment: successful and failed deployments per day, from the
 *   repository's deployments filtered to the environment.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { BbDeployment, BbPipeline } from "./types.js";
import { pipelineDuration, stateWord } from "./mappers.js";

export const DEFAULT_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - DEFAULT_METRICS_WINDOW_MS, endMs };
}

export function bucketSize(range: TimeRange): number {
  return range.endMs - range.startMs <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function group<T>(items: T[], at: (t: T) => string | undefined | null, range: TimeRange) {
  const size = bucketSize(range);
  const buckets = new Map<number, T[]>();
  for (const item of items) {
    const raw = at(item);
    const t = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(t) || t < range.startMs || t > range.endMs) continue;
    const b = Math.floor(t / size) * size;
    const listed = buckets.get(b);
    if (listed) listed.push(item);
    else buckets.set(b, [item]);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
}

const FAILED = new Set(["FAILED", "ERROR"]);

export function pipelineSeries(pipelines: BbPipeline[], range: TimeRange): MetricSeries[] {
  const runs: MetricSeries = { label: "Pipelines", unit: "pipelines", points: [] };
  const failed: MetricSeries = { label: "Failed pipelines", unit: "pipelines", points: [] };
  const success: MetricSeries = { label: "Success rate", unit: "%", points: [] };
  const minutes: MetricSeries = { label: "Build minutes", unit: "min", points: [] };
  const p50: MetricSeries = { label: "Duration p50", unit: "s", points: [] };
  const p95: MetricSeries = { label: "Duration p95", unit: "s", points: [] };
  for (const [timestamp, items] of group(pipelines, (p) => p.created_on, range)) {
    const results = items.map((p) => stateWord(p.state) ?? "");
    runs.points.push({ timestamp, value: items.length });
    failed.points.push({ timestamp, value: results.filter((r) => FAILED.has(r)).length });
    const done = results.filter((r) => r === "SUCCESSFUL" || FAILED.has(r));
    if (done.length > 0) {
      const ok = done.filter((r) => r === "SUCCESSFUL").length;
      success.points.push({ timestamp, value: Math.round((ok / done.length) * 1000) / 10 });
    }
    const secs = items.reduce((sum, p) => sum + (p.build_seconds_used ?? 0), 0);
    minutes.points.push({ timestamp, value: Math.round((secs / 60) * 10) / 10 });
    const durations = items
      .filter((p) => p.completed_on)
      .map(pipelineDuration)
      .filter((d): d is number => typeof d === "number");
    const a = percentile(durations, 50);
    const b = percentile(durations, 95);
    if (a !== undefined) p50.points.push({ timestamp, value: a });
    if (b !== undefined) p95.points.push({ timestamp, value: b });
  }
  return [runs, failed, success, minutes, p50, p95].filter((s) => s.points.length > 0);
}

export function deploymentSeries(deployments: BbDeployment[], range: TimeRange): MetricSeries[] {
  const ok: MetricSeries = { label: "Successful deployments", unit: "deployments", points: [] };
  const bad: MetricSeries = { label: "Failed deployments", unit: "deployments", points: [] };
  for (const [timestamp, items] of group(
    deployments,
    (d) => d.state?.completion_date ?? d.state?.start_date ?? d.last_update_time,
    range,
  )) {
    ok.points.push({
      timestamp,
      value: items.filter((d) => d.state?.status?.name === "SUCCESSFUL").length,
    });
    bad.points.push({
      timestamp,
      value: items.filter((d) => d.state?.status?.name === "FAILED").length,
    });
  }
  return [ok, bad].filter((s) => s.points.some((p) => p.value > 0));
}
