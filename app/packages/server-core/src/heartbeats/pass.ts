/**
 * The poller's heartbeat pass: mark heartbeats whose deadline has passed as
 * down, and announce each once.
 *
 * The deadline is precomputed by the ping route (the next expected ping plus
 * grace), so this is one indexed range scan with no cron arithmetic. The
 * transition and the claim are the same statement: `UPDATE … WHERE id IN
 * (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *` flips `up` to `down` and
 * clears the deadline, so replicas never double-alert and a heartbeat already
 * down is never claimed again.
 *
 * Postgres and `routeAlert` only, so it can run on the edge (the probes pass's
 * runtime). Never throws: it runs inside the poller loop.
 */
import { and, asc, eq, inArray, lte, lt } from "drizzle-orm";
import { HEARTBEAT_LIMITS } from "@infrawrench/client-core";
import { db } from "../db/client";
import { heartbeatPings, heartbeats } from "../db/schema";
import { notifyHeartbeatDown } from "./notify";

export interface HeartbeatPassOutcome {
  missed: number;
}

/** Flip up to `limit` overdue heartbeats to down, returning the rows as they now are. */
export async function claimMissedHeartbeats(limit: number, now = new Date()) {
  const due = db
    .select({ id: heartbeats.id })
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.enabled, true),
        eq(heartbeats.status, "up"),
        lte(heartbeats.deadlineAt, now),
      ),
    )
    .orderBy(asc(heartbeats.deadlineAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  return db
    .update(heartbeats)
    .set({
      status: "down",
      downReason: "missed",
      deadlineAt: null,
      lastStateChangeAt: now,
      updatedAt: now,
    })
    .where(inArray(heartbeats.id, due))
    .returning();
}

/** Claim and announce a bounded batch of missed heartbeats. Never throws. */
export async function runHeartbeatPass(
  options: { limit?: number; now?: Date } = {},
): Promise<HeartbeatPassOutcome> {
  let missed: Awaited<ReturnType<typeof claimMissedHeartbeats>>;
  try {
    missed = await claimMissedHeartbeats(options.limit ?? 50, options.now);
  } catch (err) {
    console.error("[heartbeats] claim failed:", err);
    return { missed: 0 };
  }
  // The state is durable before anything is sent: no other replica can claim
  // these rows again, so each outage is announced at most once.
  await Promise.allSettled(
    missed.map((row) =>
      notifyHeartbeatDown(row, "missed").catch((err) =>
        console.error(`[heartbeats] notification for ${row.id} failed:`, err),
      ),
    ),
  );
  return { missed: missed.length };
}

/** Drop ping history past the retention window. Idempotent; the retention pass calls it. */
export async function pruneHeartbeatPings(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - HEARTBEAT_LIMITS.pingRetentionDays * 86_400_000);
  await db.delete(heartbeatPings).where(lt(heartbeatPings.receivedAt, cutoff));
}
