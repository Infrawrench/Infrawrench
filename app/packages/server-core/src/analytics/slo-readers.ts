/**
 * Reads behind service-level objectives: the hourly good/total buckets the
 * evaluator and the detail view share, and the (resource, series) vocabulary
 * the editor's metric picker offers.
 *
 * Its own module beside `readers.ts`, the `network-flow-readers.ts` split.
 * Like those readers, a failing query throws rather than answering empty.
 */
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { getAnalyticsDb } from "./client";
import { epochMillis, rollupAverage, withinSeconds } from "./readers";
import { metricPoints1m, metricPointsRaw } from "./schema";

/**
 * How an SLO judges one minute's averaged sample, in SQL: `fraction` counts
 * the minute as its own value clamped into 0–1 (the probe "Up" series),
 * `threshold` counts it good when the comparison holds. The comparator is a
 * closed set and the threshold a bound parameter, so nothing user-typed
 * reaches the statement text.
 */
export type SloMinuteJudgement =
  | { kind: "fraction" }
  | { kind: "threshold"; comparator: "<" | "<=" | ">" | ">="; threshold: number };

/** One hour of an SLO's events: minutes with data, and how much of them was good. */
export interface SloHourlyBucketRow {
  startMs: number;
  good: number;
  total: number;
}

/** A minute's judgement as a 0–1 SQL expression over its rollup average. */
function goodExpr(value: SQL, judgement: SloMinuteJudgement): SQL {
  if (judgement.kind === "fraction") return sql`least(greatest(${value}, 0), 1)`;
  const t = judgement.threshold;
  let holds: SQL;
  switch (judgement.comparator) {
    case "<":
      holds = sql`${value} < ${t}`;
      break;
    case "<=":
      holds = sql`${value} <= ${t}`;
      break;
    case ">":
      holds = sql`${value} > ${t}`;
      break;
    case ">=":
      holds = sql`${value} >= ${t}`;
      break;
  }
  return sql`CASE WHEN ${holds} THEN 1 ELSE 0 END`;
}

/**
 * Hourly good/total sums of one series for one resource, built from the 1m
 * rollup: each rollup row is one minute's average, so a minute is one event
 * however bursty the raw reporting was; each minute is judged and the hour
 * sums them. The evaluator's long-window read and the detail view's history
 * read. The 1m rollup keeps 30 days, which is the longest SLO window.
 */
export async function getSloHourlyBuckets(
  organizationId: string,
  resourceId: string,
  seriesLabel: string,
  judgement: SloMinuteJudgement,
  fromMs: number,
  toMs: number,
): Promise<SloHourlyBucketRow[]> {
  const good = goodExpr(rollupAverage(metricPoints1m), judgement);
  // Truncated in UTC, as the writer buckets, so an hour is the same hour
  // whatever the session's time zone.
  const hour = sql`date_trunc('hour', ${metricPoints1m.ts_minute}, 'UTC')`;
  const rows = await getAnalyticsDb()
    .select({
      hour_ms: epochMillis(hour).as("hour_ms"),
      good: sql<number>`sum(${good})::float8`.mapWith(Number).as("good"),
      total: sql<number>`count(*)::int`.mapWith(Number).as("total"),
    })
    .from(metricPoints1m)
    .where(
      and(
        eq(metricPoints1m.organization_id, organizationId),
        eq(metricPoints1m.resource_id, resourceId),
        eq(metricPoints1m.series_label, seriesLabel),
        withinSeconds(metricPoints1m.ts_minute, fromMs, toMs),
      ),
    )
    .groupBy(hour)
    .orderBy(hour);
  return rows.map((r) => ({
    startMs: Number(r.hour_ms),
    good: Number(r.good),
    total: Number(r.total),
  }));
}

/** A resource and a series it has reported recently: the SLO editor's metric picker. */
export interface ResourceSeriesRow {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  label: string;
  unit: string;
}

/**
 * Every (resource, series) pair an org's resources reported in the last week,
 * from the raw table (the only one with plugin/type columns), excluding the
 * synthetic probe identity, which the editor offers through its own picker.
 * Bounded, so a vast estate gets a stable subset rather than a timeout.
 */
export async function listResourceMetricSeries(
  organizationId: string,
  limit = 5000,
): Promise<ResourceSeriesRow[]> {
  const rows = await getAnalyticsDb()
    .select({
      resource_id: metricPointsRaw.resource_id,
      plugin_id: sql<string>`min(${metricPointsRaw.plugin_id})`.as("plugin_id"),
      resource_type_id: sql<string>`min(${metricPointsRaw.resource_type_id})`.as(
        "resource_type_id",
      ),
      series_label: metricPointsRaw.series_label,
      unit: sql<string>`min(${metricPointsRaw.unit})`.as("unit"),
    })
    .from(metricPointsRaw)
    .where(
      and(
        eq(metricPointsRaw.organization_id, organizationId),
        sql`${metricPointsRaw.ts} > now() - interval '7 days'`,
        sql`${metricPointsRaw.plugin_id} <> 'synthetic-probe'`,
      ),
    )
    .groupBy(metricPointsRaw.resource_id, metricPointsRaw.series_label)
    .orderBy(asc(metricPointsRaw.resource_id), asc(metricPointsRaw.series_label))
    .limit(limit);
  return rows.map((r) => ({
    resourceId: r.resource_id,
    pluginId: r.plugin_id,
    resourceTypeId: r.resource_type_id,
    label: r.series_label,
    unit: r.unit,
  }));
}
