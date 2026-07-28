/**
 * Reports hosted build usage to a Stripe billing meter, so build time is
 * billed rather than absorbed into the flat seat price.
 *
 * Mirrors the chat meter (`web/src/chat/billing.ts`) with two deliberate
 * differences:
 *
 * - **It lives in server-core**, because deploys run from two services: the
 *   web app and `github-watcher` (deploy-on-push). A web-only reporter would
 *   bill exactly the deploys somebody was watching and miss the automated ones.
 * - **The meter value is build SECONDS, not micro-dollars.** Chat has to
 *   pre-price because cost-per-token varies by model, so its meter unit is
 *   money. Build seconds are uniform (one machine type, deliberately not
 *   configurable), so the price belongs in Stripe — a per-second unit price on
 *   the metered price object, adjustable there without a deploy. The
 *   `HOSTED_BUILD_USD_PER_SECOND` constant in cost/deployment-costs.ts is for
 *   the org's own cost graphs and never reaches an invoice.
 *
 * Plain `fetch` against the meter-events endpoint rather than the Stripe SDK:
 * server-core doesn't depend on `stripe`, and one form-encoded POST doesn't
 * justify adding it.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { deploymentRuns } from "../db/deployment-schema.js";
import { organizations } from "../db/core-schema.js";
import { subscriptions } from "../db/schema.js";

export interface BuildMeterInput {
  organizationId: string;
  /** The deployment run, which is also the idempotency identifier. */
  runId: string;
  buildSeconds: number;
}

/**
 * Emit one meter event for a run's hosted build time. Best-effort by contract:
 * the run row records what was consumed either way, and `meter_event_id` being
 * null is what a future replay job would key on — the same arrangement chat's
 * `chat_usage_unreported_idx` anticipates.
 *
 * Silently does nothing when: the meter isn't configured, the org is
 * complimentary, or the org has no Stripe customer. Those are states, not
 * errors.
 */
export async function reportHostedBuildToMeter(input: BuildMeterInput): Promise<void> {
  const eventName = process.env["INFRAWRENCH_STRIPE_BUILD_METER_EVENT"];
  const secretKey = process.env["STRIPE_SECRET_KEY"];
  if (!eventName || !secretKey) return;
  if (!Number.isFinite(input.buildSeconds) || input.buildSeconds <= 0) return;

  // Complimentary orgs are never billed — the cost row still exists for their
  // own graphs, but no meter event is emitted.
  const [org] = await db
    .select({ complimentary: organizations.complimentary })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (org?.complimentary) return;

  const [sub] = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, input.organizationId))
    .limit(1);
  if (!sub?.stripeCustomerId) return;

  // The run id rides in `identifier`, not the payload: Stripe rejects
  // undeclared payload keys (they count as meter dimensions), and identifier
  // gives 24h dedup for free if this ever gets replayed.
  const identifier = `deploy-${input.runId}`;
  const body = new URLSearchParams({
    event_name: eventName,
    identifier,
    "payload[stripe_customer_id]": sub.stripeCustomerId,
    "payload[value]": String(Math.round(input.buildSeconds)),
  });

  const res = await fetch("https://api.stripe.com/v1/billing/meter_events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Stripe rejected the build meter event (${res.status}).`);
  }

  // Mark the row reported so an unreported-rows replay can exist later.
  await db
    .update(deploymentRuns)
    .set({ meterEventId: identifier })
    .where(eq(deploymentRuns.id, input.runId));
}
