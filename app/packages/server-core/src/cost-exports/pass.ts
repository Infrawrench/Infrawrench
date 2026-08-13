/**
 * The poller pass that runs due cost exports.
 *
 * Same protocol as every other claimed pass in this codebase (see
 * `poller/src/claim.ts` for the canonical write-up): one conditional
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, with the
 * row's own due-time column (`cost_exports.next_run_at`) doubling as the lease.
 * Concurrent poller replicas skip past each other's locked rows instead of
 * blocking, and a row is only ever handed to one claimer. An instance that dies
 * mid-run leaves the lease to expire, at which point the export becomes due
 * again — no orphan state, no reaper.
 *
 * Nothing here throws into the tick: {@link runCostExport} already records its
 * own failures on the row, and the claim itself is wrapped by the caller.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { costExports } from "../db/schema";
import type { CostExportDestination, CostExportQuery } from "@infrawrench/client-core";
import { runCostExport } from "./run";
import type { CostExportRecord } from "./store";

/**
 * Must exceed the worst-case duration of one run. A run streams up to 91 daily
 * periods out of ClickHouse and uploads each as its own object, against a
 * bucket that may be on the other side of the planet — minutes, not seconds.
 * Too short and a second replica starts the same export while the first is
 * still uploading, which would have the two racing to overwrite the same keys.
 */
export const COST_EXPORT_LEASE_MS = 30 * 60 * 1000;

/**
 * Exports claimed per tick. Bounded for the same reason the digest is: this
 * shares the poller's 15s tick with account polling and cost collection, and
 * every export on the default 04:00 schedule comes due within the same hour.
 * Claiming moves `next_run_at` forward, so a deferred export simply lands in a
 * later tick's batch — a warehouse feed that arrives a minute later is not late.
 */
export const COST_EXPORTS_PER_TICK = 2;

/**
 * Claim up to `limit` due exports, leasing each for {@link COST_EXPORT_LEASE_MS}.
 *
 * `next_run_at IS NOT NULL` is what excludes disabled and soft-deleted rows
 * without a second predicate: both paths null the column, so "has a due time"
 * and "should run" are the same statement.
 */
export async function claimDueCostExports(limit: number): Promise<CostExportRecord[]> {
  const rows = await db.execute(sql`
    UPDATE cost_exports
    SET next_run_at = now() + ${COST_EXPORT_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT id FROM cost_exports
      WHERE enabled = true
        AND deleted_at IS NULL
        AND next_run_at IS NOT NULL
        AND next_run_at <= now()
      ORDER BY next_run_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    organizationId: String(r["organization_id"]),
    name: String(r["name"]),
    format: String(r["format"]),
    query: r["query"] as CostExportQuery,
    cadence: String(r["cadence"]),
    hour: Number(r["hour"]),
    timezone: String(r["timezone"]),
    restatementDays: Number(r["restatement_days"]),
    enabled: r["enabled"] === true,
    destinationKind: String(r["destination_kind"]),
    destination: r["destination"] as CostExportDestination,
    encryptedCredentials: (r["encrypted_credentials"] as string | null) ?? null,
    credentialsIv: (r["credentials_iv"] as string | null) ?? null,
    credentialHint: (r["credential_hint"] as string | null) ?? null,
    lastRunAt: r["last_run_at"] ? new Date(r["last_run_at"] as string) : null,
    lastStatus: String(r["last_status"]),
    lastError: (r["last_error"] as string | null) ?? null,
    lastObjectCount: r["last_object_count"] === null ? null : Number(r["last_object_count"]),
    lastRowCount: r["last_row_count"] === null ? null : Number(r["last_row_count"]),
    nextRunAt: r["next_run_at"] ? new Date(r["next_run_at"] as string) : null,
    createdByUserId: (r["created_by_user_id"] as string | null) ?? null,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
    deletedAt: r["deleted_at"] ? new Date(r["deleted_at"] as string) : null,
  }));
}

/**
 * One tick's worth of cost exports. Claimed exports run concurrently — each is
 * mostly waiting on a socket — and every one of them records its own outcome,
 * so a rejected settle here means the claim leased a row we then failed to
 * write, which the lease expiry retries.
 */
export async function runCostExportPass(opts: { limit?: number } = {}): Promise<void> {
  const claimed = await claimDueCostExports(opts.limit ?? COST_EXPORTS_PER_TICK);
  if (claimed.length === 0) return;
  console.log(`[cost-export] running ${claimed.length} due export(s)`);
  await Promise.allSettled(claimed.map((row) => runCostExport(row)));
}
