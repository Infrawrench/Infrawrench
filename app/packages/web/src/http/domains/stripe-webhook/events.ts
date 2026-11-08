/**
 * Applying a verified Stripe event to the billing tables: promise code, run
 * by the handler as one `legacy` call once the signature has checked out.
 *
 * Stripe redelivers anything that does not get a 2xx, so every branch here is
 * idempotent: the subscription writes set absolute values, capacity seats are
 * granted once per Checkout Session (a unique index), and the Revnu report is
 * queued, never sent inline.
 */
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import {
  recordCapacitySlotPurchase,
  refundCapacitySlots,
} from "@infrawrench/server-core/billing/capacity-slots";
import { db } from "../../../db/client";
import { subscriptions } from "../../../db/schema";
import { queuePaidCheckout } from "../../../services/revnu-checkout";

/** Seat quantity from the licensed plan item; metered items carry no quantity. */
function seatQuantity(sub: Stripe.Subscription): number {
  return sub.items.data.find((i) => i.quantity != null)?.quantity ?? 1;
}

/**
 * The id of a field Stripe sends as an id unless the request expanded it,
 * which a webhook payload never does.
 */
function idOf(value: string | { readonly id: string }): string {
  return typeof value === "string" ? value : value.id;
}

/**
 * Grant the seats a settled capacity-slot payment bought.
 *
 * Only ever called for a session whose `payment_status` is `paid`. Seat quantity
 * is read back from the settled line items rather than the metadata we set at
 * creation time, because Checkout lets the buyer adjust it: trusting our own
 * number would grant what we offered instead of what they paid for.
 *
 * Idempotent through the unique index on the session id, so Stripe's redeliveries
 * (and the `completed` + `async_payment_succeeded` pair a delayed payment method
 * produces) grant once between them.
 */
async function grantCapacitySlots(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  const organizationId = session.metadata?.["organizationId"];
  if (!organizationId) {
    console.error(`[stripe-webhook] capacity slot session ${session.id} carries no organizationId`);
    return false;
  }

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
  const quantity = lineItems.data.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  if (quantity < 1) {
    console.error(`[stripe-webhook] capacity slot session ${session.id} settled with no seats`);
    return false;
  }

  const { granted, expiresAt } = await recordCapacitySlotPurchase({
    organizationId,
    quantity,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : (session.payment_intent?.id ?? null),
    amountPaidCents: session.amount_total,
  });

  // A repeat delivery is normal operation, so this is a log line rather than an
  // error, but it should be visible, because the alternative explanation is a
  // session id colliding across orgs.
  console.log(
    granted
      ? `[stripe-webhook] granted ${quantity} capacity seat(s) to org ${organizationId} until ${expiresAt.toISOString()}`
      : `[stripe-webhook] capacity slot session ${session.id} was already granted; ignoring redelivery`,
  );
  return true;
}

/** Whether this Checkout Session is a settled capacity-slot purchase. */
function isPaidCapacitySlotSession(session: Stripe.Checkout.Session): boolean {
  return (
    session.mode === "payment" &&
    session.metadata?.["kind"] === "capacity_slot" &&
    // Delayed payment methods report `completed` while still unpaid; the seats
    // wait for `async_payment_succeeded`, which lands here with this set.
    session.payment_status === "paid"
  );
}

/** Apply one verified event. Events this does not handle are acknowledged and ignored. */
export async function applyStripeEvent(stripe: Stripe, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    // Both land here: a card payment settles inside `completed`, while a
    // delayed method (bank debit) reports `completed` unpaid and settles later.
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.completed": {
      const session = event.data.object;
      let purchased = session.payment_status === "paid";
      if (isPaidCapacitySlotSession(session)) {
        purchased = await grantCapacitySlots(stripe, session);
      } else if (session.customer && session.subscription) {
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
      }
      // A redirect to the success URL is not a purchase. Delayed methods
      // report `completed` while unpaid and settle on `async_payment_succeeded`.
      // Refunds stay counted, so `charge.refunded` does not report a reversal.
      // This only queues the event and never throws: a redelivery would re-run
      // the subscription write above, so Revnu must not be able to cause one.
      if (purchased) await queuePaidCheckout(session, event.created);
      return;
    }

    case "invoice.paid": {
      const invoice = event.data.object;
      if (invoice.subscription) {
        const subscriptionId = idOf(invoice.subscription);
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await db
          .update(subscriptions)
          .set({
            currentPeriodStart: new Date(sub.current_period_start * 1000),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            status: "active",
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));
      }
      return;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      if (invoice.subscription) {
        await db
          .update(subscriptions)
          .set({ status: "past_due", updatedAt: new Date() })
          .where(eq(subscriptions.stripeSubscriptionId, idOf(invoice.subscription)));
      }
      return;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object;
      await db
        .update(subscriptions)
        .set({
          status: sub.status,
          seatCount: seatQuantity(sub),
          currentPeriodStart: new Date(sub.current_period_start * 1000),
          currentPeriodEnd: new Date(sub.current_period_end * 1000),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.stripeSubscriptionId, sub.id));
      return;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      await db
        .update(subscriptions)
        .set({ status: "canceled", updatedAt: new Date() })
        .where(eq(subscriptions.stripeSubscriptionId, sub.id));
      return;
    }

    // Refunding a capacity slot takes its seats back. Keyed on the payment
    // intent because a charge carries no session id, which is why the
    // purchase route mirrors its metadata onto the PaymentIntent. Partial
    // refunds void the whole purchase: a half-refunded seat is not a thing,
    // and leaving the capacity standing would be the costlier mistake.
    case "charge.refunded": {
      const charge = event.data.object;
      const paymentIntentId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : (charge.payment_intent?.id ?? null);
      if (!paymentIntentId) return;
      const voided = await refundCapacitySlots(paymentIntentId);
      if (voided > 0) {
        console.log(
          `[stripe-webhook] voided ${voided} capacity slot purchase(s) refunded on ${paymentIntentId}`,
        );
      }
      return;
    }

    default:
      return;
  }
}
