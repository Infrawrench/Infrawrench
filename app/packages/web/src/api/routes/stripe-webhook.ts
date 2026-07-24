import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { subscriptions } from "../../db/schema";
import { getStripe, getStripeWebhookSecret } from "../../services/stripe";
import type Stripe from "stripe";

const app = new Hono();

/** Seat quantity from the licensed plan item; metered items carry no quantity. */
function seatQuantity(sub: Stripe.Subscription): number {
  return sub.items.data.find((i) => i.quantity != null)?.quantity ?? 1;
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
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
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
    }
  } catch (err) {
    console.error(`[stripe-webhook] Error handling ${event.type}:`, err);
    return c.json({ error: "Webhook handler error" }, 500);
  }

  return c.json({ received: true });
});

export { app as stripeWebhookRoutes };
