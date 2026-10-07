/**
 * Metric series, folded from runs: the API has no metrics endpoint. Runs are
 * listed newest first, so paging stops at the first page that reaches back
 * past the window start, and at {@link MAX_RUN_PAGES} pages of 100.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { Doc, TfContext } from "./api.js";
import { tfRaw } from "./api.js";
import { RUN_FINAL, runDuration, s } from "./mappers.js";

export const DEFAULT_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const MAX_RUN_PAGES = 5;

type A = Record<string, unknown>;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

/** Fold runs (and their included plans) into per-bucket series. */
export function runSeries(runs: Doc<A>[], plans: Map<string, A>, bucketMs: number): MetricSeries[] {
  const buckets = new Map<number, Doc<A>[]>();
  for (const r of runs) {
    const t = Date.parse(s(r.attributes["created-at"]));
    if (!Number.isFinite(t)) continue;
    const key = Math.floor(t / bucketMs) * bucketMs;
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  const mk = (label: string, unit: string): MetricSeries => ({ label, unit, points: [] });
  const count = mk("Runs", "runs");
  const errored = mk("Errored runs", "runs");
  const applied = mk("Applied runs", "runs");
  const p50 = mk("Run duration p50", "s");
  const p95 = mk("Run duration p95", "s");
  const added = mk("Resources added", "resources");
  const changed = mk("Resources changed", "resources");
  const destroyed = mk("Resources destroyed", "resources");
  for (const timestamp of [...buckets.keys()].sort((a, b) => a - b)) {
    const group = buckets.get(timestamp) ?? [];
    count.points.push({ timestamp, value: group.length });
    errored.points.push({
      timestamp,
      value: group.filter((r) => r.attributes["status"] === "errored").length,
    });
    const appliedRuns = group.filter((r) => r.attributes["status"] === "applied");
    applied.points.push({ timestamp, value: appliedRuns.length });
    const durations = group
      .filter((r) => RUN_FINAL.has(s(r.attributes["status"])))
      .map((r) => runDuration(r.attributes))
      .filter((d): d is number => d !== undefined);
    const a = percentile(durations, 50);
    const c = percentile(durations, 95);
    if (a !== undefined) p50.points.push({ timestamp, value: a });
    if (c !== undefined) p95.points.push({ timestamp, value: c });
    let add = 0;
    let chg = 0;
    let del = 0;
    let seen = false;
    for (const r of appliedRuns) {
      const planId = (r.relationships?.["plan"]?.data as { id?: string } | null | undefined)?.id;
      const p = planId ? plans.get(planId) : undefined;
      if (!p) continue;
      seen = true;
      add += Number(p["resource-additions"] ?? 0);
      chg += Number(p["resource-changes"] ?? 0);
      del += Number(p["resource-destructions"] ?? 0);
    }
    if (seen) {
      added.points.push({ timestamp, value: add });
      changed.points.push({ timestamp, value: chg });
      destroyed.points.push({ timestamp, value: del });
    }
  }
  return [count, errored, applied, p50, p95, added, changed, destroyed].filter(
    (x) => x.points.length > 0,
  );
}

/** Runs created inside `range` at `path`, with their plans. */
export async function runMetrics(
  ctx: TfContext,
  path: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const runs: Doc<A>[] = [];
  const plans = new Map<string, A>();
  for (let page = 1; page <= MAX_RUN_PAGES; page++) {
    const res = JSON.parse(
      await tfRaw(ctx, path, {
        query: { include: "plan", "page[size]": 100, "page[number]": page },
      }),
    ) as {
      data?: Doc<A>[];
      included?: Doc<A>[];
      meta?: { pagination?: { "next-page"?: number | null } };
    };
    for (const inc of res.included ?? [])
      if (inc.type === "plans") plans.set(inc.id, inc.attributes);
    let older = false;
    for (const r of res.data ?? []) {
      const t = Date.parse(s(r.attributes["created-at"]));
      if (t < range.startMs) {
        older = true;
        continue;
      }
      if (t <= range.endMs) runs.push(r);
    }
    if (older || !res.meta?.pagination?.["next-page"]) break;
  }
  const bucketMs = range.endMs - range.startMs <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
  return runSeries(runs, plans, bucketMs);
}
