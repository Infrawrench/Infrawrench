/**
 * Business metrics and unit costs — "what does one of the thing we do cost?"
 *
 * Absolute spend answers "are we spending more". It cannot answer "are we
 * spending more *per customer*", which is the question that decides whether a
 * rising bill is growth or waste. A business metric is the denominator: a named
 * daily series the org reports itself (customers, API requests, GB processed,
 * revenue), optionally tied to the slice of spend it divides.
 *
 * Three rules are contractual rather than incidental, and every surface — web,
 * desktop, mobile, the CLI, the MCP tools — has to honour all three:
 *
 * 1. **The ratio is computed at the bucket the caller asked for**, from a summed
 *    numerator and a summed denominator. A daily unit cost averaged over a month
 *    is not the monthly unit cost; on a month where volume moved, the two differ
 *    by more than anyone would tolerate in a finance review.
 * 2. **A missing or non-positive denominator is a gap, never 0 and never ∞.**
 *    A chart that reads 0 on days a metric was not reported will be believed,
 *    and it says the opposite of the truth — "that day was free" instead of
 *    "we do not know". {@link UnitCostPoint.value} is `null` for those buckets
 *    and {@link UnitCostPoint.gap} says which case it was.
 * 3. **Currencies are never merged.** Spend in a currency the org holds no rate
 *    for keeps its own unit-cost series rather than vanishing into another
 *    one's — the same invariant the cost graph already holds, for the same
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
  CostFilter,
  CostGraphConfig,
  UnitCostGraphMode,
} from "./costs";
import type { CloudFetch } from "./fetch";

/* ------------------------------------------------------------------ *
 * The metric definition.
 * ------------------------------------------------------------------ */

/**
 * What a metric's numbers *are*, which decides what can be computed from them.
 *
 * - `count` — a unit-less quantity: customers, requests, GB, orders. Supports
 *   unit cost (spend ÷ count) and nothing else.
 * - `currency` — money the business took in, denominated in the metric's own
 *   {@link BusinessMetric.currency}. Supports unit cost *and* margin.
 *
 * Margin is modelled as a property of the metric rather than as a flag on the
 * query, deliberately. `(revenue − cost) ÷ revenue` is only meaningful when the
 * denominator is money in a known currency: computing it against "requests"
 * subtracts dollars from requests and divides by requests, which type-checks in
 * every language and means nothing. Making the org declare the metric's kind
 * once, at definition time, is what lets every surface refuse the nonsense
 * without each of them re-deriving the rule — and a `currency` metric must
 * carry a currency code, which is the fact the margin computation needs anyway.
 */
export const BUSINESS_METRIC_KINDS = ["count", "currency"] as const;
export type BusinessMetricKind = (typeof BUSINESS_METRIC_KINDS)[number];

export const BUSINESS_METRIC_KIND_LABELS: Record<BusinessMetricKind, string> = {
  count: "Count",
  currency: "Revenue (money)",
};

export const BUSINESS_METRIC_KIND_DESCRIPTIONS: Record<BusinessMetricKind, string> = {
  count: "A quantity — customers, requests, GB processed. Divides spend into a cost per unit.",
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
   * Singular unit label for display — "customer", "request", "GB". Purely a
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
   * (the two are AND-composed), but never widen it — a caller who could drop the
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
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The reported range, or null when the metric has no values at all. A metric
   * with no values is not broken — it was just created — but every unit-cost
   * chart drawn from it is one continuous gap, so the surfaces say so.
   */
  coverage: BusinessMetricCoverage | null;
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
}

/** One reported day (GET /business-metrics/{id}/values). */
export interface BusinessMetricValue {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  value: number;
  /** Where the number came from — for "who wrote this" on a surprising point. */
  source: BusinessMetricValueSource;
  updatedAt: string;
}

/**
 * Who wrote a value. Both paths run the same validator and the same restating
 * upsert; this only exists so a reader can tell a nightly workflow's number
 * from a hand-corrected one.
 */
export const BUSINESS_METRIC_VALUE_SOURCES = ["api", "workflow"] as const;
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
} as const;

/**
 * Keys are lowercase slugs: they are typed into workflows, CLI flags and URLs,
 * and a key that differs from another only by case or by a space is a support
 * ticket waiting to happen.
 */
export const BUSINESS_METRIC_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

export const BUSINESS_METRIC_KEY_HELP =
  "A metric key is a lowercase slug — letters, digits, and _ . - — starting with a letter or " +
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

/* ------------------------------------------------------------------ *
 * The unit-cost query — POST /business-metrics/{id}/unit-costs.
 * ------------------------------------------------------------------ */

/**
 * Which ratio to compute.
 *
 * - `unit_cost` — spend ÷ metric value. Available for every metric.
 * - `margin` — (revenue − spend) ÷ revenue, as a fraction (0.42 is 42%).
 *   Available only for a `currency` metric, and only when the whole numerator
 *   can be expressed in that metric's currency — see {@link UnitCostQueryResponse}.
 */
export const UNIT_COST_MODES = ["unit_cost", "margin"] as const;
export type UnitCostMode = (typeof UNIT_COST_MODES)[number];

/**
 * `CostGraphConfig.unitCostMode` spells the same union out inline to avoid a
 * circular import. This fails the build if the two ever drift apart.
 */
type ModesMatchGraphConfig = UnitCostMode extends UnitCostGraphMode
  ? UnitCostGraphMode extends UnitCostMode
    ? true
    : never
  : never;
export type UnitCostModesMatchGraphConfig = ModesMatchGraphConfig;

export const UNIT_COST_MODE_LABELS: Record<UnitCostMode, string> = {
  unit_cost: "Cost per unit",
  margin: "Margin",
};

export interface UnitCostQueryRequest {
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
  binning: CostBinningId;
  /** Absent is `unit_cost`. */
  mode?: UnitCostMode | undefined;
  /**
   * Extra filters AND-composed with the metric's own `costScope` — narrowing
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
   * Ignored for `margin`, which always converts to the metric's own currency —
   * subtracting spend from revenue is only defined in one currency.
   */
  displayCurrency?: string | undefined;
}

/**
 * Why a bucket has no ratio. Never rendered as a number by any surface — a gap
 * is drawn as a gap and explained in words.
 */
export const UNIT_COST_GAP_REASONS = [
  "no_metric_value",
  "non_positive_metric_value",
  "unconvertible_currency",
] as const;
export type UnitCostGapReason = (typeof UNIT_COST_GAP_REASONS)[number];

export const UNIT_COST_GAP_REASON_LABELS: Record<UnitCostGapReason, string> = {
  no_metric_value: "No metric value reported",
  non_positive_metric_value: "Metric value was zero or negative",
  unconvertible_currency: "Spend in a currency with no rate to the metric's currency",
};

/**
 * One bucket of a unit-cost series.
 *
 * `value` is `null` for a gap and only for a gap: a real 0 is possible and
 * meaningful (spend of nothing over a positive denominator genuinely costs
 * nothing per unit), so the two must stay distinguishable. `cost` and
 * `metricValue` carry the numerator and denominator that produced the ratio so
 * a reader can check the arithmetic without a second query — and so a tooltip
 * can say "$1,240 ÷ 310 customers" rather than only the quotient.
 */
export interface UnitCostPoint {
  /** Bucket start date, YYYY-MM-DD. */
  bucket: string;
  /** The ratio, or null when this bucket is a gap. Never ±Infinity, never NaN. */
  value: number | null;
  /** Spend summed over the bucket, in `UnitCostSeries.currency`. */
  cost: number;
  /** Metric value summed over the bucket, or null when nothing was reported. */
  metricValue: number | null;
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
   * quotient looks wrong. The point is still computed — discarding six days of
   * real data would be its own distortion — but every surface flags it, and
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
 * One unit-cost series, in one currency.
 *
 * There is one series per currency the numerator ended up in — usually exactly
 * one. More than one means the org has spend in a currency it holds no rate
 * for, and rather than dropping that spend (understating every unit cost) or
 * adding euros to dollars (inventing a number), each currency divides the same
 * denominator on its own.
 */
export interface UnitCostSeries {
  /** ISO-4217 code the numerator — and therefore the ratio — is expressed in. */
  currency: string;
  points: UnitCostPoint[];
  /**
   * The period ratio: **summed numerator ÷ summed denominator** across every
   * bucket, not the mean of the per-bucket ratios. The two differ whenever
   * volume moves, and the mean is the wrong one — it weights a quiet Sunday the
   * same as a peak Monday.
   *
   * Null when nothing in the range had a usable denominator.
   */
  overallValue: number | null;
  /** Numerator and denominator behind `overallValue`. */
  overallCost: number;
  overallMetricValue: number | null;
}

export interface UnitCostQueryResponse {
  /** The metric this was divided by, so a client needs no second fetch. */
  metric: Pick<BusinessMetric, "id" | "key" | "name" | "unit" | "kind" | "currency">;
  mode: UnitCostMode;
  binning: CostBinningId;
  series: UnitCostSeries[];
  /** Set when spend currencies were folded together — same shape as a cost query. */
  conversion?: CostConversion;
  /** Buckets in the queried range that produced no ratio at all. */
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
 * `topN`, `comparePreviousPeriod` and `showForecast` — the four options that
 * presuppose a stack of series or a projection, neither of which survives being
 * divided by a single declared denominator. Dropping them here, in one shared
 * place, is what stops each surface from inventing its own answer to "what does
 * top-5 mean for a ratio".
 */
export function unitCostQueryForConfig(
  config: CostGraphConfig,
  today = new Date(),
): UnitCostQueryRequest {
  const { from, to } = resolveCostDateRange(config.dateRange, today);
  return {
    from,
    to,
    binning: config.binning,
    ...(config.unitCostMode ? { mode: config.unitCostMode } : {}),
    filters: config.filters,
    ...(config.savedFilterId ? { savedFilterId: config.savedFilterId } : {}),
    ...(config.costBasis ? { costBasis: config.costBasis } : {}),
  };
}

/**
 * The unit a ratio is expressed in, as one short string: "USD per customer",
 * or "%" for a margin. Shared so the chart axis, the CLI, the tooltip and the
 * MCP tool all name the same number the same way.
 */
export function unitCostUnitLabel(
  metric: Pick<BusinessMetric, "unit">,
  mode: UnitCostMode,
  currency: string,
): string {
  if (mode === "margin") return "%";
  return `${currency} per ${metric.unit || "unit"}`;
}

/**
 * A ratio formatted for display, or an em dash for a gap.
 *
 * Unit costs are routinely sub-cent (cost per API request), so this keeps
 * enough significant digits to be useful rather than rounding a real number to
 * `$0.00` — which reads as "free" and is the same lie as rendering a gap as
 * zero.
 */
export function formatUnitCostValue(value: number | null, mode: UnitCostMode): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (mode === "margin") return `${(value * 100).toFixed(1)}%`;
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
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
  if (response.gapBuckets > 0) {
    parts.push(
      `${response.gapBuckets} ${response.gapBuckets === 1 ? "period has" : "periods have"} ` +
        "no metric value — shown as a gap, not as zero.",
    );
  }
  if (response.partialBuckets > 0) {
    parts.push(
      `${response.partialBuckets} ${response.partialBuckets === 1 ? "period is" : "periods are"} ` +
        "only partly reported, so the ratio there reads high.",
    );
  }
  if (response.series.length > 1) {
    parts.push(
      "Spend spans currencies with no stated rate, so each currency divides the metric on " +
        "its own — the series are not comparable to each other.",
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/* ------------------------------------------------------------------ *
 * Fetch helpers — used by mobile and anything else holding a CloudFetch.
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
