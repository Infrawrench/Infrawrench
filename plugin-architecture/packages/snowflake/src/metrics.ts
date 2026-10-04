/**
 * Metric series for the Metrics tab, all from ACCOUNT_USAGE views (latency
 * up to three hours, which is why the default windows are days rather than
 * hours):
 *
 * - Warehouse: credits per hour (`WAREHOUSE_METERING_HISTORY`) and running,
 *   queued and blocked query load per hour (`WAREHOUSE_LOAD_HISTORY`, five
 *   minute intervals averaged to the hour).
 * - Account: credits per day by service group (`METERING_DAILY_HISTORY`) and
 *   storage bytes per day (`STORAGE_USAGE`).
 * - Database: storage and fail-safe bytes per day
 *   (`DATABASE_STORAGE_USAGE_HISTORY`).
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { SnowflakeContext } from "./api.js";
import { literal, num, runSql, str } from "./api.js";
import { serviceGroup } from "./catalog.js";

export const WAREHOUSE_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNT_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

const ts = (ms: number) => `TO_TIMESTAMP_LTZ(${Math.floor(ms / 1000)})`;

/** Builds series from rows keyed by `t` (ISO time or date) and value columns. */
export function seriesFrom(
  rows: Record<string, unknown>[],
  metrics: Array<{ column: string; label: string; unit?: string }>,
  groupColumn?: string,
): MetricSeries[] {
  const out = new Map<string, MetricSeries>();
  for (const row of rows) {
    const t = Date.parse(str(row["t"]));
    if (!Number.isFinite(t)) continue;
    const group = groupColumn ? str(row[groupColumn]) : "";
    for (const m of metrics) {
      const value = num(row[m.column]);
      if (value === undefined) continue;
      const label = group ? `${m.label} (${group})` : m.label;
      let series = out.get(label);
      if (!series) {
        series = { label, ...(m.unit ? { unit: m.unit } : {}), points: [] };
        out.set(label, series);
      }
      (series.points as MetricSeriesPoint[]).push({ timestamp: t, value });
    }
  }
  for (const s of out.values()) {
    (s.points as MetricSeriesPoint[]).sort((a, b) => a.timestamp - b.timestamp);
  }
  return [...out.values()].filter((s) => s.points.length > 0);
}

export async function warehouseSeries(
  ctx: SnowflakeContext,
  warehouse: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const name = literal(warehouse);
  const window = `START_TIME >= ${ts(range.startMs)} AND START_TIME < ${ts(range.endMs)}`;
  const [credits, load] = await Promise.all([
    runSql(
      ctx,
      `SELECT START_TIME AS T, CREDITS_USED AS CREDITS, CREDITS_USED_CLOUD_SERVICES AS CLOUD
       FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
       WHERE WAREHOUSE_NAME = ${name} AND ${window}
       ORDER BY START_TIME`,
    ),
    runSql(
      ctx,
      `SELECT DATE_TRUNC('hour', START_TIME) AS T, AVG(AVG_RUNNING) AS RUNNING,
         AVG(AVG_QUEUED_LOAD + AVG_QUEUED_PROVISIONING) AS QUEUED, AVG(AVG_BLOCKED) AS BLOCKED
       FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
       WHERE WAREHOUSE_NAME = ${name} AND ${window}
       GROUP BY 1 ORDER BY 1`,
    ),
  ]);
  return [
    ...seriesFrom(credits.rows, [
      { column: "credits", label: "Credits used", unit: "credits" },
      { column: "cloud", label: "Cloud services credits", unit: "credits" },
    ]),
    ...seriesFrom(load.rows, [
      { column: "running", label: "Running query load" },
      { column: "queued", label: "Queued query load" },
      { column: "blocked", label: "Blocked query load" },
    ]),
  ];
}

export async function accountSeries(
  ctx: SnowflakeContext,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const from = new Date(range.startMs).toISOString().slice(0, 10);
  const to = new Date(range.endMs).toISOString().slice(0, 10);
  const [metering, storage] = await Promise.all([
    runSql(
      ctx,
      `SELECT TO_VARCHAR(USAGE_DATE, 'YYYY-MM-DD') AS T, SERVICE_TYPE AS ST, SUM(CREDITS_BILLED) AS CREDITS
       FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
       WHERE USAGE_DATE BETWEEN '${from}' AND '${to}'
       GROUP BY 1, 2`,
    ),
    runSql(
      ctx,
      `SELECT TO_VARCHAR(USAGE_DATE, 'YYYY-MM-DD') AS T, STORAGE_BYTES AS DB, STAGE_BYTES AS STAGE,
         FAILSAFE_BYTES AS FAILSAFE
       FROM SNOWFLAKE.ACCOUNT_USAGE.STORAGE_USAGE
       WHERE USAGE_DATE BETWEEN '${from}' AND '${to}'
       ORDER BY USAGE_DATE`,
    ),
  ]);
  // Several service types fold into one group; sum them per day first.
  const grouped = new Map<string, Record<string, unknown>>();
  for (const r of metering.rows) {
    const group = serviceGroup(str(r["st"]));
    const key = `${str(r["t"])}|${group}`;
    const cur = grouped.get(key) ?? { t: r["t"], group, credits: 0 };
    cur["credits"] = (num(cur["credits"]) ?? 0) + (num(r["credits"]) ?? 0);
    grouped.set(key, cur);
  }
  return [
    ...seriesFrom(
      [...grouped.values()],
      [{ column: "credits", label: "Credits", unit: "credits" }],
      "group",
    ),
    ...seriesFrom(storage.rows, [
      { column: "db", label: "Database storage", unit: "bytes" },
      { column: "stage", label: "Stage storage", unit: "bytes" },
      { column: "failsafe", label: "Fail-safe storage", unit: "bytes" },
    ]),
  ];
}

export async function databaseSeries(
  ctx: SnowflakeContext,
  database: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const from = new Date(range.startMs).toISOString().slice(0, 10);
  const to = new Date(range.endMs).toISOString().slice(0, 10);
  const res = await runSql(
    ctx,
    `SELECT TO_VARCHAR(USAGE_DATE, 'YYYY-MM-DD') AS T, AVERAGE_DATABASE_BYTES AS DB,
       AVERAGE_FAILSAFE_BYTES AS FAILSAFE
     FROM SNOWFLAKE.ACCOUNT_USAGE.DATABASE_STORAGE_USAGE_HISTORY
     WHERE DATABASE_NAME = ${literal(database)} AND DELETED IS NULL
       AND USAGE_DATE BETWEEN '${from}' AND '${to}'
     ORDER BY USAGE_DATE`,
  );
  return seriesFrom(res.rows, [
    { column: "db", label: "Database storage", unit: "bytes" },
    { column: "failsafe", label: "Fail-safe storage", unit: "bytes" },
  ]);
}
