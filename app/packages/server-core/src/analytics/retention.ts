import { getTableName, sql } from "drizzle-orm";
import { ANALYTICS_RETENTION } from "../db/analytics-schema";
import { getAnalyticsDb } from "./client";

/**
 * How often the `analytics-retention` poller pass does real work. Expiry is
 * measured in days, so hourly is more than precise enough; it is hourly rather
 * than daily so a table whose expired rows outrun one run's ceiling (below)
 * catches up within the day instead of falling further behind.
 */
export const ANALYTICS_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Rows deleted per statement. Each batch is its own short transaction, so a
 * first prune of a long-neglected table never holds row locks, or a snapshot
 * that keeps vacuum from cleaning up, for longer than one batch takes.
 */
export const RETENTION_BATCH_SIZE = 5_000;

/**
 * Ceiling on batches per table per run (half a million rows). Anything left is
 * deleted on the next run an hour later: a backlog must not turn one pass into
 * an unbounded loop.
 */
export const MAX_RETENTION_BATCHES_PER_TABLE = 100;

export interface TableRetentionResult {
  table: string;
  deleted: number;
  /** True when the table hit the batch ceiling and still has expired rows. */
  truncated: boolean;
  /** Set when the table's prune threw (logged, then skipped). */
  error?: string;
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
 * Delete every analytics row older than its table's window in
 * {@link ANALYTICS_RETENTION}.
 *
 * The cutoff is computed by the database (`now() - keep`), and for the `day`
 * tables it is cast to a `date` so the comparison stays on the column's own
 * type and an index on it remains usable. Each statement deletes at most
 * {@link RETENTION_BATCH_SIZE} rows picked by `ctid`, with `SKIP LOCKED` so two
 * pollers pruning at once take disjoint batches rather than queueing behind
 * each other; a short batch means the table is drained.
 *
 * Global rather than per organization on purpose: rows of a deleted
 * organization expire like any other, and nothing else would remove them.
 *
 * Never throws: a failing table is logged and the run moves on to the next.
 */
export async function pruneAnalytics(): Promise<TableRetentionResult[]> {
  const db = getAnalyticsDb();
  const results: TableRetentionResult[] = [];

  for (const { table, column, keep } of ANALYTICS_RETENTION) {
    const name = getTableName(table);
    const cutoff =
      column.getSQLType() === "date" ? sql`(now() - ${keep})::date` : sql`now() - ${keep}`;
    const result: TableRetentionResult = { table: name, deleted: 0, truncated: false };
    try {
      for (let batch = 0; batch < MAX_RETENTION_BATCHES_PER_TABLE; batch++) {
        const removed = affectedRows(
          await db.execute(sql`
            DELETE FROM ${table}
            WHERE ctid IN (
              SELECT ctid FROM ${table}
              WHERE ${column} < ${cutoff}
              LIMIT ${RETENTION_BATCH_SIZE}
              FOR UPDATE SKIP LOCKED
            )
          `),
        );
        result.deleted += removed;
        // A short batch means the table is drained (or another replica holds
        // the rest; same outcome: stop here).
        if (removed < RETENTION_BATCH_SIZE) break;
        if (batch === MAX_RETENTION_BATCHES_PER_TABLE - 1) {
          result.truncated = true;
          console.warn(
            `[analytics-retention] ${name}: hit the ${MAX_RETENTION_BATCHES_PER_TABLE}-batch ` +
              `ceiling, resuming next run`,
          );
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`[analytics-retention] ${name}: prune failed:`, err);
    }
    results.push(result);
  }

  const deleted = results.filter((r) => r.deleted > 0);
  if (deleted.length > 0) {
    console.log(
      `[analytics-retention] deleted ${deleted.map((r) => `${r.deleted} from ${r.table}`).join(", ")}`,
    );
  }
  return results;
}
