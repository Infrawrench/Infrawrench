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
 */
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { GIT_FORGE_LIMITS } from "@infrawrench/client-core";

import { customerOf, sendMeterEvent } from "../ci/billing.js";
import { db } from "../db/client.js";
import { gitNamespaces, gitRepositories, gitStorageSamples } from "../db/schema.js";
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

/** The poller's pass: sample the hour, send what is owed, prune what is old. */
export async function runGitStoragePass(): Promise<void> {
  await sampleGitStorage();
  await reportGitStorage(200);
  await pruneGitStorageSamples();
}
