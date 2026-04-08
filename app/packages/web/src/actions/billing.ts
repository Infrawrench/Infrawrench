"use server";

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/db/client";
import { subscriptions } from "@/db/schema";
import { requireAuth } from "@/auth/session";
import { getStripe, getStripePriceId } from "@/services/stripe";

export interface SubscriptionStatus {
  status: string;
  seatCount: number;
  currentPeriodEnd: Date | null;
  stripeCustomerId: string | null;
}

export async function getSubscriptionStatus(): Promise<SubscriptionStatus | null> {
  const session = await requireAuth();
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, session.organizationId));
  if (!sub) return null;
  return {
    status: sub.status,
    seatCount: sub.seatCount,
    currentPeriodEnd: sub.currentPeriodEnd,
    stripeCustomerId: sub.stripeCustomerId,
  };
}

export async function createCheckoutSession(): Promise<{ url: string }> {
  const session = await requireAuth();
  const stripe = getStripe();
  const priceId = getStripePriceId();

  // Ensure a Stripe customer exists for this org
  let [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, session.organizationId));

  let customerId: string;
  if (sub) {
    customerId = sub.stripeCustomerId;
  } else {
    const customer = await stripe.customers.create({
      email: session.email,
      metadata: { organizationId: session.organizationId },
    });
    customerId = customer.id;
    await db.insert(subscriptions).values({
      id: uuid(),
      organizationId: session.organizationId,
      stripeCustomerId: customerId,
      status: "trialing",
      seatCount: 1,
    });
  }

  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/settings/billing?success=true`,
    cancel_url: `${appUrl}/settings/billing`,
  });

  if (!checkoutSession.url) throw new Error("Failed to create checkout session");
  return { url: checkoutSession.url };
}

export async function createBillingPortalSession(): Promise<{ url: string }> {
  const session = await requireAuth();
  const stripe = getStripe();

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, session.organizationId));
  if (!sub) throw new Error("No subscription found");

  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${appUrl}/settings/billing`,
  });

  return { url: portalSession.url };
}
