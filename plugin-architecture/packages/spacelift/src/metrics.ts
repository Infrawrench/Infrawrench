/**
 * Stack metrics, folded from the stack's runs (`stack { runs(before:) }`,
 * newest first, paged by passing the last run id as `before`). The API has
 * no metrics query for stacks.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { SlRun } from "./mappers.js";

export const DEFAULT_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function rangeOrDefault(
  range: { startMs: number; endMs: number } | undefined,
  windowMs: number,
) {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

export function runSeries(runs: SlRun[], startMs: number, endMs: number): MetricSeries[] {
  const buckets = new Map<number, SlRun[]>();
  for (const r of runs) {
    const t = (r.createdAt ?? 0) * 1000;
    if (t < startMs || t > endMs) continue;
    const k = Math.floor(t / DAY_MS) * DAY_MS;
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  const mk = (label: string, unit: string): MetricSeries => ({ label, unit, points: [] });
  const count = mk("Runs", "runs");
  const failed = mk("Failed runs", "runs");
  const tracked = mk("Tracked runs", "runs");
  const drift = mk("Drift detection runs", "runs");
  const add = mk("Resources to add", "resources");
  const change = mk("Resources to change", "resources");
  const del = mk("Resources to delete", "resources");
  for (const timestamp of [...buckets.keys()].sort((a, b) => a - b)) {
    const g = buckets.get(timestamp) ?? [];
    count.points.push({ timestamp, value: g.length });
    failed.points.push({ timestamp, value: g.filter((r) => r.state === "FAILED").length });
    tracked.points.push({ timestamp, value: g.filter((r) => r.type === "TRACKED").length });
    drift.points.push({ timestamp, value: g.filter((r) => r.driftDetection).length });
    add.points.push({ timestamp, value: g.reduce((s, r) => s + (r.delta?.addCount ?? 0), 0) });
    change.points.push({
      timestamp,
      value: g.reduce((s, r) => s + (r.delta?.changeCount ?? 0), 0),
    });
    del.points.push({ timestamp, value: g.reduce((s, r) => s + (r.delta?.deleteCount ?? 0), 0) });
  }
  return [count, failed, tracked, drift, add, change, del].filter((s) => s.points.length > 0);
}
