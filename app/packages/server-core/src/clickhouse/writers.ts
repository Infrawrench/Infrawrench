/**
 * Row writes into the metrics cluster.
 *
 * Every one of these goes through `db.insert(...)`, which sends a `JSONEachRow`
 * body rather than inlining the rows into the statement — see the dialect's
 * `values()`. That matters here more than anywhere else in the codebase: a
 * single poll flattens one resource's series into thousands of points, and
 * inlined they would be one SQL string built in this process and re-parsed field
 * by field as expressions on the other side.
 *
 * `insertMetricPoints` and friends stay fire-and-forget — a metric point is
 * worth less than the poll that produced it, so a failed write is logged and the
 * pass continues. Cost and flow writes are not; they throw. See their modules.
 */
import type { DashboardStat, MetricSeries } from "@infrawrench/plugin-base";
import { getTableName, type InferInsertModel } from "drizzle-orm";
import type { ClickHouseTable } from "drizzle-orm/clickhouse-core";
import { getClickHouseDb, isClickHouseConfigured } from "./client";
import type { ResourceCount } from "./readers";
import { accountResourceCounts, dashboardStats, metricPointsRaw, pollOutcomes } from "./schema";

export type MetricPointRow = InferInsertModel<typeof metricPointsRaw>;

/** What `readResourceCounts` reads back — writer and reader are one contract. */
export type ResourceCountRow = ResourceCount;

/** Flatten MetricSeries[] (one entry per series with N points) into per-point CH rows. */
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
async function insertRows<TTable extends ClickHouseTable>(
  table: TTable,
  values: readonly InferInsertModel<TTable>[],
): Promise<void> {
  if (!isClickHouseConfigured() || values.length === 0) return;
  try {
    await getClickHouseDb()
      .insert(table)
      .values(values as InferInsertModel<TTable>[]);
  } catch (err) {
    console.error(`[clickhouse] insert into ${getTableName(table)} failed:`, err);
  }
}

export async function insertMetricPoints(rows: MetricPointRow[]): Promise<void> {
  await insertRows(metricPointsRaw, rows);
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
