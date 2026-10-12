/**
 * Event delivery: the poller's `event-deliveries` pass and the inline send
 * behind "Send test event".
 *
 * Claim: the `alerts/pass.ts` idiom. One statement
 *
 *     UPDATE event_deliveries SET next_attempt_at = <lease>, attempt_count + 1
 *      WHERE id IN (SELECT … WHERE state IN ('pending','retrying')
 *                     AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED LIMIT n)
 *   RETURNING *
 *
 * so N replicas never send the same attempt twice, and a replica that dies
 * mid-send lets the row come due again when the lease runs out. The cost of
 * that is at-least-once delivery, which is why every envelope carries a
 * stable `id` and the docs tell receivers to dedupe on it.
 *
 * Gateway-only: a publish destination runs plugin code for an arbitrary
 * account (possibly behind a bastion), and a webhook send goes through the
 * Node egress guard.
 */
import { createHmac } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  EVENT_DELIVERY_HEADER,
  EVENT_ID_HEADER,
  EVENT_SIGNATURE_HEADER,
  EVENT_TYPE_HEADER,
  TEST_EVENT,
  eventRetryDelayMs,
  eventSignedContent,
  formatEventSignatureHeader,
  shouldAutoDisable,
  type EventDelivery,
  type InfrawrenchEvent,
} from "@infrawrench/client-core";
import { randomUUID } from "node:crypto";

import { db } from "../db/client";
import { eventDeliveries, eventSubscriptions } from "../db/schema";
import { runInEgressScope } from "../egress-guard";
import { getOrgAccountClient } from "../org-accounts";
import { pluginCodeAvailable } from "../plugin-loader";
import { orgAppUrl } from "../app-url";
import { buildEnvelope } from "./publish";
import {
  EventSubscriptionError,
  activeSecrets,
  getSubscriptionRow,
  toDelivery,
  type DeliveryRow,
  type SubscriptionRow,
} from "./store";
import { notifySubscriptionDisabled } from "./disable-email";

const CLAIM_LEASE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_EXCERPT = 1024;
const MAX_ATTEMPT_LOG = 10;
/** Terminal rows older than this are pruned on the hourly retention tick. */
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const USER_AGENT = "Infrawrench-Webhooks/1";

export interface AttemptOutcome {
  ok: boolean;
  status: number | null;
  excerpt: string | null;
  error: string | null;
  durationMs: number;
}

/** Hex HMAC-SHA256 of `<t>.<body>` under each secret, newest first. */
export function signEventBody(secrets: string[], timestampSeconds: number, body: string): string[] {
  const content = eventSignedContent(timestampSeconds, body);
  return secrets.map((s) => createHmac("sha256", s).update(content, "utf8").digest("hex"));
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function sendWebhook(sub: SubscriptionRow, row: DeliveryRow): Promise<AttemptOutcome> {
  const started = Date.now();
  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(started / 1000);
  const secrets = await activeSecrets(sub);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    [EVENT_ID_HEADER]: row.eventId,
    [EVENT_TYPE_HEADER]: row.eventType,
    [EVENT_DELIVERY_HEADER]: row.id,
  };
  if (secrets.length > 0) {
    headers[EVENT_SIGNATURE_HEADER] = formatEventSignatureHeader(
      timestamp,
      signEventBody(secrets, timestamp, body),
    );
  }
  try {
    const res = await runInEgressScope({ organizationId: sub.organizationId }, () =>
      fetch(sub.url ?? "", {
        method: "POST",
        headers,
        body,
        // A redirect is a failure, not a hop: following it would send a
        // signed body somewhere the admin never typed.
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    );
    const text = await res.text().catch(() => "");
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      status: res.status,
      excerpt: text ? truncate(text, MAX_EXCERPT) : null,
      error: ok
        ? null
        : res.status >= 300 && res.status < 400
          ? `Receiver answered with a redirect (HTTP ${res.status}); redirects are not followed.`
          : `Receiver answered HTTP ${res.status}.`,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "TimeoutError"
          ? `No response within ${REQUEST_TIMEOUT_MS / 1000}s.`
          : (err.cause instanceof Error ? err.cause.message : null) || err.message
        : String(err);
    return {
      ok: false,
      status: null,
      excerpt: null,
      error: message,
      durationMs: Date.now() - started,
    };
  }
}

async function sendPublish(sub: SubscriptionRow, row: DeliveryRow): Promise<AttemptOutcome> {
  const started = Date.now();
  try {
    const accountId = sub.publishAccountId ?? "";
    const resolved = await getOrgAccountClient(accountId, sub.organizationId);
    if (!resolved) throw new Error("The destination account is no longer connected.");
    const { client } = resolved;
    if (!client.publishMessage) throw new Error("This provider cannot publish messages.");
    const payload = row.payload as unknown as InfrawrenchEvent;
    const result = await runInEgressScope({ organizationId: sub.organizationId, accountId }, () =>
      client.publishMessage!(
        sub.publishResourceTypeId ?? "",
        sub.publishResourceId ?? "",
        accountId,
        {
          body: JSON.stringify(payload),
          extras: {},
          event: {
            type: payload.type,
            version: payload.version,
            id: payload.id,
            source: "infrawrench",
          },
        },
      ),
    );
    return {
      ok: true,
      status: null,
      excerpt: result.summary ?? (result.id ? `Published ${result.id}` : "Published."),
      error: null,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      excerpt: null,
      error: truncate(err instanceof Error ? err.message : String(err), MAX_EXCERPT),
      durationMs: Date.now() - started,
    };
  }
}

export function sendToDestination(sub: SubscriptionRow, row: DeliveryRow): Promise<AttemptOutcome> {
  return sub.destinationKind === "publish" ? sendPublish(sub, row) : sendWebhook(sub, row);
}

/**
 * Record one attempt on the row (and, for real events, on the subscription's
 * health). `row.attemptCount` already counts this attempt: the claim, or the
 * test path, incremented it.
 */
async function recordAttempt(
  sub: SubscriptionRow | null,
  row: DeliveryRow,
  outcome: AttemptOutcome,
  now: Date,
): Promise<DeliveryRow> {
  const attempts = [
    ...row.attempts,
    {
      at: now.toISOString(),
      status: outcome.status,
      durationMs: outcome.durationMs,
      error: outcome.error,
    },
  ].slice(-MAX_ATTEMPT_LOG);
  const delay = outcome.ok || row.isTest ? null : eventRetryDelayMs(row.attemptCount);
  const state = outcome.ok ? "succeeded" : delay === null ? "dead" : "retrying";
  const [updated] = await db
    .update(eventDeliveries)
    .set({
      state,
      attempts,
      lastAttemptAt: now,
      responseStatus: outcome.status,
      responseExcerpt: outcome.excerpt,
      error: outcome.error,
      deliveredAt: outcome.ok ? now : null,
      nextAttemptAt: delay === null ? null : new Date(now.getTime() + delay),
      updatedAt: now,
    })
    .where(eq(eventDeliveries.id, row.id))
    .returning();

  // A test says nothing about whether the receiver is healthy for real
  // traffic in either direction: it must not reset a failure streak that is
  // about to disable a subscription, nor push one over the edge.
  if (sub && !row.isTest) await recordHealth(sub, outcome.ok, now);
  return updated ?? row;
}

async function recordHealth(sub: SubscriptionRow, ok: boolean, now: Date): Promise<void> {
  if (ok) {
    await db
      .update(eventSubscriptions)
      .set({ consecutiveFailures: 0, failingSince: null, lastSuccessAt: now })
      .where(eq(eventSubscriptions.id, sub.id));
    return;
  }
  const [after] = await db
    .update(eventSubscriptions)
    .set({
      consecutiveFailures: sql`${eventSubscriptions.consecutiveFailures} + 1`,
      failingSince: sql`coalesce(${eventSubscriptions.failingSince}, ${now})`,
      lastFailureAt: now,
    })
    .where(eq(eventSubscriptions.id, sub.id))
    .returning();
  if (!after || !after.enabled) return;
  if (!shouldAutoDisable(after, now)) return;

  const reason =
    `Turned off automatically after ${after.consecutiveFailures} failed deliveries in a row ` +
    `since ${after.failingSince?.toISOString().slice(0, 10) ?? "recently"}.`;
  // Conditional on `enabled`, so two replicas crossing the line together
  // send one email.
  const [disabled] = await db
    .update(eventSubscriptions)
    .set({ enabled: false, disabledReason: reason, disabledAt: now, updatedAt: now })
    .where(and(eq(eventSubscriptions.id, sub.id), eq(eventSubscriptions.enabled, true)))
    .returning();
  if (!disabled) return;
  // Whatever is still queued would only fail too; keep it as history.
  await db
    .update(eventDeliveries)
    .set({
      state: "skipped",
      nextAttemptAt: null,
      error: "Subscription was turned off.",
      updatedAt: now,
    })
    .where(
      and(
        eq(eventDeliveries.subscriptionId, sub.id),
        inArray(eventDeliveries.state, ["pending", "retrying"]),
      ),
    );
  await notifySubscriptionDisabled(disabled, reason);
}

async function claimDue(now: Date, limit: number): Promise<DeliveryRow[]> {
  const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
  return db
    .update(eventDeliveries)
    .set({
      nextAttemptAt: lease,
      attemptCount: sql`${eventDeliveries.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      inArray(
        eventDeliveries.id,
        db
          .select({ id: eventDeliveries.id })
          .from(eventDeliveries)
          .where(
            and(
              inArray(eventDeliveries.state, ["pending", "retrying"]),
              lte(eventDeliveries.nextAttemptAt, now),
            ),
          )
          .orderBy(eventDeliveries.nextAttemptAt)
          .limit(limit)
          .for("update", { skipLocked: true }),
      ),
    )
    .returning();
}

async function processClaimed(row: DeliveryRow): Promise<boolean> {
  const sub = await getSubscriptionRow(row.organizationId, row.subscriptionId);
  const now = new Date();
  if (!sub || (!sub.enabled && !row.isTest)) {
    await db
      .update(eventDeliveries)
      .set({
        state: "skipped",
        nextAttemptAt: null,
        error: "Subscription is turned off.",
        updatedAt: now,
      })
      .where(eq(eventDeliveries.id, row.id));
    return false;
  }
  const outcome = await sendToDestination(sub, row);
  await recordAttempt(sub, row, outcome, new Date());
  return outcome.ok;
}

export interface EventDeliveryPassStats {
  claimed: number;
  delivered: number;
  failed: number;
}

/** The poller pass. Bounded per tick; a backlog spreads over ticks. */
export async function runEventDeliveryPass(
  opts: { limit?: number; concurrency?: number } = {},
): Promise<EventDeliveryPassStats> {
  const rows = await claimDue(new Date(), opts.limit ?? 50);
  const stats: EventDeliveryPassStats = { claimed: rows.length, delivered: 0, failed: 0 };
  const queue = [...rows];
  const workers = Array.from(
    { length: Math.min(opts.concurrency ?? 8, queue.length) },
    async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          if (await processClaimed(row)) stats.delivered++;
          else stats.failed++;
        } catch (err) {
          stats.failed++;
          console.error(`[events] delivery ${row.id} failed unexpectedly:`, err);
        }
      }
    },
  );
  await Promise.all(workers);
  return stats;
}

/** Drop terminal deliveries past retention. Rides the hourly retention tick. */
export async function pruneEventDeliveries(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  await db
    .delete(eventDeliveries)
    .where(
      and(
        inArray(eventDeliveries.state, ["succeeded", "dead", "skipped"]),
        lte(eventDeliveries.createdAt, cutoff),
      ),
    );
}

/**
 * "Send test event": queue an `infrawrench.test` envelope and, where this
 * process can run the send (anywhere for a webhook, the gateway for a publish
 * destination), attempt it now so the form shows the receiver's answer. A
 * test is tried once; it does not retry and does not count toward health.
 * Works on a disabled subscription too, which is how an admin checks a fix
 * before turning it back on.
 */
export async function sendTestEvent(
  organizationId: string,
  subscriptionId: string,
): Promise<EventDelivery> {
  const sub = await getSubscriptionRow(organizationId, subscriptionId);
  if (!sub) throw new EventSubscriptionError("Event subscription not found.", 404);
  const envelope = buildEnvelope(
    TEST_EVENT,
    organizationId,
    {
      message: "This is a test event from Infrawrench. Nothing happened.",
      subscriptionId,
    },
    { title: `Test event for "${sub.name}"`, url: orgAppUrl(organizationId, "settings/paging") },
    { test: true },
  );
  const now = new Date();
  const inline = sub.destinationKind === "webhook" || pluginCodeAvailable();
  const [row] = await db
    .insert(eventDeliveries)
    .values({
      id: randomUUID(),
      organizationId,
      subscriptionId,
      eventId: envelope.id,
      eventType: envelope.type,
      payload: envelope as unknown as Record<string, unknown>,
      state: "pending",
      isTest: true,
      // Inline: this request holds the row, as a claim would. Otherwise the
      // gateway pass picks it up on its next tick.
      attemptCount: inline ? 1 : 0,
      nextAttemptAt: inline ? new Date(now.getTime() + CLAIM_LEASE_MS) : now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!inline) return toDelivery(row!);
  const outcome = await sendToDestination(sub, row!);
  return toDelivery(await recordAttempt(sub, row!, outcome, new Date()));
}
