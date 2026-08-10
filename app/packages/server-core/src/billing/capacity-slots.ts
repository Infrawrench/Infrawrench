/**
 * Prepaid seat capacity: a **capacity slot** is one seat bought outright for a
 * fixed term instead of rented by the month.
 *
 * The monthly plan rents seats — the Stripe subscription carries a quantity and
 * `releaseSeat`/`addSeat` move it up and down. A capacity slot is the opposite
 * trade: one payment now, one seat guaranteed for {@link CAPACITY_SLOT_TERM_MONTHS}
 * months, nothing to cancel and nothing to true up.
 *
 * Three consequences worth knowing before touching seat code:
 *
 * - **Slot seats are additive to subscription seats**, never a replacement. An
 *   org's real capacity is `subscriptions.seatCount + activeCapacitySeats()`,
 *   which is why `checkSeatAvailability` cannot read the subscription alone.
 * - **A slot is paid access by itself.** It is bought outright, so it must keep
 *   granting the paid plan even with no subscription row at all, or an org could
 *   pay for a slot and then be refused the teammate it bought it for. See
 *   `planAccess` in `../entitlements.ts`.
 * - **Expiry is computed, not swept.** Capacity is a sum over rows still inside
 *   their term, so a slot stops counting the moment it lapses without any cron
 *   having to run. Nothing mutates a row except a refund.
 *
 * Deliberately free of Stripe: server-core has no `stripe` dependency (same
 * reason as `build-meter.ts`). The purchase flow lives in
 * `web/src/api/routes/billing.ts` and hands the settled numbers to
 * {@link recordCapacitySlotPurchase}.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { capacitySlots } from "../db/schema.js";

/**
 * Term of one capacity slot, in months. Recorded per row as `termMonths`, so
 * changing this changes what new purchases get and leaves sold terms alone.
 */
export const CAPACITY_SLOT_TERM_MONTHS = 24;

/**
 * List price of one slot, in whole dollars — for copy only. The amount actually
 * charged comes from the Stripe price named by `STRIPE_CAPACITY_SLOT_PRICE_ID`,
 * and what was charged is stored per row as `amountPaidCents`. Keep this in step
 * with that price object; it is quoted in the billing UI and the docs plan table
 * the same way the $20 monthly seat is.
 */
export const CAPACITY_SLOT_PRICE_USD = 200;

export interface CapacitySlot {
  id: string;
  quantity: number;
  status: string;
  startsAt: string;
  expiresAt: string;
  termMonths: number;
  amountPaidCents: number | null;
}

/**
 * End of a slot's term, `CAPACITY_SLOT_TERM_MONTHS` after it starts.
 *
 * Calendar months, not 730 days: someone who buys on the 3rd expects to lose it
 * on the 3rd. The one irregular case is a Feb 29 purchase, which lands on Mar 1
 * two years later — that is `setUTCMonth` overflow and it favours the customer,
 * so it stands.
 */
export function capacitySlotExpiry(
  startsAt: Date,
  termMonths: number = CAPACITY_SLOT_TERM_MONTHS,
): Date {
  const expires = new Date(startsAt.getTime());
  expires.setUTCMonth(expires.getUTCMonth() + termMonths);
  return expires;
}

/**
 * Seats granted by this org's slots that are still inside their term and not
 * refunded. `0` when the org has never bought one, which is the common case —
 * callers can treat it as "no prepaid capacity" without a null check.
 */
export async function activeCapacitySeats(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ seats: sql<number>`coalesce(sum(${capacitySlots.quantity}), 0)` })
    .from(capacitySlots)
    .where(
      and(
        eq(capacitySlots.organizationId, organizationId),
        eq(capacitySlots.status, "active"),
        // gt(), not a raw sql`` fragment: interpolating a Date into raw SQL
        // hands postgres.js a bind parameter it rejects. See b10f2289.
        gt(capacitySlots.expiresAt, new Date()),
      ),
    );
  return Number(row?.seats ?? 0);
}

/**
 * Every slot the org has ever bought, newest first — including lapsed and
 * refunded ones, because the billing page shows purchase history, not just
 * current capacity. Callers that want capacity want {@link activeCapacitySeats}.
 */
export async function listCapacitySlots(organizationId: string): Promise<CapacitySlot[]> {
  const rows = await db
    .select({
      id: capacitySlots.id,
      quantity: capacitySlots.quantity,
      status: capacitySlots.status,
      startsAt: capacitySlots.startsAt,
      expiresAt: capacitySlots.expiresAt,
      termMonths: capacitySlots.termMonths,
      amountPaidCents: capacitySlots.amountPaidCents,
    })
    .from(capacitySlots)
    .where(eq(capacitySlots.organizationId, organizationId))
    .orderBy(desc(capacitySlots.startsAt));

  return rows.map((r) => ({
    ...r,
    startsAt: r.startsAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

export interface RecordCapacitySlotInput {
  organizationId: string;
  /** Seats bought together, from the settled Checkout line item. */
  quantity: number;
  /** Unique per purchase — this is what makes the grant idempotent. */
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string | null;
  amountPaidCents: number | null;
  /** Defaults to now; injectable so tests can pin a term. */
  startsAt?: Date;
}

/**
 * Grant a purchased slot, once.
 *
 * Stripe redelivers webhook events, and a `checkout.session.completed` arriving
 * twice must not hand out the seats twice — so the insert leans on the unique
 * index over `stripeCheckoutSessionId` and does nothing on conflict. The return
 * value says whether this call was the one that granted, which is worth logging
 * but never worth failing on: a duplicate delivery is normal operation, not an
 * error.
 */
export async function recordCapacitySlotPurchase(
  input: RecordCapacitySlotInput,
): Promise<{ granted: boolean; expiresAt: Date }> {
  const startsAt = input.startsAt ?? new Date();
  const expiresAt = capacitySlotExpiry(startsAt);

  const inserted = await db
    .insert(capacitySlots)
    .values({
      id: randomUUID(),
      organizationId: input.organizationId,
      // A Checkout line item can never settle at zero seats, but clamping here
      // means a malformed event can't create a row that grants nothing.
      quantity: Math.max(1, Math.trunc(input.quantity)),
      status: "active",
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      stripePaymentIntentId: input.stripePaymentIntentId,
      amountPaidCents: input.amountPaidCents,
      termMonths: CAPACITY_SLOT_TERM_MONTHS,
      startsAt,
      expiresAt,
    })
    .onConflictDoNothing({ target: capacitySlots.stripeCheckoutSessionId })
    .returning({ id: capacitySlots.id });

  return { granted: inserted.length > 0, expiresAt };
}

/**
 * Void the slots paid for by a refunded charge. Capacity drops immediately —
 * money back means seats back — but the row stays so the purchase history still
 * shows what happened.
 */
export async function refundCapacitySlots(stripePaymentIntentId: string): Promise<number> {
  const updated = await db
    .update(capacitySlots)
    .set({ status: "refunded", updatedAt: new Date() })
    .where(
      and(
        eq(capacitySlots.stripePaymentIntentId, stripePaymentIntentId),
        eq(capacitySlots.status, "active"),
      ),
    )
    .returning({ id: capacitySlots.id });
  return updated.length;
}
