import type { DashboardStat, MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getClickHouseDb, isClickHouseConfigured, type ClickHouseDb } from "./client";
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

/**
 * Deployments without ClickHouse configured genuinely have no metric history,
 * so the empty result is the truth there. A configured-but-failing ClickHouse
 * is not: it throws so the caller's request fails loudly instead of rendering
 * an outage as "this resource has no data".
 */
async function query<T>(build: (db: ClickHouseDb) => Promise<T[]>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  return await build(getClickHouseDb());
}

/**
 * Milliseconds since the epoch, as ClickHouse's own conversion of a timestamp
 * column. `UInt64` comes back through JSON as a string, so callers pass the
 * result through `Number`.
 */
const tsMillis = (column: unknown) => sql<string>`toUnixTimestamp64Milli(${column})`;
const secondsToMillis = (column: unknown) => sql<string>`toUnixTimestamp(${column}) * 1000`;

/** `>= from AND <= to` over a second-resolution column, from millisecond bounds. */
function withinSeconds(column: unknown, fromMs: number, toMs: number) {
  return and(
    gte(column as never, sql`toDateTime(${Math.floor(fromMs / 1000)})`),
    lte(column as never, sql`toDateTime(${Math.floor(toMs / 1000)})`),
  );
}

/** Latest DashboardStat[] snapshot for one resource. Null if none. */
export async function getLatestStats(
  organizationId: string,
  resourceId: string,
): Promise<DashboardStat[] | null> {
  const rows = await query((db) =>
    db
      .select({ stats_json: dashboardStats.stats_json })
      .from(dashboardStats)
      .where(
        and(
          eq(dashboardStats.organization_id, organizationId),
          eq(dashboardStats.resource_id, resourceId),
        ),
      )
      .orderBy(desc(dashboardStats.ts))
      .limit(1),
  );
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0]!.stats_json) as DashboardStat[];
  } catch {
    return null;
  }
}

/**
 * Latest MetricSeries[] for one resource — most recent ~60min of raw points,
 * grouped back into per-series shape so the dashboard sparkline logic works
 * unchanged.
 */
export async function getLatestMetrics(
  organizationId: string,
  resourceId: string,
): Promise<MetricSeries[] | null> {
  const rows = await query((db) =>
    db
      .select({
        series_label: metricPointsRaw.series_label,
        unit: metricPointsRaw.unit,
        ts_ms: tsMillis(metricPointsRaw.ts).as("ts_ms"),
        value: metricPointsRaw.value,
      })
      .from(metricPointsRaw)
      .where(
        and(
          eq(metricPointsRaw.organization_id, organizationId),
          eq(metricPointsRaw.resource_id, resourceId),
          sql`${metricPointsRaw.ts} > now() - INTERVAL 1 HOUR`,
        ),
      )
      .orderBy(asc(metricPointsRaw.ts)),
  );
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

/** Batch variant — returns Map keyed by resourceId. */
export async function getLatestMetricsBatch(
  organizationId: string,
  resourceIds: string[],
): Promise<Map<string, MetricSeries[]>> {
  const result = new Map<string, MetricSeries[]>();
  if (resourceIds.length === 0) return result;
  const rows = await query((db) =>
    db
      .select({
        resource_id: metricPointsRaw.resource_id,
        series_label: metricPointsRaw.series_label,
        unit: metricPointsRaw.unit,
        ts_ms: tsMillis(metricPointsRaw.ts).as("ts_ms"),
        value: metricPointsRaw.value,
      })
      .from(metricPointsRaw)
      .where(
        and(
          eq(metricPointsRaw.organization_id, organizationId),
          inArray(metricPointsRaw.resource_id, resourceIds),
          sql`${metricPointsRaw.ts} > now() - INTERVAL 1 HOUR`,
        ),
      )
      .orderBy(asc(metricPointsRaw.ts)),
  );
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

/** Batch variant of getLatestStats. */
export async function getLatestStatsBatch(
  organizationId: string,
  resourceIds: string[],
): Promise<Map<string, DashboardStat[]>> {
  const result = new Map<string, DashboardStat[]>();
  if (resourceIds.length === 0) return result;
  const rows = await query((db) =>
    db
      .select({
        resource_id: dashboardStats.resource_id,
        stats_json: sql<string>`argMax(${dashboardStats.stats_json}, ${dashboardStats.ts})`.as(
          "stats_json",
        ),
      })
      .from(dashboardStats)
      .where(
        and(
          eq(dashboardStats.organization_id, organizationId),
          inArray(dashboardStats.resource_id, resourceIds),
        ),
      )
      .groupBy(dashboardStats.resource_id),
  );
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
  const rows = await query((db) =>
    db
      .select({ counts_json: accountResourceCounts.counts_json })
      .from(accountResourceCounts)
      .where(
        and(
          eq(accountResourceCounts.organization_id, organizationId),
          eq(accountResourceCounts.account_id, accountId),
        ),
      )
      .orderBy(desc(accountResourceCounts.ts))
      .limit(1),
  );
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0]!.counts_json) as ResourceCount[];
  } catch {
    return null;
  }
}

/** Batch variant of getLatestAccountCounts. */
export async function getLatestAccountCountsBatch(
  organizationId: string,
  accountIds: string[],
): Promise<Map<string, ResourceCount[]>> {
  const result = new Map<string, ResourceCount[]>();
  if (accountIds.length === 0) return result;
  const rows = await query((db) =>
    db
      .select({
        account_id: accountResourceCounts.account_id,
        counts_json:
          sql<string>`argMax(${accountResourceCounts.counts_json}, ${accountResourceCounts.ts})`.as(
            "counts_json",
          ),
      })
      .from(accountResourceCounts)
      .where(
        and(
          eq(accountResourceCounts.organization_id, organizationId),
          inArray(accountResourceCounts.account_id, accountIds),
        ),
      )
      .groupBy(accountResourceCounts.account_id),
  );
  for (const r of rows) {
    try {
      result.set(r.account_id, JSON.parse(r.counts_json) as ResourceCount[]);
    } catch {
      // skip malformed
    }
  }
  return result;
}

/** Per-series quantiles over a window — the right-sizing utilisation read. */
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
 * Reads `metric_points_1m` (30-day TTL — callers must stay inside it; the
 * right-sizing window is 14 days) rather than the 1h rollup: a p95 of hourly
 * averages flattens the very peaks the recommendation must respect. The inner
 * query finalizes the avg-state per minute, the outer one takes quantiles
 * over those per-minute points. Series identity is (resource, label) — a
 * series whose unit string changed mid-window still combines into one row,
 * with a representative unit via `any(unit)`.
 */
export async function getMetricQuantilesBatch(
  organizationId: string,
  resourceIds: string[],
  fromMs: number,
  toMs: number,
): Promise<Map<string, MetricSeriesQuantiles[]>> {
  const result = new Map<string, MetricSeriesQuantiles[]>();
  if (resourceIds.length === 0) return result;
  const rows = await query((db) => {
    const minutes = db
      .select({
        resource_id: metricPoints1m.resource_id,
        series_label: metricPoints1m.series_label,
        unit: metricPoints1m.unit,
        ts_minute: metricPoints1m.ts_minute,
        minute_avg: sql<number>`avgMerge(${metricPoints1m.value_avg})`.as("minute_avg"),
      })
      .from(metricPoints1m)
      .where(
        and(
          eq(metricPoints1m.organization_id, organizationId),
          inArray(metricPoints1m.resource_id, resourceIds),
          withinSeconds(metricPoints1m.ts_minute, fromMs, toMs),
        ),
      )
      .groupBy(
        metricPoints1m.resource_id,
        metricPoints1m.series_label,
        metricPoints1m.unit,
        metricPoints1m.ts_minute,
      )
      .as("minutes");

    return db
      .select({
        resource_id: minutes.resource_id,
        series_label: minutes.series_label,
        unit: sql<string>`any(${minutes.unit})`.as("unit"),
        q05: sql<number>`quantile(0.05)(${minutes.minute_avg})`.as("q05"),
        q95: sql<number>`quantile(0.95)(${minutes.minute_avg})`.as("q95"),
        vmax: sql<number>`max(${minutes.minute_avg})`.as("vmax"),
        samples: sql<string>`count()`.as("samples"),
      })
      .from(minutes)
      .groupBy(minutes.resource_id, minutes.series_label);
  });
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
 * plugin / resource type), for the metric-alert rule builder's key picker —
 * the user picks from what their resources really report instead of having to
 * know internal series labels.
 *
 * Reads the raw table (the only one carrying plugin/type columns) over its
 * full 7-day TTL, so a metric only stops being offered a week after the last
 * resource stopped reporting it.
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
  const rows = await query((db) =>
    db
      .select({
        series_label: metricPointsRaw.series_label,
        unit: sql<string>`any(${metricPointsRaw.unit})`.as("unit"),
        resource_count: sql<string>`uniqExact(${metricPointsRaw.resource_id})`.as("resource_count"),
      })
      .from(metricPointsRaw)
      .where(
        and(
          eq(metricPointsRaw.organization_id, organizationId),
          sql`${metricPointsRaw.ts} > now() - INTERVAL 7 DAY`,
          ...(filter.pluginId ? [eq(metricPointsRaw.plugin_id, filter.pluginId)] : []),
          ...(filter.resourceTypeId
            ? [eq(metricPointsRaw.resource_type_id, filter.resourceTypeId)]
            : []),
        ),
      )
      .groupBy(metricPointsRaw.series_label)
      .orderBy(asc(metricPointsRaw.series_label)),
  );
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
 * Per-minute averages of one series for many resources over a window — the
 * metric-alert evaluator's read. Uses the 1m rollup (30-day TTL) rather than
 * raw points so the "held for the whole window" judgement runs over evenly
 * bucketed samples regardless of how bursty the plugin's reporting is.
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
  const rows = await query((db) =>
    db
      .select({
        resource_id: metricPoints1m.resource_id,
        ts_ms: secondsToMillis(metricPoints1m.ts_minute).as("ts_ms"),
        value: sql<number>`avgMerge(${metricPoints1m.value_avg})`.as("value"),
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
      .groupBy(metricPoints1m.resource_id, metricPoints1m.ts_minute)
      .orderBy(asc(metricPoints1m.ts_minute)),
  );
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
 * Average of one series per resource over a window, from the 1m rollup — the
 * probe list's uptime read (averaging the 0/1 "Up" series over 24h yields the
 * up fraction). The inner GROUP BY finalizes the per-minute avg state first so
 * bursty raw reporting can't weight some minutes more than others.
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
  const rows = await query((db) => {
    const minutes = db
      .select({
        resource_id: metricPoints1m.resource_id,
        ts_minute: metricPoints1m.ts_minute,
        value: sql<number>`avgMerge(${metricPoints1m.value_avg})`.as("value"),
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
      .groupBy(metricPoints1m.resource_id, metricPoints1m.ts_minute)
      .as("minutes");

    return db
      .select({
        resource_id: minutes.resource_id,
        value: sql<number>`avg(${minutes.value})`.as("value"),
      })
      .from(minutes)
      .groupBy(minutes.resource_id);
  });
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
 * Daily averages of one series per resource, from the 1h rollup — the status
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
 * `getMetricSeriesAverageBatch` — an hour of sparse sampling counts the same as
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
  const rows = await query((db) => {
    const hours = db
      .select({
        resource_id: metricPoints1h.resource_id,
        day: sql<string>`toDate(${metricPoints1h.ts_hour})`.as("day"),
        ts_hour: metricPoints1h.ts_hour,
        value: sql<number>`avgMerge(${metricPoints1h.value_avg})`.as("value"),
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
      .groupBy(metricPoints1h.resource_id, sql`day`, metricPoints1h.ts_hour)
      .as("hours");

    return db
      .select({
        resource_id: hours.resource_id,
        day: hours.day,
        value: sql<number>`avg(${hours.value})`.as("value"),
      })
      .from(hours)
      .groupBy(hours.resource_id, hours.day)
      .orderBy(asc(hours.day));
  });
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

  type Row = { series_label: string; unit: string; ts_ms: string | number; value: number };
  let rows: Row[];

  if (spanMs <= 2 * HOUR) {
    rows = await query<Row>((db) =>
      db
        .select({
          series_label: metricPointsRaw.series_label,
          unit: metricPointsRaw.unit,
          ts_ms: tsMillis(metricPointsRaw.ts).as("ts_ms"),
          value: metricPointsRaw.value,
        })
        .from(metricPointsRaw)
        .where(
          and(
            eq(metricPointsRaw.organization_id, organizationId),
            eq(metricPointsRaw.resource_id, resourceId),
            gte(metricPointsRaw.ts, sql`fromUnixTimestamp64Milli(${fromMs})`),
            lte(metricPointsRaw.ts, sql`fromUnixTimestamp64Milli(${toMs})`),
          ),
        )
        .orderBy(asc(metricPointsRaw.ts)),
    );
  } else if (spanMs <= 7 * DAY) {
    rows = await query<Row>((db) =>
      db
        .select({
          series_label: metricPoints1m.series_label,
          unit: metricPoints1m.unit,
          ts_ms: secondsToMillis(metricPoints1m.ts_minute).as("ts_ms"),
          value: sql<number>`avgMerge(${metricPoints1m.value_avg})`.as("value"),
        })
        .from(metricPoints1m)
        .where(
          and(
            eq(metricPoints1m.organization_id, organizationId),
            eq(metricPoints1m.resource_id, resourceId),
            withinSeconds(metricPoints1m.ts_minute, fromMs, toMs),
          ),
        )
        .groupBy(metricPoints1m.series_label, metricPoints1m.unit, metricPoints1m.ts_minute)
        .orderBy(asc(metricPoints1m.ts_minute)),
    );
  } else {
    rows = await query<Row>((db) =>
      db
        .select({
          series_label: metricPoints1h.series_label,
          unit: metricPoints1h.unit,
          ts_ms: secondsToMillis(metricPoints1h.ts_hour).as("ts_ms"),
          value: sql<number>`avgMerge(${metricPoints1h.value_avg})`.as("value"),
        })
        .from(metricPoints1h)
        .where(
          and(
            eq(metricPoints1h.organization_id, organizationId),
            eq(metricPoints1h.resource_id, resourceId),
            withinSeconds(metricPoints1h.ts_hour, fromMs, toMs),
          ),
        )
        .groupBy(metricPoints1h.series_label, metricPoints1h.unit, metricPoints1h.ts_hour)
        .orderBy(asc(metricPoints1h.ts_hour)),
    );
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
