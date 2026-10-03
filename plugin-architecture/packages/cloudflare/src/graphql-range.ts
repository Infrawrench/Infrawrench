/**
 * Cloudflare's GraphQL Analytics API refuses a query whose time range is wider
 * than the dataset's retention ("cannot request a time range wider than
 * 4w4d"), and the metric fetchers treat any error as "no data", so a 90-day
 * chart used to come back empty. Clamp the start instead: the chart then shows
 * the most recent window the dataset can answer for.
 *
 * Limits measured against the live API on 2026-10-03: the adaptive datasets
 * allow 4w4d (32 days, the 31-day retention plus slack) and Turnstile 1w1h.
 * Zones are left alone (they read the aggregated `httpRequests1h/1mGroups`,
 * whose limits follow the zone's plan), and Analytics Engine datasets use the
 * SQL API, which keeps three months.
 */
const DAY_MS = 24 * 3_600_000;

const MAX_RANGE_MS: Record<string, number> = {
  "turnstile-widget": 7 * DAY_MS,
};
const DEFAULT_MAX_RANGE_MS = 31 * DAY_MS;
const UNCLAMPED = new Set(["zone", "analytics-engine-dataset"]);

export function clampGraphqlRange(
  resourceTypeId: string,
  timeRange: { startMs: number; endMs: number } | undefined,
): { startMs: number; endMs: number } | undefined {
  if (!timeRange || UNCLAMPED.has(resourceTypeId)) return timeRange;
  const max = MAX_RANGE_MS[resourceTypeId] ?? DEFAULT_MAX_RANGE_MS;
  if (timeRange.endMs - timeRange.startMs <= max) return timeRange;
  return { startMs: timeRange.endMs - max, endMs: timeRange.endMs };
}

const UNIT_MS: Record<string, number> = {
  w: 7 * DAY_MS,
  d: DAY_MS,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
};

/**
 * The widest range a GraphQL error says the dataset allows, in ms, or
 * undefined when the error is something else. Cloudflare words it as
 * `cannot request a time range wider than 3d` (or `1w1h`, `4w4d`); the limit
 * follows the zone's plan for aggregated datasets, so it can't be known up
 * front.
 */
export function rangeLimitFromError(message: string): number | undefined {
  const m = /cannot request a time range wider than ((?:\d+[wdhms])+)/.exec(message);
  if (!m) return undefined;
  let total = 0;
  for (const [, n, unit] of m[1]!.matchAll(/(\d+)([wdhms])/g)) {
    total += Number(n) * UNIT_MS[unit!]!;
  }
  return total > 0 ? total : undefined;
}
