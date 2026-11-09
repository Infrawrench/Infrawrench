/**
 * Billing for CI through Stripe Billing Meters, the way hosted build time is
 * billed (`billing/build-meter.ts`): usage in its natural unit, the price on
 * the Stripe price object, plain `fetch` (server-core has no Stripe SDK).
 *
 * Three meters, each optional (unset means that part is not billed):
 * - `INFRAWRENCH_STRIPE_CI_VCPU_METER_EVENT`: vCPU-seconds per run (a job is
 *   charged its wall time at its share of a vCPU, as the runner reports).
 * - `INFRAWRENCH_STRIPE_CI_MEMORY_METER_EVENT`: GiB-seconds of memory
 *   reserved per run.
 * - `INFRAWRENCH_STRIPE_CI_STORAGE_METER_EVENT`: GiB-hours of cache storage,
 *   sampled from the runners once an hour per GitHub account.
 *
 * Unlike the build meter, nothing is fire-and-forget: the poller pass sends
 * what has not been sent yet (`usage_reported_at` / `reported_at` null),
 * with the run's or the hour's own timestamp and a fixed identifier, so a
 * retry is deduplicated by Stripe and a late report still lands in the
 * right period. Complimentary organizations are never billed; usage older
 * than Stripe's 35-day window is dropped with a log line.
 */
import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { CiUsage } from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { organizations } from "../db/core-schema.js";
import { ciAccounts, ciRuns, ciStorageSamples, subscriptions } from "../db/schema.js";
import { accountOwnerKey } from "./events.js";
import { proxyJson } from "./proxy.js";

const GIB = 1024 ** 3;
/** Stripe accepts meter events up to 35 days old; stay inside it. */
const MAX_AGE_MS = 34 * 24 * 60 * 60_000;

function meter(name: "VCPU" | "MEMORY" | "STORAGE"): string | null {
  return process.env[`INFRAWRENCH_STRIPE_CI_${name}_METER_EVENT`] || null;
}

export function ciBillingConfigured(): boolean {
  return Boolean(
    process.env["STRIPE_SECRET_KEY"] && (meter("VCPU") || meter("MEMORY") || meter("STORAGE")),
  );
}

type Customer = { kind: "bill"; id: string } | { kind: "never" } | { kind: "unknown" };

/** Who to bill: the org's Stripe customer, never (complimentary), or not yet known. */
async function customerOf(organizationId: string): Promise<Customer> {
  const [org] = await db
    .select({ complimentary: organizations.complimentary })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org || org.complimentary) return { kind: "never" };
  const [sub] = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId))
    .limit(1);
  return sub?.stripeCustomerId ? { kind: "bill", id: sub.stripeCustomerId } : { kind: "unknown" };
}

async function sendMeterEvent(
  eventName: string,
  identifier: string,
  customerId: string,
  value: number,
  at: Date,
): Promise<void> {
  const secretKey = process.env["STRIPE_SECRET_KEY"];
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not set");
  const body = new URLSearchParams({
    event_name: eventName,
    identifier,
    timestamp: String(Math.floor(at.getTime() / 1000)),
    "payload[stripe_customer_id]": customerId,
    // Decimals are allowed; three places is well below a cent of anything.
    "payload[value]": value.toFixed(3),
  });
  const res = await fetch("https://api.stripe.com/v1/billing/meter_events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  // 400 with `resource_already_exists` is a retry of an event Stripe kept.
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 400 && text.includes("resource_already_exists")) return;
    throw new Error(`Stripe rejected the CI meter event ${identifier} (${res.status}).`);
  }
}

/** Sends finished runs' usage to the meters. Returns how many were settled. */
export async function reportRunUsage(limit: number): Promise<number> {
  if (!ciBillingConfigured()) return 0;
  const rows = await db
    .select()
    .from(ciRuns)
    .where(
      and(
        isNull(ciRuns.usageReportedAt),
        isNotNull(ciRuns.vcpuSeconds),
        isNotNull(ciRuns.finishedAt),
      ),
    )
    .orderBy(ciRuns.finishedAt)
    .limit(limit);
  let settled = 0;
  for (const row of rows) {
    const finishedAt = row.finishedAt ?? new Date();
    const markReported = () =>
      db.update(ciRuns).set({ usageReportedAt: new Date() }).where(eq(ciRuns.id, row.id));
    if (Date.now() - finishedAt.getTime() > MAX_AGE_MS) {
      console.warn(`[ci] run ${row.id}'s usage is older than Stripe accepts; not billed`);
      await markReported();
      settled++;
      continue;
    }
    const customer = await customerOf(row.organizationId);
    if (customer.kind === "never") {
      await markReported();
      settled++;
      continue;
    }
    if (customer.kind === "unknown") continue;
    try {
      const vcpu = meter("VCPU");
      if (vcpu && (row.vcpuSeconds ?? 0) > 0) {
        await sendMeterEvent(
          vcpu,
          `ci-${row.id}-vcpu`,
          customer.id,
          row.vcpuSeconds ?? 0,
          finishedAt,
        );
      }
      const memory = meter("MEMORY");
      if (memory && (row.memoryGibSeconds ?? 0) > 0) {
        await sendMeterEvent(
          memory,
          `ci-${row.id}-memory`,
          customer.id,
          row.memoryGibSeconds ?? 0,
          finishedAt,
        );
      }
      await markReported();
      settled++;
    } catch (err) {
      console.warn(`[ci] reporting run ${row.id}'s usage failed; will retry:`, err);
    }
  }
  return settled;
}

function hourStart(at: Date): Date {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** Records this hour's cache storage for every GitHub account that runs CI. */
export async function sampleStorage(): Promise<number> {
  if (!meter("STORAGE")) return 0;
  const hour = hourStart(new Date());
  const owners = await db
    .selectDistinct({
      organizationId: ciAccounts.organizationId,
      accountLogin: ciAccounts.accountLogin,
    })
    .from(ciAccounts);
  let sampled = 0;
  for (const owner of owners) {
    const ownerKey = accountOwnerKey(owner.accountLogin);
    const [existing] = await db
      .select({ id: ciStorageSamples.id })
      .from(ciStorageSamples)
      .where(and(eq(ciStorageSamples.ownerKey, ownerKey), eq(ciStorageSamples.hour, hour)))
      .limit(1);
    if (existing) continue;
    try {
      const usage = await proxyJson<{ used_bytes?: number }>(
        `/v1/storage/${encodeURIComponent(ownerKey)}`,
      );
      await db
        .insert(ciStorageSamples)
        .values({
          id: crypto.randomUUID(),
          organizationId: owner.organizationId,
          ownerKey,
          hour,
          bytes: Math.max(0, Math.round(usage.used_bytes ?? 0)),
        })
        .onConflictDoNothing();
      sampled++;
    } catch (err) {
      console.warn(`[ci] could not sample ${ownerKey}'s storage:`, err);
    }
  }
  return sampled;
}

/** Sends sampled storage hours to the storage meter. */
export async function reportStorage(limit: number): Promise<number> {
  const storage = meter("STORAGE");
  if (!storage || !process.env["STRIPE_SECRET_KEY"]) return 0;
  const rows = await db
    .select()
    .from(ciStorageSamples)
    .where(isNull(ciStorageSamples.reportedAt))
    .orderBy(ciStorageSamples.hour)
    .limit(limit);
  let settled = 0;
  for (const row of rows) {
    const markReported = () =>
      db
        .update(ciStorageSamples)
        .set({ reportedAt: new Date() })
        .where(eq(ciStorageSamples.id, row.id));
    if (Date.now() - row.hour.getTime() > MAX_AGE_MS || row.bytes === 0) {
      await markReported();
      settled++;
      continue;
    }
    const customer = await customerOf(row.organizationId);
    if (customer.kind === "never") {
      await markReported();
      settled++;
      continue;
    }
    if (customer.kind === "unknown") continue;
    try {
      // One hour of `bytes` is bytes/GiB GiB-hours.
      await sendMeterEvent(storage, `ci-storage-${row.id}`, customer.id, row.bytes / GIB, row.hour);
      await markReported();
      settled++;
    } catch (err) {
      console.warn(`[ci] reporting ${row.ownerKey}'s storage failed; will retry:`, err);
    }
  }
  return settled;
}

/** The organization's CI usage in a UTC month (`YYYY-MM`, default this one). */
export async function ciUsage(organizationId: string, month?: string): Promise<CiUsage> {
  const now = new Date();
  const [y, m] = (
    month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  )
    .split("-")
    .map(Number);
  const start = new Date(Date.UTC(y ?? now.getUTCFullYear(), (m ?? 1) - 1, 1));
  const end = new Date(Date.UTC(y ?? now.getUTCFullYear(), m ?? 1, 1));
  const [runs] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      vcpu: sql<number>`coalesce(sum(${ciRuns.vcpuSeconds}), 0)::float8`,
      memory: sql<number>`coalesce(sum(${ciRuns.memoryGibSeconds}), 0)::float8`,
    })
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.organizationId, organizationId),
        isNotNull(ciRuns.finishedAt),
        gte(ciRuns.finishedAt, start),
        lt(ciRuns.finishedAt, end),
      ),
    );
  const [storage] = await db
    .select({ bytesHours: sql<number>`coalesce(sum(${ciStorageSamples.bytes}), 0)::float8` })
    .from(ciStorageSamples)
    .where(
      and(
        eq(ciStorageSamples.organizationId, organizationId),
        gte(ciStorageSamples.hour, start),
        lt(ciStorageSamples.hour, end),
      ),
    );
  // The latest sample is the storage now.
  const [latest] = await db
    .select({ hour: ciStorageSamples.hour })
    .from(ciStorageSamples)
    .where(eq(ciStorageSamples.organizationId, organizationId))
    .orderBy(sql`${ciStorageSamples.hour} desc`)
    .limit(1);
  let storageBytes: number | null = null;
  if (latest) {
    const [sum] = await db
      .select({ bytes: sql<number>`coalesce(sum(${ciStorageSamples.bytes}), 0)::float8` })
      .from(ciStorageSamples)
      .where(
        and(
          eq(ciStorageSamples.organizationId, organizationId),
          eq(ciStorageSamples.hour, latest.hour),
        ),
      );
    storageBytes = sum?.bytes ?? null;
  }
  return {
    month: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    runs: runs?.runs ?? 0,
    vcpuSeconds: runs?.vcpu ?? 0,
    memoryGibSeconds: runs?.memory ?? 0,
    storageGibHours: (storage?.bytesHours ?? 0) / GIB,
    storageBytes,
  };
}
