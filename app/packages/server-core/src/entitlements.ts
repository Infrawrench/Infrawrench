/**
 * What an organization's plan entitles it to.
 *
 * Kept in one module so a paid-only feature is gated by a named check rather
 * than by each route reimplementing "is there a subscription row". The billing
 * routes own buying a plan; this owns reading what one grants.
 *
 * In server-core rather than web because the deployment runner needs it, and
 * that runner is shared with `github-watcher` — which cannot import web.
 */
import { eq } from "drizzle-orm";

import { db } from "./db/client.js";
import { organizations, subscriptions } from "./db/schema.js";

/**
 * Stripe statuses that still count as paid.
 *
 * `past_due` is deliberately included. Stripe is still retrying the card, and
 * cutting off deploys the moment a payment bounces would take someone's
 * shipping ability away during exactly the window they are least able to notice
 * why — often mid-incident. Losing access should follow a cancellation, not a
 * transient billing failure.
 */
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

export interface PlanAccess {
  paid: boolean;
  /** Why access was granted or withheld, for the message the caller shows. */
  reason: "complimentary" | "subscription" | "none" | "inactive";
  /** The subscription's Stripe status, when there is a subscription at all. */
  status?: string;
}

/** Whether this org is on a paid plan (or has complimentary access). */
export async function planAccess(organizationId: string): Promise<PlanAccess> {
  const [org] = await db
    .select({ complimentary: organizations.complimentary })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (org?.complimentary === true) return { paid: true, reason: "complimentary" };

  // Ask "is there ANY paid row", not "what is the first row". An org can carry
  // a stale `canceled` alongside a live `active` one, and without an ordering
  // Postgres is free to hand back either — which would deny a paying customer
  // or admit a lapsed one depending on the day.
  const subs = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId));
  if (subs.length === 0) return { paid: false, reason: "none" };
  const paid = subs.find((s) => PAID_STATUSES.has(s.status));
  if (paid) return { paid: true, reason: "subscription", status: paid.status };
  return { paid: false, reason: "inactive", status: subs[0]!.status };
}

/** Thrown when a paid-only feature is reached on a free organization. */
export class PlanRequiredError extends Error {
  status = 402;
  constructor(message: string) {
    super(message);
    this.name = "PlanRequiredError";
  }
}

/**
 * Gate a paid-only feature. `feature` names the thing being attempted so the
 * message says what is blocked rather than just that something is.
 */
export async function requirePaidPlan(organizationId: string, feature: string): Promise<void> {
  const access = await planAccess(organizationId);
  if (access.paid) return;
  throw new PlanRequiredError(
    access.reason === "inactive"
      ? `${feature} needs an active plan — this organization's subscription is ${access.status}. ` +
          `Reactivate it under Settings → Billing.`
      : `${feature} is available on the paid plan. Upgrade under Settings → Billing.`,
  );
}
