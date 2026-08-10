import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  recordCapacitySlotPurchase,
  refundCapacitySlots,
} from "@infrawrench/server-core/billing/capacity-slots";
import { db } from "../../db/client";
import { subscriptions } from "../../db/schema";
import { getStripe, getStripeWebhookSecret } from "../../services/stripe";
import type Stripe from "stripe";

const app = new Hono();

/** Seat quantity from the licensed plan item; metered items carry no quantity. */
function seatQuantity(sub: Stripe.Subscription): number {
  return sub.items.data.find((i) => i.quantity != null)?.quantity ?? 1;
}

/**
 * Grant the seats a settled capacity-slot payment bought.
 *
 * Only ever called for a session whose `payment_status` is `paid`. Seat quantity
 * is read back from the settled line items rather than the metadata we set at
 * creation time, because Checkout lets the buyer adjust it — trusting our own
 * number would grant what we offered instead of what they paid for.
 *
 * Idempotent through the unique index on the session id, so Stripe's redeliveries
 * (and the `completed` + `async_payment_succeeded` pair a delayed payment method
 * produces) grant once between them.
 */
async function grantCapacitySlots(stripe: Stripe, session: Stripe.Checkout.Session): Promise<void> {
  const organizationId = session.metadata?.["organizationId"];
  if (!organizationId) {
    console.error(`[stripe-webhook] capacity slot session ${session.id} carries no organizationId`);
    return;
  }

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
  const quantity = lineItems.data.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  if (quantity < 1) {
    console.error(`[stripe-webhook] capacity slot session ${session.id} settled with no seats`);
    return;
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
  // error — but it should be visible, because the alternative explanation is a
  // session id colliding across orgs.
  console.log(
    granted
      ? `[stripe-webhook] granted ${quantity} capacity seat(s) to org ${organizationId} until ${expiresAt.toISOString()}`
      : `[stripe-webhook] capacity slot session ${session.id} was already granted; ignoring redelivery`,
  );
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

/** POST /api/v1/webhooks/stripe */
app.post("/", async (c) => {
  const stripe = getStripe();
  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");

  if (!signature) return c.json({ error: "Missing signature" }, 400);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, getStripeWebhookSecret());
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      // Both land here: a card payment settles inside `completed`, while a
      // delayed method (bank debit) reports `completed` unpaid and settles later.
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (isPaidCapacitySlotSession(session)) {
          await grantCapacitySlots(stripe, session);
          break;
        }
        if (session.customer && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          await db
            .update(subscriptions)
            .set({
              stripeSubscriptionId: session.subscription as string,
              status: "active",
              seatCount: seatQuantity(sub),
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.stripeCustomerId, session.customer as string));
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
          await db
            .update(subscriptions)
            .set({
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              status: "active",
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.stripeSubscriptionId, invoice.subscription as string));
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.subscription) {
          await db
            .update(subscriptions)
            .set({ status: "past_due", updatedAt: new Date() })
            .where(eq(subscriptions.stripeSubscriptionId, invoice.subscription as string));
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const quantity = seatQuantity(sub);
        await db
          .update(subscriptions)
          .set({
            status:
              sub.status === "active"
                ? "active"
                : sub.status === "past_due"
                  ? "past_due"
                  : sub.status === "canceled"
                    ? "canceled"
                    : sub.status === "unpaid"
                      ? "unpaid"
                      : sub.status,
            seatCount: quantity,
            currentPeriodStart: new Date(sub.current_period_start * 1000),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.stripeSubscriptionId, sub.id));
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await db
          .update(subscriptions)
          .set({ status: "canceled", updatedAt: new Date() })
          .where(eq(subscriptions.stripeSubscriptionId, sub.id));
        break;
      }

      // Refunding a capacity slot takes its seats back. Keyed on the payment
      // intent because a charge carries no session id — which is why the
      // purchase route mirrors its metadata onto the PaymentIntent. Partial
      // refunds void the whole purchase: a half-refunded seat is not a thing,
      // and leaving the capacity standing would be the costlier mistake.
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent?.id ?? null);
        if (!paymentIntentId) break;
        const voided = await refundCapacitySlots(paymentIntentId);
        if (voided > 0) {
          console.log(
            `[stripe-webhook] voided ${voided} capacity slot purchase(s) refunded on ${paymentIntentId}`,
          );
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[stripe-webhook] Error handling ${event.type}:`, err);
    return c.json({ error: "Webhook handler error" }, 500);
  }

  return c.json({ received: true });
});

export { app as stripeWebhookRoutes };
