/**
 * Row writes into the metric and poll-health tables.
 *
 * A single poll flattens one resource's series into thousands of points, so
 * `insertMetricPoints` sends them as one `jsonb` parameter expanded with
 * `jsonb_to_recordset` rather than a bind parameter per field (Postgres caps a
 * statement at 65,535 of those).
 *
 * `insertMetricPoints` and friends stay fire-and-forget: a metric point is
 * worth less than the poll that produced it, so a failed write is logged and the
 * pass continues. Cost and flow writes are not; they throw. See their modules.
 */
import type { DashboardStat, MetricSeries } from "@infrawrench/plugin-base";
import { getTableName, sql, type InferInsertModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getAnalyticsDb } from "./client";
import type { ResourceCount } from "./readers";
import { accountResourceCounts, dashboardStats, metricPointsRaw, pollOutcomes } from "./schema";

export type MetricPointRow = InferInsertModel<typeof metricPointsRaw>;

/** What `readResourceCounts` reads back: writer and reader are one contract. */
export type ResourceCountRow = ResourceCount;

/** Flatten MetricSeries[] (one entry per series with N points) into per-point rows. */
export function flattenMetricSeries(
  meta: {
    organizationId: string;
    accountId: string;
    resourceId: string;
    pluginId: string;
    resourceTypeId: string;
  },
  series: MetricSeries[],
): MetricPointRow[] {
  const rows: MetricPointRow[] = [];
  for (const s of series) {
    const unit = s.unit ?? "";
    for (const p of s.points) {
      rows.push({
        organization_id: meta.organizationId,
        account_id: meta.accountId,
        resource_id: meta.resourceId,
        plugin_id: meta.pluginId,
        resource_type_id: meta.resourceTypeId,
        series_label: s.label,
        unit,
        ts: new Date(p.timestamp).toISOString(),
        value: p.value,
      });
    }
  }
  return rows;
}

/**
 * Insert rows, swallowing failures.
 *
 * Generic over the table so each caller's rows are checked against that table's
 * insert model. The name in the log line comes from the table too, so it cannot
 * drift from the one written to.
 */
async function insertRows<TTable extends PgTable>(
  table: TTable,
  values: readonly InferInsertModel<TTable>[],
): Promise<void> {
  if (values.length === 0) return;
  try {
    await getAnalyticsDb()
      .insert(table)
      .values(values as InferInsertModel<TTable>[]);
  } catch (err) {
    console.error(`[analytics] insert into ${getTableName(table)} failed:`, err);
  }
}

/**
 * Store raw points and fold them into the minute and hour rollups, in one
 * statement.
 *
 * A poll re-fetches a window that overlaps the previous one, so most points
 * arrive more than once. The raw insert skips points already stored (the key is
 * org, resource, series, ts) and `RETURNING` hands on only the ones it actually
 * inserted, which is what makes adding them to the rollups' running
 * sum/count/min/max correct: a point is counted once however often it is sent.
 * Buckets are truncated in UTC so a session time zone with a half-hour offset
 * cannot shift an hour bucket.
 */
export async function insertMetricPoints(rows: MetricPointRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await getAnalyticsDb().execute(sql`
      WITH input AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(
          organization_id text, account_id text, resource_id text, plugin_id text,
          resource_type_id text, series_label text, unit text, ts timestamptz, value float8
        )
      ),
      inserted AS (
        INSERT INTO metric_points_raw
          (organization_id, account_id, resource_id, plugin_id, resource_type_id,
           series_label, unit, ts, value)
        SELECT organization_id, account_id, resource_id, plugin_id, resource_type_id,
               series_label, unit, ts, value
        FROM input
        ON CONFLICT DO NOTHING
        RETURNING organization_id, resource_id, series_label, unit, ts, value
      ),
      minute AS (
        INSERT INTO metric_points_1m AS m
          (organization_id, resource_id, series_label, unit, ts_minute,
           value_sum, value_count, value_min, value_max)
        SELECT organization_id, resource_id, series_label, max(unit),
               date_trunc('minute', ts, 'UTC'), sum(value), count(*), min(value), max(value)
        FROM inserted
        GROUP BY organization_id, resource_id, series_label, date_trunc('minute', ts, 'UTC')
        ON CONFLICT (organization_id, resource_id, series_label, ts_minute) DO UPDATE SET
          unit = excluded.unit,
          value_sum = m.value_sum + excluded.value_sum,
          value_count = m.value_count + excluded.value_count,
          value_min = least(m.value_min, excluded.value_min),
          value_max = greatest(m.value_max, excluded.value_max)
      )
      INSERT INTO metric_points_1h AS h
        (organization_id, resource_id, series_label, unit, ts_hour,
         value_sum, value_count, value_min, value_max)
      SELECT organization_id, resource_id, series_label, max(unit),
             date_trunc('hour', ts, 'UTC'), sum(value), count(*), min(value), max(value)
      FROM inserted
      GROUP BY organization_id, resource_id, series_label, date_trunc('hour', ts, 'UTC')
      ON CONFLICT (organization_id, resource_id, series_label, ts_hour) DO UPDATE SET
        unit = excluded.unit,
        value_sum = h.value_sum + excluded.value_sum,
        value_count = h.value_count + excluded.value_count,
        value_min = least(h.value_min, excluded.value_min),
        value_max = greatest(h.value_max, excluded.value_max)
    `);
  } catch (err) {
    console.error("[analytics] insert into metric_points_raw failed:", err);
  }
}

export async function insertDashboardStats(row: {
  organizationId: string;
  accountId: string;
  resourceId: string;
  ts: Date;
  stats: DashboardStat[];
}): Promise<void> {
  await insertRows(dashboardStats, [
    {
      organization_id: row.organizationId,
      account_id: row.accountId,
      resource_id: row.resourceId,
      ts: row.ts.toISOString(),
      stats_json: JSON.stringify(row.stats),
    },
  ]);
}

export async function insertAccountResourceCounts(row: {
  organizationId: string;
  accountId: string;
  ts: Date;
  counts: ResourceCountRow[];
}): Promise<void> {
  await insertRows(accountResourceCounts, [
    {
      organization_id: row.organizationId,
      account_id: row.accountId,
      ts: row.ts.toISOString(),
      counts_json: JSON.stringify(row.counts),
    },
  ]);
}

export async function insertPollOutcome(row: {
  organizationId: string;
  accountId: string;
  pluginId: string;
  ts: Date;
  durationMs: number;
  resourceCount: number;
  succeededTypeCount: number;
  failedTypeCount: number;
  skippedTypeCount: number;
  firstError?: string;
}): Promise<void> {
  await insertRows(pollOutcomes, [
    {
      organization_id: row.organizationId,
      account_id: row.accountId,
      plugin_id: row.pluginId,
      ts: row.ts.toISOString(),
      duration_ms: row.durationMs,
      resource_count: row.resourceCount,
      succeeded_type_count: row.succeededTypeCount,
      failed_type_count: row.failedTypeCount,
      skipped_type_count: row.skippedTypeCount,
      first_error: row.firstError ?? "",
    },
  ]);
}
