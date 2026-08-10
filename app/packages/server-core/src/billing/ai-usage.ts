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
 * (rows hang off a workflow/run) — plus any in-flight holds in
 * `ai_spend_reservations`. Splitting the cap per feature would let a workflow
 * spend on top of everything chat already allowed.
 *
 * Before a provider call, both surfaces {@link reserveAiSpend} under an
 * org-scoped advisory lock so concurrent consumers see each other's hold.
 * Reservations older than {@link AI_SPEND_RESERVATION_TTL_MS} are purged and
 * ignored, so a crashed process cannot permanently block the org. On success
 * the caller records real usage first, then {@link releaseAiSpendReservation}
 * (brief double-count is conservative for the cap); on failure or Stop they
 * release without recording.
 *
 * Workflow usage reports to the same Stripe chat meter (micro-dollar unit)
 * with the same plain-fetch approach as `./build-meter.ts` — server-core does
 * not depend on the Stripe SDK. Best-effort by contract: a null
 * `stripe_usage_record_id` is what a future replay job would key on.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  aiSpendReservations,
  chatUsage,
  organizations,
  subscriptions,
  workflowAiUsage,
} from "../db/schema.js";
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

/**
 * How long an in-flight reservation counts toward the cap. Past the workflow
 * AI timeout (2 min) and long enough for a chat model call; short enough that
 * a dead process stops blocking the org within minutes.
 */
export const AI_SPEND_RESERVATION_TTL_MS = 10 * 60 * 1000;

/** Structurally identical to `SpendStatus` in @infrawrench/ui. */
export interface AiSpendStatus {
  monthToDateMicros: number;
  monthlyCapMicros: number | null;
  exceeded: boolean;
  freeTier: boolean;
  complimentary: boolean;
}

/** Thrown when {@link reserveAiSpend} finds the org already at its monthly cap. */
export class AiSpendCapExceededError extends Error {
  readonly spend: AiSpendStatus;

  constructor(spend: AiSpendStatus, message?: string) {
    super(
      message ??
        "This organization has reached its monthly AI spend cap. " +
          "An admin can raise it under Settings → AI Chat, or it resets when the month rolls over.",
    );
    this.name = "AiSpendCapExceededError";
    this.spend = spend;
  }
}

/** Anything that can run the selects `getAiSpendStatus` needs — `db` or a tx. */
type SpendQueryable = Pick<typeof db, "select">;

function reservationCutoff(): Date {
  return new Date(Date.now() - AI_SPEND_RESERVATION_TTL_MS);
}

/** Drop reservations past the TTL so a crashed holder cannot block the org. */
async function purgeExpiredReservations(
  queryable: { delete: typeof db.delete },
  organizationId?: string,
): Promise<void> {
  const cutoff = reservationCutoff();
  await queryable
    .delete(aiSpendReservations)
    .where(
      organizationId
        ? and(
            eq(aiSpendReservations.organizationId, organizationId),
            lt(aiSpendReservations.createdAt, cutoff),
          )
        : lt(aiSpendReservations.createdAt, cutoff),
    );
}

export async function getAiSpendStatus(
  organizationId: string,
  queryable: SpendQueryable = db,
): Promise<AiSpendStatus> {
  const [org] = await queryable
    .select({
      cap: organizations.chatMonthlyCapMicros,
      complimentary: organizations.complimentary,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  const [sub] = await queryable
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

  const chatRows = await queryable
    .select({ total: sql<string>`coalesce(sum(${chatUsage.costMicros}), 0)` })
    .from(chatUsage)
    .where(
      and(eq(chatUsage.organizationId, organizationId), gte(chatUsage.createdAt, monthStart())),
    );
  const workflowRows = await queryable
    .select({ total: sql<string>`coalesce(sum(${workflowAiUsage.costMicros}), 0)` })
    .from(workflowAiUsage)
    .where(
      and(
        eq(workflowAiUsage.organizationId, organizationId),
        gte(workflowAiUsage.createdAt, monthStart()),
      ),
    );
  // Active holds only — expired rows are ignored here and deleted on reserve.
  const reservationRows = await queryable
    .select({ total: sql<string>`coalesce(sum(${aiSpendReservations.estimatedCostMicros}), 0)` })
    .from(aiSpendReservations)
    .where(
      and(
        eq(aiSpendReservations.organizationId, organizationId),
        gte(aiSpendReservations.createdAt, reservationCutoff()),
      ),
    );

  const monthToDateMicros =
    (Number(chatRows[0]?.total ?? 0) || 0) +
    (Number(workflowRows[0]?.total ?? 0) || 0) +
    (Number(reservationRows[0]?.total ?? 0) || 0);
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
 * Rough token count from character length. Anthropic's Latin-script average is
 * ~4 characters per token; overshooting the estimate is fine — the reservation
 * is a ceiling, and real usage replaces it after the call.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Check the org's monthly AI cap and insert a reservation under an org-scoped
 * advisory lock. Chat and workflow callers both use this so they serialize on
 * the same key and see each other's holds in the month-to-date sum.
 *
 * Returns the reservation id. The caller must record real usage (if any) and
 * then {@link releaseAiSpendReservation}, or release alone on failure/Stop.
 *
 * @throws {AiSpendCapExceededError} when the org is already at its cap
 */
export async function reserveAiSpend(
  organizationId: string,
  estimatedCostMicros: number,
): Promise<string> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai_spend:${organizationId}`}))`);
    await purgeExpiredReservations(tx, organizationId);
    const spend = await getAiSpendStatus(organizationId, tx);
    if (spend.exceeded) {
      throw new AiSpendCapExceededError(spend);
    }
    await tx.insert(aiSpendReservations).values({
      id,
      organizationId,
      estimatedCostMicros: Math.max(0, estimatedCostMicros),
    });
  });
  return id;
}

/** Drop an in-flight reservation so its estimate stops counting toward the cap. */
export async function releaseAiSpendReservation(reservationId: string): Promise<void> {
  await db.delete(aiSpendReservations).where(eq(aiSpendReservations.id, reservationId));
}

/**
 * Insert a finalized workflow_ai_usage row and try to report it to the chat
 * Stripe meter. Call this before releasing the matching reservation so the
 * brief overlap is a conservative double-count rather than a gap.
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
