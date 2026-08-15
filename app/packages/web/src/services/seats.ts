/**
 * Seat accounting across both ways an org can hold seats.
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
 * **Capacity is the sum of two sources**, and every function here has to read
 * both: the subscription's rented monthly seats, and prepaid capacity slots
 * (`server-core/billing/capacity-slots.ts`) bought outright for a fixed term.
 * Reading `subscriptions.seatCount` alone under-counts a slot-holding org — it
 * would refuse an invite the org has already paid for — and an org can hold
 * slots with no subscription row whatsoever.
 *
 * Free-tier and self-hosted orgs have neither, so every entry point below
 * no-ops before constructing the Stripe client (which throws without
 * STRIPE_SECRET_KEY).
 */
import { and, eq, gt, isNull, notLike, sql } from "drizzle-orm";
import { activeCapacitySeats } from "@infrawrench/server-core/billing/capacity-slots";
import { AGENT_USER_ID_LIKE_PATTERN } from "@infrawrench/server-core/trials/identity";
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
  /** Total capacity: rented monthly seats plus prepaid capacity-slot seats. */
  seatCount: number;
  seatsUsed: number;
  /**
   * Whether one more monthly seat can be bought on the spot. False for an org
   * whose capacity is entirely prepaid slots — there is no subscription item to
   * increment, so the remedy is buying another slot on the billing page, and
   * the caller's prompt has to say so rather than offering a one-click add.
   */
  canAddSeat: boolean;
}

/**
 * Null when the org can invite freely (free tier, or seats to spare);
 * otherwise how full the plan is, for the "add a seat?" prompt.
 */
export async function checkSeatAvailability(
  organizationId: string,
): Promise<SeatLimitStatus | null> {
  const sub = await liveSubscription(organizationId);
  const prepaidSeats = await activeCapacitySeats(organizationId);
  const capacity = (sub?.seatCount ?? 0) + prepaidSeats;
  // No capacity from either source is the free tier, whose user limit is
  // enforced by the plan gate at the invite route, not here.
  if (capacity === 0) return null;

  // Agent memberships are excluded: an agent whose trial was adopted or merged
  // in is not a person and must not consume a seat — counted, it would refuse
  // a real hire's invite while a phantom "member" nobody can see in a billing
  // sense holds the slot.
  const members = await countRows(
    db
      .select({ n: sql<number>`count(*)` })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          notLike(organizationMembers.userId, AGENT_USER_ID_LIKE_PATTERN),
        ),
      ),
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
  if (seatsUsed < capacity) return null;
  return { seatCount: capacity, seatsUsed, canAddSeat: sub !== null };
}

/**
 * Buy one more *monthly* seat. Throws on any failure — callers only reach this
 * after {@link checkSeatAvailability} said the plan is full, and the invite must
 * not go out if the seat purchase didn't happen.
 *
 * Needs a live subscription to grow, so only call it when
 * {@link SeatLimitStatus.canAddSeat} is true; a slot-only org has to buy another
 * capacity slot instead, which is a checkout, not a quantity bump.
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

  // People only — an agent membership must not hold the subscription's floor
  // up, or the org keeps paying for a seat no person occupies.
  const remaining = await countRows(
    db
      .select({ n: sql<number>`count(*)` })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          notLike(organizationMembers.userId, AGENT_USER_ID_LIKE_PATTERN),
        ),
      ),
  );
  const prepaidSeats = await activeCapacitySeats(organizationId);

  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
  const seatItem = stripeSub.items.data.find((i) => i.quantity != null);
  if (!seatItem) return;

  const current = seatItem.quantity ?? 1;
  // Drop one seat, but never below the people still in the org, never below
  // one, and never upward — undersold orgs are an enforcement gap, not ours to
  // charge. (Extra seats bought deliberately beyond the member count stay.)
  //
  // Prepaid slots cover that many members already, so the monthly floor is only
  // the members they don't cover: an org with 3 slots and 3 members owes nothing
  // monthly, and billing it for 3 rented seats would charge twice for the same
  // people.
  const monthlyMembers = Math.max(0, remaining - prepaidSeats);
  const target = Math.max(1, monthlyMembers, current - 1);
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
