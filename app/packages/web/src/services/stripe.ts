import Stripe from "stripe";
import { GIT_SHORT_USERNAME_LOOKUP_KEY } from "@infrawrench/client-core";

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
 * INFRAWRENCH_STRIPE_CHAT_METER_EVENT. Optional: without it checkout omits
 * the metered line item and chat usage goes unbilled.
 */
export function getStripeChatPriceId(): string | null {
  return process.env["STRIPE_CHAT_PRICE_ID"] || null;
}

/**
 * Metered CI prices, each bound to the meter its env names
 * (`INFRAWRENCH_STRIPE_CI_{VCPU,MEMORY,STORAGE}_METER_EVENT`, see
 * `server-core/src/ci/billing.ts`): vCPU-seconds, memory GiB-seconds and
 * storage (caches and downloads) GiB-hours. Each optional: one that is unset is left off
 * subscriptions, and that part of CI goes unbilled.
 */
export function getStripeCiPriceIds(): string[] {
  return [
    process.env["STRIPE_CI_VCPU_PRICE_ID"],
    process.env["STRIPE_CI_MEMORY_PRICE_ID"],
    process.env["STRIPE_CI_STORAGE_PRICE_ID"],
  ].filter((id): id is string => Boolean(id));
}

/**
 * Metered price for private storage on git.infrawrench.com, bound to the
 * meter `INFRAWRENCH_STRIPE_GIT_STORAGE_METER_EVENT` names (GiB-hours above
 * the plan's included storage, see `server-core/src/git/billing.ts`).
 * Optional: without it the line is left off subscriptions and that storage
 * goes unbilled.
 */
export function getStripeGitStoragePriceId(): string | null {
  return process.env["STRIPE_GIT_STORAGE_PRICE_ID"] || null;
}

/**
 * One-time price of a single prepaid capacity slot: a seat bought outright for
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

let _gitShortUsernamePriceId: string | null = null;

/**
 * One-time price of a short username on git.infrawrench.com (client-core
 * `git-forge.ts`): `STRIPE_GIT_SHORT_USERNAME_PRICE_ID` when it is set, else
 * the active price whose `lookup_key` is `git_short_username`, which exists
 * in live and in test mode, so a deployment needs no id of its own. Looked up
 * once per process. Null when the account has no such price: the payment
 * route then sends the person back to the forge instead of to Stripe.
 */
export async function getStripeGitShortUsernamePriceId(): Promise<string | null> {
  const configured = process.env["STRIPE_GIT_SHORT_USERNAME_PRICE_ID"];
  if (configured) return configured;
  if (_gitShortUsernamePriceId !== null) return _gitShortUsernamePriceId;
  const found = await getStripe().prices.list({
    lookup_keys: [GIT_SHORT_USERNAME_LOOKUP_KEY],
    active: true,
    limit: 1,
  });
  _gitShortUsernamePriceId = found.data[0]?.id ?? null;
  return _gitShortUsernamePriceId;
}

export function getStripeWebhookSecret(): string {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET environment variable is required");
  return secret;
}
