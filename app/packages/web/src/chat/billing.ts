/**
 * Chat usage tracking + monthly spend cap enforcement + Stripe metered reporting.
 *
 * After each assistant turn we insert a `chat_usage` row computing the
 * micro-dollar cost from token counts (see ./pricing.ts), then push a usage
 * record to the org's Stripe subscription item id stored in
 * `INFRAWRENCH_STRIPE_CHAT_USAGE_PRICE` (configured per-deployment). Best-effort
 * — a Stripe outage doesn't fail the user's request; we leave the usage row
 * unreported and a periodic reconciler can replay it later.
 */
import { v4 as uuidv4 } from "uuid";
import { eq, and, gte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { chatUsage, organizations, subscriptions } from "../db/schema";
import { computeCostMicros, type TokenUsage } from "./pricing";
import { getStripe } from "../services/stripe";

/** ISO timestamp of the first day of the current month (UTC). */
function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

interface SpendStatus {
  monthToDateMicros: number;
  monthlyCapMicros: number | null;
  /** True when capMicros is set and monthToDateMicros >= capMicros. */
  exceeded: boolean;
}

export async function getMonthlySpend(organizationId: string): Promise<SpendStatus> {
  const [org] = await db
    .select({ cap: organizations.chatMonthlyCapMicros })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${chatUsage.costMicros}), 0)` })
    .from(chatUsage)
    .where(
      and(eq(chatUsage.organizationId, organizationId), gte(chatUsage.createdAt, monthStart())),
    );

  const monthToDateMicros = Number(rows[0]?.total ?? 0) || 0;
  const monthlyCapMicros = org?.cap ?? null;
  return {
    monthToDateMicros,
    monthlyCapMicros,
    exceeded: monthlyCapMicros != null && monthToDateMicros >= monthlyCapMicros,
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
  const costMicros = computeCostMicros(input.usage);
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
  // Stripe usage reporting requires a subscription item id for the metered
  // chat-tokens price. We look that up from the org's subscription row and
  // record the total token cost as a single "usage record" (unit-priced).
  //
  // The deployment configures the metered price id via env so we don't need
  // a column for it; the subscription item id is stored on the sub row by
  // the Stripe webhook when the subscription is first set up.
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
  await stripe.billing.meterEvents.create({
    event_name: meterEventName,
    payload: {
      stripe_customer_id: sub.stripeCustomerId,
      value: String(_costMicros),
      usage_row_id: usageRowId,
    },
  });

  await db
    .update(chatUsage)
    .set({ stripeUsageRecordId: usageRowId })
    .where(eq(chatUsage.id, usageRowId));
}
