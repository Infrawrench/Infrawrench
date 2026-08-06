import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  CAPACITY_SLOT_PRICE_USD,
  CAPACITY_SLOT_TERM_MONTHS,
  activeCapacitySeats,
  listCapacitySlots,
} from "@infrawrench/server-core/billing/capacity-slots";
import { db } from "../../db/client";
import { organizations, subscriptions } from "../../db/schema";
import {
  getStripe,
  getStripePriceId,
  getStripeChatPriceId,
  getStripeBuildPriceId,
  getStripeCapacitySlotPriceId,
} from "../../services/stripe";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** Whether the org has platform-granted complimentary (never-billed) access. */
async function isComplimentary(orgId: string): Promise<boolean> {
  const [org] = await db
    .select({ complimentary: organizations.complimentary })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org?.complimentary === true;
}

/**
 * The org's Stripe customer, created on first purchase.
 *
 * One customer per org, shared by the monthly subscription and one-time capacity
 * slot purchases — a second customer would split the org's invoices and payment
 * methods across two portals. The customer id lives on the `subscriptions` row
 * even when there is no subscription yet: a row with no
 * `stripeSubscriptionId` grants nothing (see `isPaidRow` in entitlements), so
 * using it as the customer record is safe.
 */
async function ensureStripeCustomer(organizationId: string, email: string): Promise<string> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId));
  if (sub) return sub.stripeCustomerId;

  const customer = await getStripe().customers.create({
    email,
    metadata: { organizationId },
  });
  await db.insert(subscriptions).values({
    id: uuid(),
    organizationId,
    stripeCustomerId: customer.id,
    status: "trialing",
    seatCount: 1,
  });
  return customer.id;
}

/** GET /api/billing/status */
app.get("/status", async (c) => {
  requirePermission(c, "billing:read");
  const orgId = c.get("organizationId");
  const complimentary = await isComplimentary(orgId);
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, orgId));
  const [capacitySeats, slots] = await Promise.all([
    activeCapacitySeats(orgId),
    listCapacitySlots(orgId),
  ]);
  return c.json({
    complimentary,
    subscription: sub
      ? {
          status: sub.status,
          seatCount: sub.seatCount,
          currentPeriodEnd: sub.currentPeriodEnd,
          stripeCustomerId: sub.stripeCustomerId,
        }
      : null,
    capacity: {
      // False on deployments with no one-time price configured — the UI hides
      // the option rather than offering a purchase that would 503.
      purchasable: getStripeCapacitySlotPriceId() !== null,
      termMonths: CAPACITY_SLOT_TERM_MONTHS,
      priceUsd: CAPACITY_SLOT_PRICE_USD,
      /** Seats from slots still inside their term; excludes lapsed and refunded. */
      seats: capacitySeats,
      /** Full purchase history, newest first — lapsed and refunded included. */
      slots,
    },
  });
});

/** POST /api/billing/checkout */
app.post("/checkout", async (c) => {
  requirePermission(c, "billing:write");
  if (await isComplimentary(c.get("organizationId"))) {
    return c.json({ error: "This organization has complimentary access — nothing to buy" }, 400);
  }
  const session = c.get("session");
  const stripe = getStripe();
  const priceId = getStripePriceId();

  const customerId = await ensureStripeCustomer(c.get("organizationId"), session.email);

  const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";
  const billingUrl = `${appUrl}/org/${c.get("organizationId")}/settings/billing`;
  const chatPriceId = getStripeChatPriceId();
  const buildPriceId = getStripeBuildPriceId();
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    // Metered prices take no quantity — Stripe bills them from the meter.
    line_items: [
      { price: priceId, quantity: 1, adjustable_quantity: { enabled: true, minimum: 1 } },
      ...(chatPriceId ? [{ price: chatPriceId }] : []),
      ...(buildPriceId ? [{ price: buildPriceId }] : []),
    ],
    success_url: `${billingUrl}?success=true`,
    cancel_url: billingUrl,
  });

  if (!checkoutSession.url) return c.json({ error: "Failed to create checkout session" }, 500);
  return c.json({ url: checkoutSession.url });
});

/**
 * Largest number of slots one checkout can buy. Not a business rule — a guard
 * so a fat-fingered quantity can't open a five-figure payment page. Buying more
 * than this is a second purchase, or a conversation with sales.
 */
const MAX_SLOTS_PER_PURCHASE = 25;

/**
 * POST /api/billing/capacity/checkout — buy prepaid capacity slots.
 *
 * `payment` mode, not `subscription`: a slot is bought outright for its term, so
 * there is nothing to renew and nothing to cancel. The seats are granted by the
 * webhook once Stripe confirms the payment, never here — returning a URL only
 * means the user was sent to a payment page.
 */
app.post("/capacity/checkout", async (c) => {
  requirePermission(c, "billing:write");
  const orgId = c.get("organizationId");
  if (await isComplimentary(orgId)) {
    return c.json({ error: "This organization has complimentary access — nothing to buy" }, 400);
  }

  const priceId = getStripeCapacitySlotPriceId();
  if (!priceId) {
    return c.json({ error: "Prepaid capacity slots are not configured on this deployment" }, 503);
  }

  // An absent body means one slot; anything else has to be a whole number in
  // range, because it becomes a charge.
  let quantity = 1;
  const raw: unknown = await c.req.json().catch(() => ({}));
  if (raw && typeof raw === "object" && "quantity" in raw) {
    const q = (raw as { quantity: unknown }).quantity;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > MAX_SLOTS_PER_PURCHASE) {
      return c.json(
        { error: `quantity must be a whole number between 1 and ${MAX_SLOTS_PER_PURCHASE}` },
        400,
      );
    }
    quantity = q;
  }

  const session = c.get("session");
  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(orgId, session.email);

  const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";
  const billingUrl = `${appUrl}/org/${orgId}/settings/billing`;
  // `kind` is what the webhook matches on. Without it a one-time payment is
  // indistinguishable from any other and the seats never get granted.
  const metadata = { organizationId: orgId, kind: "capacity_slot" };
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [
      {
        price: priceId,
        quantity,
        adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_SLOTS_PER_PURCHASE },
      },
    ],
    // A $200 purchase needs a document for the org's own books; subscription
    // invoices come for free, one-time payments do not unless asked for.
    invoice_creation: { enabled: true },
    metadata,
    // Mirrored onto the PaymentIntent so `charge.refunded` — which carries the
    // payment intent, not the session — can still be traced back.
    payment_intent_data: { metadata },
    success_url: `${billingUrl}?capacity=purchased`,
    cancel_url: billingUrl,
  });

  if (!checkoutSession.url) return c.json({ error: "Failed to create checkout session" }, 500);
  return c.json({ url: checkoutSession.url });
});

/** POST /api/billing/portal */
app.post("/portal", async (c) => {
  requirePermission(c, "billing:write");
  const stripe = getStripe();

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, c.get("organizationId")));
  if (!sub) return c.json({ error: "No subscription found" }, 404);

  const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${appUrl}/org/${c.get("organizationId")}/settings/billing`,
  });
  return c.json({ url: portalSession.url });
});

export { app as billingRoutes };
