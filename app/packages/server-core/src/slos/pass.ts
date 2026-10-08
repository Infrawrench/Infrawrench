/**
 * The poller's SLO pass: claim due SLOs, evaluate them, reschedule.
 *
 * `slos.next_eval_at` is the due column AND the claim lease, the metric-alert
 * protocol verbatim: one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
 * LOCKED) RETURNING`, so replicas share the work and a replica that dies
 * mid-pass lets its SLOs come due again when the lease expires.
 *
 * Runtime `edge`: an evaluation reads Postgres and ClickHouse and routes
 * alerts over fixed HTTPS services, and calls no plugin code, exactly like the
 * metric-alert pass it sits beside.
 *
 * Never throws.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { slos } from "../db/schema";
import { evaluateSlo } from "./eval";
import type { SloRecord } from "./store";

/** Must exceed one evaluation (two bounded ClickHouse reads) with a wide margin. */
export const SLO_LEASE_MS = 5 * 60 * 1000;

/**
 * How often each SLO re-evaluates. The shortest burn window is five minutes,
 * so a minute keeps the fast-burn page within a couple of minutes of the
 * burning starting.
 */
export const SLO_EVAL_INTERVAL_MS = 60 * 1000;

export async function claimDueSlos(limit: number): Promise<SloRecord[]> {
  const claimed = await db.execute(sql`
    UPDATE slos
    SET next_eval_at = now() + ${SLO_LEASE_MS}::float8 * interval '1 millisecond'
    WHERE id IN (
      SELECT id FROM slos
      WHERE enabled = true
        AND (next_eval_at IS NULL OR next_eval_at <= now())
      ORDER BY last_eval_at ASC NULLS FIRST, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  const ids = Array.from(claimed as Iterable<Record<string, unknown>>, (r) => String(r["id"]));
  if (ids.length === 0) return [];
  // Re-read through Drizzle so column types (timestamps, jsonb) come back typed.
  return db.select().from(slos).where(inArray(slos.id, ids));
}

async function reschedule(sloId: string, now: Date): Promise<void> {
  try {
    await db
      .update(slos)
      .set({ nextEvalAt: new Date(now.getTime() + SLO_EVAL_INTERVAL_MS) })
      .where(eq(slos.id, sloId));
  } catch (err) {
    console.error(`[slos] slo ${sloId} reschedule failed:`, err);
  }
}

export async function runSloPass(options: { limit?: number } = {}): Promise<{ claimed: number }> {
  let claimed: SloRecord[];
  try {
    claimed = await claimDueSlos(options.limit ?? 10);
  } catch (err) {
    console.error("[slos] claim failed:", err);
    return { claimed: 0 };
  }
  await Promise.allSettled(
    claimed.map(async (row) => {
      const now = new Date();
      await evaluateSlo(row, now);
      await reschedule(row.id, now);
    }),
  );
  return { claimed: claimed.length };
}
