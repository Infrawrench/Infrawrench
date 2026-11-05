import { and, eq, isNull, or } from "drizzle-orm";
import type Stripe from "stripe";
import { v4 as uuid } from "uuid";
import {
  anonymousIdOrNull,
  buildPaymentSucceededEvent,
  type ParsedMeasurement,
  type RevnuConsentState,
} from "@infrawrench/server-core/billing/revnu";
import { db } from "../db/client";
import { revnuCheckoutHandoffs } from "../db/schema";

/** A database error's message carries its query parameters, so log only the kind. */
function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}

/**
 * Remember what the browser knew when checkout started. Never throws: the buyer
 * already has a Stripe session, and a missing row must not cost the sale. The
 * webhook falls back to the session metadata when there is no row.
 */
export async function saveCheckoutHandoff(input: {
  organizationId: string;
  createdByUserId: string;
  stripeCheckoutSessionId: string;
  measurement: ParsedMeasurement;
}): Promise<void> {
  try {
    await db.insert(revnuCheckoutHandoffs).values({
      id: uuid(),
      organizationId: input.organizationId,
      createdByUserId: input.createdByUserId,
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      anonymousId: input.measurement.anonymousId,
      consentState: input.measurement.consentState,
    });
  } catch (err) {
    console.error(
      `[revnu] could not save the handoff for ${input.stripeCheckoutSessionId}: ${errorKind(err)}`,
    );
  }
}

/**
 * Apply a changed consent answer to this user's unpaid checkouts.
 *
 * A withdrawal reaches all of them, whichever browser started them. Any other
 * answer only reaches this visitor's rows and rows still pending with no visitor
 * id: a grant in one browser must not overrule a decline made in another. Paid
 * rows are frozen, because Revnu refuses a retry with a changed body.
 */
export async function refreshUnreportedConsent(
  organizationId: string,
  userId: string,
  measurement: ParsedMeasurement,
): Promise<number> {
  const { anonymousId, consentState } = measurement;
  if (!consentState) return 0;
  const t = revnuCheckoutHandoffs;
  const mine = eq(t.createdByUserId, userId);
  const visitor = anonymousId ? eq(t.anonymousId, anonymousId) : undefined;
  const scope =
    consentState === "denied"
      ? or(mine, visitor)
      : or(visitor, and(mine, isNull(t.anonymousId), eq(t.consentState, "pending")));
  const rows = await db
    .update(t)
    .set({ consentState, updatedAt: new Date() })
    .where(and(eq(t.organizationId, organizationId), isNull(t.paidAt), scope))
    .returning({ id: t.id });
  return rows.length;
}

/**
 * Queue one paid Checkout Session for the `revnu-reports` pass. Refunds are not
 * reported: a full refund stays counted. `invoice.paid` is not a purchase event
 * either. Never throws, so Revnu can never make Stripe redeliver a billing event.
 */
export async function queuePaidCheckout(
  session: Stripe.Checkout.Session,
  occurredAt: unknown,
): Promise<void> {
  try {
    if (session.payment_status !== "paid" || !session.id) return;
    // Anything else on this Stripe account is not a purchase of ours.
    const kind = purchaseKind(session);
    if (!kind) return;
    if (!process.env["REVNU_EVENT_KEY"]) {
      console.warn("[revnu] REVNU_EVENT_KEY is unset; the confirmed purchase was not queued");
      return;
    }

    const t = revnuCheckoutHandoffs;
    const [row] = await db.select().from(t).where(eq(t.stripeCheckoutSessionId, session.id));
    if (row?.paidAt) return;

    // A visitor who declined is not reported at all. No recorded answer is not a
    // decline (a desktop checkout has no prompt), so it goes as pending. The
    // visitor id only ever rides in metadata after a grant, so it stands in for
    // the row a failed save lost. Only a grant joins the purchase to the visit.
    const metadataId = anonymousIdOrNull(session.metadata?.["revnu_anonymous_id"]);
    const consentState: RevnuConsentState = row
      ? ((row.consentState as RevnuConsentState | null) ?? "pending")
      : metadataId
        ? "granted"
        : "pending";
    if (consentState === "denied") {
      // `row` is set: only a saved answer can be a decline. Marking it paid stops
      // later consent changes and redeliveries, and nothing is queued.
      if (row) {
        const declinedAt = new Date();
        await db
          .update(t)
          .set({ paidAt: declinedAt, anonymousId: null, updatedAt: declinedAt })
          .where(and(eq(t.id, row.id), isNull(t.paidAt)));
      }
      return;
    }
    const event = buildPaymentSucceededEvent({
      eventId: session.id,
      occurredAt,
      anonymousId: consentState === "granted" ? (row?.anonymousId ?? metadataId) : null,
      consentState,
      amountMinor: session.amount_total,
      currency: session.currency,
      email: session.customer_details?.email ?? session.customer_email ?? null,
      phone: session.customer_details?.phone ?? null,
      purchaseKind: kind,
    });
    if (!event) {
      console.error(`[revnu] checkout ${session.id} has no usable occurred_at; not queued`);
      return;
    }

    const now = new Date();
    const queued = {
      paidAt: now,
      reportPayload: event as unknown as Record<string, unknown>,
      nextReportAt: now,
      updatedAt: now,
    };
    if (row) {
      await db
        .update(t)
        .set(queued)
        .where(and(eq(t.id, row.id), isNull(t.paidAt)));
      return;
    }
    const organizationId = session.metadata?.["organizationId"];
    if (!organizationId) {
      console.error(`[revnu] checkout ${session.id} carries no organizationId; not queued`);
      return;
    }
    await db
      .insert(t)
      .values({
        id: uuid(),
        organizationId,
        stripeCheckoutSessionId: session.id,
        anonymousId: event.anonymous_id ?? null,
        consentState,
        ...queued,
      })
      .onConflictDoNothing({ target: t.stripeCheckoutSessionId });
  } catch (err) {
    console.error(`[revnu] could not queue checkout ${session.id}: ${errorKind(err)}`);
  }
}

function purchaseKind(session: Stripe.Checkout.Session): "subscription" | "capacity_slot" | null {
  if (session.metadata?.["kind"] === "capacity_slot") return "capacity_slot";
  if (session.mode === "subscription") return "subscription";
  return null;
}
