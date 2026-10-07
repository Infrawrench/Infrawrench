/**
 * Stack metrics, folded from the stack's update history
 * (`GET /api/stacks/{org}/{project}/{stack}/updates`, newest first); the
 * organization's come from the usage summaries in `usage.ts`.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { PuUpdate } from "./mappers.js";

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

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function updateSeries(updates: PuUpdate[], startMs: number, endMs: number): MetricSeries[] {
  const buckets = new Map<number, PuUpdate[]>();
  for (const u of updates) {
    const t = (u.startTime ?? 0) * 1000;
    if (t < startMs || t > endMs) continue;
    const k = Math.floor(t / DAY_MS) * DAY_MS;
    buckets.set(k, [...(buckets.get(k) ?? []), u]);
  }
  const mk = (label: string, unit: string): MetricSeries => ({ label, unit, points: [] });
  const count = mk("Updates", "updates");
  const failed = mk("Failed updates", "updates");
  const created = mk("Resources created", "resources");
  const updated = mk("Resources updated", "resources");
  const deleted = mk("Resources deleted", "resources");
  const p50 = mk("Update duration p50", "s");
  const resources = mk("Resources", "resources");
  for (const timestamp of [...buckets.keys()].sort((a, b) => a - b)) {
    const g = buckets.get(timestamp) ?? [];
    count.points.push({ timestamp, value: g.length });
    failed.points.push({ timestamp, value: g.filter((u) => u.result === "failed").length });
    const sum = (k: string) => g.reduce((s, u) => s + (u.resourceChanges?.[k] ?? 0), 0);
    created.points.push({ timestamp, value: sum("create") });
    updated.points.push({ timestamp, value: sum("update") });
    deleted.points.push({ timestamp, value: sum("delete") });
    const d = percentile(
      g.filter((u) => u.startTime && u.endTime).map((u) => (u.endTime ?? 0) - (u.startTime ?? 0)),
      50,
    );
    if (d !== undefined) p50.points.push({ timestamp, value: d });
    const last = [...g]
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
      .find((u) => typeof u.resourceCount === "number");
    if (last) resources.points.push({ timestamp, value: last.resourceCount ?? 0 });
  }
  return [count, failed, created, updated, deleted, p50, resources].filter(
    (s) => s.points.length > 0,
  );
}
