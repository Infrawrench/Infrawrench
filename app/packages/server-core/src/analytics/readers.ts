import type { DashboardStat, MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { getAnalyticsDb } from "./client";
import {
  accountResourceCounts,
  dashboardStats,
  metricPoints1h,
  metricPoints1m,
  metricPointsRaw,
} from "./schema";

export interface ResourceCount {
  typeLabel: string;
  count: number;
}

/*
 * Every read here throws when the query fails rather than answering empty: an
 * outage must fail the caller's request loudly, never render as "this resource
 * has no data".
 */

/** Milliseconds since the epoch of a `timestamptz` expression, as a number. */
export function epochMillis(expr: unknown): SQL<number> {
  return sql<number>`(extract(epoch from ${expr}) * 1000)::float8`.mapWith(Number);
}

/**
 * A rollup row's average. Rollups store a running sum and count (see
 * `writers.ts`), so a bucket's mean is their ratio. A row always has a count of
 * at least one; the `nullif` only keeps a hand-edited zero from dividing.
 */
export function rollupAverage(table: typeof metricPoints1m | typeof metricPoints1h): SQL<number> {
  return sql<number>`(${table.value_sum} / nullif(${table.value_count}, 0))`.mapWith(Number);
}

/** The ISO instant of a millisecond bound, floored to the second. */
function isoSecond(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/**
 * `>= from AND <= to` over a rollup bucket column, from millisecond bounds
 * floored to the second, as the rollup readers have always compared them.
 */
export function withinSeconds(
  column: typeof metricPoints1m.ts_minute | typeof metricPoints1h.ts_hour,
  fromMs: number,
  toMs: number,
): SQL {
  return and(gte(column, isoSecond(fromMs)), lte(column, isoSecond(toMs)))!;
}

/** Latest DashboardStat[] snapshot for one resource. Null if none. */
export async function getLatestStats(
  organizationId: string,
  resourceId: string,
): Promise<DashboardStat[] | null> {
  const rows = await getAnalyticsDb()
    .select({ stats_json: dashboardStats.stats_json })
    .from(dashboardStats)
    .where(
      and(
        eq(dashboardStats.organization_id, organizationId),
        eq(dashboardStats.resource_id, resourceId),
      ),
    )
    .orderBy(desc(dashboardStats.ts))
    .limit(1);
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0]!.stats_json) as DashboardStat[];
  } catch {
    return null;
  }
}

/**
 * Latest MetricSeries[] for one resource: most recent ~60min of raw points,
 * grouped back into per-series shape so the dashboard sparkline logic works
 * unchanged.
 */
export async function getLatestMetrics(
  organizationId: string,
  resourceId: string,
): Promise<MetricSeries[] | null> {
  const rows = await getAnalyticsDb()
    .select({
      series_label: metricPointsRaw.series_label,
      unit: metricPointsRaw.unit,
      ts_ms: epochMillis(metricPointsRaw.ts).as("ts_ms"),
      value: metricPointsRaw.value,
    })
    .from(metricPointsRaw)
    .where(
      and(
        eq(metricPointsRaw.organization_id, organizationId),
        eq(metricPointsRaw.resource_id, resourceId),
        sql`${metricPointsRaw.ts} > now() - interval '1 hour'`,
      ),
    )
    .orderBy(asc(metricPointsRaw.ts));
  if (rows.length === 0) return null;
  const bySeries = new Map<string, MetricSeries>();
  for (const r of rows) {
    let s = bySeries.get(r.series_label);
    if (!s) {
      s = { label: r.series_label, points: [] };
      if (r.unit) s.unit = r.unit;
      bySeries.set(r.series_label, s);
    }
    s.points.push({ timestamp: Number(r.ts_ms), value: r.value });
  }
  return [...bySeries.values()];
}

/** Batch variant: returns Map keyed by resourceId. */
export async function getLatestMetricsBatch(
  organizationId: string,
  resourceIds: string[],
): Promise<Map<string, MetricSeries[]>> {
  const result = new Map<string, MetricSeries[]>();
  if (resourceIds.length === 0) return result;
  const rows = await getAnalyticsDb()
    .select({
      resource_id: metricPointsRaw.resource_id,
      series_label: metricPointsRaw.series_label,
      unit: metricPointsRaw.unit,
      ts_ms: epochMillis(metricPointsRaw.ts).as("ts_ms"),
      value: metricPointsRaw.value,
    })
    .from(metricPointsRaw)
    .where(
      and(
        eq(metricPointsRaw.organization_id, organizationId),
        inArray(metricPointsRaw.resource_id, resourceIds),
        sql`${metricPointsRaw.ts} > now() - interval '1 hour'`,
      ),
    )
    .orderBy(asc(metricPointsRaw.ts));
  for (const r of rows) {
    let list = result.get(r.resource_id);
    if (!list) {
      list = [];
      result.set(r.resource_id, list);
    }
    let s = list.find((x) => x.label === r.series_label);
    if (!s) {
      s = { label: r.series_label, points: [] };
      if (r.unit) s.unit = r.unit;
      list.push(s);
    }
    s.points.push({ timestamp: Number(r.ts_ms), value: r.value });
  }
  return result;
}

/** Batch variant of getLatestStats: the newest snapshot per resource. */
export async function getLatestStatsBatch(
  organizationId: string,
  resourceIds: string[],
): Promise<Map<string, DashboardStat[]>> {
  const result = new Map<string, DashboardStat[]>();
  if (resourceIds.length === 0) return result;
  const rows = await getAnalyticsDb()
    .selectDistinctOn([dashboardStats.resource_id], {
      resource_id: dashboardStats.resource_id,
      stats_json: dashboardStats.stats_json,
    })
    .from(dashboardStats)
    .where(
      and(
        eq(dashboardStats.organization_id, organizationId),
        inArray(dashboardStats.resource_id, resourceIds),
      ),
    )
    .orderBy(asc(dashboardStats.resource_id), desc(dashboardStats.ts));
  for (const r of rows) {
    try {
      result.set(r.resource_id, JSON.parse(r.stats_json) as DashboardStat[]);
    } catch {
      // skip malformed
    }
  }
  return result;
}

/** Latest resource-count snapshot for one account. */
export async function getLatestAccountCounts(
  organizationId: string,
  accountId: string,
): Promise<ResourceCount[] | null> {
  const rows = await getAnalyticsDb()
    .select({ counts_json: accountResourceCounts.counts_json })
    .from(accountResourceCounts)
    .where(
      and(
        eq(accountResourceCounts.organization_id, organizationId),
        eq(accountResourceCounts.account_id, accountId),
      ),
    )
    .orderBy(desc(accountResourceCounts.ts))
    .limit(1);
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0]!.counts_json) as ResourceCount[];
  } catch {
    return null;
  }
}

/** Batch variant of getLatestAccountCounts: the newest snapshot per account. */
export async function getLatestAccountCountsBatch(
  organizationId: string,
  accountIds: string[],
): Promise<Map<string, ResourceCount[]>> {
  const result = new Map<string, ResourceCount[]>();
  if (accountIds.length === 0) return result;
  const rows = await getAnalyticsDb()
    .selectDistinctOn([accountResourceCounts.account_id], {
      account_id: accountResourceCounts.account_id,
      counts_json: accountResourceCounts.counts_json,
    })
    .from(accountResourceCounts)
    .where(
      and(
        eq(accountResourceCounts.organization_id, organizationId),
        inArray(accountResourceCounts.account_id, accountIds),
      ),
    )
    .orderBy(asc(accountResourceCounts.account_id), desc(accountResourceCounts.ts));
  for (const r of rows) {
    try {
      result.set(r.account_id, JSON.parse(r.counts_json) as ResourceCount[]);
    } catch {
      // skip malformed
    }
  }
  return result;
}

/** Per-series quantiles over a window: the right-sizing utilisation read. */
export interface MetricSeriesQuantiles {
  label: string;
  unit: string;
  /** 5th / 95th percentile of the per-minute averages inside the window. */
  q05: number;
  q95: number;
  max: number;
  /** Number of per-minute samples backing the quantiles. */
  samples: number;
}

/**
 * Batch p05/p95/max per series over the 1m rollup for many resources at once.
 *
 * Reads `metric_points_1m` (30 days of retention; callers must stay inside it;
 * the right-sizing window is 14 days) rather than the 1h rollup: a p95 of
 * hourly averages flattens the very peaks the recommendation must respect.
 * A rollup row is one series' minute, so the quantiles are taken over the
 * per-minute averages directly. Series identity is (resource, label): a series
 * whose unit string changed mid-window still combines into one row, with a
 * representative unit.
 */
export async function getMetricQuantilesBatch(
  organizationId: string,
  resourceIds: string[],
  fromMs: number,
  toMs: number,
): Promise<Map<string, MetricSeriesQuantiles[]>> {
  const result = new Map<string, MetricSeriesQuantiles[]>();
  if (resourceIds.length === 0) return result;
  const minuteAvg = rollupAverage(metricPoints1m);
  const rows = await getAnalyticsDb()
    .select({
      resource_id: metricPoints1m.resource_id,
      series_label: metricPoints1m.series_label,
      unit: sql<string>`min(${metricPoints1m.unit})`.as("unit"),
      q05: sql<number>`percentile_cont(0.05) WITHIN GROUP (ORDER BY ${minuteAvg})`
        .mapWith(Number)
        .as("q05"),
      q95: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${minuteAvg})`
        .mapWith(Number)
        .as("q95"),
      vmax: sql<number>`max(${minuteAvg})`.mapWith(Number).as("vmax"),
      samples: sql<number>`count(*)::int`.mapWith(Number).as("samples"),
    })
    .from(metricPoints1m)
    .where(
      and(
        eq(metricPoints1m.organization_id, organizationId),
        inArray(metricPoints1m.resource_id, resourceIds),
        withinSeconds(metricPoints1m.ts_minute, fromMs, toMs),
      ),
    )
    .groupBy(metricPoints1m.resource_id, metricPoints1m.series_label);
  for (const r of rows) {
    let list = result.get(r.resource_id);
    if (!list) {
      list = [];
      result.set(r.resource_id, list);
    }
    list.push({
      label: r.series_label,
      unit: r.unit,
      q05: Number(r.q05),
      q95: Number(r.q95),
      max: Number(r.vmax),
      samples: Number(r.samples),
    });
  }
  return result;
}

/**
 * A metric series that actually exists for the org (optionally narrowed to a
 * plugin / resource type), for the metric-alert rule builder's key picker:
 * the user picks from what their resources really report instead of having to
 * know internal series labels.
 *
 * Reads the raw table (the only one carrying plugin/type columns) over its
 * full 7-day retention, so a metric only stops being offered a week after the
 * last resource stopped reporting it.
 */
export interface MetricSeriesKey {
  label: string;
  unit: string;
  /** How many distinct resources reported this series in the window. */
  resourceCount: number;
}

export async function listMetricSeriesKeys(
  organizationId: string,
  filter: { pluginId?: string | undefined; resourceTypeId?: string | undefined } = {},
): Promise<MetricSeriesKey[]> {
  const rows = await getAnalyticsDb()
    .select({
      series_label: metricPointsRaw.series_label,
      unit: sql<string>`min(${metricPointsRaw.unit})`.as("unit"),
      resource_count: sql<number>`count(DISTINCT ${metricPointsRaw.resource_id})::int`
        .mapWith(Number)
        .as("resource_count"),
    })
    .from(metricPointsRaw)
    .where(
      and(
        eq(metricPointsRaw.organization_id, organizationId),
        sql`${metricPointsRaw.ts} > now() - interval '7 days'`,
        ...(filter.pluginId ? [eq(metricPointsRaw.plugin_id, filter.pluginId)] : []),
        ...(filter.resourceTypeId
          ? [eq(metricPointsRaw.resource_type_id, filter.resourceTypeId)]
          : []),
      ),
    )
    .groupBy(metricPointsRaw.series_label)
    .orderBy(asc(metricPointsRaw.series_label));
  return rows.map((r) => ({
    label: r.series_label,
    unit: r.unit,
    resourceCount: Number(r.resource_count),
  }));
}

/** One per-minute averaged sample, as the metric-alert evaluator consumes it. */
export interface MetricMinuteSample {
  tsMs: number;
  value: number;
}

/**
 * Per-minute averages of one series for many resources over a window: the
 * metric-alert evaluator's read. Uses the 1m rollup (30 days of retention)
 * rather than raw points so the "held for the whole window" judgement runs
 * over evenly bucketed samples regardless of how bursty the plugin's
 * reporting is.
 */
export async function getMetricMinuteSeriesBatch(
  organizationId: string,
  resourceIds: string[],
  seriesLabel: string,
  fromMs: number,
  toMs: number,
): Promise<Map<string, MetricMinuteSample[]>> {
  const result = new Map<string, MetricMinuteSample[]>();
  if (resourceIds.length === 0) return result;
  const rows = await getAnalyticsDb()
    .select({
      resource_id: metricPoints1m.resource_id,
      ts_ms: epochMillis(metricPoints1m.ts_minute).as("ts_ms"),
      value: rollupAverage(metricPoints1m).as("value"),
    })
    .from(metricPoints1m)
    .where(
      and(
        eq(metricPoints1m.organization_id, organizationId),
        inArray(metricPoints1m.resource_id, resourceIds),
        eq(metricPoints1m.series_label, seriesLabel),
        withinSeconds(metricPoints1m.ts_minute, fromMs, toMs),
      ),
    )
    .orderBy(asc(metricPoints1m.ts_minute));
  for (const r of rows) {
    let list = result.get(r.resource_id);
    if (!list) {
      list = [];
      result.set(r.resource_id, list);
    }
    list.push({ tsMs: Number(r.ts_ms), value: Number(r.value) });
  }
  return result;
}

/**
 * Average of one series per resource over a window, from the 1m rollup: the
 * probe list's uptime read (averaging the 0/1 "Up" series over 24h yields the
 * up fraction). It averages the per-minute averages, so bursty raw reporting
 * can't weight some minutes more than others.
 */
export async function getMetricSeriesAverageBatch(
  organizationId: string,
  resourceIds: string[],
  seriesLabel: string,
  fromMs: number,
  toMs: number,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (resourceIds.length === 0) return result;
  const rows = await getAnalyticsDb()
    .select({
      resource_id: metricPoints1m.resource_id,
      value: sql<number>`avg(${rollupAverage(metricPoints1m)})`.mapWith(Number).as("value"),
    })
    .from(metricPoints1m)
    .where(
      and(
        eq(metricPoints1m.organization_id, organizationId),
        inArray(metricPoints1m.resource_id, resourceIds),
        eq(metricPoints1m.series_label, seriesLabel),
        withinSeconds(metricPoints1m.ts_minute, fromMs, toMs),
      ),
    )
    .groupBy(metricPoints1m.resource_id);
  for (const r of rows) result.set(r.resource_id, Number(r.value));
  return result;
}

/** One UTC day's average of a series for one resource. */
export interface MetricDailyAverage {
  resourceId: string;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  value: number;
}

/**
 * Daily averages of one series per resource, from the 1h rollup: the status
 * page's uptime history read (averaging the 0/1 "Up" series per day yields a
 * daily up fraction).
 *
 * The 1h rollup, not the 1m one, because the window is months: `metric_points_1h`
 * keeps a year (`metric_points_1m` does not) and a 90-day span over minute rows
 * would scan two orders of magnitude more data for the same answer.
 *
 * Days with no rows are simply absent rather than zero. That distinction is the
 * whole point on a public page: a day nothing was recorded must render as a gap,
 * never as a day of downtime, and never as a day of perfect uptime.
 *
 * Hours are weighted equally within a day, as minutes are within an hour in
 * `getMetricSeriesAverageBatch`: an hour of sparse sampling counts the same as
 * a busy one, which is what keeps a retry storm from skewing the figure.
 */
export async function getMetricDailyAverageBatch(
  organizationId: string,
  resourceIds: string[],
  seriesLabel: string,
  fromMs: number,
  toMs: number,
): Promise<MetricDailyAverage[]> {
  if (resourceIds.length === 0) return [];
  const rows = await getAnalyticsDb()
    .select({
      resource_id: metricPoints1h.resource_id,
      day: sql<string>`to_char(${metricPoints1h.ts_hour} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as(
        "day",
      ),
      value: sql<number>`avg(${rollupAverage(metricPoints1h)})`.mapWith(Number).as("value"),
    })
    .from(metricPoints1h)
    .where(
      and(
        eq(metricPoints1h.organization_id, organizationId),
        inArray(metricPoints1h.resource_id, resourceIds),
        eq(metricPoints1h.series_label, seriesLabel),
        withinSeconds(metricPoints1h.ts_hour, fromMs, toMs),
      ),
    )
    // `day` is the output column, the UTC date the select computes.
    .groupBy(metricPoints1h.resource_id, sql`day`)
    .orderBy(sql`day`);
  return rows.map((r) => ({
    resourceId: r.resource_id,
    day: String(r.day).slice(0, 10),
    value: Number(r.value),
  }));
}

/**
 * Historical metric range. Auto-routes between raw / 1m / 1h based on span:
 *  <= 2h: raw
 *  <= 7d: 1m rollup
 *  >  7d: 1h rollup
 */
export async function getMetricRange(
  organizationId: string,
  resourceId: string,
  fromMs: number,
  toMs: number,
): Promise<MetricSeries[]> {
  const spanMs = toMs - fromMs;
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const db = getAnalyticsDb();

  type Row = { series_label: string; unit: string; ts_ms: number; value: number };
  let rows: Row[];

  if (spanMs <= 2 * HOUR) {
    rows = await db
      .select({
        series_label: metricPointsRaw.series_label,
        unit: metricPointsRaw.unit,
        ts_ms: epochMillis(metricPointsRaw.ts).as("ts_ms"),
        value: metricPointsRaw.value,
      })
      .from(metricPointsRaw)
      .where(
        and(
          eq(metricPointsRaw.organization_id, organizationId),
          eq(metricPointsRaw.resource_id, resourceId),
          gte(metricPointsRaw.ts, new Date(fromMs).toISOString()),
          lte(metricPointsRaw.ts, new Date(toMs).toISOString()),
        ),
      )
      .orderBy(asc(metricPointsRaw.ts));
  } else if (spanMs <= 7 * DAY) {
    rows = await db
      .select({
        series_label: metricPoints1m.series_label,
        unit: metricPoints1m.unit,
        ts_ms: epochMillis(metricPoints1m.ts_minute).as("ts_ms"),
        value: rollupAverage(metricPoints1m).as("value"),
      })
      .from(metricPoints1m)
      .where(
        and(
          eq(metricPoints1m.organization_id, organizationId),
          eq(metricPoints1m.resource_id, resourceId),
          withinSeconds(metricPoints1m.ts_minute, fromMs, toMs),
        ),
      )
      .orderBy(asc(metricPoints1m.ts_minute));
  } else {
    rows = await db
      .select({
        series_label: metricPoints1h.series_label,
        unit: metricPoints1h.unit,
        ts_ms: epochMillis(metricPoints1h.ts_hour).as("ts_ms"),
        value: rollupAverage(metricPoints1h).as("value"),
      })
      .from(metricPoints1h)
      .where(
        and(
          eq(metricPoints1h.organization_id, organizationId),
          eq(metricPoints1h.resource_id, resourceId),
          withinSeconds(metricPoints1h.ts_hour, fromMs, toMs),
        ),
      )
      .orderBy(asc(metricPoints1h.ts_hour));
  }

  const bySeries = new Map<string, MetricSeries>();
  for (const r of rows) {
    let s = bySeries.get(r.series_label);
    if (!s) {
      s = { label: r.series_label, points: [] };
      if (r.unit) s.unit = r.unit;
      bySeries.set(r.series_label, s);
    }
    const pt: MetricSeriesPoint = { timestamp: Number(r.ts_ms), value: r.value };
    s.points.push(pt);
  }
  return [...bySeries.values()];
}

/** One hour's peak of one series on one resource. */
export interface MetricHourlyPeak {
  resourceId: string;
  seriesLabel: string;
  tsMs: number;
  value: number;
}

/**
 * Hourly peaks of named series across resources, from the 1h rollup: the
 * capacity runway's read for metric usages (a storage percentage, a
 * connection count). The peak rather than the mean, because what fills a disk
 * or exhausts a connection pool is the high-water mark, not the average hour.
 */
export async function getMetricHourlyPeaksBatch(
  organizationId: string,
  resourceIds: string[],
  seriesLabels: string[],
  fromMs: number,
  toMs: number,
): Promise<MetricHourlyPeak[]> {
  if (resourceIds.length === 0 || seriesLabels.length === 0) return [];
  const rows = await getAnalyticsDb()
    .select({
      resource_id: metricPoints1h.resource_id,
      series_label: metricPoints1h.series_label,
      ts_ms: epochMillis(metricPoints1h.ts_hour).as("ts_ms"),
      value: metricPoints1h.value_max,
    })
    .from(metricPoints1h)
    .where(
      and(
        eq(metricPoints1h.organization_id, organizationId),
        inArray(metricPoints1h.resource_id, resourceIds),
        inArray(metricPoints1h.series_label, seriesLabels),
        withinSeconds(metricPoints1h.ts_hour, fromMs, toMs),
      ),
    )
    .orderBy(asc(metricPoints1h.ts_hour));
  return rows.map((r) => ({
    resourceId: r.resource_id,
    seriesLabel: r.series_label,
    tsMs: Number(r.ts_ms),
    value: Number(r.value),
  }));
}
