/**
 * Virtual tags: CRUD, the reference check that guards deletion, and the
 * resolver that turns stored rules into what the cost readers compile.
 *
 * Shaped like `cost/billing-rules.ts` on purpose, and for the same reason it
 * lives in server-core rather than `web/services`: the HTTP/MCP/CLI read path
 * and the poller's unattended readers (budgets, change alerts, report
 * delivery, exports) must resolve a virtual tag identically. The readers load
 * definitions through {@link loadVirtualTagDefinitions} by themselves when a
 * query mentions `virtual_tag`, so no reader can forget to.
 *
 * Nothing here writes to `cost_daily`; a virtual tag is compiled into the read.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  VIRTUAL_TAG_LIMITS,
  compileVirtualTagQuery,
  computeMetricSplitWeights,
  normalizeVirtualTagInput,
  virtualTagInputError,
  virtualTagMetricIds,
  virtualTagSplits,
  type CostFilter,
  type VirtualTag,
  type VirtualTagInput,
  type VirtualTagProcessingState,
  type VirtualTagRule,
  type VirtualTagStats,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import {
  budgets,
  businessMetricValues,
  businessMetrics,
  costAlerts,
  costAllocationRules,
  costExports,
  costReports,
  dashboardWidgets,
  savedCostFilters,
  virtualTags,
} from "../db/schema";
import type {
  CompiledVirtualTag,
  CompiledVirtualTagRule,
  VirtualTagDefinitions,
} from "../clickhouse/virtual-tag-sql";

export type { VirtualTag, VirtualTagInput, VirtualTagRule };
export { VIRTUAL_TAG_LIMITS };

/** A virtual-tag write the API should refuse with a 400 and this message. */
export class VirtualTagError extends Error {
  override readonly name = "VirtualTagError";
}

/** A key already taken in this org: the API maps this to a 409. */
export class VirtualTagKeyConflictError extends Error {
  override readonly name = "VirtualTagKeyConflictError";

  constructor(key: string) {
    super(
      `A virtual tag with the key "${key}" already exists. Keys are how filters, budgets and ` +
        "reports address a virtual tag, so they must be unique.",
    );
  }
}

/** Deleting a tag something still references: the API maps this to a 409. */
export class VirtualTagInUseError extends Error {
  override readonly name = "VirtualTagInUseError";
  readonly references: VirtualTagReference[];

  constructor(key: string, references: VirtualTagReference[]) {
    const named = references
      .slice(0, 5)
      .map((r) => `${r.kind} "${r.name}"`)
      .join(", ");
    const more = references.length > 5 ? ` and ${references.length - 5} more` : "";
    super(
      `The virtual tag "${key}" is still used by ${named}${more}. Remove it from those first: ` +
        "deleting it would make them fail rather than quietly widen to all spend.",
    );
    this.references = references;
  }
}

/** Something that stores a reference to a virtual tag key. */
export interface VirtualTagReference {
  kind:
    | "saved filter"
    | "budget"
    | "cost report"
    | "dashboard card"
    | "change alert"
    | "allocation rule"
    | "cost export"
    | "business metric";
  id: string;
  name: string;
}

/* ------------------------------------------------------------------ *
 * Wire mapping
 * ------------------------------------------------------------------ */

const PROCESSING_STATES = new Set<VirtualTagProcessingState>([
  "pending",
  "processing",
  "ready",
  "failed",
]);

function toWire(row: typeof virtualTags.$inferSelect): VirtualTag {
  const state = PROCESSING_STATES.has(row.processingState as VirtualTagProcessingState)
    ? (row.processingState as VirtualTagProcessingState)
    : "pending";
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    defaultValue: row.defaultValue,
    rules: (row.rules ?? []) as VirtualTagRule[],
    status: {
      state,
      processedAt: row.processedAt ? row.processedAt.toISOString() : null,
      error: row.processingError,
      stats: (row.stats as VirtualTagStats | null) ?? null,
    },
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * CRUD
 * ------------------------------------------------------------------ */

export async function listVirtualTags(organizationId: string): Promise<VirtualTag[]> {
  const rows = await db
    .select()
    .from(virtualTags)
    .where(eq(virtualTags.organizationId, organizationId))
    .orderBy(asc(virtualTags.key));
  return rows.map(toWire);
}

export async function getVirtualTag(
  organizationId: string,
  id: string,
): Promise<VirtualTag | null> {
  const [row] = await db
    .select()
    .from(virtualTags)
    .where(and(eq(virtualTags.id, id), eq(virtualTags.organizationId, organizationId)))
    .limit(1);
  return row ? toWire(row) : null;
}

/** Normalise, then validate, in the words the editor uses. */
function prepare(input: VirtualTagInput): VirtualTagInput {
  const normalized = normalizeVirtualTagInput(input);
  const error = virtualTagInputError(normalized);
  if (error) throw new VirtualTagError(error);
  return normalized;
}

/**
 * Every metric a rule names must be a live metric of this org: a metric id from
 * another org would otherwise weight a split by somebody else's numbers.
 */
async function assertMetricsBelongToOrg(
  organizationId: string,
  rules: VirtualTagRule[],
): Promise<void> {
  const ids = virtualTagMetricIds(rules);
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: businessMetrics.id })
    .from(businessMetrics)
    .where(
      and(
        eq(businessMetrics.organizationId, organizationId),
        inArray(businessMetrics.id, ids),
        isNull(businessMetrics.deletedAt),
      ),
    );
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.find((id) => !found.has(id));
  if (missing) {
    throw new VirtualTagError(
      `Business metric ${missing} does not exist in this organization. Pick a metric from the list.`,
    );
  }
}

export async function createVirtualTag(
  organizationId: string,
  input: VirtualTagInput,
  createdByUserId?: string | undefined,
): Promise<VirtualTag> {
  const data = prepare(input);
  await assertMetricsBelongToOrg(organizationId, data.rules);

  const existing = await db
    .select({ id: virtualTags.id })
    .from(virtualTags)
    .where(eq(virtualTags.organizationId, organizationId));
  if (existing.length >= VIRTUAL_TAG_LIMITS.maxTagsPerOrg) {
    throw new VirtualTagError(
      `An organisation can have at most ${VIRTUAL_TAG_LIMITS.maxTagsPerOrg} virtual tags.`,
    );
  }

  try {
    const [row] = await db
      .insert(virtualTags)
      .values({
        id: randomUUID(),
        organizationId,
        key: data.key,
        name: data.name,
        description: data.description ?? null,
        defaultValue: data.defaultValue ?? null,
        rules: data.rules,
        processingState: "pending",
        nextProcessAt: new Date(),
        createdByUserId: createdByUserId ?? null,
      })
      .returning();
    if (!row) throw new Error("Failed to create virtual tag");
    return toWire(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new VirtualTagKeyConflictError(data.key);
    throw e;
  }
}

/**
 * Full replace. The key is immutable: saved filters, budgets, reports and
 * exports store it, so a rename would silently break every one of them. A
 * different key is refused with the reason rather than applied.
 *
 * Saving re-queues processing, so the status badge goes back to "Queued" and
 * the stats are recomputed over the whole history against the new rules.
 */
export async function updateVirtualTag(
  organizationId: string,
  id: string,
  input: VirtualTagInput,
): Promise<VirtualTag | null> {
  const data = prepare(input);
  const current = await getVirtualTag(organizationId, id);
  if (!current) return null;
  if (current.key !== data.key) {
    throw new VirtualTagError(
      `A virtual tag's key cannot be changed (it is "${current.key}"): saved filters, budgets, ` +
        "reports and exports store it. Change the name instead, or create a new tag.",
    );
  }
  await assertMetricsBelongToOrg(organizationId, data.rules);

  const [row] = await db
    .update(virtualTags)
    .set({
      name: data.name,
      description: data.description ?? null,
      defaultValue: data.defaultValue ?? null,
      rules: data.rules,
      processingState: "pending",
      nextProcessAt: new Date(),
      processingError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(virtualTags.id, id), eq(virtualTags.organizationId, organizationId)))
    .returning();
  return row ? toWire(row) : null;
}

/** Queue a re-evaluation now, without changing the rules. Null when not found. */
export async function reprocessVirtualTag(
  organizationId: string,
  id: string,
): Promise<VirtualTag | null> {
  const [row] = await db
    .update(virtualTags)
    .set({ processingState: "pending", nextProcessAt: new Date() })
    .where(and(eq(virtualTags.id, id), eq(virtualTags.organizationId, organizationId)))
    .returning();
  return row ? toWire(row) : null;
}

/**
 * Every stored object that references `key`.
 *
 * Read in application code rather than with jsonb operators because the
 * references live in five different shapes (filter arrays, a graph config, an
 * allocation match, an export query, a cost scope) and the per-org row counts
 * are small. Missing one would let a delete orphan a budget, which is the
 * failure this check exists to prevent, so it errs on scanning more.
 */
export async function findVirtualTagReferences(
  organizationId: string,
  key: string,
): Promise<VirtualTagReference[]> {
  const mentions = (filters: unknown): boolean =>
    Array.isArray(filters) &&
    filters.some(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as CostFilter).dimension === "virtual_tag" &&
        (f as CostFilter).tagKey === key,
    );
  const configMentions = (config: unknown): boolean => {
    if (typeof config !== "object" || config === null) return false;
    const c = config as { filters?: unknown; groupBy?: unknown; groupByTagKey?: unknown };
    return mentions(c.filters) || (c.groupBy === "virtual_tag" && c.groupByTagKey === key);
  };

  const [filters, budgetRows, reports, widgets, alerts, rules, exportsRows, metrics] =
    await Promise.all([
      db
        .select({
          id: savedCostFilters.id,
          name: savedCostFilters.name,
          filters: savedCostFilters.filters,
        })
        .from(savedCostFilters)
        .where(
          and(
            eq(savedCostFilters.organizationId, organizationId),
            isNull(savedCostFilters.deletedAt),
          ),
        ),
      db
        .select({ id: budgets.id, name: budgets.name, filters: budgets.filters })
        .from(budgets)
        .where(and(eq(budgets.organizationId, organizationId), isNull(budgets.deletedAt))),
      db
        .select({ id: costReports.id, name: costReports.name, config: costReports.config })
        .from(costReports)
        .where(and(eq(costReports.organizationId, organizationId), isNull(costReports.deletedAt))),
      db
        .select({
          id: dashboardWidgets.id,
          kind: dashboardWidgets.kind,
          config: dashboardWidgets.config,
        })
        .from(dashboardWidgets)
        .where(
          and(
            eq(dashboardWidgets.organizationId, organizationId),
            isNull(dashboardWidgets.deletedAt),
            eq(dashboardWidgets.kind, "cost_graph"),
          ),
        ),
      db
        .select({
          id: costAlerts.id,
          name: costAlerts.name,
          filters: costAlerts.filters,
          groupBy: costAlerts.groupBy,
          groupByTagKey: costAlerts.groupByTagKey,
        })
        .from(costAlerts)
        .where(and(eq(costAlerts.organizationId, organizationId), isNull(costAlerts.deletedAt))),
      db
        .select({ id: costAllocationRules.id, match: costAllocationRules.match })
        .from(costAllocationRules)
        .where(eq(costAllocationRules.organizationId, organizationId)),
      db
        .select({ id: costExports.id, name: costExports.name, query: costExports.query })
        .from(costExports)
        .where(and(eq(costExports.organizationId, organizationId), isNull(costExports.deletedAt))),
      db
        .select({
          id: businessMetrics.id,
          name: businessMetrics.name,
          costScope: businessMetrics.costScope,
        })
        .from(businessMetrics)
        .where(
          and(
            eq(businessMetrics.organizationId, organizationId),
            isNull(businessMetrics.deletedAt),
          ),
        ),
    ]);

  const refs: VirtualTagReference[] = [];
  for (const r of filters)
    if (mentions(r.filters)) refs.push({ kind: "saved filter", id: r.id, name: r.name });
  for (const r of budgetRows)
    if (mentions(r.filters)) refs.push({ kind: "budget", id: r.id, name: r.name });
  for (const r of reports)
    if (configMentions(r.config)) refs.push({ kind: "cost report", id: r.id, name: r.name });
  for (const r of widgets) {
    if (configMentions(r.config)) refs.push({ kind: "dashboard card", id: r.id, name: r.id });
  }
  for (const r of alerts) {
    if (mentions(r.filters) || (r.groupBy === "virtual_tag" && r.groupByTagKey === key)) {
      refs.push({ kind: "change alert", id: r.id, name: r.name });
    }
  }
  for (const r of rules) {
    if ((r.match as { virtualTagKey?: string } | null)?.virtualTagKey === key) {
      refs.push({ kind: "allocation rule", id: r.id, name: r.id });
    }
  }
  for (const r of exportsRows) {
    const q = r.query as { filters?: unknown; virtualTagKeys?: unknown };
    if (
      mentions(q.filters) ||
      (Array.isArray(q.virtualTagKeys) && q.virtualTagKeys.includes(key))
    ) {
      refs.push({ kind: "cost export", id: r.id, name: r.name });
    }
  }
  for (const r of metrics)
    if (mentions(r.costScope)) refs.push({ kind: "business metric", id: r.id, name: r.name });
  return refs;
}

/**
 * Delete a tag. False when not found; {@link VirtualTagInUseError} when
 * something still references it, naming what, the saved-filter precedent.
 */
export async function deleteVirtualTag(organizationId: string, id: string): Promise<boolean> {
  const current = await getVirtualTag(organizationId, id);
  if (!current) return false;
  const references = await findVirtualTagReferences(organizationId, current.key);
  if (references.length > 0) throw new VirtualTagInUseError(current.key, references);
  const deleted = await db
    .delete(virtualTags)
    .where(and(eq(virtualTags.id, id), eq(virtualTags.organizationId, organizationId)))
    .returning({ id: virtualTags.id });
  return deleted.length > 0;
}

/* ------------------------------------------------------------------ *
 * Compilation for the readers
 * ------------------------------------------------------------------ */

function maxDay(a: string, b: string | null): string {
  return b && b > a ? b : a;
}
function minDay(a: string, b: string | null): string {
  return b && b < a ? b : a;
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Business metric values by metric id, then day. */
export type MetricValueLookup = ReadonlyMap<string, ReadonlyMap<string, number>>;

/**
 * Metric values for a split's weights over `[from, to]`, reaching back a year
 * before `from` so a day with no report can carry the last good weights
 * forward instead of falling back to an even split at the range edge.
 */
export async function loadMetricValues(
  organizationId: string,
  metricIds: readonly string[],
  from: string,
  to: string,
): Promise<MetricValueLookup> {
  const result = new Map<string, Map<string, number>>();
  if (metricIds.length === 0) return result;
  const rows = await db
    .select({
      metricId: businessMetricValues.metricId,
      day: sql<string>`${businessMetricValues.day}::text`,
      value: businessMetricValues.value,
    })
    .from(businessMetricValues)
    .where(
      and(
        eq(businessMetricValues.organizationId, organizationId),
        inArray(businessMetricValues.metricId, [...metricIds]),
        gte(businessMetricValues.day, addDays(from, -366)),
        lte(businessMetricValues.day, to),
      ),
    );
  for (const r of rows) {
    let m = result.get(r.metricId);
    if (!m) {
      m = new Map();
      result.set(r.metricId, m);
    }
    m.set(String(r.day).slice(0, 10), Number(r.value));
  }
  return result;
}

/**
 * Compile one stored tag for a read over `[from, to]`.
 *
 * `metricFallbackDays` is reported back so the processing pass can count the
 * days a metric split could not weight from its own data.
 */
export function compileVirtualTagForRange(
  tag: Pick<VirtualTag, "key" | "defaultValue" | "rules">,
  metricValues: MetricValueLookup,
  from: string,
  to: string,
): { compiled: CompiledVirtualTag; metricFallbackDays: number } {
  let metricFallbackDays = 0;
  const rules: CompiledVirtualTagRule[] = tag.rules.map((rule) => {
    const base: CompiledVirtualTagRule = {
      filters: compileVirtualTagQuery(rule.query),
      startsOn: rule.startsOn,
      endsOn: rule.endsOn,
      kind: rule.kind,
      value: rule.value,
      sources: rule.sources.map((s) => ({
        tagKey: s.tagKey,
        valuePrefix: s.valuePrefix,
        filters: compileVirtualTagQuery(s.query),
      })),
      valueTransform: rule.valueTransform,
      shares: [],
      metric: null,
    };
    if (rule.kind === "split") {
      const total = rule.allocations.reduce((s, a) => s + (a.percent ?? 0), 0);
      base.shares = rule.allocations.map((a) => ({
        value: a.value,
        weight: total > 0 ? (a.percent ?? 0) / total : 1 / rule.allocations.length,
      }));
    } else if (rule.kind === "metric_split") {
      const start = maxDay(from, rule.startsOn);
      const end = minDay(to, rule.endsOn);
      const weights = computeMetricSplitWeights(
        rule.allocations.map((a) => metricValues.get(a.metricId ?? "") ?? new Map()),
        start,
        end,
      );
      metricFallbackDays += weights.fallbackDays;
      base.metric = {
        values: rule.allocations.map((a) => a.value),
        days: weights.days,
        weights: weights.weights,
      };
    }
    return base;
  });
  return {
    compiled: {
      key: tag.key,
      defaultValue: tag.defaultValue,
      split: virtualTagSplits(tag.rules),
      rules,
    },
    metricFallbackDays,
  };
}

/**
 * The definitions a read over `[from, to]` needs for `keys`, compiled. Keys
 * that name no tag are simply absent from the result: the reader's scope
 * throws `VirtualTagUnresolvedError` for them, which is the point.
 */
export async function loadVirtualTagDefinitions(
  organizationId: string,
  keys: readonly string[],
  from: string,
  to: string,
): Promise<VirtualTagDefinitions> {
  const result = new Map<string, CompiledVirtualTag>();
  if (keys.length === 0) return result;
  const rows = await db
    .select()
    .from(virtualTags)
    .where(
      and(eq(virtualTags.organizationId, organizationId), inArray(virtualTags.key, [...keys])),
    );
  const tags = rows.map(toWire);
  const metricValues = await loadMetricValues(
    organizationId,
    [...new Set(tags.flatMap((t) => virtualTagMetricIds(t.rules)))],
    from,
    to,
  );
  for (const tag of tags) {
    result.set(tag.key, compileVirtualTagForRange(tag, metricValues, from, to).compiled);
  }
  return result;
}
