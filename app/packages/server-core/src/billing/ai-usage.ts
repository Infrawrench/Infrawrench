/**
 * Org-level AI spend accounting, shared by AI chat (web) and `infra.ai()` in
 * workflows (web + poller — which is why it lives in server-core, same reason
 * as the build meter).
 *
 * One pool, deliberately: an org has a single monthly AI cap
 * (`organizations.chat_monthly_cap_micros`, plus the $5 free tier for unpaid
 * orgs), and both chat turns and workflow AI calls draw from it. The
 * month-to-date figure is therefore the sum of BOTH usage tables —
 * `chat_usage` (rows hang off a conversation/message) and `workflow_ai_usage`
 * (rows hang off a workflow/run). Splitting the cap per feature would let a
 * workflow spend on top of everything chat already allowed.
 *
 * Workflow usage reports to the same Stripe chat meter (micro-dollar unit)
 * with the same plain-fetch approach as `./build-meter.ts` — server-core does
 * not depend on the Stripe SDK. Best-effort by contract: a null
 * `stripe_usage_record_id` is what a future replay job would key on.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { chatUsage, organizations, subscriptions, workflowAiUsage } from "../db/schema.js";
import { activeCapacitySeats } from "./capacity-slots.js";
import { computeCostMicros, type TokenUsage } from "./ai-pricing.js";

/** ISO timestamp of the first day of the current month (UTC). */
function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Orgs without a paid subscription (no payment method on file) get this much
 * AI usage per month: $5. An org-configured cap below this still applies.
 */
const FREE_TIER_CAP_MICROS = 5_000_000;

/** Structurally identical to `SpendStatus` in @infrawrench/ui. */
export interface AiSpendStatus {
  monthToDateMicros: number;
  monthlyCapMicros: number | null;
  exceeded: boolean;
  freeTier: boolean;
  complimentary: boolean;
}

export async function getAiSpendStatus(organizationId: string): Promise<AiSpendStatus> {
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
  //
  // A prepaid capacity slot counts too, and has to: it is a paid plan on its own
  // (see `planAccess`), so an org holding one and no subscription would otherwise
  // be handed the $5 free-tier chat cap after paying for two years of seats.
  const complimentary = org?.complimentary === true;
  const subscriptionPaid = sub?.status === "active" || sub?.status === "past_due";
  const hasPaidSubscription =
    complimentary ||
    subscriptionPaid ||
    // Only asked when nothing cheaper already settled it.
    (await activeCapacitySeats(organizationId)) > 0;

  const chatRows = await db
    .select({ total: sql<string>`coalesce(sum(${chatUsage.costMicros}), 0)` })
    .from(chatUsage)
    .where(
      and(eq(chatUsage.organizationId, organizationId), gte(chatUsage.createdAt, monthStart())),
    );
  const workflowRows = await db
    .select({ total: sql<string>`coalesce(sum(${workflowAiUsage.costMicros}), 0)` })
    .from(workflowAiUsage)
    .where(
      and(
        eq(workflowAiUsage.organizationId, organizationId),
        gte(workflowAiUsage.createdAt, monthStart()),
      ),
    );

  const monthToDateMicros =
    (Number(chatRows[0]?.total ?? 0) || 0) + (Number(workflowRows[0]?.total ?? 0) || 0);
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

export interface WorkflowAiUsageInput {
  organizationId: string;
  workflowId: string;
  /** The run that made the call, when known (interactive runs always know). */
  runId?: string;
  model: string;
  usage: TokenUsage;
}

/**
 * Insert a workflow_ai_usage row and try to report it to the chat Stripe meter.
 * Returns the cost in micros so `infra.ai()` can surface it to the author.
 *
 * Best-effort past the insert: a call that succeeded is never failed back to
 * the workflow because Stripe was down — but the insert itself must succeed,
 * because the row is what the spend cap sums.
 */
export async function recordWorkflowAiUsage(input: WorkflowAiUsageInput): Promise<number> {
  const costMicros = computeCostMicros(input.model, input.usage);
  const id = randomUUID();
  await db.insert(workflowAiUsage).values({
    id,
    organizationId: input.organizationId,
    workflowId: input.workflowId,
    runId: input.runId ?? null,
    model: input.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens,
    costMicros,
  });

  void reportWorkflowAiUsageToStripe(id, input.organizationId, costMicros).catch((e) => {
    console.error("[billing/ai-usage] Stripe usage report failed:", e);
  });

  return costMicros;
}

async function reportWorkflowAiUsageToStripe(
  usageRowId: string,
  organizationId: string,
  costMicros: number,
): Promise<void> {
  // Same meter as chat: both are AI token spend priced in micro-dollars, and
  // one metered price on the subscription bills them together.
  const eventName = process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"];
  const secretKey = process.env["STRIPE_SECRET_KEY"];
  if (!eventName || !secretKey) return;

  // Complimentary orgs are never billed — keep the usage row for internal
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

  // The usage row id rides in `identifier`, not the payload: Stripe rejects
  // undeclared payload keys (they count as meter dimensions), and identifier
  // gives us 24h dedup for free when a reconciler replays unreported rows.
  const body = new URLSearchParams({
    event_name: eventName,
    identifier: usageRowId,
    "payload[stripe_customer_id]": sub.stripeCustomerId,
    "payload[value]": String(costMicros),
  });

  const res = await fetch("https://api.stripe.com/v1/billing/meter_events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Stripe meter event failed: HTTP ${res.status} ${await res.text()}`);
  }

  await db
    .update(workflowAiUsage)
    .set({ stripeUsageRecordId: usageRowId })
    .where(eq(workflowAiUsage.id, usageRowId));
}
