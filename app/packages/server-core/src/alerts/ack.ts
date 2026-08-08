/**
 * Acknowledging an alert — the thing that stops it escalating.
 *
 * The only surface today is the Slack button `routeAlert` attaches when a rule
 * has an escalation policy; the inbound handler in
 * `web/src/api/routes/slack-inbound.ts` resolves the clicking Slack user to an
 * org member first, so this module can take "who" on trust and worry only about
 * "which row".
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/client";
import { alertDeliveries } from "../db/schema";

export interface AckResult {
  /** True when this call is what moved the row. */
  acknowledged: boolean;
  /** Set when somebody got there first, so the UI can name them. */
  alreadyAcknowledgedBy?: string | null;
  /**
   * Set when the row did not move, and why.
   *
   * `not_pending` is the catch-all for a row that exists but was never waiting
   * on an acknowledgement — still `held`, already `sent` without an escalation
   * policy, or `expired`. It is deliberately distinct from
   * `already_acknowledged`: reporting "somebody already acknowledged this" for a
   * row nobody ever could have acknowledged names an event that did not happen,
   * and does it with `alreadyAcknowledgedBy: null` so the message cannot even
   * say who.
   */
  reason?: "not_found" | "not_pending" | "already_escalated" | "already_acknowledged";
  /** Alert title, for the message the caller writes back into Slack. */
  title?: string;
}

/**
 * Acknowledge one delivery.
 *
 * The write is a **conditional UPDATE**, not a read-then-write, for the same
 * reason every other claim in this codebase is: two people can press the button
 * in the same second, and the loser has to find out it lost rather than
 * overwrite the winner's name. `state = 'awaiting_ack'` in the WHERE clause is
 * the whole race protection — only one statement can move a row out of that
 * state, and it also means an escalation that fired a moment earlier (which
 * moved the row to `escalated`) cannot be retroactively acknowledged into
 * silence.
 *
 * Clearing `escalateAt` in the same statement is what actually stops the
 * escalation: the pass claims on `state = 'awaiting_ack' AND escalate_at <=
 * now()`, so a row that fails either half is invisible to it.
 */
export async function acknowledgeAlert(args: {
  deliveryId: string;
  organizationId: string;
  userId: string;
  via: string;
}): Promise<AckResult> {
  const now = new Date();
  const [won] = await db
    .update(alertDeliveries)
    .set({
      state: "acknowledged",
      acknowledgedAt: now,
      acknowledgedByUserId: args.userId,
      acknowledgedVia: args.via,
      escalateAt: null,
      deliverAfter: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(alertDeliveries.id, args.deliveryId),
        eq(alertDeliveries.organizationId, args.organizationId),
        eq(alertDeliveries.state, "awaiting_ack"),
      ),
    )
    .returning();

  if (won) {
    const payload = won.payload as { title?: string } | null;
    return { acknowledged: true, ...(payload?.title ? { title: payload.title } : {}) };
  }

  // Nothing moved. Read the row to say *why* — "already acknowledged by Sam" is
  // a useful answer and "that alert doesn't exist" is a different bug.
  const [row] = await db
    .select()
    .from(alertDeliveries)
    .where(
      and(
        eq(alertDeliveries.id, args.deliveryId),
        eq(alertDeliveries.organizationId, args.organizationId),
      ),
    )
    .limit(1);

  if (!row) return { acknowledged: false, reason: "not_found" };
  const payload = row.payload as { title?: string } | null;
  const title = payload?.title ? { title: payload.title } : {};
  if (row.state === "escalated") {
    return { acknowledged: false, reason: "already_escalated", ...title };
  }
  if (row.state !== "acknowledged") {
    // `held`, `sent` or `expired` — the row exists but was never awaiting an
    // acknowledgement, so there is nothing here to take and nobody to name.
    return { acknowledged: false, reason: "not_pending", ...title };
  }
  return {
    acknowledged: false,
    reason: "already_acknowledged",
    alreadyAcknowledgedBy: row.acknowledgedByUserId,
    ...title,
  };
}

/**
 * The org's recent delivery rows, newest first — what the settings page shows
 * under "Recent alerts" so an admin can see what is held, what is waiting on an
 * acknowledgement, and what escalated.
 */
export async function listAlertDeliveries(
  organizationId: string,
  limit = 50,
): Promise<Array<typeof alertDeliveries.$inferSelect>> {
  return db
    .select()
    .from(alertDeliveries)
    .where(eq(alertDeliveries.organizationId, organizationId))
    .orderBy(desc(alertDeliveries.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** Minimal DB surface used by settlement — the module client or a transaction. */
type SettlementDb = Pick<typeof db, "update">;

/**
 * Settle every awaiting-acknowledgement delivery raised about one thing that
 * has now been dealt with elsewhere.
 *
 * Some alerts have their own resolution — a workflow approval is approved,
 * denied or times out — and that resolution *is* the acknowledgement. Without
 * this the escalation clock keeps running on a settled request and fires a
 * "nobody acknowledged this" page about a decision that was made ten minutes
 * ago, which is worse than no escalation at all: it wakes someone up to look at
 * something already closed.
 *
 * Matched on the deep-link payload rather than a stored id list because that is
 * the identifier the alert already carries — `routeAlert` writes the whole
 * `AlertEvent` into `payload`, `pushData.approvalId` included — so no new
 * column and no bookkeeping that can drift from the rows it describes. Scoped
 * to the org and to `awaiting_ack`, so it can never touch a finished row or
 * another org's.
 *
 * `state` is the caller's to choose because it is a claim about what happened:
 * `acknowledged` when a person decided, `expired` when the deadline passed and
 * nobody did.
 *
 * Propagates database errors rather than swallowing them: a failed settle
 * leaves the row armed to escalate, which is the failure mode this helper
 * exists to prevent. Callers that land a decision should run this inside the
 * same transaction (pass `executor`) so the decision and the settle commit
 * together — a decision that lands while the escalate clock keeps running is
 * worse than no decision at all.
 */
export async function settleDeliveriesForPushTarget(args: {
  organizationId: string;
  /** A `pushData` key present on the alert, e.g. `approvalId`. */
  field: "approvalId";
  value: string;
  state: "acknowledged" | "expired";
  userId?: string | null;
  via?: string;
  /**
   * Transaction handle so the settle can commit with the decision that
   * triggered it. Defaults to the module-scope client.
   */
  executor?: SettlementDb;
}): Promise<number> {
  const now = new Date();
  const exec = args.executor ?? db;
  const rows = await exec
    .update(alertDeliveries)
    .set({
      state: args.state,
      // Both deadlines cleared, so neither claim in the follow-up pass can
      // pick the row up again.
      escalateAt: null,
      deliverAfter: null,
      ...(args.state === "acknowledged"
        ? {
            acknowledgedAt: now,
            acknowledgedByUserId: args.userId ?? null,
            acknowledgedVia: args.via ?? "workflow",
          }
        : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(alertDeliveries.organizationId, args.organizationId),
        eq(alertDeliveries.state, "awaiting_ack"),
        sql`${alertDeliveries.payload} -> 'pushData' ->> ${args.field} = ${args.value}`,
      ),
    )
    .returning({ id: alertDeliveries.id });
  return rows.length;
}

/** Cancel held or awaiting-ack rows — used when an admin clears the queue. */
export async function cancelAlertDeliveries(
  organizationId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date();
  const rows = await db
    .update(alertDeliveries)
    .set({ state: "expired", deliverAfter: null, escalateAt: null, updatedAt: now })
    .where(
      and(
        eq(alertDeliveries.organizationId, organizationId),
        inArray(alertDeliveries.id, ids),
        inArray(alertDeliveries.state, ["held", "awaiting_ack"]),
      ),
    )
    .returning({ id: alertDeliveries.id });
  return rows.length;
}
