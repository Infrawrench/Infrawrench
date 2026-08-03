import type { DashboardStat, MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import { getClickHouseClient, isClickHouseConfigured } from "./client";

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
async function query<T>(query: string, query_params: Record<string, unknown>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  const rs = await getClickHouseClient().query({ query, query_params, format: "JSONEachRow" });
  return await rs.json<T>();
}

/** Latest DashboardStat[] snapshot for one resource. Null if none. */
export async function getLatestStats(
  organizationId: string,
  resourceId: string,
): Promise<DashboardStat[] | null> {
  const rows = await query<{ stats_json: string }>(
    `SELECT stats_json
     FROM dashboard_stats
     WHERE organization_id = {orgId:String} AND resource_id = {resourceId:String}
     ORDER BY ts DESC
     LIMIT 1`,
    { orgId: organizationId, resourceId },
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
  const rows = await query<{
    series_label: string;
    unit: string;
    ts_ms: number;
    value: number;
  }>(
    `SELECT series_label,
            unit,
            toUnixTimestamp64Milli(ts) AS ts_ms,
            value
     FROM metric_points_raw
     WHERE organization_id = {orgId:String}
       AND resource_id = {resourceId:String}
       AND ts > now() - INTERVAL 1 HOUR
     ORDER BY ts ASC`,
    { orgId: organizationId, resourceId },
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
  const rows = await query<{
    resource_id: string;
    series_label: string;
    unit: string;
    ts_ms: number;
    value: number;
  }>(
    `SELECT resource_id,
            series_label,
            unit,
            toUnixTimestamp64Milli(ts) AS ts_ms,
            value
     FROM metric_points_raw
     WHERE organization_id = {orgId:String}
       AND resource_id IN {ids:Array(String)}
       AND ts > now() - INTERVAL 1 HOUR
     ORDER BY ts ASC`,
    { orgId: organizationId, ids: resourceIds },
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
  const rows = await query<{ resource_id: string; stats_json: string }>(
    `SELECT resource_id, argMax(stats_json, ts) AS stats_json
     FROM dashboard_stats
     WHERE organization_id = {orgId:String}
       AND resource_id IN {ids:Array(String)}
     GROUP BY resource_id`,
    { orgId: organizationId, ids: resourceIds },
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
  const rows = await query<{ counts_json: string }>(
    `SELECT counts_json
     FROM account_resource_counts
     WHERE organization_id = {orgId:String} AND account_id = {accountId:String}
     ORDER BY ts DESC
     LIMIT 1`,
    { orgId: organizationId, accountId },
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
  const rows = await query<{ account_id: string; counts_json: string }>(
    `SELECT account_id, argMax(counts_json, ts) AS counts_json
     FROM account_resource_counts
     WHERE organization_id = {orgId:String}
       AND account_id IN {ids:Array(String)}
     GROUP BY account_id`,
    { orgId: organizationId, ids: accountIds },
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
  const rows = await query<{
    resource_id: string;
    series_label: string;
    unit: string;
    q05: number;
    q95: number;
    vmax: number;
    samples: string | number;
  }>(
    `SELECT resource_id,
            series_label,
            any(unit)                  AS unit,
            quantile(0.05)(minute_avg) AS q05,
            quantile(0.95)(minute_avg) AS q95,
            max(minute_avg)            AS vmax,
            count()                    AS samples
     FROM (
       SELECT resource_id,
              series_label,
              unit,
              ts_minute,
              avgMerge(value_avg) AS minute_avg
       FROM metric_points_1m
       WHERE organization_id = {orgId:String}
         AND resource_id IN {ids:Array(String)}
         AND ts_minute >= toDateTime({fromSec:Int64})
         AND ts_minute <= toDateTime({toSec:Int64})
       GROUP BY resource_id, series_label, unit, ts_minute
     )
     GROUP BY resource_id, series_label`,
    {
      orgId: organizationId,
      ids: resourceIds,
      fromSec: Math.floor(fromMs / 1000),
      toSec: Math.floor(toMs / 1000),
    },
  );
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
  const conditions = [
    "organization_id = {orgId:String}",
    "ts > now() - INTERVAL 7 DAY",
    ...(filter.pluginId ? ["plugin_id = {pluginId:String}"] : []),
    ...(filter.resourceTypeId ? ["resource_type_id = {resourceTypeId:String}"] : []),
  ];
  const rows = await query<{ series_label: string; unit: string; resource_count: string | number }>(
    `SELECT series_label,
            any(unit)                AS unit,
            uniqExact(resource_id)   AS resource_count
     FROM metric_points_raw
     WHERE ${conditions.join(" AND ")}
     GROUP BY series_label
     ORDER BY series_label ASC`,
    {
      orgId: organizationId,
      ...(filter.pluginId ? { pluginId: filter.pluginId } : {}),
      ...(filter.resourceTypeId ? { resourceTypeId: filter.resourceTypeId } : {}),
    },
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
  const rows = await query<{ resource_id: string; ts_ms: number; value: number }>(
    `SELECT resource_id,
            toUnixTimestamp(ts_minute) * 1000 AS ts_ms,
            avgMerge(value_avg) AS value
     FROM metric_points_1m
     WHERE organization_id = {orgId:String}
       AND resource_id IN {ids:Array(String)}
       AND series_label = {seriesLabel:String}
       AND ts_minute >= toDateTime({fromSec:Int64})
       AND ts_minute <= toDateTime({toSec:Int64})
     GROUP BY resource_id, ts_minute
     ORDER BY ts_minute ASC`,
    {
      orgId: organizationId,
      ids: resourceIds,
      seriesLabel,
      fromSec: Math.floor(fromMs / 1000),
      toSec: Math.floor(toMs / 1000),
    },
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

  type Row = { series_label: string; unit: string; ts_ms: number; value: number };
  let rows: Row[];

  if (spanMs <= 2 * HOUR) {
    rows = await query<Row>(
      `SELECT series_label,
              unit,
              toUnixTimestamp64Milli(ts) AS ts_ms,
              value
       FROM metric_points_raw
       WHERE organization_id = {orgId:String}
         AND resource_id = {resourceId:String}
         AND ts >= fromUnixTimestamp64Milli({fromMs:Int64})
         AND ts <= fromUnixTimestamp64Milli({toMs:Int64})
       ORDER BY ts ASC`,
      { orgId: organizationId, resourceId, fromMs, toMs },
    );
  } else if (spanMs <= 7 * DAY) {
    rows = await query<Row>(
      `SELECT series_label,
              unit,
              toUnixTimestamp(ts_minute) * 1000 AS ts_ms,
              avgMerge(value_avg) AS value
       FROM metric_points_1m
       WHERE organization_id = {orgId:String}
         AND resource_id = {resourceId:String}
         AND ts_minute >= toDateTime({fromSec:Int64})
         AND ts_minute <= toDateTime({toSec:Int64})
       GROUP BY series_label, unit, ts_minute
       ORDER BY ts_minute ASC`,
      {
        orgId: organizationId,
        resourceId,
        fromSec: Math.floor(fromMs / 1000),
        toSec: Math.floor(toMs / 1000),
      },
    );
  } else {
    rows = await query<Row>(
      `SELECT series_label,
              unit,
              toUnixTimestamp(ts_hour) * 1000 AS ts_ms,
              avgMerge(value_avg) AS value
       FROM metric_points_1h
       WHERE organization_id = {orgId:String}
         AND resource_id = {resourceId:String}
         AND ts_hour >= toDateTime({fromSec:Int64})
         AND ts_hour <= toDateTime({toSec:Int64})
       GROUP BY series_label, unit, ts_hour
       ORDER BY ts_hour ASC`,
      {
        orgId: organizationId,
        resourceId,
        fromSec: Math.floor(fromMs / 1000),
        toSec: Math.floor(toMs / 1000),
      },
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
