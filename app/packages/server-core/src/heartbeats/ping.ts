/**
 * Recording a ping from the public URL (`/api/ping/:token[/start|/fail]`).
 *
 * This runs on every ping a customer's job sends, unauthenticated, on the edge
 * Worker, so it is a handful of indexed statements and nothing else:
 *
 * 1. One `UPDATE … WHERE ping_token = $1 RETURNING *` that both finds the row
 *    and counts the ping against the per-minute window kept on the row. The
 *    limit lives in Postgres because an in-memory counter on the edge is per
 *    isolate and would hold nowhere.
 * 2. The state change, computed with the shared schedule arithmetic and
 *    written conditionally on `updated_at`, so a ping that races the poller
 *    marking the row down recomputes from what the poller wrote instead of
 *    silently overwriting a "down" whose alert has already gone out.
 * 3. One insert into the ping history.
 *
 * The token is never logged: errors here name the heartbeat id, not the URL.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  HEARTBEAT_LIMITS,
  heartbeatDeadline,
  heartbeatNextExpected,
  type HeartbeatPingKind,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { heartbeatPings, heartbeats } from "../db/schema";
import { isPingTokenShape, scheduleOf, type HeartbeatRecord } from "./store";
import { notifyHeartbeatDown, notifyHeartbeatRecovered } from "./notify";

export interface PingMeta {
  method: string;
  userAgent: string | null;
  body: string | null;
}

/** What changed, for the caller to announce after answering. */
export type PingTransition =
  | { kind: "down"; heartbeat: HeartbeatRecord; detail: string | null }
  | { kind: "recovered"; heartbeat: HeartbeatRecord };

export type PingOutcome =
  | { outcome: "recorded"; transition: PingTransition | null }
  | { outcome: "not-found" }
  | { outcome: "rate-limited" };

/** A run longer than this is not paired with its start: the start was lost or stale. */
const MAX_RUN_MS = 7 * 24 * 60 * 60 * 1000;

/** Find the row by token and count the ping against its one-minute window. */
async function claimPing(token: string): Promise<HeartbeatRecord | null> {
  const fresh = sql`(${heartbeats.pingWindowStart} IS NULL OR ${heartbeats.pingWindowStart} <= now() - interval '1 minute')`;
  const [row] = await db
    .update(heartbeats)
    .set({
      pingWindowStart: sql`CASE WHEN ${fresh} THEN now() ELSE ${heartbeats.pingWindowStart} END`,
      pingWindowCount: sql`CASE WHEN ${fresh} THEN 1 ELSE ${heartbeats.pingWindowCount} + 1 END`,
    })
    .where(eq(heartbeats.pingToken, token))
    .returning();
  return row ?? null;
}

/** The run's duration, when this ping closes a run opened by a start ping. */
function runDuration(row: HeartbeatRecord, now: Date): number | null {
  const start = row.lastStartAt;
  if (!start) return null;
  if (row.lastPingAt && row.lastPingAt >= start) return null;
  const ms = now.getTime() - start.getTime();
  return ms >= 0 && ms <= MAX_RUN_MS ? ms : null;
}

/** The columns a ping changes, and the transition it causes. */
export function applyPing(
  row: HeartbeatRecord,
  kind: HeartbeatPingKind,
  now: Date,
  body: string | null,
): {
  set: Partial<typeof heartbeats.$inferInsert>;
  durationMs: number | null;
  transition: PingTransition | null;
} {
  const set: Partial<typeof heartbeats.$inferInsert> = { updatedAt: now };
  if (kind === "start") {
    set.lastStartAt = now;
    return { set, durationMs: null, transition: null };
  }

  const durationMs = runDuration(row, now);
  if (durationMs !== null) set.lastDurationMs = durationMs;
  set.lastPingAt = now;
  if (kind === "fail") set.lastFailAt = now;

  // A paused heartbeat keeps its history and nothing else.
  if (!row.enabled) return { set, durationMs, transition: null };

  const schedule = scheduleOf(row);
  set.nextExpectedAt = heartbeatNextExpected(schedule, now);

  if (kind === "fail") {
    set.status = "down";
    set.downReason = "failed";
    set.deadlineAt = null;
    // Already down: the outage is open and announced; another failure of the
    // same job is the same outage.
    if (row.status === "down") return { set, durationMs, transition: null };
    set.lastStateChangeAt = now;
    const next = { ...row, ...set } as HeartbeatRecord;
    return { set, durationMs, transition: { kind: "down", heartbeat: next, detail: body } };
  }

  set.status = "up";
  set.downReason = null;
  set.deadlineAt = heartbeatDeadline(schedule, row.graceMinutes, now);
  if (row.status !== "up") set.lastStateChangeAt = now;
  const transition: PingTransition | null =
    row.status === "down"
      ? { kind: "recovered", heartbeat: { ...row, ...set } as HeartbeatRecord }
      : null;
  return { set, durationMs, transition };
}

/**
 * Record one ping. Never throws for a caller mistake: an unknown token and a
 * full window are outcomes, so the route answers them without a stack trace.
 */
export async function recordHeartbeatPing(
  token: string,
  kind: HeartbeatPingKind,
  meta: PingMeta,
  now = new Date(),
): Promise<PingOutcome> {
  if (!isPingTokenShape(token)) return { outcome: "not-found" };
  let row = await claimPing(token);
  if (!row) return { outcome: "not-found" };
  if (row.pingWindowCount > HEARTBEAT_LIMITS.maxPingsPerMinute) return { outcome: "rate-limited" };

  const body = meta.body ? meta.body.slice(0, HEARTBEAT_LIMITS.maxPingBodyChars) : null;
  let applied = applyPing(row, kind, now, body);
  for (let attempt = 0; ; attempt++) {
    // The last attempt writes unconditionally: a heartbeat edited three times
    // during one ping still records it.
    const guard =
      attempt < 2
        ? and(eq(heartbeats.id, row.id), eq(heartbeats.updatedAt, row.updatedAt))
        : eq(heartbeats.id, row.id);
    const written = await db
      .update(heartbeats)
      .set(applied.set)
      .where(guard)
      .returning({ id: heartbeats.id });
    if (written.length > 0) break;
    if (attempt >= 2) return { outcome: "not-found" };
    // Something else (the poller, an edit, a concurrent ping) wrote first:
    // recompute from what it wrote.
    const [current] = await db.select().from(heartbeats).where(eq(heartbeats.id, row.id));
    if (!current) return { outcome: "not-found" };
    row = current;
    applied = applyPing(row, kind, now, body);
  }

  await db.insert(heartbeatPings).values({
    id: randomUUID(),
    heartbeatId: row.id,
    organizationId: row.organizationId,
    kind,
    receivedAt: now,
    durationMs: applied.durationMs,
    method: meta.method.slice(0, 10),
    userAgent: meta.userAgent ? meta.userAgent.slice(0, 200) : null,
    body,
  });
  return { outcome: "recorded", transition: applied.transition };
}

/** Announce a ping's transition. Never throws: the ping is already recorded. */
export async function announcePingTransition(transition: PingTransition): Promise<void> {
  try {
    if (transition.kind === "down") {
      await notifyHeartbeatDown(transition.heartbeat, "failed", transition.detail);
    } else {
      await notifyHeartbeatRecovered(transition.heartbeat);
    }
  } catch (err) {
    console.error(`[heartbeats] notification for ${transition.heartbeat.id} failed:`, err);
  }
}
