/**
 * Retention for recorded SSH sessions.
 *
 * Unlike the change-timeline prune, the window is per organization: recording
 * is a compliance control and the regime an org is under is what sets how long
 * the tape is kept, so `org_session_recording_settings.retention_days` is
 * authoritative and this pass reads it per org.
 *
 * Only orgs that have a settings row are scanned. An org that never enabled
 * recording has nothing to prune, and the ones that disabled it keep their
 * window — turning recording off must not be a way to make yesterday's tapes
 * vanish faster than the policy says.
 */
import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { orgSessionRecordingSettings } from "../db/schema";

import { clampRetentionDays } from "./settings";
import { pruneOrgSessionRecordings } from "./store";

/**
 * How often the pass does real work. Recordings expire on a day boundary at
 * the finest, so an hour keeps the tables within an hour of the policy while
 * costing 24 index probes a day per org.
 */
export const RECORDING_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/** Recordings deleted per statement. Each drags its chunks with it. */
const PRUNE_BATCH_SIZE = 200;

/**
 * Ceiling on batches per org per pass. The leftovers go on the next pass an
 * hour later; a backlog must not turn one retention pass into an unbounded
 * loop holding the poller's tick.
 */
const MAX_PRUNE_BATCHES_PER_ORG = 25;

export interface RecordingRetentionResult {
  organizationsScanned: number;
  deleted: number;
  failed: number;
  /** True when an org hit the per-pass ceiling and has expired rows left. */
  truncated: boolean;
}

/**
 * Delete every org's recordings older than that org's window.
 *
 * Replica-safe without a claim: the delete is idempotent and two pollers
 * racing simply find fewer rows each. Never throws — a failing org is logged
 * and the pass moves on.
 */
export async function pruneSessionRecordings(now = new Date()): Promise<RecordingRetentionResult> {
  let orgs: Array<{ organizationId: string; retentionDays: number }>;
  try {
    orgs = await db
      .select({
        organizationId: orgSessionRecordingSettings.organizationId,
        retentionDays: orgSessionRecordingSettings.retentionDays,
      })
      .from(orgSessionRecordingSettings);
  } catch (err) {
    console.error("[retention] failed to list session-recording settings:", err);
    return { organizationsScanned: 0, deleted: 0, failed: 0, truncated: false };
  }

  let deleted = 0;
  let failed = 0;
  let truncated = false;

  for (const org of orgs) {
    const days = clampRetentionDays(org.retentionDays);
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    try {
      for (let batch = 0; batch < MAX_PRUNE_BATCHES_PER_ORG; batch++) {
        const removed = await pruneOrgSessionRecordings(
          org.organizationId,
          cutoff,
          PRUNE_BATCH_SIZE,
        );
        deleted += removed;
        if (removed < PRUNE_BATCH_SIZE) break;
        if (batch === MAX_PRUNE_BATCHES_PER_ORG - 1) {
          truncated = true;
          console.warn(
            `[retention] org ${org.organizationId}: hit the ${MAX_PRUNE_BATCHES_PER_ORG}-batch ` +
              `session-recording ceiling, resuming next pass`,
          );
        }
      }
    } catch (err) {
      failed++;
      console.error(`[retention] org ${org.organizationId}: recording prune failed:`, err);
    }
  }

  if (deleted > 0 || failed > 0) {
    console.log(
      `[retention] ssh_session_recordings: deleted ${deleted} recording(s) across ` +
        `${orgs.length} org(s)` +
        (failed > 0 ? `, ${failed} org(s) failed` : ""),
    );
  }
  return { organizationsScanned: orgs.length, deleted, failed, truncated };
}

/**
 * Settle rows the recorder never closed, so an operator does not see a
 * week-old session claiming to be live.
 *
 * The list view derives "abandoned" for presentation; this makes it durable so
 * a status filter in SQL (and anything reading the table directly — the CLI's
 * `--json`, an export) agrees with the UI. Bounded and idempotent.
 */
export async function settleAbandonedRecordings(olderThanMs = 10 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
  try {
    const result = await db.execute(sql`
      UPDATE ssh_session_recordings
      SET status = 'abandoned',
          ended_at = coalesce(ended_at, started_at)
      WHERE id IN (
        SELECT id FROM ssh_session_recordings
        WHERE status = 'recording'
          AND coalesce(ended_at, started_at) < ${cutoff}::timestamp
        LIMIT 500
        FOR UPDATE SKIP LOCKED
      )
    `);
    const r = result as { count?: unknown; rowCount?: unknown } | null;
    if (typeof r?.count === "number") return r.count;
    if (typeof r?.rowCount === "number") return r.rowCount;
    return Array.isArray(result) ? result.length : 0;
  } catch (err) {
    console.error("[retention] settling abandoned session recordings failed:", err);
    return 0;
  }
}
