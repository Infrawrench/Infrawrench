/**
 * ClickHouse reads behind service-level objectives: the hourly good/total
 * buckets the evaluator and the detail view share, and the (resource, series)
 * vocabulary the editor's metric picker offers.
 *
 * Its own module beside `readers.ts`, the `network-flow-readers.ts` split.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { getClickHouseDb, isClickHouseConfigured, type ClickHouseDb } from "./client";
import { metricPoints1m, metricPointsRaw } from "./schema";

/** Same contract as `readers.ts`: unconfigured is empty, configured-but-failing throws. */
async function query<T>(build: (db: ClickHouseDb) => Promise<T[]>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  return await build(getClickHouseDb());
}

function withinSeconds(column: unknown, fromMs: number, toMs: number) {
  return and(
    gte(column as never, sql`toDateTime(${Math.floor(fromMs / 1000)})`),
    lte(column as never, sql`toDateTime(${Math.floor(toMs / 1000)})`),
  );
}

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

/**
 * Hourly good/total sums of one series for one resource, built from the 1m
 * rollup: the inner GROUP BY finalizes each minute's average first, so a
 * minute is one event however bursty the raw reporting was; then each minute
 * is judged and the hour sums them. The evaluator's long-window read and the
 * detail view's history read. The 1m rollup keeps 30 days, which is the
 * longest SLO window.
 */
export async function getSloHourlyBuckets(
  organizationId: string,
  resourceId: string,
  seriesLabel: string,
  judgement: SloMinuteJudgement,
  fromMs: number,
  toMs: number,
): Promise<SloHourlyBucketRow[]> {
  const rows = await query((db) => {
    const minutes = db
      .select({
        ts_minute: metricPoints1m.ts_minute,
        value: sql<number>`avgMerge(${metricPoints1m.value_avg})`.as("value"),
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
      .groupBy(metricPoints1m.ts_minute)
      .as("minutes");

    let good;
    if (judgement.kind === "fraction") {
      good = sql`least(greatest(${minutes.value}, 0), 1)`;
    } else {
      const t = judgement.threshold;
      switch (judgement.comparator) {
        case "<":
          good = sql`if(${minutes.value} < ${t}, 1, 0)`;
          break;
        case "<=":
          good = sql`if(${minutes.value} <= ${t}, 1, 0)`;
          break;
        case ">":
          good = sql`if(${minutes.value} > ${t}, 1, 0)`;
          break;
        case ">=":
          good = sql`if(${minutes.value} >= ${t}, 1, 0)`;
          break;
      }
    }

    return db
      .select({
        hour_ms: sql<string>`toUnixTimestamp(toStartOfHour(${minutes.ts_minute})) * 1000`.as(
          "hour_ms",
        ),
        good: sql<number>`sum(${good})`.as("good"),
        total: sql<string>`count()`.as("total"),
      })
      .from(minutes)
      .groupBy(sql`hour_ms`)
      .orderBy(asc(sql`hour_ms`));
  });
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
  const rows = await query((db) =>
    db
      .select({
        resource_id: metricPointsRaw.resource_id,
        plugin_id: sql<string>`any(${metricPointsRaw.plugin_id})`.as("plugin_id"),
        resource_type_id: sql<string>`any(${metricPointsRaw.resource_type_id})`.as(
          "resource_type_id",
        ),
        series_label: metricPointsRaw.series_label,
        unit: sql<string>`any(${metricPointsRaw.unit})`.as("unit"),
      })
      .from(metricPointsRaw)
      .where(
        and(
          eq(metricPointsRaw.organization_id, organizationId),
          sql`${metricPointsRaw.ts} > now() - INTERVAL 7 DAY`,
          sql`${metricPointsRaw.plugin_id} != 'synthetic-probe'`,
        ),
      )
      .groupBy(metricPointsRaw.resource_id, metricPointsRaw.series_label)
      .orderBy(asc(metricPointsRaw.resource_id), asc(metricPointsRaw.series_label))
      .limit(limit),
  );
  return rows.map((r) => ({
    resourceId: r.resource_id,
    pluginId: r.plugin_id,
    resourceTypeId: r.resource_type_id,
    label: r.series_label,
    unit: r.unit,
  }));
}
