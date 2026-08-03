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
 *
 * `trialing` is NOT here unconditionally: the checkout route stamps `trialing`
 * on the placeholder row it inserts before Stripe Checkout even opens, so a
 * status of `trialing` alone only proves someone clicked Upgrade. It counts as
 * paid only when the row carries a `stripeSubscriptionId` — i.e. Stripe itself
 * reported the subscription as being in a trial (see {@link isPaidRow}).
 */
const PAID_STATUSES = new Set(["active", "past_due"]);

/**
 * Whether one subscription row grants paid access. A `trialing` row without a
 * Stripe subscription behind it is an abandoned checkout, not a trial — it
 * must grant nothing, or starting checkout and closing the tab would be a
 * permanent free ride.
 */
function isPaidRow(row: { status: string; stripeSubscriptionId: string | null }): boolean {
  if (PAID_STATUSES.has(row.status)) return true;
  return row.status === "trialing" && row.stripeSubscriptionId !== null;
}

/**
 * What the free tier includes. Enforced at the invite and account-creation
 * routes; the same numbers appear in billing copy and the docs plan table, so
 * a change here means changing those too.
 */
export const FREE_PLAN_LIMITS = {
  users: 1,
  accounts: 3,
} as const;

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
    .select({
      status: subscriptions.status,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
    })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId));
  if (subs.length === 0) return { paid: false, reason: "none" };
  const paid = subs.find(isPaidRow);
  if (paid) return { paid: true, reason: "subscription", status: paid.status };
  // Rows that never became a Stripe subscription are abandoned checkouts, not
  // lapsed plans — an org that only has those has never subscribed, so the
  // caller's message should say "upgrade", not "reactivate".
  const lapsed = subs.find((s) => s.status !== "trialing" || s.stripeSubscriptionId !== null);
  if (!lapsed) return { paid: false, reason: "none" };
  return { paid: false, reason: "inactive", status: lapsed.status };
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
