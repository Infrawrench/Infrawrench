import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "../../db/client";
import { subscriptions } from "../../db/schema";
import { getStripe, getStripePriceId, getStripeChatPriceId } from "../../services/stripe";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/billing/status */
app.get("/status", async (c) => {
  requirePermission(c, "billing:read");
  const session = c.get("session");
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, c.get("organizationId")));
  if (!sub) return c.json(null);
  return c.json({
    status: sub.status,
    seatCount: sub.seatCount,
    currentPeriodEnd: sub.currentPeriodEnd,
    stripeCustomerId: sub.stripeCustomerId,
  });
});

/** POST /api/billing/checkout */
app.post("/checkout", async (c) => {
  requirePermission(c, "billing:write");
  const session = c.get("session");
  const stripe = getStripe();
  const priceId = getStripePriceId();

  let [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, c.get("organizationId")));

  let customerId: string;
  if (sub) {
    customerId = sub.stripeCustomerId;
  } else {
    const customer = await stripe.customers.create({
      email: session.email,
      metadata: { organizationId: c.get("organizationId") },
    });
    customerId = customer.id;
    await db.insert(subscriptions).values({
      id: uuid(),
      organizationId: c.get("organizationId"),
      stripeCustomerId: customerId,
      status: "trialing",
      seatCount: 1,
    });
  }

  const appUrl =
    process.env["APP_URL"] ?? process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const chatPriceId = getStripeChatPriceId();
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    // Metered prices take no quantity — Stripe bills them from the meter.
    line_items: [
      { price: priceId, quantity: 1, adjustable_quantity: { enabled: true, minimum: 1 } },
      ...(chatPriceId ? [{ price: chatPriceId }] : []),
    ],
    success_url: `${appUrl}/settings/billing?success=true`,
    cancel_url: `${appUrl}/settings/billing`,
  });

  if (!checkoutSession.url) return c.json({ error: "Failed to create checkout session" }, 500);
  return c.json({ url: checkoutSession.url });
});

/** POST /api/billing/portal */
app.post("/portal", async (c) => {
  requirePermission(c, "billing:write");
  const session = c.get("session");
  const stripe = getStripe();

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, c.get("organizationId")));
  if (!sub) return c.json({ error: "No subscription found" }, 404);

  const appUrl =
    process.env["APP_URL"] ?? process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${appUrl}/settings/billing`,
  });
  return c.json({ url: portalSession.url });
});

export { app as billingRoutes };
