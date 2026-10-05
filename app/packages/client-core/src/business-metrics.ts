/**
 * Business metrics and unit costs: "what does one of the thing we do cost?"
 *
 * Absolute spend answers "are we spending more". It cannot answer "are we
 * spending more *per customer*", which is the question that decides whether a
 * rising bill is growth or waste. A business metric is the denominator: a named
 * daily series the org reports itself (customers, API requests, GB processed,
 * revenue), optionally tied to the slice of spend it divides.
 *
 * Three rules are contractual rather than incidental, and every surface (web,
 * desktop, mobile, the CLI, the MCP tools) has to honour all three:
 *
 * 1. **The ratio is computed at the bucket the caller asked for**, from a summed
 *    numerator and a summed denominator. A daily unit cost averaged over a month
 *    is not the monthly unit cost; on a month where volume moved, the two differ
 *    by more than anyone would tolerate in a finance review.
 * 2. **A missing or non-positive denominator is a gap, never 0 and never ∞.**
 *    A chart that reads 0 on days a metric was not reported will be believed,
 *    and it says the opposite of the truth: "that day was free" instead of
 *    "we do not know". {@link UnitCostPoint.value} is `null` for those buckets
 *    and {@link UnitCostPoint.gap} says which case it was.
 * 3. **Currencies are never merged.** Spend in a currency the org holds no rate
 *    for keeps its own unit-cost series rather than vanishing into another
 *    one's; the same invariant the cost graph already holds, for the same
 *    reason: a silently understated numerator is worse than two numbers.
 *
 * Types live here rather than in `@infrawrench/ui` because mobile doesn't
 * depend on that package; `ui/src/cost/config.ts` holds the zod schemas and
 * proves at compile time that they parse to exactly these shapes.
 */

import { resolveCostDateRange } from "./costs";
import type {
  CostBasis,
  CostBinningId,
  CostChargeType,
  CostConversion,
  CostDimensionId,
  CostFilter,
  CostGraphConfig,
  UnitCostGraphMode,
  UnitCostGraphScale,
} from "./costs";
import type { CloudFetch } from "./fetch";

/* ------------------------------------------------------------------ *
 * The metric definition.
 * ------------------------------------------------------------------ */

/**
 * What a metric's numbers *are*, which decides what can be computed from them.
 *
 * - `count`: a unit-less quantity: customers, requests, GB, orders. Supports
 *   unit cost (spend ÷ count) and nothing else.
 * - `currency`: money the business took in, denominated in the metric's own
 *   {@link BusinessMetric.currency}. Supports unit cost *and* margin.
 *
 * Margin is modelled as a property of the metric rather than as a flag on the
 * query, deliberately. `(revenue − cost) ÷ revenue` is only meaningful when the
 * denominator is money in a known currency: computing it against "requests"
 * subtracts dollars from requests and divides by requests, which type-checks in
 * every language and means nothing. Making the org declare the metric's kind
 * once, at definition time, is what lets every surface refuse the nonsense
 * without each of them re-deriving the rule, and a `currency` metric must
 * carry a currency code, which is the fact the margin computation needs anyway.
 */
export const BUSINESS_METRIC_KINDS = ["count", "currency"] as const;
export type BusinessMetricKind = (typeof BUSINESS_METRIC_KINDS)[number];

export const BUSINESS_METRIC_KIND_LABELS: Record<BusinessMetricKind, string> = {
  count: "Count",
  currency: "Revenue (money)",
};

export const BUSINESS_METRIC_KIND_DESCRIPTIONS: Record<BusinessMetricKind, string> = {
  count:
    "A quantity such as customers, requests or GB processed. Divides spend into a cost per unit.",
  currency:
    "Money the business took in, in one currency. Divides spend into a cost per unit of " +
    "revenue, and is the only kind margin can be computed against.",
};

/** A business metric definition, as the API returns it. */
export interface BusinessMetric {
  id: string;
  /**
   * Stable slug the CLI, workflows and `POST /business-metrics/values` address
   * the metric by. Unique per org among live metrics; renaming the display name
   * never breaks a workflow, which is the point of having both.
   */
  key: string;
  name: string;
  /**
   * Singular unit label for display: "customer", "request", "GB". Purely a
   * label: nothing is converted or validated against it, because there is no
   * closed set of business units and pretending otherwise would just make the
   * form refuse legitimate ones.
   */
  unit: string;
  description: string | null;
  kind: BusinessMetricKind;
  /** Set exactly when `kind === "currency"`; null for a count metric. */
  currency: string | null;
  /**
   * The spend this metric divides, as the same `CostFilter[]` graphs and
   * budgets use. Empty means all of the org's spend.
   *
   * Stored on the metric rather than supplied per query because it is a
   * property of the metric's meaning: "cost per customer" is only honest if the
   * numerator is the spend that serves customers. A query may narrow it further
   * (the two are AND-composed), but never widen it: a caller who could drop the
   * scope would silently be answering a different question under the same name.
   */
  costScope: CostFilter[];
  /**
   * A saved cost filter AND-composed with `costScope`, resolved server-side at
   * query time. Same referencing rule as budgets and graphs: editing the saved
   * filter re-scopes this metric's numerator, and a reference that fails to
   * resolve errors the query rather than silently widening it to all spend.
   */
  savedFilterId: string | null;
  /**
   * Which value labels correspond to a cost dimension, so a unit cost can be
   * computed *per label value*: "customer" mapped to the `customer` tag turns
   * one revenue series into a margin per customer. A label with no mapping can
   * still be filtered and grouped when plotting the raw metric, but never
   * divides spend: see {@link BusinessMetricLabelMapping}.
   */
  labelMappings: BusinessMetricLabelMapping[];
  /**
   * Standing limits on this metric's unit cost or margin, evaluated daily and
   * routed like every other cost alert. Empty is none.
   */
  thresholds: UnitCostThreshold[];
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The reported range, or null when the metric has no values at all. A metric
   * with no values is not broken (it was just created) but every unit-cost
   * chart drawn from it is one continuous gap, so the surfaces say so.
   */
  coverage: BusinessMetricCoverage | null;
  /**
   * The scheduled importer feeding this metric, in summary, or null when its
   * values are only pushed. The full configuration and run history are on
   * `GET /business-metrics/{id}/importer`.
   */
  importer: BusinessMetricImporterSummary | null;
}

/** Enough about a metric's importer for a list row: what feeds it and whether that is working. */
export interface BusinessMetricImporterSummary {
  accountId: string;
  accountName: string | null;
  pluginId: string | null;
  /** The plugin's name for the source, e.g. "CloudWatch metric". */
  sourceLabel: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastError: string | null;
}

/** What days a metric actually has numbers for. */
export interface BusinessMetricCoverage {
  /** Inclusive UTC days, YYYY-MM-DD. */
  firstDay: string;
  lastDay: string;
  /** Days carrying a value. Compare against the span to spot a sparse series. */
  reportedDays: number;
}

/** Create/update payload (POST/PUT /business-metrics). */
export interface BusinessMetricInput {
  key: string;
  name: string;
  unit: string;
  description?: string | undefined;
  kind: BusinessMetricKind;
  /** Required when `kind === "currency"`; rejected otherwise. */
  currency?: string | undefined;
  costScope?: CostFilter[] | undefined;
  savedFilterId?: string | undefined;
  /** Absent is none. A full replace, like every other field. */
  labelMappings?: BusinessMetricLabelMapping[] | undefined;
  /** Absent is none. A full replace, like every other field. */
  thresholds?: UnitCostThreshold[] | undefined;
}

/* ------------------------------------------------------------------ *
 * Labels: one metric, many dimensions.
 * ------------------------------------------------------------------ */

/**
 * A value's labels: `{ customer: "acme", plan: "pro" }`. Empty is an unlabelled
 * value, which is what every value written before labels existed is.
 *
 * **Rows partition the metric.** A day's total is the sum of every row for that
 * day, labelled or not, so a breakdown must not be reported alongside the total
 * it breaks down (that would count the day twice). An unlabelled row reads as
 * "the part not attributed to any label value", and groups under "(no label)".
 *
 * The identity of a stored value is `(metric, day, labels)`: re-reporting the
 * same day with the same labels restates it, while the same day with different
 * labels is a different row. Keys follow the metric-key slug rule so a label is
 * typed the same way in a workflow, a CSV header and a CLI flag.
 */
export type BusinessMetricLabels = Record<string, string>;

/**
 * Where a label's values live on the cost side.
 *
 * - `dimension`: a cost dimension, the same vocabulary filters and group-bys
 *   use. A label value matches the dimension value exactly: label `customer`
 *   mapped to the `customer` tag joins `customer=acme` to spend tagged
 *   `customer=acme`. Keyed dimensions (tags) carry `tagKey`.
 * - `cost_centre`: the org's cost centres. A label value matches a centre by
 *   its id or, case-insensitively, by its name, so a metric can be reported
 *   against the names people already use.
 */
export type BusinessMetricLabelTarget =
  | { kind: "dimension"; dimension: CostDimensionId; tagKey?: string | undefined }
  | { kind: "cost_centre" };

export const BUSINESS_METRIC_LABEL_TARGET_KINDS = ["dimension", "cost_centre"] as const;
export type BusinessMetricLabelTargetKind = (typeof BUSINESS_METRIC_LABEL_TARGET_KINDS)[number];

/**
 * A label joined to a cost dimension.
 *
 * Why unit costs need one: grouping "cost per customer" by customer needs a
 * per-customer *numerator* as well as a per-customer denominator. Without a
 * mapping the only spend available is the metric's whole scope, and dividing
 * that by one customer's volume produces a number per customer that sums to
 * nothing and means nothing. So a ratio mode refuses an unmapped label, and
 * the mapping is what turns it on.
 */
export interface BusinessMetricLabelMapping {
  /** The label key, e.g. `customer`. */
  label: string;
  target: BusinessMetricLabelTarget;
}

/**
 * Cost dimensions whose filter needs a key as well as a value. A string test
 * rather than a narrowing on `CostDimensionId` so a keyed dimension added to
 * the vocabulary later is recognised without touching this file.
 */
export function costDimensionNeedsKey(dimension: string): boolean {
  return dimension === "tag" || dimension === "virtual_tag";
}

/** One label key a metric's values carry, and the values seen for it. */
export interface BusinessMetricLabelSummary {
  key: string;
  /** Distinct values, alphabetical, capped at `maxLabelValuesListed`. */
  values: string[];
  /** True when more values exist than were listed. */
  truncated: boolean;
  /** The mapping for this label, when one is declared. */
  mapping: BusinessMetricLabelTarget | null;
}

/** One reported day (GET /business-metrics/{id}/values). */
export interface BusinessMetricValue {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  value: number;
  /**
   * The single breakdown label (a customer, a region): the `label` key of
   * {@link labels}, as the importers write it. Null when the value has none.
   * Kept beside `labels` for clients that predate multi-dimensional labels.
   */
  label: string | null;
  /** Empty for an unlabelled value. */
  labels: BusinessMetricLabels;
  /** Where the number came from, for "who wrote this" on a surprising point. */
  source: BusinessMetricValueSource;
  updatedAt: string;
}

/**
 * Who wrote a value. Both paths run the same validator and the same restating
 * upsert; this only exists so a reader can tell a nightly workflow's number
 * from a hand-corrected one.
 */
export const BUSINESS_METRIC_VALUE_SOURCES = ["api", "workflow", "import"] as const;
export type BusinessMetricValueSource = (typeof BUSINESS_METRIC_VALUE_SOURCES)[number];

/** One value in a write batch (POST /business-metrics/{id}/values). */
export interface BusinessMetricValueInput {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  /**
   * The day's value. Re-reporting a day **restates** it rather than adding to
   * it, exactly like re-pushing a cost row: an ingest that accumulated would
   * double every number the first time a nightly job retried.
   */
  value: number;
  /**
   * A single breakdown label, stored as `{ label: <value> }`; `labels` wins
   * when both are sent. Omit both for a plain daily total.
   */
  label?: string | undefined;
  /**
   * Optional labels. The same day with the same labels restates; the same day
   * with different labels is a separate row. See {@link BusinessMetricLabels}.
   */
  labels?: BusinessMetricLabels | undefined;
}

/** Result of a value write, mirroring `infra.costs.write`'s. */
export interface BusinessMetricWriteResult {
  /** How many days were written (or restated). */
  written: number;
}

/**
 * Bounds the API enforces; clients enforce the same ones locally so a typo
 * fails in the form rather than as a 400 after the round trip.
 */
export const BUSINESS_METRIC_LIMITS = {
  maxKeyLength: 64,
  maxNameLength: 120,
  maxUnitLength: 32,
  maxDescriptionLength: 2000,
  /** Past this a "metric" is a data feed and belongs in the warehouse. */
  maxMetricsPerOrg: 200,
  /** One call can restate about 13 years of daily values. */
  maxValuesPerCall: 5_000,
  maxScopeFilters: 50,
  /** GET /business-metrics/{id}/values?limit= */
  maxValuesPageSize: 1_000,
  /** Labels on one value. A value with more is a row from a warehouse. */
  maxLabelsPerValue: 8,
  maxLabelKeyLength: 64,
  maxLabelValueLength: 200,
  /** Mappings on one metric: one per label key at most. */
  maxLabelMappings: 8,
  /** Values listed per label key by GET /business-metrics/{id}/labels. */
  maxLabelValuesListed: 500,
  /** Series one grouped unit-cost query returns, per currency. */
  maxLabelGroups: 25,
  /** Standing thresholds on one metric. */
  maxThresholds: 10,
  minThresholdWindowDays: 1,
  maxThresholdWindowDays: 90,
  /** Rows one CSV import may carry; the same cap as one value write. */
  maxCsvRows: 5_000,
} as const;

/**
 * Keys are lowercase slugs: they are typed into workflows, CLI flags and URLs,
 * and a key that differs from another only by case or by a space is a support
 * ticket waiting to happen.
 */
export const BUSINESS_METRIC_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

export const BUSINESS_METRIC_KEY_HELP =
  "A metric key is a lowercase slug (letters, digits, and _ . -) starting with a letter or " +
  "digit, e.g. `active-customers`.";

/** What a new-metric form starts on. */
export const DEFAULT_BUSINESS_METRIC_INPUT: BusinessMetricInput = {
  key: "",
  name: "",
  unit: "",
  kind: "count",
  costScope: [],
};

/**
 * Normalize a typed key the way the server will, so a form can show the value
 * that is actually going to be stored rather than surprising the user after
 * the save.
 */
export function normalizeBusinessMetricKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Label keys use the metric-key slug rule. Normalised the same way (trimmed,
 * lowercased) so `Customer` in a CSV header and `customer` in a workflow are
 * one label rather than two that each hold half the data.
 */
export const BUSINESS_METRIC_LABEL_KEY_PATTERN = BUSINESS_METRIC_KEY_PATTERN;

export function normalizeBusinessMetricLabelKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The canonical form of a label set: keys normalised, values trimmed, empty
 * values dropped (an empty label is the same as no label), keys sorted. Two
 * label sets that mean the same thing serialise identically, which is what the
 * storage identity `(metric, day, labels)` relies on.
 */
export function canonicalBusinessMetricLabels(
  labels: BusinessMetricLabels | undefined | null,
): BusinessMetricLabels {
  if (!labels) return {};
  const entries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(labels)) {
    if (typeof rawValue !== "string") continue;
    const key = normalizeBusinessMetricLabelKey(rawKey);
    const value = rawValue.trim();
    if (!key || !value) continue;
    entries.push([key, value]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

/**
 * The label key a single, unnamed breakdown label is stored under: a value
 * written with just a breakdown string (as the scheduled importers do) is the
 * label set `{ label: "<value>" }`.
 */
export const BUSINESS_METRIC_DEFAULT_LABEL_KEY = "label";

/**
 * The stable string a canonical label set is stored and compared under (the
 * `business_metric_values.label` column). `''` for no labels; the bare value
 * for a set holding only the default `label` key, so a single breakdown label
 * reads as itself; canonical JSON for anything richer.
 */
export function businessMetricLabelsKey(labels: BusinessMetricLabels | undefined | null): string {
  const canonical = canonicalBusinessMetricLabels(labels);
  const keys = Object.keys(canonical);
  if (keys.length === 0) return "";
  if (keys.length === 1 && keys[0] === BUSINESS_METRIC_DEFAULT_LABEL_KEY) {
    const value = canonical[BUSINESS_METRIC_DEFAULT_LABEL_KEY]!;
    // A bare value that happens to look like JSON would read back as a label
    // set, so it is stored in the JSON form instead.
    if (!value.startsWith("{")) return value;
  }
  return JSON.stringify(canonical);
}

/** The inverse of {@link businessMetricLabelsKey}, for rows read without their jsonb. */
export function businessMetricLabelsFromKey(key: string): BusinessMetricLabels {
  if (!key) return {};
  if (key.startsWith("{")) {
    try {
      const parsed = JSON.parse(key) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return canonicalBusinessMetricLabels(parsed as BusinessMetricLabels);
      }
    } catch {
      // Fall through: a malformed key is a bare value.
    }
  }
  return { [BUSINESS_METRIC_DEFAULT_LABEL_KEY]: key };
}

/** `customer=acme, plan=pro`, or the empty string for no labels. */
export function formatBusinessMetricLabels(
  labels: BusinessMetricLabels | undefined | null,
): string {
  return Object.entries(canonicalBusinessMetricLabels(labels))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/* ------------------------------------------------------------------ *
 * The unit-cost query: POST /business-metrics/{id}/unit-costs, and
 * POST /business-metrics/usage-unit-costs for the metric-free mode.
 * ------------------------------------------------------------------ */

/**
 * Which calculation to draw.
 *
 * - `unit_cost`: spend ÷ metric value. Available for every metric.
 * - `margin`: (revenue − spend) ÷ revenue, as a fraction (0.42 is 42%), with
 *   the absolute margin (revenue − spend, in the metric's currency) beside it
 *   on every point. Available only for a `currency` metric, and only where the
 *   numerator can be expressed in that metric's currency.
 * - `usage_unit_cost`: spend ÷ the usage quantity the providers themselves
 *   report, in one usage unit (GB-month, vCPU-hour, request). Needs no business
 *   metric: both sides come from the same cost rows, restricted to the rows
 *   reported in that unit, so the numerator is exactly the spend that bought the
 *   denominator.
 * - `raw_metric`: the metric itself, plotted beside the spend of its scope.
 *   No division at all, so zero and negative values are real points here rather
 *   than gaps.
 */
export const UNIT_COST_MODES = ["unit_cost", "margin", "usage_unit_cost", "raw_metric"] as const;
export type UnitCostMode = (typeof UNIT_COST_MODES)[number];

/**
 * `CostGraphConfig.unitCostMode` spells the same union out inline to avoid a
 * circular import. This fails the build if the two ever drift apart.
 */
true satisfies UnitCostMode extends UnitCostGraphMode
  ? UnitCostGraphMode extends UnitCostMode
    ? true
    : never
  : never;

export const UNIT_COST_MODE_LABELS: Record<UnitCostMode, string> = {
  unit_cost: "Cost per unit",
  margin: "Gross margin",
  usage_unit_cost: "Cost per usage unit",
  raw_metric: "Raw metric",
};

export const UNIT_COST_MODE_DESCRIPTIONS: Record<UnitCostMode, string> = {
  unit_cost: "Spend divided by the metric.",
  margin: "Revenue minus spend, as a percentage of revenue and as an amount.",
  usage_unit_cost: "Spend divided by the usage quantity providers report, in one unit.",
  raw_metric: "The metric itself, plotted beside spend.",
};

/** Modes that divide by a business metric (and so need one). */
export function unitCostModeNeedsMetric(mode: UnitCostMode): boolean {
  return mode !== "usage_unit_cost";
}

/**
 * "Per N units": the block a ratio is expressed against. A cost per API
 * request is a string of zeros; a cost per million requests is a number a
 * person can compare. For `raw_metric` the same scale divides the plotted value
 * ("thousands of requests"). Margin is a fraction and ignores it.
 */
export const UNIT_COST_SCALES = [1, 100, 1_000, 1_000_000, 1_000_000_000] as const;
export type UnitCostScale = (typeof UNIT_COST_SCALES)[number];

true satisfies UnitCostScale extends UnitCostGraphScale
  ? UnitCostGraphScale extends UnitCostScale
    ? true
    : never
  : never;

export const UNIT_COST_SCALE_LABELS: Record<`${UnitCostScale}`, string> = {
  "1": "Per unit",
  "100": "Per hundred",
  "1000": "Per thousand",
  "1000000": "Per million",
  "1000000000": "Per billion",
};

/** The scale words used inside a unit label: "", "100 ", "1K ", "1M ", "1B ". */
function scalePrefix(scale: UnitCostScale): string {
  switch (scale) {
    case 1:
      return "";
    case 100:
      return "100 ";
    case 1_000:
      return "1K ";
    case 1_000_000:
      return "1M ";
    case 1_000_000_000:
      return "1B ";
  }
}

/** Narrow an arbitrary number to a scale, falling back to per-unit. */
export function toUnitCostScale(value: number | undefined | null): UnitCostScale {
  return (UNIT_COST_SCALES as readonly number[]).includes(value ?? 1)
    ? (value as UnitCostScale)
    : 1;
}

/**
 * Narrow a unit-cost query to some label values. `in` keeps rows carrying one
 * of `values` for `key`; `not_in` drops them (and keeps rows without the label).
 */
export interface UnitCostLabelFilter {
  key: string;
  op: "in" | "not_in";
  values: string[];
}

export interface UnitCostQueryRequest {
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
  binning: CostBinningId;
  /** Absent is `unit_cost`. */
  mode?: UnitCostMode | undefined;
  /** Absent is 1 (per unit). Ignored for `margin`. */
  scale?: UnitCostScale | undefined;
  /**
   * Extra filters AND-composed with the metric's own `costScope`: narrowing
   * only. There is no way to widen past the scope, because the scope is part of
   * what the metric *means*.
   */
  filters?: CostFilter[] | undefined;
  /** The same narrowing written in the cost query language. */
  query?: string | undefined;
  /** A saved cost filter, also AND-composed. */
  savedFilterId?: string | undefined;
  /** Which number to sum; absent is `cash`. */
  costBasis?: CostBasis | undefined;
  /** Restrict the numerator to these charge types; absent is all of them. */
  chargeTypes?: CostChargeType[] | undefined;
  /**
   * Fold spend currencies the org holds a rate for into this one before
   * dividing. Absent means no conversion, and a mixed-currency estate then
   * yields one unit-cost series per currency rather than one wrong number.
   *
   * Ignored for `margin`, which always converts to the metric's own currency:
   * subtracting spend from revenue is only defined in one currency.
   */
  displayCurrency?: string | undefined;
  /**
   * Keep only values carrying these labels. In a ratio mode every filtered
   * label must be mapped to a cost dimension, so the spend is narrowed to the
   * same slice as the volume; `raw_metric` accepts any label.
   */
  labelFilters?: UnitCostLabelFilter[] | undefined;
  /**
   * One series per value of this label. Same mapping rule as `labelFilters`:
   * in a ratio mode the label must be mapped, because a per-customer ratio needs
   * per-customer spend. The largest `maxLabelGroups` values by metric total are
   * kept; the rest fold into one "Other" series.
   */
  groupByLabel?: string | undefined;
  /**
   * `usage_unit_cost` only, and required there: which provider usage unit to
   * divide by (`GB-Mo`, `Hrs`, `Requests`, ...). Pick one from
   * `GET /business-metrics/usage-units`.
   */
  usageUnit?: string | undefined;
}

/**
 * Why a bucket has no value. Never rendered as a number by any surface: a gap
 * is drawn as a gap and explained in words.
 */
export const UNIT_COST_GAP_REASONS = [
  "no_metric_value",
  "non_positive_metric_value",
  "unconvertible_currency",
  "no_usage",
] as const;
export type UnitCostGapReason = (typeof UNIT_COST_GAP_REASONS)[number];

export const UNIT_COST_GAP_REASON_LABELS: Record<UnitCostGapReason, string> = {
  no_metric_value: "No metric value reported",
  non_positive_metric_value: "Metric value was zero or negative",
  unconvertible_currency: "Spend in a currency with no rate to the metric's currency",
  no_usage: "No usage reported in this unit",
};

/**
 * One bucket of a unit-cost series.
 *
 * `value` is `null` for a gap and only for a gap: a real 0 is possible and
 * meaningful (spend of nothing over a positive denominator genuinely costs
 * nothing per unit), so the two must stay distinguishable. `cost` and
 * `metricValue` carry the numerator and denominator that produced the ratio so
 * a reader can check the arithmetic without a second query, and so a tooltip
 * can say "$1,240 ÷ 310 customers" rather than only the quotient.
 */
export interface UnitCostPoint {
  /** Bucket start date, YYYY-MM-DD. */
  bucket: string;
  /**
   * The ratio (already multiplied by the response's `scale`), the margin
   * fraction, or for `raw_metric` the metric value (already divided by
   * `scale`). Null when this bucket is a gap. Never ±Infinity, never NaN.
   */
  value: number | null;
  /** Spend summed over the bucket, in `UnitCostSeries.currency`. */
  cost: number;
  /**
   * The denominator summed over the bucket (the metric, or for
   * `usage_unit_cost` the usage quantity), unscaled. Null when nothing was
   * reported.
   */
  metricValue: number | null;
  /** `margin` only: revenue − spend, in the series currency. Null on a gap. */
  absoluteMargin?: number | null | undefined;
  /** Set exactly when `value` is null. */
  gap?: UnitCostGapReason | undefined;
  /**
   * How much of the bucket the denominator actually covers: days carrying a
   * reported value, out of days in the bucket that fall inside the queried
   * range.
   *
   * These matter because a partially reported bucket is the one silently wrong
   * number this feature can still produce: six days of volume under seven days
   * of spend inflates a weekly unit cost by about a sixth, and nothing about the
   * quotient looks wrong. The point is still computed (discarding six days of
   * real data would be its own distortion) but every surface flags it, and
   * `daily` binning makes the whole question moot (every bucket is one day).
   */
  reportedDays: number;
  bucketDays: number;
}

/** True when a point's denominator covers only part of its bucket. */
export function isPartialUnitCostPoint(point: UnitCostPoint): boolean {
  return point.value !== null && point.reportedDays > 0 && point.reportedDays < point.bucketDays;
}

/**
 * One unit-cost series, in one currency, and (when grouped) for one label value.
 *
 * There is one series per currency the numerator ended up in: usually exactly
 * one. More than one means the org has spend in a currency it holds no rate
 * for, and rather than dropping that spend (understating every unit cost) or
 * adding euros to dollars (inventing a number), each currency divides the same
 * denominator on its own.
 */
export interface UnitCostSeries {
  /** ISO-4217 code the numerator (and therefore the ratio) is expressed in. */
  currency: string;
  /**
   * Set when the query grouped by a label. `value: null` is the rows carrying
   * no value for that label; `other: true` folds the values past the group cap.
   */
  label?: { key: string; value: string | null; other?: boolean | undefined } | undefined;
  points: UnitCostPoint[];
  /**
   * The period ratio: **summed numerator ÷ summed denominator** across every
   * bucket, not the mean of the per-bucket ratios. The two differ whenever
   * volume moves, and the mean is the wrong one: it weights a quiet Sunday the
   * same as a peak Monday. Scaled like the points.
   *
   * Null when nothing in the range had a usable denominator.
   */
  overallValue: number | null;
  /** Numerator and denominator behind `overallValue`. */
  overallCost: number;
  overallMetricValue: number | null;
  /** `margin` only: summed revenue − summed spend over the same buckets. */
  overallAbsoluteMargin?: number | null | undefined;
}

export interface UnitCostQueryResponse {
  /**
   * The metric this was divided by, so a client needs no second fetch. Null for
   * `usage_unit_cost`, which divides by provider usage instead; `usageUnit`
   * names that denominator.
   */
  metric: Pick<BusinessMetric, "id" | "key" | "name" | "unit" | "kind" | "currency"> | null;
  mode: UnitCostMode;
  binning: CostBinningId;
  /** The scale the values are expressed against (always 1 for `margin`). */
  scale: UnitCostScale;
  /** `usage_unit_cost` only: the usage unit divided by. */
  usageUnit?: string | undefined;
  /** The label the series are grouped by, when they are. */
  groupByLabel?: string | undefined;
  /**
   * True when each label series carries its own spend (the label is mapped to
   * a cost dimension). False on a `raw_metric` grouped by an unmapped label,
   * where every series' `cost` is the whole scope's spend; a surface should
   * draw that spend once rather than once per label.
   */
  costPerLabel?: boolean | undefined;
  series: UnitCostSeries[];
  /** Set when spend currencies were folded together: same shape as a cost query. */
  conversion?: CostConversion;
  /** Buckets in the queried range that produced no value at all (summed across label series). */
  gapBuckets: number;
  /** Buckets whose denominator covers only part of the bucket. */
  partialBuckets: number;
}

/**
 * Turn a cost graph config into the unit-cost query the API expects.
 *
 * The sibling of `costQueryForConfig`, and it carries across exactly the fields
 * that describe the *numerator*: the resolved date range, the binning, the
 * filters, the saved filter, the cost basis. It deliberately drops `groupBy`,
 * `topN`, `comparePreviousPeriod` and `showForecast`: the four options that
 * presuppose a stack of spend series or a projection, neither of which
 * survives being divided by a declared denominator. Grouping here is by a
 * *label* (`unitCostGroupByLabel`), which has its own field because it splits
 * both sides of the ratio at once.
 */
export function unitCostQueryForConfig(
  config: CostGraphConfig,
  today = new Date(),
): UnitCostQueryRequest {
  const { from, to } = resolveCostDateRange(config.dateRange, today);
  const mode = config.unitCostMode;
  return {
    from,
    to,
    binning: config.binning,
    ...(mode ? { mode } : {}),
    ...(config.unitCostScale && config.unitCostScale !== 1 && mode !== "margin"
      ? { scale: config.unitCostScale }
      : {}),
    filters: config.filters,
    ...(config.savedFilterId ? { savedFilterId: config.savedFilterId } : {}),
    ...(config.costBasis ? { costBasis: config.costBasis } : {}),
    ...(config.unitCostLabelFilters &&
    config.unitCostLabelFilters.length > 0 &&
    mode !== "usage_unit_cost"
      ? { labelFilters: config.unitCostLabelFilters }
      : {}),
    ...(config.unitCostGroupByLabel && mode !== "usage_unit_cost"
      ? { groupByLabel: config.unitCostGroupByLabel }
      : {}),
    ...(mode === "usage_unit_cost" && config.unitCostUsageUnit
      ? { usageUnit: config.unitCostUsageUnit }
      : {}),
  };
}

/** True when a cost graph config draws a unit-cost calculation rather than spend. */
export function isUnitCostConfig(config: CostGraphConfig): boolean {
  return Boolean(config.unitCostMetricId) || config.unitCostMode === "usage_unit_cost";
}

/**
 * The unit a value is expressed in, as one short string: "USD per customer",
 * "USD per 1K requests", "%" for a margin, or "1K requests" for a raw metric.
 * Shared so the chart axis, the CLI, the tooltip and the MCP tool all name the
 * same number the same way.
 */
export function unitCostUnitLabel(
  metric: Pick<BusinessMetric, "unit"> | null,
  mode: UnitCostMode,
  currency: string,
  scale: UnitCostScale = 1,
  usageUnit?: string,
): string {
  if (mode === "margin") return "%";
  const unit = mode === "usage_unit_cost" ? usageUnit || "unit" : metric?.unit || "unit";
  if (mode === "raw_metric") return `${scalePrefix(scale)}${unit}`.trim();
  return `${currency} per ${scalePrefix(scale)}${unit}`;
}

/** A label series' display name: the label value, "(no label)" or "Other". */
export function unitCostSeriesLabel(series: UnitCostSeries): string {
  if (!series.label) return series.currency;
  if (series.label.other) return "Other";
  return series.label.value ?? "(no label)";
}

/**
 * A ratio formatted for display, or an em dash for a gap.
 *
 * Unit costs are routinely sub-cent (cost per API request), so this keeps
 * enough significant digits to be useful rather than rounding a real number to
 * `$0.00`, which reads as "free" and is the same lie as rendering a gap as
 * zero.
 */
export function formatUnitCostValue(value: number | null, mode: UnitCostMode): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (mode === "margin") return `${(value * 100).toFixed(1)}%`;
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
  if (mode === "raw_metric") {
    return magnitude >= 100
      ? Math.round(value).toLocaleString("en-US")
      : String(Math.round(value * 100) / 100);
  }
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(2);
  if (magnitude >= 0.01) return value.toFixed(4);
  return value.toPrecision(3);
}

/**
 * The caveat line a unit-cost surface shows under its title, or null when
 * there is nothing to warn about.
 *
 * One function so the web card, the mobile card and the CLI say the same thing:
 * a gap that is explained on one surface and silent on another is exactly how a
 * wrong number gets believed.
 */
export function describeUnitCostCaveats(response: UnitCostQueryResponse): string | null {
  const parts: string[] = [];
  const subject = response.mode === "usage_unit_cost" ? "usage" : "metric value";
  if (response.gapBuckets > 0) {
    parts.push(
      `${response.gapBuckets} ${response.gapBuckets === 1 ? "period has" : "periods have"} ` +
        `no ${subject} (shown as a gap, not zero).`,
    );
  }
  if (response.partialBuckets > 0) {
    parts.push(
      `${response.partialBuckets} ${response.partialBuckets === 1 ? "period is" : "periods are"} ` +
        "only partly reported, so the ratio there reads high.",
    );
  }
  const currencies = new Set(response.series.map((s) => s.currency));
  if (currencies.size > 1) {
    parts.push(
      "Spend spans currencies with no stated rate, so each currency divides the metric on " +
        "its own; the series are not comparable to each other.",
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/* ------------------------------------------------------------------ *
 * Thresholds: standing limits on a unit cost or a margin.
 * ------------------------------------------------------------------ */

/** The calculations a threshold can watch. */
export const UNIT_COST_THRESHOLD_MODES = ["unit_cost", "margin"] as const;
export type UnitCostThresholdMode = (typeof UNIT_COST_THRESHOLD_MODES)[number];

export const UNIT_COST_THRESHOLD_DIRECTIONS = ["above", "below"] as const;
export type UnitCostThresholdDirection = (typeof UNIT_COST_THRESHOLD_DIRECTIONS)[number];

/**
 * "Alert when cost per 1K requests goes above $0.40", or "when margin per
 * customer drops below 30%".
 *
 * Evaluated once a day over the trailing `windowDays` complete days, as one
 * summed ratio per series (the same rule the chart's headline follows), never
 * the worst single day. A series fires once per window end and then stays quiet
 * for a cooldown, like a unit-cost regression.
 *
 * `value` is in the threshold's own terms: currency units per `scale` metric
 * units for `unit_cost` (in the org's display currency when one is set, else
 * per spend currency), and a **percentage** (30 for 30%) for `margin`.
 *
 * `groupByLabel` evaluates the threshold per value of that label (each
 * customer separately), and needs the label to be mapped to a cost dimension.
 */
export interface UnitCostThreshold {
  mode: UnitCostThresholdMode;
  direction: UnitCostThresholdDirection;
  value: number;
  /** Ignored for `margin`. Absent is 1. */
  scale?: UnitCostScale | undefined;
  groupByLabel?: string | undefined;
  /** Trailing complete days the ratio is summed over. Absent is 7. */
  windowDays?: number | undefined;
}

export const DEFAULT_UNIT_COST_THRESHOLD_WINDOW_DAYS = 7;

/** "Cost per 1K request above 0.4 USD over 7 days, per customer". */
export function describeUnitCostThreshold(
  threshold: UnitCostThreshold,
  metric: Pick<BusinessMetric, "unit" | "currency">,
): string {
  const window = threshold.windowDays ?? DEFAULT_UNIT_COST_THRESHOLD_WINDOW_DAYS;
  const per = threshold.groupByLabel ? `, per ${threshold.groupByLabel}` : "";
  if (threshold.mode === "margin") {
    return `Margin ${threshold.direction} ${threshold.value}% over ${window} days${per}`;
  }
  const scale = toUnitCostScale(threshold.scale);
  return (
    `Cost per ${scalePrefix(scale)}${metric.unit || "unit"} ${threshold.direction} ` +
    `${threshold.value}${metric.currency ? ` ${metric.currency}` : ""} over ${window} days${per}`
  );
}

/* ------------------------------------------------------------------ *
 * Fetch helpers: used by mobile and anything else holding a CloudFetch.
 * ------------------------------------------------------------------ */

/** The org's business metrics (`GET /business-metrics`, `costs:read`). */
export async function listBusinessMetrics(
  api: CloudFetch,
  orgId: string,
): Promise<BusinessMetric[]> {
  const res = await api.org<{ metrics: BusinessMetric[] }>(orgId, "/business-metrics");
  return res?.metrics ?? [];
}

/**
 * Run a unit-cost query (`POST /business-metrics/{id}/unit-costs`,
 * `costs:read`). Null when the server answered no content.
 */
export async function queryUnitCosts(
  api: CloudFetch,
  orgId: string,
  metricId: string,
  request: UnitCostQueryRequest,
): Promise<UnitCostQueryResponse | null> {
  return api.org<UnitCostQueryResponse>(
    orgId,
    `/business-metrics/${encodeURIComponent(metricId)}/unit-costs`,
    { method: "POST", body: JSON.stringify(request) },
  );
}

/** A metric's label keys and values (`GET /business-metrics/{id}/labels`). */
export async function listBusinessMetricLabels(
  api: CloudFetch,
  orgId: string,
  metricId: string,
): Promise<BusinessMetricLabelSummary[]> {
  const res = await api.org<{ labels: BusinessMetricLabelSummary[] }>(
    orgId,
    `/business-metrics/${encodeURIComponent(metricId)}/labels`,
  );
  return res?.labels ?? [];
}
