/**
 * Metric series for the Metrics tab. GitLab has no time-series API for CI on
 * Free and Premium, so every series is bucketed here from the raw lists:
 *
 * - Project: pipelines started per day and their success rate
 *   (`GET /projects/:id/pipelines?created_after&created_before`), plus job
 *   duration and queue-time percentiles and failed jobs per day
 *   (`GET /projects/:id/jobs`, newest first, read until older than the
 *   window). Queue time is `queued_duration`: how long a job waited for a
 *   runner, the number that says "add capacity".
 * - Runner: jobs run, failed and their duration per day
 *   (`GET /runners/:id/jobs?order_by=id&sort=desc`).
 * - Environment: successful and failed deployments per day
 *   (`GET /projects/:id/deployments?environment&updated_after`).
 * - Group: compute minutes per month (GraphQL `ciMinutesUsage`, the same
 *   figures as the group's Usage Quotas page).
 *
 * Each walk is capped in pages so a busy project costs a bounded number of
 * requests; the cap is generous enough for a 30-day window on most projects
 * and the series simply starts later when it is reached.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { GitLabContext } from "./api.js";
import { glGraphql, glPaged, glRequest } from "./api.js";
import type { GlDeployment, GlJob, GlPipeline } from "./types.js";

export const DEFAULT_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_JOB_PAGES = 10;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(
  range: TimeRange | undefined,
  windowMs = DEFAULT_METRICS_WINDOW_MS,
): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

/** Hourly buckets for windows up to two days, daily otherwise. */
export function bucketSize(range: TimeRange): number {
  return range.endMs - range.startMs <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
}

const bucketOf = (ms: number, size: number) => Math.floor(ms / size) * size;

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function group<T>(
  items: T[],
  at: (t: T) => string | undefined | null,
  size: number,
  range: TimeRange,
) {
  const buckets = new Map<number, T[]>();
  for (const item of items) {
    const raw = at(item);
    const t = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(t) || t < range.startMs || t > range.endMs) continue;
    const b = bucketOf(t, size);
    const list = buckets.get(b);
    if (list) list.push(item);
    else buckets.set(b, [item]);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
}

const FAILED = new Set(["failed"]);
const FINISHED = new Set(["success", "failed"]);

/** Pipelines per bucket and the success rate of the ones that finished. */
export function pipelineSeries(pipelines: GlPipeline[], range: TimeRange): MetricSeries[] {
  const size = bucketSize(range);
  const runs: MetricSeries = { label: "Pipelines", unit: "pipelines", points: [] };
  const failed: MetricSeries = { label: "Failed pipelines", unit: "pipelines", points: [] };
  const success: MetricSeries = { label: "Pipeline success rate", unit: "%", points: [] };
  for (const [timestamp, items] of group(pipelines, (p) => p.created_at, size, range)) {
    runs.points.push({ timestamp, value: items.length });
    failed.points.push({ timestamp, value: items.filter((p) => FAILED.has(p.status)).length });
    const done = items.filter((p) => FINISHED.has(p.status));
    if (done.length > 0) {
      const ok = done.filter((p) => p.status === "success").length;
      success.points.push({ timestamp, value: Math.round((ok / done.length) * 1000) / 10 });
    }
  }
  return [runs, failed, success].filter((s) => s.points.length > 0);
}

/** Job duration and queue-time percentiles, plus failed jobs, per bucket. */
export function jobSeries(jobs: GlJob[], range: TimeRange, prefix = ""): MetricSeries[] {
  const size = bucketSize(range);
  const count: MetricSeries = { label: `${prefix}Jobs`, unit: "jobs", points: [] };
  const failed: MetricSeries = { label: `${prefix}Failed jobs`, unit: "jobs", points: [] };
  const p50: MetricSeries = { label: `${prefix}Job duration p50`, unit: "s", points: [] };
  const p95: MetricSeries = { label: `${prefix}Job duration p95`, unit: "s", points: [] };
  const q50: MetricSeries = { label: `${prefix}Queue time p50`, unit: "s", points: [] };
  const q95: MetricSeries = { label: `${prefix}Queue time p95`, unit: "s", points: [] };
  for (const [timestamp, items] of group(jobs, (j) => j.created_at, size, range)) {
    count.points.push({ timestamp, value: items.length });
    failed.points.push({
      timestamp,
      value: items.filter((j) => j.status === "failed" && !j.allow_failure).length,
    });
    const durations = items
      .map((j) => j.duration)
      .filter((d): d is number => typeof d === "number" && Number.isFinite(d));
    const queues = items
      .map((j) => j.queued_duration)
      .filter((d): d is number => typeof d === "number" && Number.isFinite(d));
    const a = percentile(durations, 50);
    const b = percentile(durations, 95);
    const c = percentile(queues, 50);
    const d = percentile(queues, 95);
    if (a !== undefined) p50.points.push({ timestamp, value: Math.round(a * 10) / 10 });
    if (b !== undefined) p95.points.push({ timestamp, value: Math.round(b * 10) / 10 });
    if (c !== undefined) q50.points.push({ timestamp, value: Math.round(c * 10) / 10 });
    if (d !== undefined) q95.points.push({ timestamp, value: Math.round(d * 10) / 10 });
  }
  return [count, failed, p50, p95, q50, q95].filter((s) => s.points.length > 0);
}

/** Successful and failed deployments per bucket. */
export function deploymentSeries(deployments: GlDeployment[], range: TimeRange): MetricSeries[] {
  const size = bucketSize(range);
  const ok: MetricSeries = { label: "Successful deployments", unit: "deployments", points: [] };
  const bad: MetricSeries = { label: "Failed deployments", unit: "deployments", points: [] };
  for (const [timestamp, items] of group(
    deployments,
    (d) => d.finished_at ?? d.created_at,
    size,
    range,
  )) {
    ok.points.push({ timestamp, value: items.filter((d) => d.status === "success").length });
    bad.points.push({ timestamp, value: items.filter((d) => d.status === "failed").length });
  }
  return [ok, bad].filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * Newest-first jobs until the oldest one predates the window. Offset pages
 * are used (keyset would need the `Link` header parsed), bounded by
 * `MAX_JOB_PAGES`.
 */
export async function jobsSince(
  ctx: GitLabContext,
  path: string,
  startMs: number,
  query: Record<string, string> = {},
): Promise<GlJob[]> {
  const out: GlJob[] = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page++) {
    const res = await glRequest(ctx, path, { query: { ...query, per_page: 100, page } });
    const batch = res.text ? (JSON.parse(res.text) as GlJob[]) : [];
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    const oldest = batch[batch.length - 1]?.created_at;
    if (oldest && Date.parse(oldest) < startMs) break;
    if (res.headers["x-next-page"] === "" || batch.length < 100) break;
  }
  return out;
}

export async function projectSeries(
  ctx: GitLabContext,
  projectId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const [pipelines, jobs] = await Promise.all([
    glPaged<GlPipeline>(
      ctx,
      `/projects/${projectId}/pipelines`,
      {
        created_after: new Date(range.startMs).toISOString(),
        created_before: new Date(range.endMs).toISOString(),
      },
      MAX_JOB_PAGES,
    ),
    jobsSince(ctx, `/projects/${projectId}/jobs`, range.startMs).catch(() => [] as GlJob[]),
  ]);
  return [...pipelineSeries(pipelines, range), ...jobSeries(jobs, range)];
}

export async function runnerSeries(
  ctx: GitLabContext,
  runnerId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const jobs = await jobsSince(ctx, `/runners/${runnerId}/jobs`, range.startMs, {
    order_by: "id",
    sort: "desc",
  });
  return jobSeries(jobs, range);
}

export async function environmentSeries(
  ctx: GitLabContext,
  projectId: string,
  environment: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const deployments = await glPaged<GlDeployment>(
    ctx,
    `/projects/${projectId}/deployments`,
    {
      environment,
      updated_after: new Date(range.startMs).toISOString(),
      updated_before: new Date(range.endMs).toISOString(),
      order_by: "updated_at",
      sort: "desc",
    },
    MAX_JOB_PAGES,
  );
  return deploymentSeries(deployments, range);
}

interface MinutesUsage {
  ciMinutesUsage?: {
    nodes?: Array<{ monthIso8601?: string; minutes?: number; sharedRunnersDuration?: number }>;
  };
}

/** Compute minutes per month, from GitLab's own usage records. */
export function computeMinutesSeries(
  nodes: NonNullable<MinutesUsage["ciMinutesUsage"]>["nodes"],
  range: TimeRange,
): MetricSeries[] {
  const minutes: MetricSeries = { label: "Compute minutes", unit: "min", points: [] };
  const shared: MetricSeries = { label: "Instance runner time", unit: "min", points: [] };
  for (const n of nodes ?? []) {
    const t = n.monthIso8601 ? Date.parse(n.monthIso8601) : NaN;
    if (!Number.isFinite(t)) continue;
    // A month counts when any part of it falls inside the window.
    if (t > range.endMs || t + 31 * DAY_MS < range.startMs) continue;
    if (typeof n.minutes === "number") minutes.points.push({ timestamp: t, value: n.minutes });
    if (typeof n.sharedRunnersDuration === "number") {
      shared.points.push({ timestamp: t, value: Math.round(n.sharedRunnersDuration / 60) });
    }
  }
  for (const s of [minutes, shared]) s.points.sort((a, b) => a.timestamp - b.timestamp);
  return [minutes, shared].filter((s) => s.points.length > 0);
}

export async function groupSeries(
  ctx: GitLabContext,
  groupId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const res = await glGraphql<MinutesUsage>(
    ctx,
    `query($ns: NamespaceID) { ciMinutesUsage(namespaceId: $ns, first: 24) { nodes { monthIso8601 minutes sharedRunnersDuration } } }`,
    { ns: `gid://gitlab/Group/${groupId}` },
  );
  return computeMinutesSeries(res.data?.ciMinutesUsage?.nodes, range);
}
