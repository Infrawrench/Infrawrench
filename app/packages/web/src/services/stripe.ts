import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) throw new Error("STRIPE_SECRET_KEY environment variable is required");
  _stripe = new Stripe(key);
  return _stripe;
}

export function getStripePriceId(): string {
  const priceId = process.env["STRIPE_PRICE_ID"];
  if (!priceId) throw new Error("STRIPE_PRICE_ID environment variable is required");
  return priceId;
}

/**
 * Metered chat-usage price, bound to the billing meter named by
 * INFRAWRENCH_STRIPE_CHAT_METER_EVENT. Optional — without it checkout omits
 * the metered line item and chat usage goes unbilled.
 */
export function getStripeChatPriceId(): string | null {
  return process.env["STRIPE_CHAT_PRICE_ID"] || null;
}

/**
 * Metered hosted-build price, bound to the billing meter named by
 * INFRAWRENCH_STRIPE_BUILD_METER_EVENT. Optional — without it checkout omits
 * the line item and build time goes unbilled (the flat plan absorbs it).
 */
export function getStripeBuildPriceId(): string | null {
  return process.env["STRIPE_BUILD_PRICE_ID"] || null;
}

/**
 * One-time price of a single prepaid capacity slot — a seat bought outright for
 * a fixed term rather than rented monthly (see
 * `server-core/billing/capacity-slots.ts`).
 *
 * Optional, and it must be a **one-time** price, not recurring: the purchase
 * route opens Checkout in `payment` mode. Without it the billing page hides the
 * option and the purchase route reports the feature as unconfigured, which is
 * the right default for self-hosted deployments that only want the monthly plan.
 */
export function getStripeCapacitySlotPriceId(): string | null {
  return process.env["STRIPE_CAPACITY_SLOT_PRICE_ID"] || null;
}

export function getStripeWebhookSecret(): string {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET environment variable is required");
  return secret;
}
