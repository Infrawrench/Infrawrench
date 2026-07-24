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

export function getStripeWebhookSecret(): string {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET environment variable is required");
  return secret;
}
