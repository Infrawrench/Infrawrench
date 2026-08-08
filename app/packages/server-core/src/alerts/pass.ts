/**
 * The follow-up pass: release quiet-hours holds, escalate what nobody
 * acknowledged.
 *
 * Both halves are the same shape — rows with a deadline in a timestamp column —
 * so both use the claim the poller already uses for due accounts and due
 * workflows (`poller/src/claim.ts`): a single
 *
 *     UPDATE … SET <due column> = <lease>
 *      WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED LIMIT n)
 *   RETURNING *
 *
 * The claim writes a lease into the row's own due column, so no extra
 * bookkeeping column was needed and a replica that dies mid-send simply lets
 * the row come due again at lease expiry. Concurrent replicas skip each other's
 * locked rows, so a held alert is released exactly once even with N pollers.
 *
 * This is deliberately *not* the cooldown protocol that decides whether an
 * alert is raised at all. Those live with each detector — `inCooldown` in
 * `cost/anomaly-eval.ts`, `PageCooldownStore` in `paging/deliver.ts`,
 * `org_drift_alert_settings.last_notified_at` — and are untouched by routing. A
 * row only reaches this table after one of them was already won, so nothing
 * here can cause a second alert about the same event.
 */
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { AlertDestination, EscalationPolicy } from "@infrawrench/client-core";

import { db } from "../db/client";
import { alertDeliveries } from "../db/schema";
import { type AlertEvent, routeAlert } from "./route";

type Row = typeof alertDeliveries.$inferSelect;

/**
 * How long a claimed row is invisible to other replicas. Generous relative to
 * the work (a fan-out to a handful of webhooks) because the cost of a lease
 * that is too short is a double send, and the cost of one that is too long is a
 * few minutes' delay on a retry.
 */
const CLAIM_LEASE_MS = 5 * 60_000;

/** Rows one tick will take, per half. Bounded so a backlog spreads over ticks. */
const BATCH = 50;

/**
 * Give up on a row after this many *delivery attempts*. A row that keeps
 * failing is failing for a reason that will not fix itself — a deleted channel,
 * a revoked webhook — and retrying it forever would mean the pass never drains.
 *
 * The claim increments `attemptCount` before `flushHold`/`escalate` read it, so
 * the guards below compare with `>`: claim N runs the Nth send, and claim
 * `MAX_ATTEMPTS + 1` is the one that does no send and expires the row. That is
 * one extra *claim*, not one extra delivery.
 */
const MAX_ATTEMPTS = 5;

/** Parse a stored payload back into an event, or null if it is unusable. */
function toEvent(row: Row): AlertEvent | null {
  const payload = row.payload as AlertEvent | null;
  if (!payload || typeof payload !== "object" || !payload.organizationId) return null;
  return payload;
}

/**
 * Claim up to `BATCH` held rows whose window has closed, leasing them forward
 * so a concurrent replica sees them as not-yet-due.
 */
async function claimReleasedHolds(now: Date): Promise<Row[]> {
  const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
  const claimed = await db
    .update(alertDeliveries)
    .set({
      deliverAfter: lease,
      attemptCount: sql`${alertDeliveries.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      inArray(
        alertDeliveries.id,
        db
          .select({ id: alertDeliveries.id })
          .from(alertDeliveries)
          .where(
            and(
              eq(alertDeliveries.state, "held"),
              isNotNull(alertDeliveries.deliverAfter),
              lte(alertDeliveries.deliverAfter, now),
            ),
          )
          .limit(BATCH)
          .for("update", { skipLocked: true }),
      ),
    )
    .returning();
  return claimed;
}

/** Claim up to `BATCH` rows whose acknowledgement deadline has passed. */
async function claimOverdueEscalations(now: Date): Promise<Row[]> {
  const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
  return db
    .update(alertDeliveries)
    .set({
      escalateAt: lease,
      attemptCount: sql`${alertDeliveries.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      inArray(
        alertDeliveries.id,
        db
          .select({ id: alertDeliveries.id })
          .from(alertDeliveries)
          .where(
            and(
              eq(alertDeliveries.state, "awaiting_ack"),
              isNotNull(alertDeliveries.escalateAt),
              lte(alertDeliveries.escalateAt, now),
            ),
          )
          .limit(BATCH)
          .for("update", { skipLocked: true }),
      ),
    )
    .returning();
}

/** Close a row out, clearing both deadlines so neither claim can pick it up again. */
async function finish(id: string, state: string, now: Date): Promise<void> {
  await db
    .update(alertDeliveries)
    .set({ state, deliverAfter: null, escalateAt: null, updatedAt: now })
    .where(eq(alertDeliveries.id, id));
}

/**
 * Send one released hold to the destinations it was queued for.
 *
 * The rule is not re-evaluated. The org may have edited its rules in the
 * intervening hours, and re-routing a held alert through the new table would
 * make the message the user sees depend on when they happened to save a form.
 * The queued destinations are what the rule said when the alert happened, which
 * is the honest answer.
 *
 * Returns true only when the message actually went somewhere — a dropped
 * payload, an exhausted row and a send that reached nobody all return false.
 */
async function flushHold(row: Row, now: Date): Promise<boolean> {
  const event = toEvent(row);
  if (!event) {
    console.error(`[alerts] held delivery ${row.id} has an unreadable payload; dropping`);
    await finish(row.id, "expired", now);
    return false;
  }
  if (row.attemptCount > MAX_ATTEMPTS) {
    console.error(`[alerts] held delivery ${row.id} exceeded ${MAX_ATTEMPTS} attempts; giving up`);
    await finish(row.id, "expired", now);
    return false;
  }

  const destinations = (row.destinations as AlertDestination[] | null) ?? [];
  const escalation = row.escalation as EscalationPolicy | null;

  // Sent through `routeAlert` with exactly one pinned leg, so the held copy
  // goes out through the same fan-out, de-duplication and channel-only-push
  // rules the immediate copy would have used — rather than a second, subtly
  // different send path that only quiet-hours users ever exercise.
  //
  // `ackDeliveryId` hands it *this* row: the escalation clock is already
  // recorded here, and letting the replay arm another would give one alert two
  // deadlines and a button that only silences one of them.
  const result = await routeAlert(event, {
    bypassQuietHours: true,
    now,
    ...(escalation ? { ackDeliveryId: row.id } : {}),
    pinnedLegs: [
      {
        ruleId: row.ruleId ?? "held",
        ruleName: row.ruleName ?? "Quiet hours",
        destinations,
        escalation,
        holdUntil: null,
      },
    ],
  });

  // A flush that reached nobody is left claimed-but-due-again: the lease
  // expires and the next tick retries, up to MAX_ATTEMPTS. Marking it sent
  // would lose it, and deleting it would hide a broken channel.
  if (result.succeeded === 0 && result.held === 0) {
    console.error(`[alerts] flush of held delivery ${row.id} reached nobody; will retry`);
    return false;
  }

  if (!escalation) {
    await finish(row.id, "sent", now);
    return true;
  }

  // A held alert that also escalates starts its acknowledgement clock *now*,
  // not when it was raised — nobody could have acknowledged a message that had
  // not been sent yet, so carrying the original deadline forward would escalate
  // it the instant the quiet window closed.
  //
  // `attemptCount` is reset with it. The counter is shared by both halves of
  // this pass, so a hold that needed four flush attempts would otherwise reach
  // the escalation half with one claim left and give up before it ever reached
  // the escalation destinations — exactly the silence the policy exists to
  // prevent. The flush attempts are spent; the escalation gets its own budget.
  await db
    .update(alertDeliveries)
    .set({
      state: "awaiting_ack",
      deliverAfter: null,
      escalateAt: new Date(now.getTime() + escalation.afterMinutes * 60_000),
      attemptCount: 0,
      updatedAt: now,
    })
    .where(eq(alertDeliveries.id, row.id));
  return true;
}

/**
 * Send one overdue alert to its escalation destinations. Returns true only when
 * the escalation reached somebody, on the same terms as {@link flushHold}.
 */
async function escalate(row: Row, now: Date): Promise<boolean> {
  const event = toEvent(row);
  const escalation = row.escalation as EscalationPolicy | null;
  if (!event || !escalation || escalation.destinations.length === 0) {
    await finish(row.id, "expired", now);
    return false;
  }
  if (row.attemptCount > MAX_ATTEMPTS) {
    console.error(`[alerts] escalation ${row.id} exceeded ${MAX_ATTEMPTS} attempts; giving up`);
    await finish(row.id, "expired", now);
    return false;
  }

  const minutes = escalation.afterMinutes;
  const result = await routeAlert(
    {
      ...event,
      // Re-titled rather than re-sent verbatim: the escalation's whole job is to
      // say "this one was not picked up", and a second identical message reads
      // as a duplicate rather than as a second, louder ask.
      title: `Unacknowledged: ${event.title}`,
      body: `${event.body}\n\nNobody acknowledged this within ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      pushBody: `Unacknowledged after ${minutes} minute${minutes === 1 ? "" : "s"}. ${event.pushBody ?? event.body}`,
      severity: "critical",
    },
    {
      bypassQuietHours: true,
      now,
      pinnedLegs: [
        {
          ruleId: row.ruleId ?? "escalation",
          ruleName: row.ruleName ? `${row.ruleName} (escalation)` : "Escalation",
          destinations: escalation.destinations,
          // No further escalation: one hop, or an unacknowledged alert would
          // ping-pong between two channels forever.
          escalation: null,
          holdUntil: null,
        },
      ],
    },
  );

  if (result.succeeded === 0) {
    console.error(`[alerts] escalation of ${row.id} reached nobody; will retry`);
    return false;
  }
  await finish(row.id, "escalated", now);
  return true;
}

export interface AlertFollowUpStats {
  /**
   * Rows that actually went somewhere. A claim that dropped an unreadable
   * payload, gave up on an exhausted row, or sent to nobody is not counted —
   * this number is read as "follow-ups that worked", so counting claims here
   * would report successful deliveries for rows that delivered nothing.
   */
  flushed: number;
  escalated: number;
}

/**
 * One tick of the follow-up pass. Never throws — like every other poller pass,
 * a failure here must not stop the ones after it.
 */
export async function runAlertFollowUpPass(now = new Date()): Promise<AlertFollowUpStats> {
  const stats: AlertFollowUpStats = { flushed: 0, escalated: 0 };

  try {
    const holds = await claimReleasedHolds(now);
    for (const row of holds) {
      try {
        if (await flushHold(row, now)) stats.flushed += 1;
      } catch (err) {
        console.error(`[alerts] failed to flush held delivery ${row.id}:`, err);
      }
    }
    if (holds.length === BATCH) {
      console.log(`[alerts] flushed a full batch of ${BATCH} holds; more remain for the next tick`);
    }
  } catch (err) {
    console.error("[alerts] hold flush pass failed:", err);
  }

  try {
    const overdue = await claimOverdueEscalations(now);
    for (const row of overdue) {
      try {
        if (await escalate(row, now)) stats.escalated += 1;
      } catch (err) {
        console.error(`[alerts] failed to escalate delivery ${row.id}:`, err);
      }
    }
    if (overdue.length === BATCH) {
      console.log(`[alerts] escalated a full batch of ${BATCH}; more remain for the next tick`);
    }
  } catch (err) {
    console.error("[alerts] escalation pass failed:", err);
  }

  return stats;
}

/**
 * Rows older than this are deleted by the retention sweep. Long enough that the
 * "recent alerts" list in settings covers a fortnight of on-call, short enough
 * that the table stays small.
 */
export const ALERT_DELIVERY_RETENTION_DAYS = 30;

/** Drop finished delivery rows past the retention window. */
export async function pruneAlertDeliveries(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ALERT_DELIVERY_RETENTION_DAYS * 86_400_000);
  const deleted = await db
    .delete(alertDeliveries)
    .where(
      and(
        inArray(alertDeliveries.state, ["sent", "acknowledged", "escalated", "expired"]),
        lte(alertDeliveries.createdAt, cutoff),
      ),
    )
    .returning({ id: alertDeliveries.id });
  if (deleted.length > 0) {
    console.log(
      `[alerts] pruned ${deleted.length} delivery row(s) older than ${ALERT_DELIVERY_RETENTION_DAYS} days`,
    );
  }
  return deleted.length;
}
