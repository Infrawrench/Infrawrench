/**
 * Metric series for the Metrics tab, computed from builds.
 *
 * Buildkite's REST API has no metrics endpoint (queue metrics are only on the
 * agent API, which takes an agent token, not an API token), so the series are
 * folded from the builds listing itself: `created_from`/`created_to` bound the
 * window and the embedded jobs give agent wait time (`runnable_at` to
 * `started_at`). At most {@link MAX_BUILD_PAGES} pages of 100 builds are read
 * per chart, so a very busy pipeline charts its most recent 500 builds of the
 * window.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { BkContext, Query } from "./api.js";
import { bkPaged } from "./api.js";
import type { BkBuild } from "./mappers.js";
import { secondsBetween } from "./mappers.js";

export const DEFAULT_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const MAX_BUILD_PAGES = 5;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

const FAILED = new Set(["failed", "canceled"]);
const FINISHED = new Set(["passed", "failed", "canceled"]);

/** Fold builds into per-bucket series. */
export function buildSeries(builds: BkBuild[], bucketMs: number): MetricSeries[] {
  const buckets = new Map<number, BkBuild[]>();
  for (const b of builds) {
    const t = Date.parse(b.created_at ?? "");
    if (!Number.isFinite(t)) continue;
    const key = Math.floor(t / bucketMs) * bucketMs;
    const list = buckets.get(key);
    if (list) list.push(b);
    else buckets.set(key, [b]);
  }
  const count: MetricSeries = { label: "Builds", unit: "builds", points: [] };
  const failed: MetricSeries = { label: "Failed builds", unit: "builds", points: [] };
  const passRate: MetricSeries = { label: "Pass rate", unit: "%", points: [] };
  const p50: MetricSeries = { label: "Build duration p50", unit: "s", points: [] };
  const p95: MetricSeries = { label: "Build duration p95", unit: "s", points: [] };
  const wait: MetricSeries = { label: "Agent wait p95", unit: "s", points: [] };
  for (const timestamp of [...buckets.keys()].sort((a, b) => a - b)) {
    const group = buckets.get(timestamp) ?? [];
    count.points.push({ timestamp, value: group.length });
    failed.points.push({
      timestamp,
      value: group.filter((b) => b.state === "failed").length,
    });
    const finished = group.filter((b) => FINISHED.has(b.state));
    if (finished.length > 0) {
      const ok = finished.filter((b) => !FAILED.has(b.state)).length;
      passRate.points.push({ timestamp, value: Math.round((ok / finished.length) * 1000) / 10 });
    }
    const durations = group
      .map((b) => secondsBetween(b.started_at, b.finished_at))
      .filter((d): d is number => d !== undefined);
    const a = percentile(durations, 50);
    const c = percentile(durations, 95);
    if (a !== undefined) p50.points.push({ timestamp, value: a });
    if (c !== undefined) p95.points.push({ timestamp, value: c });
    const waits = group
      .flatMap((b) => b.jobs ?? [])
      .filter((j) => j.type === "script")
      .map((j) => secondsBetween(j.runnable_at, j.started_at))
      .filter((d): d is number => d !== undefined);
    const w = percentile(waits, 95);
    if (w !== undefined) wait.points.push({ timestamp, value: w });
  }
  return [count, failed, passRate, p50, p95, wait].filter((s) => s.points.length > 0);
}

/** Builds created inside `range` at `path` (an org or pipeline builds listing). */
export async function buildMetrics(
  ctx: BkContext,
  path: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const endMs = Math.min(range.endMs, Date.now());
  const query: Query = {
    created_from: new Date(range.startMs).toISOString(),
    created_to: new Date(endMs).toISOString(),
    exclude_pipeline: true,
  };
  const builds = await bkPaged<BkBuild>(ctx, path, query, MAX_BUILD_PAGES);
  const bucketMs = endMs - range.startMs <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
  return buildSeries(builds, bucketMs);
}
