/**
 * The poller's `revnu-reports` pass: sends the purchase events the Stripe
 * webhook queued on `revnu_checkout_handoffs`.
 *
 * The webhook acknowledges Stripe whatever Revnu is doing. A redelivery would
 * re-run the subscription write, and a long outage would leave the billing
 * endpoint failing, so a retry lives here instead.
 *
 * Claim: the `alerts/pass.ts` idiom. One UPDATE over a SKIP LOCKED select moves
 * `next_report_at` forward as a lease, so instances never send the same attempt
 * twice and one that dies mid-send lets the row come due again. That is
 * at-least-once, which is safe: the event id is the Checkout Session id and the
 * body is frozen, so Revnu answers a repeat as a duplicate.
 */
import { and, inArray, isNotNull, isNull, lt, lte, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { revnuCheckoutHandoffs } from "../db/schema";
import { postRevnuEvent, type PaymentSucceededEvent } from "./revnu";

const CLAIM_LEASE_MS = 5 * 60_000;
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;
/** Past this a purchase is too stale to be worth sending, and the payload holds PII. */
const REPORT_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Bank debits settle within about two weeks, so an unpaid row this old is abandoned. */
const UNPAID_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function revnuRetryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

export async function runRevnuReportPass(
  options: { limit?: number; now?: Date } = {},
): Promise<{ claimed: number; reported: number }> {
  // Unconfigured is not a failure, and rows wait in case the key is coming back.
  if (!process.env["REVNU_EVENT_KEY"]) return { claimed: 0, reported: 0 };

  const now = options.now ?? new Date();
  const t = revnuCheckoutHandoffs;
  const rows = await db
    .update(t)
    .set({
      nextReportAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      reportAttempts: sql`${t.reportAttempts} + 1`,
      updatedAt: now,
    })
    .where(
      inArray(
        t.id,
        db
          .select({ id: t.id })
          .from(t)
          .where(and(isNotNull(t.reportPayload), lte(t.nextReportAt, now)))
          .orderBy(t.nextReportAt)
          .limit(options.limit ?? 50)
          .for("update", { skipLocked: true }),
      ),
    )
    .returning();

  let reported = 0;
  for (const row of rows) {
    const result = await postRevnuEvent(row.reportPayload as unknown as PaymentSucceededEvent);
    const finishedAt = new Date();
    if (result === "accepted") {
      reported += 1;
      await db
        .update(t)
        .set({
          reportedAt: finishedAt,
          reportPayload: null,
          nextReportAt: null,
          updatedAt: finishedAt,
        })
        .where(eq(t.id, row.id));
      continue;
    }
    const expired = !row.paidAt || finishedAt.getTime() - row.paidAt.getTime() > REPORT_WINDOW_MS;
    if (result === "rejected" || expired) {
      console.error(`[revnu] gave up on checkout ${row.stripeCheckoutSessionId}: ${result}`);
      await db
        .update(t)
        .set({
          reportAbandonedAt: finishedAt,
          reportPayload: null,
          nextReportAt: null,
          updatedAt: finishedAt,
        })
        .where(eq(t.id, row.id));
      continue;
    }
    await db
      .update(t)
      .set({
        nextReportAt: new Date(finishedAt.getTime() + revnuRetryDelayMs(row.reportAttempts)),
        updatedAt: finishedAt,
      })
      .where(eq(t.id, row.id));
  }
  return { claimed: rows.length, reported };
}

/** Delete checkouts that never became a purchase. */
export async function pruneRevnuCheckoutHandoffs(now: Date = new Date()): Promise<void> {
  const t = revnuCheckoutHandoffs;
  await db
    .delete(t)
    .where(and(isNull(t.paidAt), lt(t.createdAt, new Date(now.getTime() - UNPAID_RETENTION_MS))));
}
