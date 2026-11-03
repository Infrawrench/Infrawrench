import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { v4 as uuid } from "uuid";
import { db } from "../db/client";
import { revnuCheckoutHandoffs } from "../db/schema";
import {
  buildPaymentSucceededEvent,
  parseMeasurement,
  postRevnuEvent,
  type ParsedMeasurement,
} from "./revnu";

export { parseMeasurement };
export type { ParsedMeasurement };

/** Stripe should redeliver. Billing writes that already happened stay idempotent. */
export class RevnuTemporaryError extends Error {
  constructor() {
    super("Revnu did not accept the purchase event");
    this.name = "RevnuTemporaryError";
  }
}

export async function saveCheckoutHandoff(input: {
  organizationId: string;
  stripeCheckoutSessionId: string;
  measurement: ParsedMeasurement;
}): Promise<void> {
  await db.insert(revnuCheckoutHandoffs).values({
    id: uuid(),
    organizationId: input.organizationId,
    stripeCheckoutSessionId: input.stripeCheckoutSessionId,
    anonymousId: input.measurement.anonymousId,
    consentState: input.measurement.consentState,
    googleAdUserData: input.measurement.googleAdUserData,
    googleAdPersonalization: input.measurement.googleAdPersonalization,
  });
}

/**
 * Rewrite unfinished handoffs for this visitor. Reported rows stay as they
 * were sent. A different anonymous id is a different checkout and is left alone.
 */
export async function refreshUnreportedConsent(
  organizationId: string,
  measurement: ParsedMeasurement,
): Promise<number> {
  if (!measurement.anonymousId) return 0;
  const changes: {
    updatedAt: Date;
    consentState?: ParsedMeasurement["consentState"];
    googleAdUserData?: ParsedMeasurement["googleAdUserData"];
    googleAdPersonalization?: ParsedMeasurement["googleAdPersonalization"];
  } = { updatedAt: new Date() };
  if (measurement.consentState) changes.consentState = measurement.consentState;
  if (measurement.googleAdUserData) changes.googleAdUserData = measurement.googleAdUserData;
  if (measurement.googleAdPersonalization) {
    changes.googleAdPersonalization = measurement.googleAdPersonalization;
  }
  if (!changes.consentState && !changes.googleAdUserData && !changes.googleAdPersonalization) {
    return 0;
  }
  const rows = await db
    .update(revnuCheckoutHandoffs)
    .set(changes)
    .where(
      and(
        eq(revnuCheckoutHandoffs.organizationId, organizationId),
        eq(revnuCheckoutHandoffs.anonymousId, measurement.anonymousId),
        isNull(revnuCheckoutHandoffs.reportedAt),
      ),
    )
    .returning({ id: revnuCheckoutHandoffs.id });
  return rows.length;
}

/**
 * Report one paid Checkout Session. Refunds are not reported: a full refund
 * stays counted. `invoice.paid` is not a purchase event either.
 */
export async function reportPaidCheckout(
  session: Stripe.Checkout.Session,
  occurredAt: unknown,
): Promise<void> {
  if (session.payment_status !== "paid" || !session.id) return;

  const [row] = await db
    .select()
    .from(revnuCheckoutHandoffs)
    .where(eq(revnuCheckoutHandoffs.stripeCheckoutSessionId, session.id));
  if (row?.reportedAt) return;

  const anonymousId = row?.anonymousId ?? session.metadata?.["revnu_anonymous_id"] ?? null;
  const event = buildPaymentSucceededEvent({
    eventId: session.id,
    occurredAt,
    anonymousId,
    consentState: row?.consentState ?? null,
    googleAdUserData: row?.googleAdUserData ?? null,
    googleAdPersonalization: row?.googleAdPersonalization ?? null,
    amountMinor: session.amount_total,
    currency: session.currency,
    email: session.customer_details?.email ?? session.customer_email ?? null,
    phone: session.customer_details?.phone ?? null,
    purchaseKind: purchaseKind(session),
  });
  if (!event) {
    console.error(`[revnu] checkout ${session.id} has no usable occurred_at; not reported`);
    return;
  }

  const result = await postRevnuEvent(event);
  if (result === "retry") throw new RevnuTemporaryError();
  if (result !== "accepted") return;

  const now = new Date();
  if (row) {
    await db
      .update(revnuCheckoutHandoffs)
      .set({ reportedAt: now, updatedAt: now })
      .where(eq(revnuCheckoutHandoffs.id, row.id));
    return;
  }

  const organizationId = session.metadata?.["organizationId"];
  if (!organizationId) return;
  await db.insert(revnuCheckoutHandoffs).values({
    id: uuid(),
    organizationId,
    stripeCheckoutSessionId: session.id,
    anonymousId: event.anonymous_id ?? null,
    consentState: event.consent_state ?? null,
    googleAdUserData: event.google_ad_user_data,
    googleAdPersonalization: event.google_ad_personalization,
    reportedAt: now,
  });
}

function purchaseKind(session: Stripe.Checkout.Session): "subscription" | "capacity_slot" | null {
  if (session.metadata?.["kind"] === "capacity_slot") return "capacity_slot";
  if (session.mode === "subscription") return "subscription";
  return null;
}
