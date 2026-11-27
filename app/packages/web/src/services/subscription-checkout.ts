/**
 * What a completed monthly-plan Checkout Session writes to the organization's
 * `subscriptions` row: the subscription's id, its seats and its period, as
 * Stripe reports them now. Absolute values, so it is safe to repeat.
 *
 * Called by the Stripe webhook for every such session, and by the return
 * route of a workspace set up from git.infrawrench.com
 * (`git-workspace-checkout.ts`), which must not leave the new organization
 * waiting for the webhook to be on its plan.
 */
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db/client";
import { subscriptions } from "../db/schema";

/** Seat quantity from the licensed plan item; metered items carry no quantity. */
export function seatQuantity(sub: Stripe.Subscription): number {
  return sub.items.data.find((i) => i.quantity != null)?.quantity ?? 1;
}

/**
 * The id of a field Stripe sends as an id unless the request expanded it,
 * which a webhook payload never does.
 */
export function idOf(value: string | { readonly id: string }): string {
  return typeof value === "string" ? value : value.id;
}

/**
 * Record the session's subscription on the row its customer is found by.
 * False when the session has no customer or no subscription to record.
 */
export async function applyCheckoutSubscription(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  if (!session.customer || !session.subscription) return false;
  const subscriptionId = idOf(session.subscription);
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  await db
    .update(subscriptions)
    .set({
      stripeSubscriptionId: subscriptionId,
      status: "active",
      seatCount: seatQuantity(sub),
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeCustomerId, idOf(session.customer)));
  return true;
}
