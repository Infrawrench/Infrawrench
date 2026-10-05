/**
 * The unit-cost calculation engine: everything between "a metric definition
 * and a request" and "a `UnitCostQueryResponse`". Shared by the HTTP route and
 * the MCP tools (through `web/src/services/unit-cost-query.ts`) and by the
 * poller's threshold evaluator, so a threshold judges exactly the number the
 * chart draws.
 *
 * The shape of the work:
 *
 * 1. **Numerator**: one `queryCosts` call, bucketed by the caller's binning.
 *    Ungrouped unless the request splits by a *mapped* label, in which case it
 *    is grouped by the label's cost dimension (or by cost centre, through the
 *    allocation rules) in the same single scan.
 * 2. **Currency**: conversion on the already-aggregated series, through the
 *    same pure `convertGroups` the cost graph uses.
 * 3. **Denominator**: one range read of `business_metric_values` (labels
 *    included, filtered and grouped in memory), or for `usage_unit_cost` one
 *    ClickHouse read of the providers' own usage quantities.
 * 4. **The division**: `computeUnitCosts`, pure, once per label series.
 *
 * ## The label rule
 *
 * A ratio needs both halves split the same way. "Cost per customer, per
 * customer" divides each customer's spend by each customer's volume, which
 * needs the label mapped to where customer spend lives (a tag, a virtual tag,
 * a cost centre). An unmapped label could only divide the whole scope's spend
 * by one customer's volume: a number per customer that sums to nothing. So
 * every ratio mode refuses an unmapped label in `labelFilters` or
 * `groupByLabel`, with a message naming the fix, and only `raw_metric` (which
 * divides nothing) accepts any label.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  BUSINESS_METRIC_LIMITS,
  CostQueryParseError,
  costDimensionNeedsKey,
  parseCostQuery,
  toUnitCostScale,
  type BusinessMetricKind,
  type BusinessMetricLabelMapping,
  type BusinessMetricLabelTarget,
  type BusinessMetricLabels,
  type CostFilter,
  type UnitCostLabelFilter,
  type UnitCostMode,
  type UnitCostQueryRequest,
  type UnitCostQueryResponse,
  type UnitCostSeries,
  HOURLY_BINNING_UNAVAILABLE_REASON,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { businessMetrics } from "../db/schema";
import {
  queryCosts,
  queryUsageQuantities,
  type CostSeriesGroup,
  type ShowbackRule,
} from "../clickhouse/cost-readers";
import { listAllocationRules, listCostCentres } from "./allocation";
import { convertGroups, mergeConvertedGroups, RateBook } from "./currency-convert";
import { loadConversionContext, loadOrgRateBook } from "./currency-settings";
import { getLabeledMetricValues, type StoredLabeledMetricValue } from "./metric-ingest";
import { SavedCostFilterResolutionError, resolveSavedCostFilters } from "./saved-filters";
import { computeUnitCosts, type UnitCostCostGroup } from "./unit-costs";

/** Anything the caller can fix. Routes map this to a 400, tools to an error result. */
export class UnitCostRunError extends Error {
  override readonly name = "UnitCostRunError";
  /** Set only for a cost-query-language parse failure. */
  readonly queryError?: { offset: number; length: number; expected: string[] };

  constructor(
    message: string,
    queryError?: { offset: number; length: number; expected: string[] },
  ) {
    super(message);
    if (queryError) this.queryError = queryError;
  }
}

/** The parts of a metric definition the calculation reads. */
export interface UnitCostMetricDef {
  id: string;
  key: string;
  name: string;
  unit: string;
  kind: BusinessMetricKind;
  currency: string | null;
  costScope: CostFilter[];
  savedFilterId: string | null;
  labelMappings: BusinessMetricLabelMapping[];
}

/** A stored `business_metrics` row as the calculation reads it. */
export function metricDefFromRow(row: typeof businessMetrics.$inferSelect): UnitCostMetricDef {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    unit: row.unit,
    kind: row.kind === "currency" ? "currency" : "count",
    currency: row.currency,
    costScope: (row.costScope ?? []) as CostFilter[],
    savedFilterId: row.savedFilterId,
    labelMappings: (row.labelMappings ?? []) as BusinessMetricLabelMapping[],
  };
}

/** A live metric by id or key, as a calculation definition. Null when absent. */
export async function loadUnitCostMetric(
  organizationId: string,
  keyOrId: string,
): Promise<UnitCostMetricDef | null> {
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
  return row ? metricDefFromRow(row) : null;
}

function daySpan(from: string, to: string): number {
  return (
    Math.round(
      (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ) + 1
  );
}

/**
 * The filters the numerator actually runs: the metric's own `costScope` and
 * saved filter, AND-composed with whatever narrowing the request added.
 *
 * Composition, never replacement. The scope is part of what the metric
 * *means*: "cost per customer" is only honest if the numerator is the spend
 * that serves customers, so a caller can narrow it but has no way to widen it.
 */
async function resolveNumeratorFilters(
  organizationId: string,
  metric: UnitCostMetricDef | null,
  request: UnitCostQueryRequest,
): Promise<CostFilter[]> {
  const filters: CostFilter[] = metric ? [...metric.costScope] : [];

  if (metric?.savedFilterId) {
    try {
      filters.push(...(await resolveSavedCostFilters(organizationId, metric.savedFilterId)));
    } catch (e) {
      if (e instanceof SavedCostFilterResolutionError) {
        // Never a fall-through to unfiltered spend: a numerator that quietly
        // widened to the whole estate would inflate every unit cost on the
        // chart while looking entirely normal.
        throw new UnitCostRunError(
          `This metric's saved cost filter could not be resolved, so its unit costs cannot be ` +
            `computed: ${e.message}`,
        );
      }
      throw e;
    }
  }

  const inline = request.filters ?? [];
  const text = request.query?.trim();
  if (text && inline.length > 0) {
    throw new UnitCostRunError(
      "Send either `filters` or `query`, not both; they are two spellings of the same filter, " +
        "and running one while ignoring the other would silently answer a different question.",
    );
  }
  if (text) {
    try {
      filters.push(...parseCostQuery(text));
    } catch (e) {
      if (e instanceof CostQueryParseError) {
        throw new UnitCostRunError(`Invalid query at offset ${e.offset}: ${e.message}`, {
          offset: e.offset,
          length: e.length,
          expected: [...e.expected],
        });
      }
      throw e;
    }
  } else {
    filters.push(...inline);
  }

  if (request.savedFilterId) {
    try {
      filters.push(...(await resolveSavedCostFilters(organizationId, request.savedFilterId)));
    } catch (e) {
      if (e instanceof SavedCostFilterResolutionError) throw new UnitCostRunError(e.message);
      throw e;
    }
  }

  return filters;
}

/**
 * Which currency the numerator has to be expressed in, and the rates to get it
 * there. Unit cost asks the *display* question (governed by the org's opt-in
 * display currency); margin asks an *arithmetic* one (always the metric's own
 * currency, because subtracting spend from revenue is only defined in one).
 */
async function resolveConversion(
  organizationId: string,
  metric: UnitCostMetricDef | null,
  mode: UnitCostMode,
  requested: string | undefined,
) {
  if (mode === "margin" && metric) {
    return {
      displayCurrency: metric.currency,
      rates: metric.currency ? await loadOrgRateBook(organizationId) : RateBook.manualOnly([]),
    };
  }
  return loadConversionContext(organizationId, requested);
}

/** Does a stored row pass every label filter? */
function rowMatches(labels: BusinessMetricLabels, filters: UnitCostLabelFilter[]): boolean {
  return filters.every((f) => {
    const value = labels[f.key];
    const hit = value !== undefined && f.values.includes(value);
    return f.op === "in" ? hit : !hit;
  });
}

/** How a label value is matched to a numerator group key. */
interface LabelJoin {
  label: string;
  target: BusinessMetricLabelTarget;
  /**
   * Group key (dimension value or cost centre id) → the label value it stands
   * for. For a dimension target this is the identity; for cost centres it is
   * resolved by id or name. Undefined keys map to no label value.
   */
  labelValueForKey: (key: string) => string | null | undefined;
}

/**
 * Resolve a cost-centre mapping: which centre id each label value names. A
 * label value matches a centre by id, or case-insensitively by name.
 */
async function costCentreJoin(
  organizationId: string,
  label: string,
  labelValues: Iterable<string>,
): Promise<{ join: LabelJoin; rules: ShowbackRule[] }> {
  const [centres, rules] = await Promise.all([
    listCostCentres(organizationId),
    listAllocationRules(organizationId),
  ]);
  const byLowerName = new Map(centres.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const ids = new Set(centres.map((c) => c.id));
  const centreToLabel = new Map<string, string>();
  for (const value of labelValues) {
    const id = ids.has(value) ? value : byLowerName.get(value.trim().toLowerCase());
    if (id && !centreToLabel.has(id)) centreToLabel.set(id, value);
  }
  return {
    join: {
      label,
      target: { kind: "cost_centre" },
      // Unallocated spend ('') pairs with rows carrying no value for the label.
      labelValueForKey: (key) => (key === "" ? null : centreToLabel.get(key)),
    },
    rules: rules
      .filter((r) => ids.has(r.costCentreId))
      .map((r) => ({ costCentreId: r.costCentreId, match: r.match })),
  };
}

/** Merge keyed groups into one group per currency (the label split no longer matters). */
function byCurrency(groups: Array<{ currency: string; points: CostSeriesGroup["points"] }>) {
  const merged = mergeConvertedGroups(
    groups.map((g) => ({ key: "", currency: g.currency, points: g.points })),
  );
  return merged.map((g) => ({ currency: g.currency, points: g.points }));
}

/**
 * Run a unit-cost calculation for a metric (or, for `usage_unit_cost`, for no
 * metric at all).
 *
 * @throws {UnitCostRunError} for anything the caller can fix.
 */
export async function runUnitCostCalculation(
  organizationId: string,
  metric: UnitCostMetricDef | null,
  request: UnitCostQueryRequest,
): Promise<UnitCostQueryResponse> {
  if (request.from > request.to) throw new UnitCostRunError("from must not be after to");
  if (daySpan(request.from, request.to) > 1100) throw new UnitCostRunError("Date range too large");
  // Same refusal as the spend query: there are no hourly cost rows to divide.
  if (request.binning === "hourly") throw new UnitCostRunError(HOURLY_BINNING_UNAVAILABLE_REASON);

  const mode: UnitCostMode = request.mode ?? (metric ? "unit_cost" : "usage_unit_cost");
  const scale = mode === "margin" ? 1 : toUnitCostScale(request.scale);
  const labelFilters = request.labelFilters ?? [];
  const groupByLabel = request.groupByLabel?.trim() || undefined;

  if (mode === "usage_unit_cost") {
    if (!request.usageUnit) {
      throw new UnitCostRunError(
        "Cost per usage unit needs a usage unit. List the units your cost data reports with " +
          "GET /business-metrics/usage-units and pass one as `usageUnit`.",
      );
    }
    if (labelFilters.length > 0 || groupByLabel) {
      throw new UnitCostRunError(
        "Labels belong to business metrics; cost per usage unit divides by provider usage, " +
          "which has none. Narrow it with cost filters instead.",
      );
    }
  } else if (!metric) {
    throw new UnitCostRunError("This calculation needs a business metric.");
  }
  if (mode === "margin" && metric && metric.kind !== "currency") {
    // Margin against a count subtracts dollars from requests and divides by
    // requests: it type checks, it produces a number, and the number means
    // nothing. A metric declares its kind once so this is caught here.
    throw new UnitCostRunError(
      `Margin needs a revenue metric. "${metric.key}" counts ${metric.unit || "units"}, not ` +
        'money. Declare a metric with kind "currency" and its currency to compute margin.',
    );
  }

  // ---- Labels: which are used, and are they joinable? --------------------
  const ratio = mode !== "raw_metric";
  const mappings = new Map((metric?.labelMappings ?? []).map((m) => [m.label, m.target]));
  const needsMapping = (label: string, use: string): BusinessMetricLabelTarget | undefined => {
    const target = mappings.get(label);
    if (!target && ratio) {
      throw new UnitCostRunError(
        `"${label}" is not mapped to a cost dimension, so spend cannot be ${use} by it. ` +
          `Map the label to the tag, virtual tag ` +
          `or cost centre its values name (edit the metric), or plot the raw metric instead.`,
      );
    }
    return target;
  };
  const filterTargets = labelFilters.map((f) => ({
    filter: f,
    target: needsMapping(f.key, "filtered"),
  }));
  const groupTarget = groupByLabel ? needsMapping(groupByLabel, "split") : undefined;

  const centreLabels = new Set<string>();
  for (const { filter, target } of filterTargets) {
    if (target?.kind === "cost_centre") centreLabels.add(filter.key);
  }
  if (groupByLabel && groupTarget?.kind === "cost_centre") centreLabels.add(groupByLabel);
  if (centreLabels.size > 1) {
    throw new UnitCostRunError(
      "Only one cost-centre-mapped label can be used in one query: each row of spend belongs " +
        "to exactly one cost centre, so two such labels cannot both narrow it.",
    );
  }
  if (groupByLabel && groupTarget?.kind === "dimension" && centreLabels.size > 0) {
    throw new UnitCostRunError(
      "A cost-centre-mapped label filter cannot be combined with grouping by a label mapped " +
        "to a cost dimension. Group by the cost-centre label instead, or drop the filter.",
    );
  }

  const [baseFilters, { displayCurrency, rates }] = await Promise.all([
    resolveNumeratorFilters(organizationId, metric, request),
    resolveConversion(organizationId, metric, mode, request.displayCurrency),
  ]);

  // Dimension-mapped label filters narrow the spend exactly as they narrow the
  // volume: the same values, on the dimension the label names.
  const filters: CostFilter[] = [...baseFilters];
  for (const { filter, target } of filterTargets) {
    if (target?.kind !== "dimension") continue;
    if (costDimensionNeedsKey(target.dimension) && !target.tagKey) continue;
    filters.push({
      dimension: target.dimension,
      op: filter.op,
      values: filter.values,
      ...(target.tagKey ? { tagKey: target.tagKey } : {}),
    });
  }

  // ---- Denominator rows --------------------------------------------------
  let rows: StoredLabeledMetricValue[] = [];
  if (mode === "usage_unit_cost") {
    rows = (
      await queryUsageQuantities(organizationId, {
        from: request.from,
        to: request.to,
        filters,
        usageUnit: request.usageUnit!,
        chargeTypes: request.chargeTypes,
      })
    ).map((r) => ({ day: r.day, value: r.value, labels: {} }));
  } else {
    rows = (await getLabeledMetricValues(metric!.id, request.from, request.to)).filter((r) =>
      rowMatches(r.labels, labelFilters),
    );
  }

  // ---- Numerator ---------------------------------------------------------
  let join: LabelJoin | null = null;
  let allocation: ShowbackRule[] | undefined;
  const centreLabel = [...centreLabels][0];
  if (centreLabel) {
    const values = new Set<string>();
    for (const r of rows) {
      const v = r.labels[centreLabel];
      if (v !== undefined) values.add(v);
    }
    for (const { filter } of filterTargets) {
      if (filter.key === centreLabel) for (const v of filter.values) values.add(v);
    }
    const resolved = await costCentreJoin(organizationId, centreLabel, values);
    join = resolved.join;
    allocation = resolved.rules;
  } else if (groupByLabel && groupTarget?.kind === "dimension") {
    join = {
      label: groupByLabel,
      target: groupTarget,
      labelValueForKey: (key) => (key === "" ? null : key),
    };
  }

  const groupedByDimension =
    join?.target.kind === "dimension" &&
    !(costDimensionNeedsKey(join.target.dimension) && !join.target.tagKey);
  const rawGroups = await queryCosts(organizationId, {
    from: request.from,
    to: request.to,
    binning: request.binning,
    groupBy:
      groupedByDimension && join?.target.kind === "dimension" ? join.target.dimension : "none",
    ...(groupedByDimension && join?.target.kind === "dimension" && join.target.tagKey
      ? { groupByTagKey: join.target.tagKey }
      : {}),
    filters,
    ...(allocation ? { groupByAllocation: allocation } : {}),
    ...(mode === "usage_unit_cost" ? { usageUnit: request.usageUnit! } : {}),
    ...(request.costBasis ? { costBasis: request.costBasis } : {}),
    ...(request.chargeTypes && request.chargeTypes.length > 0
      ? { chargeTypes: request.chargeTypes }
      : {}),
  });

  const { groups: converted, conversion } = convertGroups(rawGroups, displayCurrency, rates);
  // Merge first, then divide: conversion turns "spend in EUR" and "spend in
  // USD" into two same-key groups, and dividing each by the full denominator
  // separately would draw two lines that each understate the real unit cost.
  let keyed = mergeConvertedGroups(converted);

  // A cost-centre label used only as a filter: keep the centres it names (or,
  // for `not_in`, every other centre, unallocated included).
  if (join && join.target.kind === "cost_centre" && centreLabel) {
    const filter = labelFilters.find((f) => f.key === centreLabel);
    if (filter) {
      keyed = keyed.filter((g) => {
        const value = join!.labelValueForKey(g.key);
        const hit = typeof value === "string" && filter.values.includes(value);
        return filter.op === "in" ? hit : !hit;
      });
    }
  }

  const fallbackCurrency = keyed[0]?.currency ?? displayCurrency ?? metric?.currency ?? "USD";
  const base = {
    from: request.from,
    to: request.to,
    binning: request.binning,
    mode,
    metricCurrency: metric?.currency ?? null,
    scale,
  };

  let series: UnitCostSeries[] = [];
  let gapBuckets = 0;
  let partialBuckets = 0;
  let costPerLabel: boolean | undefined;

  if (!groupByLabel) {
    let costGroups: UnitCostCostGroup[] = byCurrency(keyed);
    // Raw mode plots the metric even where nothing was spent; a ratio over no
    // spend at all keeps the old answer (no series) since there is nothing to
    // say per unit.
    if (costGroups.length === 0 && mode === "raw_metric") {
      costGroups = [{ currency: fallbackCurrency, points: [] }];
    }
    const result = computeUnitCosts({ ...base, costGroups, values: rows });
    series = result.series;
    gapBuckets = result.gapBuckets;
    partialBuckets = result.partialBuckets;
  } else {
    // Rank label values by their metric total; the largest get their own
    // series and the long tail folds into one "Other", the cost graph's top-N
    // rule applied to labels.
    const totals = new Map<string | null, number>();
    for (const r of rows) {
      const v = r.labels[groupByLabel] ?? null;
      totals.set(v, (totals.get(v) ?? 0) + Math.abs(r.value));
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
    const cap = BUSINESS_METRIC_LIMITS.maxLabelGroups;
    const kept = new Set(ranked.slice(0, cap));
    const folded = ranked.length > cap;
    const tail = new Set(ranked.slice(cap));

    costPerLabel = join !== null && (join.target.kind === "cost_centre" || groupedByDimension);
    const wholeScope = byCurrency(keyed);

    const groupsFor = (members: (value: string | null | undefined) => boolean) => {
      if (!costPerLabel) return wholeScope;
      return byCurrency(keyed.filter((g) => members(join!.labelValueForKey(g.key))));
    };

    const emit = (
      label: { key: string; value: string | null; other?: boolean },
      values: StoredLabeledMetricValue[],
      costGroups: UnitCostCostGroup[],
    ) => {
      const groups =
        costGroups.length > 0 ? costGroups : [{ currency: fallbackCurrency, points: [] }];
      const result = computeUnitCosts({ ...base, costGroups: groups, values });
      for (const s of result.series) series.push({ ...s, label });
      gapBuckets += result.gapBuckets;
      partialBuckets += result.partialBuckets;
    };

    for (const value of ranked) {
      if (!kept.has(value)) continue;
      emit(
        { key: groupByLabel, value },
        rows.filter((r) => (r.labels[groupByLabel] ?? null) === value),
        groupsFor((v) => (v ?? null) === value && v !== undefined),
      );
    }
    if (folded) {
      emit(
        { key: groupByLabel, value: null, other: true },
        rows.filter((r) => !kept.has(r.labels[groupByLabel] ?? null)),
        groupsFor((v) => v !== undefined && tail.has(v ?? null)),
      );
    }
  }

  const response: UnitCostQueryResponse = {
    metric: metric
      ? {
          id: metric.id,
          key: metric.key,
          name: metric.name,
          unit: metric.unit,
          kind: metric.kind,
          currency: metric.currency,
        }
      : null,
    mode,
    binning: request.binning,
    scale,
    series,
    gapBuckets,
    partialBuckets,
  };
  if (mode === "usage_unit_cost") response.usageUnit = request.usageUnit!;
  if (groupByLabel) response.groupByLabel = groupByLabel;
  if (costPerLabel !== undefined) response.costPerLabel = costPerLabel;
  // Only set when something was actually converted: its absence is how a
  // client knows the per-currency numbers are the literal collected ones.
  if (conversion) response.conversion = conversion;
  return response;
}
