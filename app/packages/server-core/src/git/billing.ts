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
 */
import { and, asc, eq, isNotNull, isNull, like, lt, sql } from "drizzle-orm";
import { GIT_FORGE_LIMITS } from "@infrawrench/client-core";

import { customerOf, sendMeterEvent } from "../ci/billing.js";
import { db } from "../db/client.js";
import {
  gitNamespaces,
  gitRepositories,
  gitStorageSamples,
  workflowAiUsage,
} from "../db/schema.js";
import { planAccess } from "../entitlements.js";

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

/**
 * The poller's pass: sample the hour, send what is owed, prune what is old,
 * and send what the review agents used.
 */
export async function runGitStoragePass(): Promise<void> {
  await sampleGitStorage();
  await reportGitStorage(200);
  await pruneGitStorageSamples();
  await reportGitReviewUsage(200);
}
