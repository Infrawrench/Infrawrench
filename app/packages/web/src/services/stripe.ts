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

export function getStripeWebhookSecret(): string {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET environment variable is required");
  return secret;
}
