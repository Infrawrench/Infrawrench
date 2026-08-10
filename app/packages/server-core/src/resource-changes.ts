import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db/client";
import { resourceChanges } from "./db/schema";

/**
 * Persistence + retention for the change timeline / drift feed.
 *
 * The diff itself is pure and lives in `@infrawrench/client-core`
 * (`resource-changes.ts`), because it has a second caller that never touches
 * this database: the environment diff compares two accounts' inventories with
 * the same comparison, and runs on the desktop and the CLI as well as here.
 * It is re-exported below so the sync path, the poller and their tests import
 * it from where they always have.
 */
export {
  computeResourceChangeEvents,
  diffResourceRecords,
  valuesEqual,
} from "@infrawrench/client-core";
export type {
  ComputeChangeEventsArgs,
  FetchedResourceSnapshot,
  PriorResourceSnapshot,
  ResourceChangeEvent,
  ResourceFieldChange,
} from "@infrawrench/client-core";

import type { ResourceChangeEvent } from "@infrawrench/client-core";

const INSERT_CHUNK_SIZE = 200;

/** Persist computed events. Callers wrap this so a write failure never breaks a poll cycle. */
export async function recordResourceChanges(
  organizationId: string,
  accountId: string,
  events: ResourceChangeEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const now = new Date();
  for (let i = 0; i < events.length; i += INSERT_CHUNK_SIZE) {
    const chunk = events.slice(i, i + INSERT_CHUNK_SIZE);
    await db.insert(resourceChanges).values(
      chunk.map((e) => ({
        id: randomUUID(),
        organizationId,
        accountId,
        resourceId: e.resourceId,
        pluginId: e.pluginId,
        resourceTypeId: e.resourceTypeId,
        displayName: e.displayName,
        changeKind: e.changeKind,
        diff: e.diff,
        origin: e.origin ?? null,
        createdAt: now,
      })),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * How long a change event stays in the feed.
 *
 * The table is append-only and every poll can add rows, so it needs a bound.
 * 90 days is chosen against what actually reads it: neither consumer asks for
 * a fixed range — the org feed (`GET /changes`) is offset-paginated with
 * optional `from`/`to`, and the per-resource tab asks for the last N events —
 * so any window is a truncation of "scroll back forever" and the only question
 * is where the floor sits. A quarter covers the questions the feed exists to
 * answer ("when did this change?", "what moved last quarter?"), and it is an
 * order of magnitude beyond every other time span in the product: the weekly
 * digest looks back two weeks (and reads `resources`/`paging_incidents`, never
 * this table), cost anomaly detection lives in ClickHouse, and
 * `account_sync_failures` is minutes.
 *
 * Deliberately a constant, not a per-org setting: a per-org window would need
 * a schema change and a settings surface for a number nobody has asked to
 * tune. Raising it later is a one-line change that loses no data; lowering it
 * is the destructive direction, which is the right way round.
 */
export const CHANGE_RETENTION_DAYS = 90;

/**
 * How often the retention pass does real work. Pruning is cheap but pointless
 * to run on the poller's 15s tick — an hour keeps the table bounded to within
 * an hour of the window with ~24 passes a day.
 */
export const CHANGE_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Rows deleted per statement. Bounded so a first prune of a long-neglected
 * table can't hold locks (or a transaction) for minutes at a time.
 */
const PRUNE_BATCH_SIZE = 2_000;

/**
 * Ceiling on batches per org per pass (100k rows). Whatever is left over is
 * simply pruned on the next pass an hour later — a backlog must not turn one
 * retention pass into an unbounded loop.
 */
const MAX_PRUNE_BATCHES_PER_ORG = 50;

export interface ChangeRetentionResult {
  /** Rows older than this were deleted. */
  cutoff: Date;
  organizationsScanned: number;
  deleted: number;
  /** Orgs whose prune threw (logged, then skipped). */
  failed: number;
  /** True when some org hit the per-pass batch ceiling and has rows left. */
  truncated: boolean;
}

/**
 * Rows affected by a statement. postgres-js returns a `RowList` (an array
 * carrying the command tag's `count`); the fallbacks keep this honest under
 * other drivers and test doubles.
 */
function affectedRows(result: unknown): number {
  const r = result as { count?: unknown; rowCount?: unknown } | null;
  if (typeof r?.count === "number") return r.count;
  if (typeof r?.rowCount === "number") return r.rowCount;
  return Array.isArray(result) ? result.length : 0;
}

/**
 * Format a cutoff the way drizzle writes a `timestamp` (no timezone) column:
 * UTC, no `Z`. Sending a bare `Date` through the raw `sql` tag would let the
 * driver stamp a local-time offset onto a column that has none.
 */
function timestampLiteral(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Delete change events older than {@link CHANGE_RETENTION_DAYS}.
 *
 * Driven per organization on purpose: `resource_changes_org_created_idx` is
 * `(organization_id, created_at)`, so a per-org prune is an index range scan
 * straight onto the expired rows, while a single global `created_at < cutoff`
 * has no usable leading column and degrades into a scan of the whole table.
 * Orgs with nothing expired cost one index probe.
 *
 * Replica- and restart-safe without any claim bookkeeping: the delete is
 * idempotent, and `FOR UPDATE SKIP LOCKED` means two pollers pruning at once
 * take disjoint batches instead of blocking on each other. A partially
 * completed pass simply leaves rows for the next one.
 *
 * Never throws: a failing org is logged and the pass moves on, so retention
 * can't take down the tick that hosts it.
 */
export async function pruneResourceChanges(now = new Date()): Promise<ChangeRetentionResult> {
  const cutoff = new Date(now.getTime() - CHANGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffText = timestampLiteral(cutoff);

  let organizationIds: string[];
  try {
    const orgRows = await db.execute(sql`SELECT id FROM organizations`);
    organizationIds = Array.from(orgRows as Iterable<Record<string, unknown>>, (r) =>
      String(r["id"]),
    );
  } catch (err) {
    console.error("[retention] failed to list organizations for resource_changes prune:", err);
    return { cutoff, organizationsScanned: 0, deleted: 0, failed: 0, truncated: false };
  }

  let deleted = 0;
  let failed = 0;
  let truncated = false;

  for (const organizationId of organizationIds) {
    try {
      for (let batch = 0; batch < MAX_PRUNE_BATCHES_PER_ORG; batch++) {
        const result = await db.execute(sql`
          DELETE FROM resource_changes
          WHERE ctid IN (
            SELECT ctid FROM resource_changes
            WHERE organization_id = ${organizationId}
              AND created_at < ${cutoffText}::timestamp
            ORDER BY created_at ASC
            LIMIT ${PRUNE_BATCH_SIZE}
            FOR UPDATE SKIP LOCKED
          )
        `);
        const removed = affectedRows(result);
        deleted += removed;
        // A short batch means the org is drained (or another replica holds the
        // rest — same outcome: stop here).
        if (removed < PRUNE_BATCH_SIZE) break;
        if (batch === MAX_PRUNE_BATCHES_PER_ORG - 1) {
          truncated = true;
          console.warn(
            `[retention] org ${organizationId}: hit the ${MAX_PRUNE_BATCHES_PER_ORG}-batch ceiling, ` +
              `resuming next pass`,
          );
        }
      }
    } catch (err) {
      failed++;
      console.error(`[retention] org ${organizationId}: resource_changes prune failed:`, err);
    }
  }

  console.log(
    `[retention] resource_changes: deleted ${deleted} row(s) older than ${cutoffText} ` +
      `(${CHANGE_RETENTION_DAYS}d) across ${organizationIds.length} org(s)` +
      (failed > 0 ? `, ${failed} org(s) failed` : ""),
  );

  return { cutoff, organizationsScanned: organizationIds.length, deleted, failed, truncated };
}
