/**
 * Billing: the database and Stripe calls behind `/api/org/:orgId/billing`.
 *
 * Promise code, run by the handlers through `legacy`, so every query and
 * Stripe call starts inside the request's scopes. Nothing here decides a
 * status: the handlers own the refusals, in the order the routes checked them.
 */
import { eq } from "drizzle-orm";
import { Predicate } from "effect";
import { v4 as uuid } from "uuid";
import {
  CAPACITY_SLOT_PRICE_USD,
  CAPACITY_SLOT_TERM_MONTHS,
  activeCapacitySeats,
  listCapacitySlots,
} from "@infrawrench/server-core/billing/capacity-slots";
import { parseMeasurement } from "@infrawrench/server-core/billing/revnu";
import { db } from "../../../db/client";
import { organizations, subscriptions } from "../../../db/schema";
import {
  getStripe,
  getStripeBuildPriceId,
  getStripeCapacitySlotPriceId,
  getStripeChatPriceId,
  getStripePriceId,
  getStripeCiPriceIds,
} from "../../../services/stripe";
import { saveCheckoutHandoff } from "../../../services/revnu-checkout";

/**
 * Largest number of slots one checkout can buy. Not a business rule: a guard
 * so a fat-fingered quantity can't open a five-figure payment page. Buying more
 * than this is a second purchase, or a conversation with sales.
 */
export const MAX_SLOTS_PER_PURCHASE = 25;

/** The caller fields a checkout records: who opened it, and the customer's email. */
export interface Buyer {
  readonly userId: string;
  readonly email: string;
}

/** Whether the org has platform-granted complimentary (never-billed) access. */
export async function isComplimentary(orgId: string): Promise<boolean> {
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
 * slot purchases: a second customer would split the org's invoices and payment
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

/** The Revnu measurement a checkout body carries, parsed leniently: anything invalid is dropped. */
export function measurementFromBody(raw: unknown) {
  return parseMeasurement(Predicate.hasProperty(raw, "measurement") ? raw.measurement : undefined);
}

const billingUrl = (orgId: string) =>
  `${process.env["APP_URL"] ?? "http://localhost:3000"}/org/${orgId}/settings/billing`;

/** `GET /status`: the complimentary flag, the subscription summary and prepaid capacity. */
export async function billingStatus(orgId: string) {
  const complimentary = await isComplimentary(orgId);
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, orgId));
  const [capacitySeats, slots] = await Promise.all([
    activeCapacitySeats(orgId),
    listCapacitySlots(orgId),
  ]);
  return {
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
      // False on deployments with no one-time price configured: the UI hides
      // the option rather than offering a purchase that would 503.
      purchasable: getStripeCapacitySlotPriceId() !== null,
      termMonths: CAPACITY_SLOT_TERM_MONTHS,
      priceUsd: CAPACITY_SLOT_PRICE_USD,
      /** Seats from slots still inside their term; excludes lapsed and refunded. */
      seats: capacitySeats,
      /** Full purchase history, newest first: lapsed and refunded included. */
      slots,
    },
  };
}

/**
 * `POST /checkout`: a monthly-plan Checkout Session for a non-complimentary
 * org. Resolves to its URL, or `null` when Stripe returned none.
 */
export async function openSubscriptionCheckout(
  orgId: string,
  buyer: Buyer,
  body: unknown,
): Promise<string | null> {
  const stripe = getStripe();
  const priceId = getStripePriceId();

  const customerId = await ensureStripeCustomer(orgId, buyer.email);
  const measurement = measurementFromBody(body);

  const url = billingUrl(orgId);
  const chatPriceId = getStripeChatPriceId();
  const buildPriceId = getStripeBuildPriceId();
  // CI's metered prices too, so an organization that later gets CI is
  // billed for it without touching its subscription.
  const ciPriceIds = getStripeCiPriceIds();
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    // Metered prices take no quantity: Stripe bills them from the meter.
    line_items: [
      { price: priceId, quantity: 1, adjustable_quantity: { enabled: true, minimum: 1 } },
      ...(chatPriceId ? [{ price: chatPriceId }] : []),
      ...(buildPriceId ? [{ price: buildPriceId }] : []),
      ...ciPriceIds.map((price) => ({ price })),
    ],
    // organizationId lets a later paid webhook find this checkout. The Revnu
    // visitor id is a spare field; consent is stored on our row, not here.
    metadata: {
      organizationId: orgId,
      ...(measurement.anonymousId ? { revnu_anonymous_id: measurement.anonymousId } : {}),
    },
    success_url: `${url}?success=true`,
    cancel_url: url,
  });

  if (checkoutSession.id) {
    await saveCheckoutHandoff({
      organizationId: orgId,
      createdByUserId: buyer.userId,
      stripeCheckoutSessionId: checkoutSession.id,
      measurement,
    });
  }
  return checkoutSession.url ?? null;
}

/**
 * `POST /capacity/checkout`: a one-time payment for `quantity` prepaid slots
 * at `priceId`. Resolves to the session's URL, or `null` when Stripe returned
 * none.
 *
 * `payment` mode, not `subscription`: a slot is bought outright for its term, so
 * there is nothing to renew and nothing to cancel. The seats are granted by the
 * webhook once Stripe confirms the payment, never here: returning a URL only
 * means the user was sent to a payment page.
 */
export async function openCapacityCheckout(
  orgId: string,
  buyer: Buyer,
  priceId: string,
  quantity: number,
  body: unknown,
): Promise<string | null> {
  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(orgId, buyer.email);

  const url = billingUrl(orgId);
  const measurement = measurementFromBody(body);
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
    metadata: {
      ...metadata,
      ...(measurement.anonymousId ? { revnu_anonymous_id: measurement.anonymousId } : {}),
    },
    // Mirrored onto the PaymentIntent so `charge.refunded` (which carries the
    // payment intent, not the session) can still be traced back. The visitor
    // id stays on the session: a refund is not a new purchase.
    payment_intent_data: { metadata },
    success_url: `${url}?capacity=purchased`,
    cancel_url: url,
  });

  if (checkoutSession.id) {
    await saveCheckoutHandoff({
      organizationId: orgId,
      createdByUserId: buyer.userId,
      stripeCheckoutSessionId: checkoutSession.id,
      measurement,
    });
  }
  return checkoutSession.url ?? null;
}

/** `POST /portal`: a customer portal URL, or `null` when the org has no subscription row. */
export async function openPortal(orgId: string): Promise<string | null> {
  const stripe = getStripe();

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, orgId));
  if (!sub) return null;

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: billingUrl(orgId),
  });
  return portalSession.url;
}

/**
 * Adds CI's metered prices to the organization's existing subscription when
 * they are missing, so turning CI on bills it. Subscriptions made by
 * checkout before CI existed lack them. Returns the prices added; nothing
 * when there is no subscription (checkout will add them) or no CI prices.
 */
export async function ensureCiPrices(orgId: string): Promise<string[]> {
  const priceIds = getStripeCiPriceIds();
  if (priceIds.length === 0 || !process.env["STRIPE_SECRET_KEY"]) return [];
  const [sub] = await db
    .select({ stripeSubscriptionId: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, orgId))
    .limit(1);
  if (!sub?.stripeSubscriptionId) return [];
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const have = new Set(subscription.items.data.map((item) => item.price.id));
  const added: string[] = [];
  for (const price of priceIds) {
    if (have.has(price)) continue;
    await stripe.subscriptionItems.create({ subscription: subscription.id, price });
    added.push(price);
  }
  return added;
}
