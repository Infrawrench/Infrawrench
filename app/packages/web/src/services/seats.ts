/**
 * Seat accounting against the Stripe subscription.
 *
 * Seats are bought at checkout and adjusted in the Stripe portal, and the
 * webhook keeps `subscriptions.seatCount` in sync. This module closes the two
 * gaps that used to require a manual trip to the portal:
 *
 * - {@link releaseSeat} shrinks the subscription when a membership ends, so
 *   the org stops paying for a seat nobody fills.
 * - {@link checkSeatAvailability} + {@link addSeat} gate invitations: on a
 *   paid plan every member and pending invite occupies a seat, and inviting
 *   past capacity means buying one more first.
 *
 * Free-tier and self-hosted orgs have no live subscription row, so every
 * entry point below no-ops before constructing the Stripe client (which
 * throws without STRIPE_SECRET_KEY).
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { invitations, organizationMembers, subscriptions } from "../db/schema";
import { getStripe } from "./stripe";

type SubscriptionRow = typeof subscriptions.$inferSelect;

async function liveSubscription(organizationId: string): Promise<SubscriptionRow | null> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId));
  if (!sub?.stripeSubscriptionId || sub.status === "canceled") return null;
  return sub;
}

async function countRows(query: Promise<Array<{ n: number }>>): Promise<number> {
  const [row] = await query;
  return Number(row?.n ?? 0);
}

export interface SeatLimitStatus {
  seatCount: number;
  seatsUsed: number;
}

/**
 * Null when the org can invite freely (free tier, or seats to spare);
 * otherwise how full the plan is, for the "add a seat?" prompt.
 */
export async function checkSeatAvailability(
  organizationId: string,
): Promise<SeatLimitStatus | null> {
  const sub = await liveSubscription(organizationId);
  if (!sub) return null;

  const members = await countRows(
    db
      .select({ n: sql<number>`count(*)` })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId)),
  );
  // A pending, unexpired invite reserves a seat — otherwise two invites sent
  // against one free seat would both be honoured on accept.
  const pending = await countRows(
    db
      .select({ n: sql<number>`count(*)` })
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, organizationId),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      ),
  );

  const seatsUsed = members + pending;
  if (seatsUsed < sub.seatCount) return null;
  return { seatCount: sub.seatCount, seatsUsed };
}

/**
 * Buy one more seat. Throws on any failure — callers only reach this after
 * {@link checkSeatAvailability} said the plan is full, and the invite must
 * not go out if the seat purchase didn't happen.
 */
export async function addSeat(organizationId: string): Promise<void> {
  const sub = await liveSubscription(organizationId);
  if (!sub) throw new Error(`org ${organizationId} has no live subscription to add a seat to`);

  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
  // The licensed plan item is the one with a quantity; metered items have none.
  const seatItem = stripeSub.items.data.find((i) => i.quantity != null);
  if (!seatItem) throw new Error(`subscription ${sub.stripeSubscriptionId} has no licensed item`);

  const target = (seatItem.quantity ?? 1) + 1;
  // Default proration: the new seat is billed pro-rata from today on the next
  // invoice, unlike releaseSeat's "none" — you pay for what you start using.
  await stripe.subscriptionItems.update(seatItem.id, { quantity: target });

  await db
    .update(subscriptions)
    .set({ seatCount: target, updatedAt: new Date() })
    .where(eq(subscriptions.id, sub.id));
}

/**
 * Free a paid seat after a membership ends. Callers treat this as
 * best-effort: removing the member must succeed even when Stripe is down, so
 * call sites catch and log rather than fail the request. The webhook's
 * `customer.subscription.updated` handler re-syncs `seatCount` from Stripe
 * afterwards; the local update here just keeps the billing page honest when
 * webhooks lag (or aren't wired up in dev).
 */
export async function releaseSeat(organizationId: string): Promise<void> {
  const sub = await liveSubscription(organizationId);
  if (!sub) return;

  const remaining = await countRows(
    db
      .select({ n: sql<number>`count(*)` })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId)),
  );

  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
  const seatItem = stripeSub.items.data.find((i) => i.quantity != null);
  if (!seatItem) return;

  const current = seatItem.quantity ?? 1;
  // Drop one seat, but never below the people still in the org (extra seats
  // beyond that were bought deliberately and stay), never below one, and
  // never upward — undersold orgs are an enforcement gap, not ours to charge.
  const target = Math.max(1, remaining, current - 1);
  if (target >= current) return;

  await stripe.subscriptionItems.update(seatItem.id, {
    quantity: target,
    // No mid-cycle credit: the seat was paid through the period; the next
    // invoice simply bills fewer.
    proration_behavior: "none",
  });

  await db
    .update(subscriptions)
    .set({ seatCount: target, updatedAt: new Date() })
    .where(eq(subscriptions.id, sub.id));
}
