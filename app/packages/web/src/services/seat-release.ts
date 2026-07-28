/**
 * Free a paid seat after a membership ends.
 *
 * Seats are bought at checkout and adjusted in the Stripe portal, but nothing
 * used to shrink the subscription when a member was removed — the org kept
 * paying for the empty seat until someone remembered to downgrade by hand.
 *
 * Callers treat this as best-effort: removing the member must succeed even
 * when Stripe is down, so call sites catch and log rather than fail the
 * request. The webhook's `customer.subscription.updated` handler re-syncs
 * `seatCount` from Stripe afterwards; the local update here just keeps the
 * billing page honest when webhooks lag (or aren't wired up in dev).
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { organizationMembers, subscriptions } from "../db/schema";
import { getStripe } from "./stripe";

export async function releaseSeat(organizationId: string): Promise<void> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId));
  // Never construct the Stripe client unless there is a live subscription to
  // shrink: it throws without STRIPE_SECRET_KEY, and self-hosted has none.
  if (!sub?.stripeSubscriptionId || sub.status === "canceled") return;

  const [members] = await db
    .select({ n: sql<number>`count(*)` })
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId));
  const remaining = Number(members?.n ?? 0);

  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  // The licensed plan item is the one with a quantity; metered items have none.
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
