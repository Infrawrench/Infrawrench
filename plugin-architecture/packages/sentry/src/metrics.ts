/**
 * Metric series for the Metrics tab.
 *
 * - Organization and project volumes come from `stats_v2` (accepted, filtered
 *   and rate-limited quantity per category), hourly for windows up to a week
 *   and daily beyond, within the endpoint's 90-day reach.
 * - An issue's event counts come from the `stats` buckets on the issue itself.
 * - Cron monitors chart their check-ins (duration, and failures as 1s).
 * - Uptime monitors chart `uptime-stats` buckets (successes and failures).
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import { pathEncode } from "@infrawrench/plugin-base";
import type { SentryContext } from "./api.js";
import { sentryApi } from "./api.js";
import type { StatsResponse } from "./cost-data.js";
import { MAX_STATS_DAYS, fetchStats } from "./cost-data.js";
import { usageCategoryOf } from "./rates.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const USAGE_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECKIN_PAGES = 10;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

/** Clamp to stats_v2's reach and pick an interval it accepts. */
export function statsWindow(range: TimeRange, nowMs = Date.now()) {
  const floor = nowMs - (MAX_STATS_DAYS - 1) * DAY_MS;
  const startMs = Math.max(range.startMs, floor);
  const endMs = Math.max(startMs + 60_000, Math.min(range.endMs, nowMs));
  const interval = endMs - startMs <= WEEK_MS ? "1h" : "1d";
  return {
    start: new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    end: new Date(endMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    interval,
  };
}

const OUTCOME_LABELS: Record<string, string> = {
  accepted: "accepted",
  filtered: "filtered",
  rate_limited: "rate limited",
};

/**
 * Series out of a `groupBy=[category, outcome]` response: one per priced
 * category and outcome (accepted, filtered, rate limited), in priced units.
 */
export function seriesFromStats(res: StatsResponse, categories?: string[]): MetricSeries[] {
  const intervals = res.intervals ?? [];
  const out = new Map<string, MetricSeries & { points: MetricSeriesPoint[] }>();
  for (const g of res.groups ?? []) {
    const cat = usageCategoryOf(String(g.by["category"] ?? ""));
    if (!cat || (categories && !categories.includes(cat.key))) continue;
    const outcome = OUTCOME_LABELS[String(g.by["outcome"] ?? "accepted")];
    if (!outcome) continue;
    const label = `${cat.service} ${outcome}`;
    let series = out.get(label);
    if (!series) {
      series = {
        label,
        unit: cat.unit.toLowerCase(),
        points: intervals.map((at) => ({ timestamp: Date.parse(at), value: 0 })),
      };
      out.set(label, series);
    }
    const { points } = series;
    (g.series?.["sum(quantity)"] ?? []).forEach((v, i) => {
      if (points[i])
        points[i] = { timestamp: points[i]!.timestamp, value: points[i]!.value + v / cat.divisor };
    });
  }
  return [...out.values()].filter((s) => s.points.some((p) => p.value > 0));
}

export async function organizationSeries(
  ctx: SentryContext,
  org: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const w = statsWindow(range);
  const res = await fetchStats(ctx, org, {
    groupBy: ["category", "outcome"],
    outcome: ["accepted", "filtered", "rate_limited"],
    ...w,
  });
  return seriesFromStats(res);
}

export async function projectSeries(
  ctx: SentryContext,
  org: string,
  projectId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const w = statsWindow(range);
  const res = await fetchStats(ctx, org, {
    groupBy: ["category", "outcome"],
    outcome: ["accepted", "filtered", "rate_limited"],
    project: [projectId],
    ...w,
  });
  return seriesFromStats(res, ["errors", "spans", "transactions", "replays"]);
}

export async function issueSeries(
  ctx: SentryContext,
  org: string,
  issueId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const issue = await sentryApi(ctx).get(
    `/organizations/${pathEncode(org)}/issues/${pathEncode(issueId)}/`,
  );
  const long = range.endMs - range.startMs > 2 * DAY_MS;
  const buckets = issue?.stats?.[long ? "30d" : "24h"] ?? issue?.stats?.["24h"] ?? [];
  const points = buckets
    .map(([ts, count]) => ({ timestamp: ts * 1000, value: count }))
    .filter((p) => p.timestamp >= range.startMs - DAY_MS && p.timestamp <= range.endMs);
  return points.length > 0 ? [{ label: "Events", unit: "events", points }] : [];
}

export async function cronSeries(
  ctx: SentryContext,
  org: string,
  slug: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  // Ten pages are charted. When the tenth has a next link an eleventh is asked
  // for and dropped, which is what this walk has always put on the wire.
  let pages = 0;
  let charted = 0;
  const rows = await sentryApi(ctx).getAll(
    `/organizations/${pathEncode(org)}/monitors/${pathEncode(slug)}/checkins/`,
    null,
    {
      maxPages: CHECKIN_PAGES + 1,
      stopWhen: (batch) => {
        pages += 1;
        if (pages <= CHECKIN_PAGES) charted += batch.length;
        const oldest = batch[batch.length - 1]?.dateCreated;
        return !!oldest && Date.parse(oldest) < range.startMs;
      },
    },
  );
  const inRange = rows
    .slice(0, charted)
    .filter((c) => c.dateCreated && Date.parse(c.dateCreated) >= range.startMs)
    .filter((c) => Date.parse(c.dateCreated!) <= range.endMs)
    .sort((a, b) => Date.parse(a.dateCreated!) - Date.parse(b.dateCreated!));
  const duration: MetricSeriesPoint[] = [];
  const failures: MetricSeriesPoint[] = [];
  for (const c of inRange) {
    const timestamp = Date.parse(c.dateCreated!);
    if (typeof c.duration === "number") duration.push({ timestamp, value: c.duration / 1000 });
    if (c.status && c.status !== "in_progress") {
      const failed = c.status === "error" || c.status === "missed" || c.status === "timeout";
      failures.push({ timestamp, value: failed ? 1 : 0 });
    }
  }
  const out: MetricSeries[] = [];
  if (duration.length > 0) out.push({ label: "Run duration", unit: "s", points: duration });
  if (failures.length > 0) out.push({ label: "Failed check-ins", unit: "count", points: failures });
  return out;
}

export async function uptimeSeries(
  ctx: SentryContext,
  org: string,
  detectorId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const span = range.endMs - range.startMs;
  const resolution = span <= DAY_MS ? "15m" : span <= WEEK_MS ? "1h" : "1d";
  const res = await sentryApi(ctx).get(`/organizations/${pathEncode(org)}/uptime-stats/`, {
    query: {
      uptimeDetectorId: detectorId,
      since: Math.floor(range.startMs / 1000),
      until: Math.floor(range.endMs / 1000),
      resolution,
    },
  });
  const buckets = res?.[detectorId] ?? Object.values(res ?? {})[0] ?? [];
  const success: MetricSeriesPoint[] = [];
  const failure: MetricSeriesPoint[] = [];
  for (const [ts, counts] of buckets) {
    const timestamp = ts * 1000;
    success.push({ timestamp, value: counts["success"] ?? 0 });
    failure.push({
      timestamp,
      value: (counts["failure"] ?? 0) + (counts["failure_incident"] ?? 0),
    });
  }
  if (success.length === 0) return [];
  return [
    { label: "Successful checks", unit: "count", points: success },
    { label: "Failed checks", unit: "count", points: failure },
  ];
}
