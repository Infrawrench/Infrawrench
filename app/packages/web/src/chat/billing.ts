/**
 * Chat usage tracking + monthly spend cap enforcement + Stripe metered reporting.
 *
 * After each assistant turn we insert a `chat_usage` row computing the
 * micro-dollar cost from token counts (see ./pricing.ts), then push a billing
 * meter event (event name from `INFRAWRENCH_STRIPE_CHAT_METER_EVENT`) keyed by
 * the org's Stripe customer id. Best-effort — a Stripe outage doesn't fail the
 * user's request; we leave the usage row unreported and a periodic reconciler
 * can replay it later.
 */
import { v4 as uuidv4 } from "uuid";
import { eq, and, gte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { chatUsage, organizations, subscriptions } from "../db/schema";
import { computeCostMicros, type TokenUsage } from "./pricing";
import { getStripe } from "../services/stripe";
import type { SpendStatus } from "@infrawrench/ui";

/** ISO timestamp of the first day of the current month (UTC). */
function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Orgs without a paid subscription (no payment method on file) get this much
 * chat usage per month: $5. An org-configured cap below this still applies.
 */
const FREE_TIER_CAP_MICROS = 5_000_000;

export async function getMonthlySpend(organizationId: string): Promise<SpendStatus> {
  const [org] = await db
    .select({ cap: organizations.chatMonthlyCapMicros })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  const [sub] = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId))
    .limit(1);
  // Same definition of "paid" as the billing settings page: an org is free
  // when it has no subscription row or the subscription never activated.
  const hasPaidSubscription = sub?.status === "active" || sub?.status === "past_due";

  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${chatUsage.costMicros}), 0)` })
    .from(chatUsage)
    .where(
      and(eq(chatUsage.organizationId, organizationId), gte(chatUsage.createdAt, monthStart())),
    );

  const monthToDateMicros = Number(rows[0]?.total ?? 0) || 0;
  const orgCapMicros = org?.cap ?? null;
  const monthlyCapMicros = hasPaidSubscription
    ? orgCapMicros
    : Math.min(orgCapMicros ?? FREE_TIER_CAP_MICROS, FREE_TIER_CAP_MICROS);
  return {
    monthToDateMicros,
    monthlyCapMicros,
    exceeded: monthlyCapMicros != null && monthToDateMicros >= monthlyCapMicros,
    freeTier: !hasPaidSubscription,
  };
}

interface RecordUsageInput {
  organizationId: string;
  conversationId: string;
  messageId: string;
  model: string;
  usage: TokenUsage;
}

/**
 * Insert a chat_usage row and try to report it to Stripe metered billing.
 * Returns the cost in micros for the caller to surface in SSE events.
 */
export async function recordUsage(input: RecordUsageInput): Promise<number> {
  const costMicros = computeCostMicros(input.model, input.usage);
  const id = uuidv4();
  await db.insert(chatUsage).values({
    id,
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    model: input.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens,
    costMicros,
  });

  void reportUsageToStripe(id, input.organizationId, costMicros).catch((e) => {
    console.error("[chat/billing] Stripe usage report failed:", e);
  });

  return costMicros;
}

async function reportUsageToStripe(
  usageRowId: string,
  organizationId: string,
  _costMicros: number,
): Promise<void> {
  // Meter events are keyed by the org's Stripe customer id; Stripe bills
  // them through the subscription item whose metered price is bound to the
  // meter (STRIPE_CHAT_PRICE_ID, attached at checkout). The event name is
  // per-deployment env so we don't need a column for it.
  const meterEventName = process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"];
  if (!meterEventName) return;

  const [sub] = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId))
    .limit(1);
  if (!sub?.stripeCustomerId) return;

  let stripe: ReturnType<typeof getStripe>;
  try {
    stripe = getStripe();
  } catch {
    // Stripe not configured for this deployment — usage is captured in DB,
    // can be replayed later. Don't fail the user request.
    return;
  }

  // Stripe billing meters expect a numeric value; we report in micro-dollars,
  // and the meter aggregator + price-per-unit in Stripe yields the dollar charge.
  // (Using meters API rather than legacy usage records — meters are the
  // forward path for v2024+ accounts.)
  // The usage row id rides in `identifier`, not the payload: Stripe rejects
  // undeclared payload keys (they count as meter dimensions), and identifier
  // gives us 24h dedup for free when the reconciler replays unreported rows.
  await stripe.billing.meterEvents.create({
    event_name: meterEventName,
    identifier: usageRowId,
    payload: {
      stripe_customer_id: sub.stripeCustomerId,
      value: String(_costMicros),
    },
  });

  await db
    .update(chatUsage)
    .set({ stripeUsageRecordId: usageRowId })
    .where(eq(chatUsage.id, usageRowId));
}
