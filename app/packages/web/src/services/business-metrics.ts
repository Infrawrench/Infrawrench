/**
 * Org-scoped business-metric CRUD: shared by the HTTP routes
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
 * behaviour we want; a unit-cost card that quietly reverted to plain spend
 * would be a chart claiming to be something it is not.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import {
  BUSINESS_METRIC_KEY_HELP,
  BUSINESS_METRIC_LABEL_KEY_PATTERN,
  BUSINESS_METRIC_LIMITS,
  COST_DIMENSIONS,
  DEFAULT_UNIT_COST_THRESHOLD_WINDOW_DAYS,
  UNIT_COST_SCALES,
  costDimensionNeedsKey,
  normalizeBusinessMetricKey,
  normalizeBusinessMetricLabelKey,
  type BusinessMetric,
  type BusinessMetricInput,
  type BusinessMetricLabelMapping,
  type BusinessMetricLabelSummary,
  type BusinessMetricLabels,
  BUSINESS_METRIC_DEFAULT_LABEL_KEY,
  type BusinessMetricValue,
  type CostFilter,
  type UnitCostThreshold,
} from "@infrawrench/client-core";
import {
  getMetricCoverage,
  getMetricLabelSummary,
  storedLabels,
} from "@infrawrench/server-core/cost/metric-ingest";
import {
  getBusinessMetricImporter,
  getBusinessMetricImporterSummaries,
} from "@infrawrench/server-core/cost/metric-importers";

import { db } from "../db/client";
import { businessMetricValues, businessMetrics } from "../db/schema";

type BusinessMetricRow = typeof businessMetrics.$inferSelect;

/** Static routes under `/business-metrics/` that a metric key would shadow. */
const RESERVED_METRIC_KEYS = new Set([
  "importer-sources",
  "importer-options",
  "importer-preview",
  "usage-units",
  "usage-unit-costs",
]);

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
  importer: BusinessMetric["importer"] = null,
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
    labelMappings: (row.labelMappings ?? []) as BusinessMetricLabelMapping[],
    thresholds: (row.thresholds ?? []) as UnitCostThreshold[],
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    coverage,
    importer,
  };
}

/** The summary of one metric's importer, or null. */
async function importerSummary(
  organizationId: string,
  metricId: string,
): Promise<BusinessMetric["importer"]> {
  const importer = await getBusinessMetricImporter(organizationId, metricId);
  if (!importer) return null;
  return {
    accountId: importer.accountId,
    accountName: importer.accountName,
    pluginId: importer.pluginId,
    sourceLabel: importer.sourceLabel,
    enabled: importer.enabled,
    lastRunAt: importer.lastRunAt,
    lastStatus: importer.lastStatus,
    lastError: importer.lastError,
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
  labelMappings: BusinessMetricLabelMapping[];
  thresholds: UnitCostThreshold[];
} {
  const key = normalizeBusinessMetricKey(input.key);
  if (RESERVED_METRIC_KEYS.has(key)) {
    throw new BusinessMetricInputError(
      `"${key}" is reserved: it is the path of a route beside the metrics, so a metric with ` +
        "that key could never be addressed by it.",
    );
  }
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
    ...withThresholds(normalizeLabelMappings(input.labelMappings ?? []), input.thresholds, kind),
  };
}

/**
 * Label mappings: one per label, each naming a real cost dimension (with a key
 * where the dimension needs one). A mapping to a nonexistent dimension would be
 * accepted today and fail every query that used it, so it is refused here.
 */
function normalizeLabelMappings(raw: BusinessMetricLabelMapping[]): BusinessMetricLabelMapping[] {
  if (raw.length > BUSINESS_METRIC_LIMITS.maxLabelMappings) {
    throw new BusinessMetricInputError(
      `A metric accepts at most ${BUSINESS_METRIC_LIMITS.maxLabelMappings} label mappings.`,
    );
  }
  const seen = new Set<string>();
  return raw.map((mapping) => {
    const label = normalizeBusinessMetricLabelKey(mapping.label);
    if (!label || !BUSINESS_METRIC_LABEL_KEY_PATTERN.test(label)) {
      throw new BusinessMetricInputError(
        `"${mapping.label}" is not a valid label key. ${BUSINESS_METRIC_KEY_HELP}`,
      );
    }
    if (seen.has(label)) {
      throw new BusinessMetricInputError(
        `The label "${label}" is mapped twice. A label's values live in one place on the cost side.`,
      );
    }
    seen.add(label);
    const target = mapping.target;
    if (target.kind === "cost_centre") return { label, target: { kind: "cost_centre" } };
    if (!(COST_DIMENSIONS as readonly string[]).includes(target.dimension)) {
      throw new BusinessMetricInputError(`"${target.dimension}" is not a cost dimension.`);
    }
    const tagKey = target.tagKey?.trim();
    if (costDimensionNeedsKey(target.dimension) && !tagKey) {
      throw new BusinessMetricInputError(
        `The label "${label}" maps to a ${target.dimension.replace("_", " ")}, which needs a key.`,
      );
    }
    return {
      label,
      target: {
        kind: "dimension",
        dimension: target.dimension,
        ...(costDimensionNeedsKey(target.dimension) && tagKey ? { tagKey } : {}),
      },
    };
  });
}

/**
 * Thresholds: bounded in number and window, margin only on a revenue metric
 * (the same refusal the query makes), and a margin limit stated as a percent.
 */
function withThresholds(
  labelMappings: BusinessMetricLabelMapping[],
  thresholds: UnitCostThreshold[] | undefined,
  kind: "count" | "currency",
): { labelMappings: BusinessMetricLabelMapping[]; thresholds: UnitCostThreshold[] } {
  const mapped = new Set(labelMappings.map((m) => m.label));
  const normalized = normalizeThresholds(thresholds ?? [], kind);
  for (const t of normalized) {
    if (t.groupByLabel && !mapped.has(t.groupByLabel)) {
      throw new BusinessMetricInputError(
        `A threshold per "${t.groupByLabel}" needs that label mapped to a cost dimension, so ` +
          "each value's spend can be divided by its own volume.",
      );
    }
  }
  return { labelMappings, thresholds: normalized };
}

function normalizeThresholds(
  raw: UnitCostThreshold[],
  kind: "count" | "currency",
): UnitCostThreshold[] {
  if (raw.length > BUSINESS_METRIC_LIMITS.maxThresholds) {
    throw new BusinessMetricInputError(
      `A metric accepts at most ${BUSINESS_METRIC_LIMITS.maxThresholds} thresholds.`,
    );
  }
  return raw.map((t) => {
    if (t.mode === "margin" && kind !== "currency") {
      throw new BusinessMetricInputError(
        "A margin threshold needs a revenue metric: margin against a count means nothing.",
      );
    }
    if (!Number.isFinite(t.value)) {
      throw new BusinessMetricInputError("A threshold needs a finite value.");
    }
    const windowDays = t.windowDays ?? DEFAULT_UNIT_COST_THRESHOLD_WINDOW_DAYS;
    if (
      !Number.isInteger(windowDays) ||
      windowDays < BUSINESS_METRIC_LIMITS.minThresholdWindowDays ||
      windowDays > BUSINESS_METRIC_LIMITS.maxThresholdWindowDays
    ) {
      throw new BusinessMetricInputError(
        `A threshold window is ${BUSINESS_METRIC_LIMITS.minThresholdWindowDays}–` +
          `${BUSINESS_METRIC_LIMITS.maxThresholdWindowDays} days.`,
      );
    }
    const scale = t.scale ?? 1;
    if (!(UNIT_COST_SCALES as readonly number[]).includes(scale)) {
      throw new BusinessMetricInputError("A threshold scale is 1, 100, 1000, 1e6 or 1e9.");
    }
    const groupByLabel = t.groupByLabel ? normalizeBusinessMetricLabelKey(t.groupByLabel) : "";
    return {
      mode: t.mode,
      direction: t.direction,
      value: t.value,
      // Kept as given even on a margin threshold (which ignores it), so a
      // declarative client reads back exactly what it wrote.
      ...(scale !== 1 ? { scale } : {}),
      ...(groupByLabel ? { groupByLabel } : {}),
      windowDays,
    };
  });
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
 * values is not broken (it was just created) but every unit-cost chart drawn
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
  const importers = await getBusinessMetricImporterSummaries(organizationId);
  return Promise.all(
    rows.map(async (row) =>
      toBusinessMetric(row, await getMetricCoverage(row.id), importers.get(row.id) ?? null),
    ),
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
  return row
    ? toBusinessMetric(
        row,
        await getMetricCoverage(row.id),
        await importerSummary(organizationId, row.id),
      )
    : null;
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
 * A full replace, matching budgets and saved filters. `key` may change (the
 * values are keyed on the metric's id, so a rename never orphans history) but
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
  return updated
    ? toBusinessMetric(
        updated,
        await getMetricCoverage(updated.id),
        await importerSummary(organizationId, updated.id),
      )
    : null;
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

/**
 * A stored row's labels, plus the single `label` the API has carried since the
 * importers (1.60.0): that key of `labels`, or null.
 */
function valueLabels(
  labels: unknown,
  label: string,
): Pick<BusinessMetricValue, "label" | "labels"> {
  const all = storedLabels(labels, label);
  return { label: all[BUSINESS_METRIC_DEFAULT_LABEL_KEY] ?? null, labels: all };
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
    .orderBy(sql`${businessMetricValues.day} DESC`, asc(businessMetricValues.label))
    .limit(Math.min(Math.max(Math.round(limit), 1), BUSINESS_METRIC_LIMITS.maxValuesPageSize));
  return rows.map((r) => ({
    day: r.day,
    value: Number(r.value),
    ...valueLabels(r.labels, r.label),
    source: r.source === "workflow" || r.source === "import" ? r.source : "api",
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/**
 * The label keys a metric's values carry, each with its values and its
 * mapping, for the label pickers. A mapped label nobody has reported yet is
 * listed too (with no values), so the editor can show the mapping exists.
 */
export async function listBusinessMetricLabels(
  metric: Pick<BusinessMetric, "id" | "labelMappings">,
): Promise<BusinessMetricLabelSummary[]> {
  const summary = await getMetricLabelSummary(metric.id);
  const mappings = new Map(metric.labelMappings.map((m) => [m.label, m.target]));
  const out: BusinessMetricLabelSummary[] = summary.map((s) => ({
    ...s,
    mapping: mappings.get(s.key) ?? null,
  }));
  for (const [label, target] of mappings) {
    if (!out.some((s) => s.key === label)) {
      out.push({ key: label, values: [], truncated: false, mapping: target });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}
