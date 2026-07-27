/**
 * Chat usage tracking + monthly spend cap enforcement + Stripe metered reporting.
 *
 * After each assistant turn we insert a `chat_usage` row computing the
 * micro-dollar cost from token counts (see ./pricing.ts), then push a billing
 * meter event (event name from `INFRAWRENCH_STRIPE_CHAT_METER_EVENT`) keyed by
 * the org's Stripe customer id. Best-effort — a Stripe outage doesn't fail the
 * user's request; the row is simply left with a null `stripeUsageRecordId`.
 *
 * Nothing replays those rows — usage dropped by a Stripe outage is never
 * billed. `chat_usage_unreported_idx` exists to support a replay job, but that
 * job has not been written.
 */
import { v4 as uuidv4 } from "uuid";
import { eq, and, gte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { chatUsage, organizations, subscriptions } from "../db/schema";
import { computeCostMicros, computeSearchCostMicros, type TokenUsage } from "./pricing";
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
    .select({
      cap: organizations.chatMonthlyCapMicros,
      complimentary: organizations.complimentary,
    })
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
  // Complimentary orgs count as paid everywhere without a Stripe subscription.
  const complimentary = org?.complimentary === true;
  const hasPaidSubscription =
    complimentary || sub?.status === "active" || sub?.status === "past_due";

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
    complimentary,
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

interface RecordWebSearchInput {
  organizationId: string;
  conversationId: string;
  /** Assistant message whose tool_use ran the search. */
  messageId: string;
  /** Backend id, for the per-query rate — see ./pricing.ts. */
  backend: string;
  /** Sub-model that ran the search, for the token half of the cost. */
  model: string;
  queries: number;
  usage: TokenUsage;
}

/**
 * Bill one `web_search` tool call.
 *
 * A search costs two things — the backend's per-query fee and the retrieval
 * sub-model's tokens — and neither is visible to {@link recordUsage}, which
 * only ever sees the main turn's usage and has already run by the time a tool
 * dispatches. So this writes its own `chat_usage` row against the same
 * assistant message. Several rows per message is already normal (a turn that
 * loops writes one per iteration), and the spend cap sums the column, so the
 * search lands in the org's month-to-date exactly like model spend.
 *
 * Best-effort: a search that succeeded is never failed back to the user because
 * we could not write its usage row.
 *
 * The row is tagged by suffixing `model` rather than adding a column, so search
 * spend is attributable in the existing usage queries with no migration; the
 * column is free text and nothing parses it back into a model id.
 */
export async function recordWebSearchUsage(input: RecordWebSearchInput): Promise<number> {
  const costMicros =
    computeCostMicros(input.model, input.usage) +
    computeSearchCostMicros(input.backend, input.queries);
  if (costMicros <= 0) return 0;

  const id = uuidv4();
  try {
    await db.insert(chatUsage).values({
      id,
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      model: `${input.model} (web_search)`,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheWriteTokens: input.usage.cacheWriteTokens,
      costMicros,
    });
  } catch (e) {
    console.error("[chat/billing] failed to record web search usage:", e);
    return costMicros;
  }

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

  // Complimentary orgs are never billed — keep the chat_usage row for internal
  // cost tracking but don't emit a meter event.
  const [org] = await db
    .select({ complimentary: organizations.complimentary })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (org?.complimentary) return;

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
