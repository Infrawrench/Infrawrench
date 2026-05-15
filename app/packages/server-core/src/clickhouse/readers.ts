import type { DashboardStat, MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import { getClickHouseClient, isClickHouseConfigured } from "./client";

export interface ResourceCount {
  typeLabel: string;
  count: number;
}

async function query<T>(query: string, query_params: Record<string, unknown>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  try {
    const rs = await getClickHouseClient().query({ query, query_params, format: "JSONEachRow" });
    return await rs.json<T>();
  } catch (err) {
    console.error("[clickhouse] query failed:", err);
    return [];
  }
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
