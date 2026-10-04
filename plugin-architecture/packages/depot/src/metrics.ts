/**
 * Metric series for Depot projects and GitHub Actions repositories.
 *
 * Projects are charted from their build history (`BuildService/ListBuilds`,
 * newest first): every build carries its duration, the time Depot's cache
 * saved, and how many of its steps were cached, which is everything a
 * per-day build-minutes and cache-hit-rate chart needs, at one request per
 * hundred builds instead of one per day.
 *
 * Repositories have no history endpoint of their own, so their charts ask
 * `UsageService/GetUsage` once per UTC day and plot that day's numbers for
 * the repository.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import {
  RPC,
  getUsage,
  listAllPages,
  mapLimit,
  type DepotTransport,
  type WireBuild,
} from "./api.js";
import { normalizeUsage } from "./cost-data.js";

const DAY_MS = 86_400_000;
/** One request per day for repository charts: a month at most. */
const MAX_USAGE_DAYS = 31;

export const DEPOT_METRICS_CAPABILITY = { defaultTimeRangeMs: 14 * DAY_MS };

function window(timeRange?: { startMs: number; endMs: number }): {
  startMs: number;
  endMs: number;
} {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - DEPOT_METRICS_CAPABILITY.defaultTimeRangeMs;
  return { startMs, endMs };
}

/** UTC day starts covering `[startMs, endMs)`. */
export function dayBuckets(startMs: number, endMs: number, max = Infinity): number[] {
  const days: number[] = [];
  for (let d = Math.floor(startMs / DAY_MS) * DAY_MS; d < endMs; d += DAY_MS) days.push(d);
  return days.slice(-max);
}

/** Builds for a project created at or after `sinceMs`, newest first. */
export async function listBuildsSince(
  transport: DepotTransport,
  projectId: string,
  sinceMs: number,
  maxPages = 10,
): Promise<WireBuild[]> {
  const builds = await listAllPages<WireBuild, { builds?: WireBuild[]; nextPageToken?: string }>(
    transport,
    RPC.listBuilds,
    { projectId },
    (r) => r.builds,
    {
      pageSize: 100,
      maxPages,
      // Newest first: once a page reaches past the window there is nothing older to want.
      stop: (page) => page.some((b) => Date.parse(b.createdAt ?? "") < sinceMs),
    },
  );
  return builds.filter((b) => Date.parse(b.createdAt ?? "") >= sinceMs);
}

export function buildSeries(builds: WireBuild[], days: number[]): MetricSeries[] {
  const index = new Map(days.map((d, i) => [d, i]));
  const zeros = () => days.map(() => 0);
  const count = zeros();
  const minutes = zeros();
  const saved = zeros();
  const failed = zeros();
  const cached = zeros();
  const steps = zeros();
  for (const b of builds) {
    const created = Date.parse(b.createdAt ?? "");
    if (!Number.isFinite(created)) continue;
    const i = index.get(Math.floor(created / DAY_MS) * DAY_MS);
    if (i === undefined) continue;
    count[i]! += 1;
    minutes[i]! += (b.buildDurationSeconds ?? 0) / 60;
    saved[i]! += (b.savedDurationSeconds ?? 0) / 60;
    cached[i]! += b.cachedSteps ?? 0;
    steps[i]! += b.totalSteps ?? 0;
    if (b.status === "STATUS_FAILED" || b.status === "STATUS_ERROR") failed[i]! += 1;
  }
  const series = (label: string, unit: string, values: number[]): MetricSeries => ({
    label,
    unit,
    points: days.map((timestamp, i) => ({ timestamp, value: Number(values[i]!.toFixed(2)) })),
  });
  // Hit rate is undefined on a day with no steps: leave a gap, not a 0%.
  const hitRate: MetricSeries = {
    label: "Cache hit rate",
    unit: "%",
    points: days.flatMap((timestamp, i) =>
      steps[i]! > 0
        ? [{ timestamp, value: Number(((cached[i]! / steps[i]!) * 100).toFixed(1)) }]
        : [],
    ),
  };
  return [
    series("Build minutes", "min", minutes),
    series("Builds", "builds", count),
    hitRate,
    series("Minutes saved by cache", "min", saved),
    series("Failed builds", "builds", failed),
  ];
}

export async function fetchProjectMetrics(
  transport: DepotTransport,
  projectId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const { startMs, endMs } = window(timeRange);
  const days = dayBuckets(startMs, endMs);
  if (days.length === 0) return [];
  const builds = await listBuildsSince(transport, projectId, days[0]!);
  return buildSeries(builds, days);
}

export async function fetchRepoMetrics(
  transport: DepotTransport,
  repo: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const { startMs, endMs } = window(timeRange);
  const days = dayBuckets(startMs, endMs, MAX_USAGE_DAYS);
  const totals = await mapLimit(days, 4, async (d) => {
    try {
      const usage = normalizeUsage(await getUsage(transport, d, d + DAY_MS));
      const rows = usage.actions.filter((a) => a.repo === repo);
      return {
        billed: rows.reduce((s, a) => s + a.billed, 0),
        elapsed: rows.reduce((s, a) => s + a.elapsed, 0),
        jobs: rows.reduce((s, a) => s + a.jobs, 0),
      };
    } catch {
      // One failed day leaves a gap rather than blanking the chart.
      return null;
    }
  });
  const series = (
    label: string,
    unit: string,
    key: "billed" | "elapsed" | "jobs",
  ): MetricSeries => ({
    label,
    unit,
    points: days.flatMap((timestamp, i) => {
      const t = totals[i];
      return t ? [{ timestamp, value: Number(t[key].toFixed(2)) }] : [];
    }),
  });
  return [
    series("Billed minutes", "min", "billed"),
    series("Elapsed minutes", "min", "elapsed"),
    series("Jobs", "jobs", "jobs"),
  ];
}
