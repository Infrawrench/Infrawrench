import type { DashboardStat, MetricSeries } from "@infrawrench/plugin-base";
import { getClickHouseClient, isClickHouseConfigured } from "./client";
import type { ResourceCount } from "./readers";

export interface MetricPointRow {
  organization_id: string;
  account_id: string;
  resource_id: string;
  plugin_id: string;
  resource_type_id: string;
  series_label: string;
  unit: string;
  ts: string;
  value: number;
}

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
 * Generic over the row type so each caller's row interface is checked against
 * the literal it builds. `@clickhouse/client`'s `insert` is itself generic
 * (`InsertParams<Stream, T>`), so `TRow` flows straight through to the driver
 * instead of being flattened to `object`.
 */
async function insert<TRow>(table: string, values: readonly TRow[]): Promise<void> {
  if (!isClickHouseConfigured() || values.length === 0) return;
  try {
    await getClickHouseClient().insert<TRow>({ table, values, format: "JSONEachRow" });
  } catch (err) {
    console.error(`[clickhouse] insert into ${table} failed:`, err);
  }
}

export async function insertMetricPoints(rows: MetricPointRow[]): Promise<void> {
  await insert("metric_points_raw", rows);
}

export async function insertDashboardStats(row: {
  organizationId: string;
  accountId: string;
  resourceId: string;
  ts: Date;
  stats: DashboardStat[];
}): Promise<void> {
  await insert("dashboard_stats", [
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
  await insert("account_resource_counts", [
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
  await insert("poll_outcomes", [
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
