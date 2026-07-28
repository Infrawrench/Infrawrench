/**
 * What an organization's plan entitles it to.
 *
 * Kept in one module so a paid-only feature is gated by a named check rather
 * than by each route reimplementing "is there a subscription row". The billing
 * routes own buying a plan; this owns reading what one grants.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { organizations, subscriptions } from "../db/schema";

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

  const [sub] = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId));
  if (!sub) return { paid: false, reason: "none" };
  return PAID_STATUSES.has(sub.status)
    ? { paid: true, reason: "subscription", status: sub.status }
    : { paid: false, reason: "inactive", status: sub.status };
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
