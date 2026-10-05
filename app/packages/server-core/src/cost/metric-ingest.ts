/**
 * Validation and storage for business metric values: the denominators unit
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
 *   usable at all: an accumulating write doubles every number the first time
 *   the job re-runs, and nothing about the resulting chart looks wrong.
 * - **Nothing lands unless everything validates.** The whole batch is checked
 *   before the first row is written, so a bad row 400s instead of leaving half
 *   a month restated.
 * - **Messages name the offending index** and reach the workflow author or the
 *   HTTP client unchanged.
 *
 * There is no reserved-tag equivalent here, and none is needed: a value's
 * identity is `(metric, day, labels)` and a metric belongs to exactly one org,
 * so there is no shared key space for two sources to collide in. When two
 * sources write the same metric they are, by construction, making claims about
 * the same number, and the last claim wins, which is what restatement means.
 *
 * Labels are canonicalised here, once, by the same client-core function every
 * reader uses (`canonicalBusinessMetricLabels` / `businessMetricLabelsKey`), so
 * `{Plan: "pro", customer: "acme"}` from a CSV and `{customer: "acme", plan:
 * "pro"}` from a workflow land on one row.
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  BUSINESS_METRIC_KEY_HELP,
  BUSINESS_METRIC_LABEL_KEY_PATTERN,
  BUSINESS_METRIC_DEFAULT_LABEL_KEY,
  BUSINESS_METRIC_LIMITS,
  businessMetricLabelsFromKey,
  businessMetricLabelsKey,
  canonicalBusinessMetricLabels,
  normalizeBusinessMetricLabelKey,
  type BusinessMetricLabels,
  type BusinessMetricValueSource,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { businessMetricValues, businessMetrics } from "../db/schema";

/** One reported day, as it arrives from user code or off the wire. */
export interface IngestMetricValue {
  date: string;
  value: number;
  labels?: BusinessMetricLabels | undefined;
  /** A single unnamed breakdown label; stored as `{ label: <value> }`. */
  label?: string | undefined;
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

/**
 * Check a value's labels and return them canonical. Absent or `{}` is no
 * labels. Keys are normalised (trimmed, lowercased) before the slug check so a
 * capitalised CSV header is accepted rather than refused for its case.
 */
function validateLabels(raw: unknown, fail: (detail: string) => never): BusinessMetricLabels {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    return fail("has labels that are not an object.");
  const entries = Object.entries(raw as Record<string, unknown>);
  for (const [rawKey, rawValue] of entries) {
    const key = normalizeBusinessMetricLabelKey(rawKey);
    if (
      !key ||
      key.length > BUSINESS_METRIC_LIMITS.maxLabelKeyLength ||
      !BUSINESS_METRIC_LABEL_KEY_PATTERN.test(key)
    ) {
      fail(`has an invalid label key "${rawKey}". ${BUSINESS_METRIC_KEY_HELP}`);
    }
    if (typeof rawValue !== "string") fail(`has a non-string value for label "${key}".`);
    if ((rawValue as string).trim().length > BUSINESS_METRIC_LIMITS.maxLabelValueLength) {
      fail(
        `has a "${key}" label longer than ${BUSINESS_METRIC_LIMITS.maxLabelValueLength} characters.`,
      );
    }
  }
  const labels = canonicalBusinessMetricLabels(raw as BusinessMetricLabels);
  if (Object.keys(labels).length > BUSINESS_METRIC_LIMITS.maxLabelsPerValue) {
    fail(`carries more than ${BUSINESS_METRIC_LIMITS.maxLabelsPerValue} labels.`);
  }
  return labels;
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
 * Returns how many days were written, which counts restatements, because from
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
  const byIdentity = new Map<
    string,
    { day: string; value: number; labels: BusinessMetricLabels; label: string }
  >();
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
    // A bare breakdown `label` (the importers' single-label shape) is the label
    // set `{ label: <value> }`; `labels` wins when both are sent.
    const labels = validateLabels(
      entry.labels ??
        (typeof entry.label === "string" && entry.label.trim()
          ? { [BUSINESS_METRIC_DEFAULT_LABEL_KEY]: entry.label }
          : undefined),
      fail,
    );
    const label = businessMetricLabelsKey(labels);
    byIdentity.set(`${entry.date}\u0000${label}`, {
      day: entry.date,
      value: entry.value,
      labels,
      label,
    });
  });

  const now = new Date();
  const rows = [...byIdentity.values()].map(({ day, value, labels, label }) => ({
    id: randomUUID(),
    organizationId,
    metricId,
    day,
    value,
    labels,
    label,
    source: source.source,
    updatedByUserId: source.userId,
    updatedAt: now,
  }));

  await db
    .insert(businessMetricValues)
    .values(rows)
    .onConflictDoUpdate({
      target: [businessMetricValues.metricId, businessMetricValues.day, businessMetricValues.label],
      set: {
        value: sql`excluded.value`,
        source: sql`excluded.source`,
        updatedByUserId: sql`excluded.updated_by_user_id`,
        updatedAt: now,
      },
    });

  return { written: rows.length };
}

/**
 * Restate whole days from an importer run: every label a day carried before is
 * replaced by exactly what the source returned for it, in one transaction.
 *
 * Unlike {@link ingestMetricValues}, which restates `(day, labels)` pairs, an
 * import owns the whole day: a customer that dropped out of the source's
 * answer must drop out of the stored breakdown too, or the day's total would
 * keep counting it. Days the source returned nothing for are left alone, so a
 * gap stays a gap rather than becoming a zero.
 *
 * An importer's single breakdown label is stored exactly as a written
 * `{ label: <value> }` would be, so imported and pushed values of one metric
 * filter, split and restate on the same label key.
 */
export async function restateImportedDays(opts: {
  organizationId: string;
  metricId: string;
  values: Array<{ date: string; value: number; label?: string | undefined }>;
  userId: string | null;
}): Promise<{ days: number }> {
  const { organizationId, metricId, values, userId } = opts;
  const days = [...new Set(values.map((v) => v.date))];
  if (days.length === 0) return { days: 0 };
  for (const day of days) {
    if (!isRealDay(day))
      throw new BusinessMetricIngestError(`Invalid day "${day}" from the source.`);
  }
  const now = new Date();
  const rows = values.map((v) => {
    const raw = (v.label ?? "").trim().slice(0, BUSINESS_METRIC_LIMITS.maxLabelValueLength);
    const labels = canonicalBusinessMetricLabels(
      raw ? { [BUSINESS_METRIC_DEFAULT_LABEL_KEY]: raw } : {},
    );
    return {
      id: randomUUID(),
      organizationId,
      metricId,
      day: v.date,
      value: v.value,
      labels,
      label: businessMetricLabelsKey(labels),
      source: "import" as const,
      updatedByUserId: userId,
      updatedAt: now,
    };
  });
  await db.transaction(async (tx) => {
    // Chunked so a two-year backfill stays well inside the parameter limit.
    for (let i = 0; i < days.length; i += 500) {
      await tx
        .delete(businessMetricValues)
        .where(
          and(
            eq(businessMetricValues.metricId, metricId),
            inArray(businessMetricValues.day, days.slice(i, i + 500)),
          ),
        );
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(businessMetricValues).values(rows.slice(i, i + 1000));
    }
  });
  return { days: days.length };
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
 * code; see the `business_metric_values` table comment for why that is the
 * right shape and a per-point cross-store join is not.
 */
export async function getMetricValues(
  metricId: string,
  from: string,
  to: string,
): Promise<StoredMetricValue[]> {
  // One number per day: the sum of every row for it, labelled or not. Rows
  // partition the metric (see `BusinessMetricLabels`), so the day total is
  // their sum, and summing in SQL keeps every pre-label caller reading exactly
  // the series it always read.
  const rows = await db
    .select({
      day: businessMetricValues.day,
      value: sql<number>`sum(${businessMetricValues.value})`,
    })
    .from(businessMetricValues)
    .where(
      and(
        eq(businessMetricValues.metricId, metricId),
        gte(businessMetricValues.day, from),
        lte(businessMetricValues.day, to),
      ),
    )
    .groupBy(businessMetricValues.day)
    .orderBy(asc(businessMetricValues.day));
  return rows.map((r) => ({ day: r.day, value: Number(r.value) }));
}

/** One stored row with its labels, for label-aware readers. */
export interface StoredLabeledMetricValue extends StoredMetricValue {
  labels: BusinessMetricLabels;
}

/**
 * A metric's rows across an inclusive day range, labels included, in day order.
 * The label-aware sibling of {@link getMetricValues}: the unit-cost query
 * filters and groups these in application code, which is cheap for the same
 * reason the bucket join is (a metric's rows over a range are at most a few
 * thousand).
 */
export async function getLabeledMetricValues(
  metricId: string,
  from: string,
  to: string,
): Promise<StoredLabeledMetricValue[]> {
  const rows = await db
    .select({
      day: businessMetricValues.day,
      value: businessMetricValues.value,
      labels: businessMetricValues.labels,
      label: businessMetricValues.label,
    })
    .from(businessMetricValues)
    .where(
      and(
        eq(businessMetricValues.metricId, metricId),
        gte(businessMetricValues.day, from),
        lte(businessMetricValues.day, to),
      ),
    )
    .orderBy(asc(businessMetricValues.day));
  return rows.map((r) => ({
    day: r.day,
    value: Number(r.value),
    labels: storedLabels(r.labels, r.label),
  }));
}

/**
 * A row's labels: the jsonb when it carries any, else the ones its `label`
 * column encodes. The fallback covers rows written by a path that only knows
 * the single breakdown label (the scheduled importers), so they read as
 * `{ label: "<value>" }` everywhere.
 */
export function storedLabels(labels: unknown, label: string): BusinessMetricLabels {
  const parsed = (labels ?? {}) as BusinessMetricLabels;
  if (Object.keys(parsed).length > 0) return parsed;
  return businessMetricLabelsFromKey(label);
}

/**
 * The label keys a metric's values carry, each with its distinct values.
 * Feeds the label pickers; capped per key so a label with a value per request
 * cannot turn a picker into a megabyte.
 */
export async function getMetricLabelSummary(
  metricId: string,
): Promise<Array<{ key: string; values: string[]; truncated: boolean }>> {
  const cap = BUSINESS_METRIC_LIMITS.maxLabelValuesListed;
  // Ranked per key so one high-cardinality label cannot crowd the others out
  // of a shared LIMIT; cap + 1 rows per key is what tells "exactly cap" from
  // "more than cap".
  const rows = await db.execute<{ key: string; value: string }>(sql`
    SELECT key, value FROM (
      SELECT d.key, d.value, row_number() OVER (PARTITION BY d.key ORDER BY d.value) AS rn
      FROM (
        SELECT DISTINCT kv.key AS key, kv.value AS value
        FROM ${businessMetricValues}, jsonb_each_text(
          CASE WHEN ${businessMetricValues.labels} = '{}'::jsonb
               THEN jsonb_build_object(${BUSINESS_METRIC_DEFAULT_LABEL_KEY}::text, ${businessMetricValues.label})
               ELSE ${businessMetricValues.labels} END
        ) AS kv
        WHERE ${businessMetricValues.metricId} = ${metricId}
          AND ${businessMetricValues.label} <> ''
      ) d
    ) ranked
    WHERE rn <= ${cap + 1}
    ORDER BY key, value
  `);
  const byKey = new Map<string, string[]>();
  for (const raw of [...rows]) {
    const values = byKey.get(raw.key) ?? [];
    values.push(raw.value);
    byKey.set(raw.key, values);
  }
  return [...byKey.entries()].map(([key, values]) => ({
    key,
    values: values.slice(0, cap),
    truncated: values.length > cap,
  }));
}

/** What days a metric has numbers for at all, or null when it has none. */
export async function getMetricCoverage(
  metricId: string,
): Promise<{ firstDay: string; lastDay: string; reportedDays: number } | null> {
  const [row] = await db
    .select({
      firstDay: sql<string | null>`min(${businessMetricValues.day})::text`,
      lastDay: sql<string | null>`max(${businessMetricValues.day})::text`,
      reportedDays: sql<number>`count(distinct ${businessMetricValues.day})::int`,
    })
    .from(businessMetricValues)
    .where(eq(businessMetricValues.metricId, metricId));
  if (!row?.firstDay || !row.lastDay) return null;
  return { firstDay: row.firstDay, lastDay: row.lastDay, reportedDays: Number(row.reportedDays) };
}
