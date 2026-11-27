/**
 * Metering for storage on git.infrawrench.com, through the same outbox CI's
 * storage uses (`ci/billing.ts`): a row per organisation per hour, sent to a
 * Stripe Billing Meter with the hour's own timestamp and a fixed identifier,
 * so a retry is deduplicated by Stripe and a late report lands in the right
 * period.
 *
 * `INFRAWRENCH_STRIPE_GIT_STORAGE_METER_EVENT` names the meter; unset, the
 * hours are still sampled (Settings > Git and support read them) and marked
 * settled at once, so turning the meter on later never bills the past.
 *
 * What is sent is GiB-hours of **private** storage above what the plan
 * includes (`GIT_FORGE_LIMITS`): public repositories are free, and so is a
 * free organisation's allowance, which pushes cannot exceed. The price is on
 * the Stripe price object. Complimentary organisations are marked without
 * sending; hours older than Stripe's 35-day window are dropped with a log
 * line. A person's own namespace is never sampled.
 *
 * The forge's review agents are metered here too ({@link reportGitReviewUsage}).
 * Their usage is written by the forge's Worker into the organisation's AI
 * spend (`workflow_ai_usage`, `billing/ai-usage.ts`), which is what the
 * monthly cap counts, but the Worker holds no Stripe key, so the meter event
 * is sent from this pass instead: the same chat meter, the same identifier
 * (the usage row's id) `recordWorkflowAiUsage` would have used.
 *
 * The pass also keeps two things in step that the forge's Worker cannot,
 * having no Stripe key and no clock: the metered storage price on the
 * subscription of an organisation that claimed its namespace on the forge
 * ({@link ensureGitStoragePrices}), and the connections of people who have
 * left the organisation their own namespace ran in (`workspace.ts`).
 */
import { and, asc, eq, isNotNull, isNull, like, lt, ne, sql } from "drizzle-orm";
import { GIT_FORGE_LIMITS } from "@infrawrench/client-core";

import { customerOf, sendMeterEvent } from "../ci/billing.js";
import { db } from "../db/client.js";
import {
  gitNamespaces,
  gitRepositories,
  gitStorageSamples,
  subscriptions,
  workflowAiUsage,
} from "../db/schema.js";
import { planAccess } from "../entitlements.js";
import { sweepGitWorkspaces } from "./workspace.js";

const GIB = 1024 ** 3;
/** Stripe accepts meter events up to 35 days old; stay inside it. */
const MAX_AGE_MS = 34 * 24 * 60 * 60_000;
/** Settled samples are kept this long, for the usage history, then pruned. */
const KEEP_MS = 400 * 24 * 60 * 60_000;

function storageMeter(): string | null {
  return process.env["INFRAWRENCH_STRIPE_GIT_STORAGE_METER_EVENT"] || null;
}

export function gitBillingConfigured(): boolean {
  return Boolean(process.env["STRIPE_SECRET_KEY"] && storageMeter());
}

function hourStart(at: Date): Date {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** The part of a plan's private storage that is metered. Pure. */
export function billableGitBytes(privateBytes: number, paid: boolean): number {
  // A free organisation's allowance is a hard limit, not a metered one.
  if (!paid) return 0;
  return Math.max(0, Math.round(privateBytes) - GIT_FORGE_LIMITS.paid.includedStorageBytes);
}

/**
 * Records this hour's storage for every organisation with a namespace that
 * holds anything. Returns how many rows were written.
 */
export async function sampleGitStorage(now: Date = new Date()): Promise<number> {
  const hour = hourStart(now);
  const owners = await db
    .select({
      organizationId: gitNamespaces.organizationId,
      bytes: sql<number>`coalesce(sum(${gitRepositories.sizeBytes}), 0)::float8`,
      privateBytes: sql<number>`coalesce(sum(${gitRepositories.sizeBytes}) filter (where ${gitRepositories.visibility} = 'private'), 0)::float8`,
    })
    .from(gitNamespaces)
    .innerJoin(gitRepositories, eq(gitRepositories.namespaceId, gitNamespaces.id))
    .where(and(eq(gitNamespaces.kind, "org"), isNotNull(gitNamespaces.organizationId)))
    .groupBy(gitNamespaces.organizationId);
  const sampledThisHour = new Set(
    (
      await db
        .select({ organizationId: gitStorageSamples.organizationId })
        .from(gitStorageSamples)
        .where(eq(gitStorageSamples.hour, hour))
    ).map((row) => row.organizationId),
  );
  const metered = gitBillingConfigured();
  let sampled = 0;
  for (const owner of owners) {
    const organizationId = owner.organizationId;
    if (organizationId === null || sampledThisHour.has(organizationId)) continue;
    if (owner.bytes <= 0) continue;
    try {
      const billableBytes = billableGitBytes(
        owner.privateBytes,
        (await planAccess(organizationId)).paid,
      );
      const inserted = await db
        .insert(gitStorageSamples)
        .values({
          id: crypto.randomUUID(),
          organizationId,
          hour,
          bytes: Math.round(owner.bytes),
          privateBytes: Math.round(owner.privateBytes),
          billableBytes,
          // Nothing to send: settled as it is written.
          reportedAt: metered && billableBytes > 0 ? null : now,
        })
        .onConflictDoNothing()
        .returning({ id: gitStorageSamples.id });
      sampled += inserted.length;
    } catch (err) {
      console.warn(`[git] could not sample ${organizationId}'s storage:`, err);
    }
  }
  return sampled;
}

/** Sends sampled storage hours to the storage meter. Returns how many were settled. */
export async function reportGitStorage(limit: number): Promise<number> {
  const meter = storageMeter();
  if (!meter || !process.env["STRIPE_SECRET_KEY"]) return 0;
  const rows = await db
    .select()
    .from(gitStorageSamples)
    .where(isNull(gitStorageSamples.reportedAt))
    .orderBy(gitStorageSamples.hour)
    .limit(limit);
  let settled = 0;
  // One lookup per organisation per pass: an organisation has many hours.
  const customers = new Map<string, Awaited<ReturnType<typeof customerOf>>>();
  for (const row of rows) {
    const markReported = () =>
      db
        .update(gitStorageSamples)
        .set({ reportedAt: new Date() })
        .where(eq(gitStorageSamples.id, row.id));
    if (Date.now() - row.hour.getTime() > MAX_AGE_MS) {
      if (row.billableBytes > 0) {
        console.warn(
          `[git] ${row.organizationId}'s storage for ${row.hour.toISOString()} is older than Stripe accepts; not billed`,
        );
      }
      await markReported();
      settled++;
      continue;
    }
    if (row.billableBytes === 0) {
      await markReported();
      settled++;
      continue;
    }
    let customer = customers.get(row.organizationId);
    if (!customer) {
      customer = await customerOf(row.organizationId);
      customers.set(row.organizationId, customer);
    }
    if (customer.kind === "never") {
      await markReported();
      settled++;
      continue;
    }
    // No Stripe customer yet (a trial, a checkout in progress): the hour
    // waits, and is dropped by the age rule above if none ever appears.
    if (customer.kind === "unknown") continue;
    try {
      // One hour of `bytes` is bytes/GiB GiB-hours.
      await sendMeterEvent(
        meter,
        `git-storage-${row.id}`,
        customer.id,
        row.billableBytes / GIB,
        row.hour,
      );
      await markReported();
      settled++;
    } catch (err) {
      console.warn(`[git] reporting ${row.organizationId}'s storage failed; will retry:`, err);
    }
  }
  return settled;
}

/** Drops settled samples past their keep. Returns how many went. */
export async function pruneGitStorageSamples(now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(gitStorageSamples)
    .where(
      and(
        isNotNull(gitStorageSamples.reportedAt),
        lt(gitStorageSamples.hour, new Date(now.getTime() - KEEP_MS)),
      ),
    )
    .returning({ id: gitStorageSamples.id });
  return removed.length;
}

/**
 * What marks a usage row as the forge's review agents': its `workflow_id`
 * is this and the repository's id. The forge's Worker writes it
 * (`git/packages/worker/src/review/runner.ts`, `reviewUsageSource`).
 */
export const GIT_REVIEW_USAGE_PREFIX = "git-review:";

/** What `stripe_usage_record_id` holds for usage that is settled without a meter event. */
export const GIT_REVIEW_NOT_BILLED = "not-billed";

/**
 * Sends the review agents' usage to the AI meter (micro-dollars, the chat
 * meter). Returns how many rows were settled. A complimentary organisation's
 * rows are settled unsent; one with no Stripe customer yet waits, and is
 * settled unsent once it is older than Stripe accepts.
 */
export async function reportGitReviewUsage(limit: number, now: Date = new Date()): Promise<number> {
  const meter = process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"] || null;
  if (!meter || !process.env["STRIPE_SECRET_KEY"]) return 0;
  const rows = await db
    .select({
      id: workflowAiUsage.id,
      organizationId: workflowAiUsage.organizationId,
      costMicros: workflowAiUsage.costMicros,
      createdAt: workflowAiUsage.createdAt,
    })
    .from(workflowAiUsage)
    .where(
      and(
        isNull(workflowAiUsage.stripeUsageRecordId),
        like(workflowAiUsage.workflowId, `${GIT_REVIEW_USAGE_PREFIX}%`),
      ),
    )
    .orderBy(asc(workflowAiUsage.createdAt))
    .limit(limit);
  let settled = 0;
  const customers = new Map<string, Awaited<ReturnType<typeof customerOf>>>();
  for (const row of rows) {
    const settle = (as: string) =>
      db
        .update(workflowAiUsage)
        .set({ stripeUsageRecordId: as })
        .where(and(eq(workflowAiUsage.id, row.id), isNull(workflowAiUsage.stripeUsageRecordId)));
    const tooOld = now.getTime() - row.createdAt.getTime() > MAX_AGE_MS;
    let customer = customers.get(row.organizationId);
    if (!customer) {
      customer = await customerOf(row.organizationId);
      customers.set(row.organizationId, customer);
    }
    if (customer.kind === "never" || row.costMicros <= 0) {
      await settle(GIT_REVIEW_NOT_BILLED);
      settled++;
      continue;
    }
    if (tooOld) {
      if (customer.kind === "bill") {
        console.warn(
          `[git] ${row.organizationId}'s review usage ${row.id} is older than Stripe accepts; not billed`,
        );
      }
      await settle(GIT_REVIEW_NOT_BILLED);
      settled++;
      continue;
    }
    // No Stripe customer: the free allowance, or a checkout in progress. It waits.
    if (customer.kind === "unknown") continue;
    try {
      await sendMeterEvent(meter, row.id, customer.id, row.costMicros, row.createdAt);
      await settle(row.id);
      settled++;
    } catch (err) {
      console.warn(`[git] reporting ${row.organizationId}'s review usage failed; will retry:`, err);
    }
  }
  return settled;
}

function storagePrice(): string | null {
  return process.env["STRIPE_GIT_STORAGE_PRICE_ID"] || null;
}

async function stripeForm(
  path: string,
  init: { method: "GET" } | { method: "POST"; body: URLSearchParams; idempotencyKey: string },
): Promise<unknown> {
  const secretKey = process.env["STRIPE_SECRET_KEY"];
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not set");
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(init.method === "POST"
        ? {
            "content-type": "application/x-www-form-urlencoded",
            "Idempotency-Key": init.idempotencyKey,
          }
        : {}),
    },
    ...(init.method === "POST" ? { body: init.body } : {}),
  });
  if (!res.ok) throw new Error(`Stripe answered ${res.status} for ${init.method} ${path}`);
  return res.json();
}

/** Whether a subscription has an item at `price`, from `GET /v1/subscription_items`. Pure. */
export function subscriptionHasPrice(listing: unknown, price: string): boolean {
  const data = (listing as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("Stripe's list of subscription items has no data");
  return data.some((item) => (item as { price?: { id?: unknown } } | null)?.price?.id === price);
}

/** A subscription that could not be checked is left alone this long, per process. */
const PRICE_RETRY_MS = 60 * 60_000;
const priceRetryAfter = new Map<string, number>();

/** For tests: forget which subscriptions failed. */
export function resetGitStoragePriceRetries(): void {
  priceRetryAfter.clear();
}

/**
 * Adds the metered storage price (`STRIPE_GIT_STORAGE_PRICE_ID`) to the
 * subscription of every organisation that has a namespace and a
 * subscription without it, so storage above what the plan includes has an
 * item to be billed to. Checkout attaches the price to a new subscription
 * and the app's claim adds it at once (web's `ensureGitStoragePrice`); this
 * is for the rest: a namespace claimed on the forge, whose Worker has no
 * Stripe key, and a claim in the app whose background call failed.
 *
 * Each namespace is looked at once: `storage_price_ensured_at` is set when
 * its subscription is seen to carry the price, added just now or already
 * there, and an organisation without a subscription yet is asked again
 * when it has one. Safe to run twice at once: the second instance finds the
 * item, or sends the same idempotency key. Returns how many were settled.
 */
export async function ensureGitStoragePrices(limit = 20, now: Date = new Date()): Promise<number> {
  const price = storagePrice();
  if (!price || !process.env["STRIPE_SECRET_KEY"]) return 0;
  const rows = await db
    .select({
      namespaceId: gitNamespaces.id,
      organizationId: gitNamespaces.organizationId,
      subscriptionId: subscriptions.stripeSubscriptionId,
    })
    .from(gitNamespaces)
    .innerJoin(subscriptions, eq(subscriptions.organizationId, gitNamespaces.organizationId))
    .where(
      and(
        eq(gitNamespaces.kind, "org"),
        isNull(gitNamespaces.storagePriceEnsuredAt),
        isNotNull(subscriptions.stripeSubscriptionId),
        ne(subscriptions.status, "canceled"),
      ),
    )
    .orderBy(asc(gitNamespaces.createdAt))
    .limit(limit);
  let settled = 0;
  for (const row of rows) {
    const subscription = row.subscriptionId;
    if (!subscription) continue;
    if ((priceRetryAfter.get(subscription) ?? 0) > now.getTime()) continue;
    try {
      const items = await stripeForm(
        `/v1/subscription_items?subscription=${encodeURIComponent(subscription)}&limit=100`,
        { method: "GET" },
      );
      if (!subscriptionHasPrice(items, price)) {
        await stripeForm("/v1/subscription_items", {
          method: "POST",
          body: new URLSearchParams({ subscription, price }),
          idempotencyKey: `git-storage-price-${subscription}-${price}`,
        });
        console.log(`[git] added the storage price to ${row.organizationId}'s subscription`);
      }
      await db
        .update(gitNamespaces)
        .set({ storagePriceEnsuredAt: now })
        .where(eq(gitNamespaces.id, row.namespaceId));
      priceRetryAfter.delete(subscription);
      settled++;
    } catch (err) {
      priceRetryAfter.set(subscription, now.getTime() + PRICE_RETRY_MS);
      console.warn(
        `[git] could not put the storage price on ${row.organizationId}'s subscription; will retry:`,
        err,
      );
    }
  }
  return settled;
}

/**
 * The poller's pass: sample the hour, send what is owed, prune what is old,
 * send what the review agents used, put the storage price on subscriptions
 * that lack it, and clear the connections of people who have left.
 */
export async function runGitStoragePass(): Promise<void> {
  await sampleGitStorage();
  await reportGitStorage(200);
  await pruneGitStorageSamples();
  await reportGitReviewUsage(200);
  await ensureGitStoragePrices();
  await sweepGitWorkspaces();
}
