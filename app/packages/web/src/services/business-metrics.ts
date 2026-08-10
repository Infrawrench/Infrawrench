/**
 * Org-scoped business-metric CRUD — shared by the HTTP routes
 * (api/routes/business-metrics.ts) and the tool registry, mirroring
 * services/saved-cost-filters.ts, so the MCP/chat surface and the API cannot
 * drift into behaving differently.
 *
 * A business metric is a declaration, not data: what the org counts, what one
 * of it is called, whether its numbers are a quantity or money, and which slice
 * of spend it is the denominator of. The values themselves arrive through
 * `server-core/cost/metric-ingest`, which both the API and workflows share for
 * the same reason.
 *
 * Deletion is a soft delete and takes the values with it (the FK cascades on a
 * hard delete only, so the values simply stop being reachable). Unlike a saved
 * filter, a metric has no referents that could be silently re-scoped: a graph
 * config pointing at a deleted metric fails its query loudly, which is the
 * behaviour we want — a unit-cost card that quietly reverted to plain spend
 * would be a chart claiming to be something it is not.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import {
  BUSINESS_METRIC_LIMITS,
  normalizeBusinessMetricKey,
  type BusinessMetric,
  type BusinessMetricInput,
  type BusinessMetricValue,
  type CostFilter,
} from "@infrawrench/client-core";
import { getMetricCoverage } from "@infrawrench/server-core/cost/metric-ingest";

import { db } from "../db/client";
import { businessMetricValues, businessMetrics } from "../db/schema";

type BusinessMetricRow = typeof businessMetrics.$inferSelect;

/** A create/update whose key is already taken by a live metric. 409. */
export class BusinessMetricKeyConflictError extends Error {
  override readonly name = "BusinessMetricKeyConflictError";

  constructor(key: string) {
    super(
      `A business metric with the key "${key}" already exists. Keys are how workflows and the ` +
        "CLI address a metric, so they must be unambiguous per organization.",
    );
  }
}

/** Anything the caller can fix about the definition. Routes map this to a 400. */
export class BusinessMetricInputError extends Error {
  override readonly name = "BusinessMetricInputError";
}

function toBusinessMetric(
  row: BusinessMetricRow,
  coverage: BusinessMetric["coverage"],
): BusinessMetric {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    unit: row.unit,
    description: row.description,
    kind: row.kind === "currency" ? "currency" : "count",
    currency: row.currency,
    costScope: (row.costScope ?? []) as CostFilter[],
    savedFilterId: row.savedFilterId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    coverage,
  };
}

/**
 * The rules a definition has to satisfy beyond its shape.
 *
 * The currency pair is the load-bearing one and is enforced in both directions,
 * matching the table's check constraint: a `currency` metric without a currency
 * cannot have margin computed against it, and a `count` metric carrying one
 * would suggest its numbers are money when they are requests. Either way the
 * row would be a trap for a later reader rather than a rejected write.
 */
function normalizeInput(input: BusinessMetricInput): {
  key: string;
  name: string;
  unit: string;
  description: string | null;
  kind: "count" | "currency";
  currency: string | null;
  costScope: CostFilter[];
  savedFilterId: string | null;
} {
  const key = normalizeBusinessMetricKey(input.key);
  const kind = input.kind;
  const currency = input.currency?.trim().toUpperCase() || null;

  if (kind === "currency" && !currency) {
    throw new BusinessMetricInputError(
      "A revenue metric must state the currency its numbers are in — margin subtracts spend " +
        "from revenue, which is only defined in one currency.",
    );
  }
  if (kind !== "currency" && currency) {
    throw new BusinessMetricInputError(
      "Only a revenue metric carries a currency. A count metric's numbers are a quantity, and " +
        "labelling them with a currency would make a later reader take them for money.",
    );
  }
  const costScope = input.costScope ?? [];
  if (costScope.length > BUSINESS_METRIC_LIMITS.maxScopeFilters) {
    throw new BusinessMetricInputError(
      `A metric's cost scope accepts at most ${BUSINESS_METRIC_LIMITS.maxScopeFilters} filters.`,
    );
  }

  return {
    key,
    name: input.name.trim(),
    unit: input.unit.trim(),
    description: input.description?.trim() || null,
    kind,
    currency,
    costScope,
    savedFilterId: input.savedFilterId?.trim() || null,
  };
}

/** Whether a live metric other than `excludeId` already uses `key`. */
async function keyTaken(organizationId: string, key: string, excludeId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: businessMetrics.id })
    .from(businessMetrics)
    .where(
      and(
        eq(businessMetrics.organizationId, organizationId),
        isNull(businessMetrics.deletedAt),
        eq(businessMetrics.key, key),
      ),
    );
  return rows.some((r) => r.id !== excludeId);
}

/**
 * The org's metrics, by key, each with its reported coverage.
 *
 * Coverage rides along rather than being a second call because a metric with no
 * values is not broken — it was just created — but every unit-cost chart drawn
 * from it is one continuous gap, and a list that did not say so would leave the
 * user to discover that on the chart.
 */
export async function listBusinessMetrics(organizationId: string): Promise<BusinessMetric[]> {
  const rows = await db
    .select()
    .from(businessMetrics)
    .where(
      and(eq(businessMetrics.organizationId, organizationId), isNull(businessMetrics.deletedAt)),
    )
    .orderBy(asc(businessMetrics.key));
  return Promise.all(
    rows.map(async (row) => toBusinessMetric(row, await getMetricCoverage(row.id))),
  );
}

/** One metric, addressed by id **or** key. Null when not found. */
export async function getBusinessMetric(
  organizationId: string,
  keyOrId: string,
): Promise<BusinessMetric | null> {
  const [row] = await db
    .select()
    .from(businessMetrics)
    .where(
      and(
        eq(businessMetrics.organizationId, organizationId),
        isNull(businessMetrics.deletedAt),
        sql`(${businessMetrics.id} = ${keyOrId} OR ${businessMetrics.key} = ${keyOrId})`,
      ),
    )
    .limit(1);
  return row ? toBusinessMetric(row, await getMetricCoverage(row.id)) : null;
}

export async function createBusinessMetric(
  organizationId: string,
  input: BusinessMetricInput,
  createdByUserId: string | null,
): Promise<BusinessMetric> {
  const values = normalizeInput(input);
  if (await keyTaken(organizationId, values.key)) {
    throw new BusinessMetricKeyConflictError(values.key);
  }

  const live = await db
    .select({ id: businessMetrics.id })
    .from(businessMetrics)
    .where(
      and(eq(businessMetrics.organizationId, organizationId), isNull(businessMetrics.deletedAt)),
    );
  if (live.length >= BUSINESS_METRIC_LIMITS.maxMetricsPerOrg) {
    throw new BusinessMetricInputError(
      `An organization can hold ${BUSINESS_METRIC_LIMITS.maxMetricsPerOrg} business metrics. ` +
        "Past that, what you have is a data feed rather than a set of denominators.",
    );
  }

  const [created] = await db
    .insert(businessMetrics)
    .values({ id: uuidv4(), organizationId, createdByUserId, ...values })
    .returning();
  return toBusinessMetric(created!, null);
}

/**
 * Replace a metric's definition. Null when not found.
 *
 * A full replace, matching budgets and saved filters. `key` may change — the
 * values are keyed on the metric's id, so a rename never orphans history — but
 * a workflow writing to the old key starts failing, which is the honest outcome
 * and is why the key exists separately from the display name in the first place.
 */
export async function updateBusinessMetric(
  organizationId: string,
  metricId: string,
  input: BusinessMetricInput,
): Promise<BusinessMetric | null> {
  const values = normalizeInput(input);
  if (await keyTaken(organizationId, values.key, metricId)) {
    throw new BusinessMetricKeyConflictError(values.key);
  }

  const [updated] = await db
    .update(businessMetrics)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(businessMetrics.id, metricId),
        eq(businessMetrics.organizationId, organizationId),
        isNull(businessMetrics.deletedAt),
      ),
    )
    .returning();
  return updated ? toBusinessMetric(updated, await getMetricCoverage(updated.id)) : null;
}

/** Soft-delete a metric. False when not found. */
export async function softDeleteBusinessMetric(
  organizationId: string,
  metricId: string,
): Promise<boolean> {
  const now = new Date();
  const [deleted] = await db
    .update(businessMetrics)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(businessMetrics.id, metricId),
        eq(businessMetrics.organizationId, organizationId),
        isNull(businessMetrics.deletedAt),
      ),
    )
    .returning({ id: businessMetrics.id });
  return !!deleted;
}

/** A metric's reported values, newest day first, capped by `limit`. */
export async function listBusinessMetricValues(
  metricId: string,
  limit: number,
): Promise<BusinessMetricValue[]> {
  const rows = await db
    .select()
    .from(businessMetricValues)
    .where(eq(businessMetricValues.metricId, metricId))
    .orderBy(sql`${businessMetricValues.day} DESC`)
    .limit(Math.min(Math.max(Math.round(limit), 1), BUSINESS_METRIC_LIMITS.maxValuesPageSize));
  return rows.map((r) => ({
    day: r.day,
    value: Number(r.value),
    source: r.source === "workflow" ? "workflow" : "api",
    updatedAt: r.updatedAt.toISOString(),
  }));
}
