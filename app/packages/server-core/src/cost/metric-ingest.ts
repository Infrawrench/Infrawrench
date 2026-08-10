/**
 * Validation and storage for business metric values — the denominators unit
 * costs divide by.
 *
 * Two callers push values and they must behave identically, so the rules live
 * here rather than in either of them:
 *
 * - `infra.businessMetrics.write(...)` from a workflow.
 * - `POST /api/org/{orgId}/business-metrics/{id}/values` from a server.
 *
 * This is deliberately the same shape of module as `cost/cost-ingest.ts`, and
 * it inherits that module's guarantees:
 *
 * - **Re-reporting a day restates it, never accumulates.** For cost rows that
 *   falls out of the ReplacingMergeTree key; here it is a `(metric_id, day)`
 *   unique index and an `ON CONFLICT DO UPDATE`. Either way a nightly job is
 *   safe to retry, which is the only property that makes unattended ingest
 *   usable at all — an accumulating write doubles every number the first time
 *   the job re-runs, and nothing about the resulting chart looks wrong.
 * - **Nothing lands unless everything validates.** The whole batch is checked
 *   before the first row is written, so a bad row 400s instead of leaving half
 *   a month restated.
 * - **Messages name the offending index** and reach the workflow author or the
 *   HTTP client unchanged.
 *
 * There is no reserved-tag equivalent here, and none is needed: a value's
 * identity is `(metric, day)` and a metric belongs to exactly one org, so there
 * is no shared key space for two sources to collide in. When two sources write
 * the same metric they are, by construction, making claims about the same
 * number — and the last claim wins, which is what restatement means.
 */
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { BusinessMetricValueSource } from "@infrawrench/client-core";

import { db } from "../db/client";
import { businessMetricValues, businessMetrics } from "../db/schema";

/** One reported day, as it arrives from user code or off the wire. */
export interface IngestMetricValue {
  date: string;
  value: number;
}

/** Where a batch came from. */
export interface MetricIngestSource {
  /** Prefixes every validation message, e.g. `infra.businessMetrics.write`. */
  errorPrefix: string;
  /** Stamped on every written row so a surprising point has an author. */
  source: BusinessMetricValueSource;
  /** Recorded on the row; null for an unattended API-key caller. */
  userId: string | null;
  /** Most values accepted in one call. */
  maxValues: number;
}

/** A rejected batch. Callers map this onto their own error surface. */
export class BusinessMetricIngestError extends Error {
  override readonly name = "BusinessMetricIngestError";
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a `YYYY-MM-DD` string that is also a real calendar date. */
function isRealDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

/** A live metric in this org, by id or by key. Null when there is none. */
export async function resolveBusinessMetric(
  organizationId: string,
  keyOrId: string,
): Promise<typeof businessMetrics.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(businessMetrics)
    .where(
      and(
        eq(businessMetrics.organizationId, organizationId),
        isNull(businessMetrics.deletedAt),
        // Keys are how workflows and the CLI address a metric; ids are how the
        // API does. Accepting both here means one lookup serves every caller
        // and no surface has to make the user find an opaque uuid.
        sql`(${businessMetrics.id} = ${keyOrId} OR ${businessMetrics.key} = ${keyOrId})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Validate and store a batch of values for one metric. Throws
 * {@link BusinessMetricIngestError} on anything the caller can fix.
 *
 * Returns how many days were written — which counts restatements, because from
 * the caller's side "I reported 30 days" is true whether or not those days
 * already had numbers.
 */
export async function ingestMetricValues(opts: {
  organizationId: string;
  metricId: string;
  values: IngestMetricValue[];
  source: MetricIngestSource;
}): Promise<{ written: number }> {
  const { organizationId, metricId, values, source } = opts;

  if (!Array.isArray(values)) {
    throw new BusinessMetricIngestError(`${source.errorPrefix} expects an array.`);
  }
  if (values.length === 0) return { written: 0 };
  if (values.length > source.maxValues) {
    throw new BusinessMetricIngestError(
      `${source.errorPrefix} accepts at most ${source.maxValues} values per call ` +
        `(got ${values.length}).`,
    );
  }

  /**
   * Deduplicate by day, last write winning.
   *
   * Not a nicety: Postgres refuses an `INSERT ... ON CONFLICT DO UPDATE` whose
   * own rows collide ("cannot affect row a second time"), so a batch naming the
   * same day twice would fail the entire write with an error naming none of the
   * caller's concepts. Collapsing here applies the same last-write-wins rule
   * *within* a batch that restatement applies *between* batches, which is the
   * only reading that is consistent.
   */
  const byDay = new Map<string, number>();
  values.forEach((entry, index) => {
    const fail = (detail: string): never => {
      throw new BusinessMetricIngestError(`${source.errorPrefix}: value ${index} ${detail}`);
    };
    if (!entry || typeof entry !== "object") fail("is not an object.");
    if (!isRealDay(entry.date)) {
      fail(`has an invalid date "${entry.date}" (expected YYYY-MM-DD).`);
    }
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      fail("has a non-finite value.");
    }
    byDay.set(entry.date, entry.value);
  });

  const now = new Date();
  const rows = [...byDay.entries()].map(([day, value]) => ({
    id: randomUUID(),
    organizationId,
    metricId,
    day,
    value,
    source: source.source,
    updatedByUserId: source.userId,
    updatedAt: now,
  }));

  await db
    .insert(businessMetricValues)
    .values(rows)
    .onConflictDoUpdate({
      target: [businessMetricValues.metricId, businessMetricValues.day],
      set: {
        value: sql`excluded.value`,
        source: sql`excluded.source`,
        updatedByUserId: sql`excluded.updated_by_user_id`,
        updatedAt: now,
      },
    });

  return { written: rows.length };
}

/** One day of one metric, as the readers consume it. */
export interface StoredMetricValue {
  day: string;
  value: number;
}

/**
 * A metric's values across an inclusive day range, in day order.
 *
 * This is the denominator side of every unit-cost query. It is deliberately a
 * plain range read rather than a join against spend: the numerator lives in
 * ClickHouse and the two are combined once, at the bucket level, in application
 * code — see the `business_metric_values` table comment for why that is the
 * right shape and a per-point cross-store join is not.
 */
export async function getMetricValues(
  metricId: string,
  from: string,
  to: string,
): Promise<StoredMetricValue[]> {
  const rows = await db
    .select({ day: businessMetricValues.day, value: businessMetricValues.value })
    .from(businessMetricValues)
    .where(
      and(
        eq(businessMetricValues.metricId, metricId),
        gte(businessMetricValues.day, from),
        lte(businessMetricValues.day, to),
      ),
    )
    .orderBy(asc(businessMetricValues.day));
  return rows.map((r) => ({ day: r.day, value: Number(r.value) }));
}

/** What days a metric has numbers for at all, or null when it has none. */
export async function getMetricCoverage(
  metricId: string,
): Promise<{ firstDay: string; lastDay: string; reportedDays: number } | null> {
  const [row] = await db
    .select({
      firstDay: sql<string | null>`min(${businessMetricValues.day})::text`,
      lastDay: sql<string | null>`max(${businessMetricValues.day})::text`,
      reportedDays: sql<number>`count(*)::int`,
    })
    .from(businessMetricValues)
    .where(eq(businessMetricValues.metricId, metricId));
  if (!row?.firstDay || !row.lastDay) return null;
  return { firstDay: row.firstDay, lastDay: row.lastDay, reportedDays: Number(row.reportedDays) };
}
