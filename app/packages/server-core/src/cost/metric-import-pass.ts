/**
 * The poller pass that runs due business-metric importers.
 *
 * The claim is the query-monitor protocol: one `UPDATE … WHERE next_run_at <=
 * now() … FOR UPDATE SKIP LOCKED` both selects the batch and pushes each due
 * time forward by the schedule's interval, so several poller replicas share
 * the work without a lease table and a crashed replica's importers simply come
 * due again. Pushing forward *before* running means an importer whose query
 * hangs until the process dies is not reclaimed immediately by the next
 * replica and turned into a stampede against the customer's warehouse.
 *
 * Importers on a soft-deleted metric are skipped by the claim; their rows go
 * when the metric is hard-deleted (the foreign key cascades).
 */
import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { businessMetricImporters, businessMetrics } from "../db/schema";
import { failStaleImportRuns, runBusinessMetricImporter } from "./metric-importers";

export interface MetricImportPassOptions {
  /** Importers to claim per tick. Small: each one queries somebody's production system. */
  limit?: number;
}

interface ClaimedImporter extends Record<string, unknown> {
  id: string;
  organizationId: string;
  metricId: string;
  accountId: string;
  params: Record<string, string>;
  schedule: string;
  backfillDays: number;
  timezone: string;
  aggregation: string;
  consecutiveFailures: number;
}

async function claimDueImporters(limit: number): Promise<ClaimedImporter[]> {
  return db.execute<ClaimedImporter>(sql`
    UPDATE ${businessMetricImporters}
    SET next_run_at = now() + make_interval(hours => CASE schedule
      WHEN 'every_6_hours' THEN 6
      WHEN 'every_12_hours' THEN 12
      WHEN 'weekly' THEN 168
      ELSE 24 END)
    WHERE id IN (
      SELECT i.id FROM ${businessMetricImporters} i
      JOIN ${businessMetrics} m ON m.id = i.metric_id AND m.deleted_at IS NULL
      WHERE i.enabled = true AND i.next_run_at <= now()
      ORDER BY i.next_run_at
      LIMIT ${limit}
      FOR UPDATE OF i SKIP LOCKED
    )
    RETURNING
      id,
      organization_id AS "organizationId",
      metric_id AS "metricId",
      account_id AS "accountId",
      params,
      schedule,
      backfill_days AS "backfillDays",
      timezone,
      aggregation,
      consecutive_failures AS "consecutiveFailures"
  `);
}

/** Claim and run a batch of due importers, sequentially. Returns how many ran. */
export async function runBusinessMetricImportPass(
  options: MetricImportPassOptions = {},
): Promise<number> {
  await failStaleImportRuns();
  const claimed = await claimDueImporters(options.limit ?? 3);
  for (const importer of claimed) {
    try {
      const run = await runBusinessMetricImporter({
        organizationId: importer.organizationId,
        importer,
        trigger: "schedule",
        userId: null,
      });
      if (run.status === "error") {
        console.warn(`[metric-import] importer ${importer.id} failed: ${run.error ?? "unknown"}`);
      }
    } catch (err) {
      // Only bookkeeping can throw here (a source failure is a recorded
      // outcome); log and carry on so one bad row cannot stall the batch.
      console.error(`[metric-import] importer ${importer.id} crashed:`, err);
    }
  }
  return claimed.length;
}
