/**
 * Commitment reports: saved, re-runnable views of how an org's reservations,
 * savings plans and committed-use discounts performed over time.
 *
 * The `GET /commitments` feed answers "how are we doing right now" over one
 * fixed trailing window. A commitment report answers "how did we do, per
 * week, for these accounts, split by service", and keeps the question under a
 * name so it can be re-run, shared and filed beside cost reports.
 *
 * This module is the contract (types, limits, validation) and every piece of
 * arithmetic a surface could get wrong: the metric definitions, the bucket
 * assembly, and the CSV writer. The server, the web and desktop UI, the CLI
 * and mobile all import it, so a metric means the same thing everywhere.
 *
 * ─── Where the inputs come from ───────────────────────────────────────────
 *
 * Everything is read from ingested cost rows on the **amortized** basis, the
 * same basis the feed's coverage and utilization use and for the same reason:
 * on a cash basis, usage a commitment covered is priced at zero by AWS and
 * Azure, so every ratio below would be structurally zero. Per bucket and
 * group the server sums five amounts (see {@link CommitmentReportTotals}):
 *
 * - **covered**: amortized consumption a commitment covered (charge type
 *   `commitment_covered_usage`, or a row stamped with a commitment id). This is
 *   the commitment's money that bought something: the *used* commitment cost.
 * - **unused**: the amortized amount of `commitment_fee` rows whose provider
 *   reported an amortized figure. On that basis a purchase amortizes to zero
 *   (its value is spread over the covered usage), so what is left on a fee row
 *   is the committed spend no usage absorbed: AWS's amortized `RIFee` and
 *   `SavingsPlanRecurringFee`, Azure's `UnusedReservation` and
 *   `UnusedSavingsPlan`. Fee rows *without* a reported amortized amount are
 *   left out: their cash amount is a purchase, not waste.
 * - **uncovered**: amortized consumption no commitment touched: the on-demand
 *   remainder. On demand, amortized equals cash.
 * - **coveredOnDemand / coveredMeasured**: for covered rows whose provider
 *   reported an on-demand equivalent (`CostRow.onDemandAmount`), that
 *   equivalent and the same rows' amortized amount. Covered rows without one
 *   count as having saved nothing; savings are never estimated from list
 *   discounts.
 *
 * ─── Metric definitions (also in the docs page) ────────────────────────────
 *
 *     used               = covered
 *     unused             = unused
 *     commitmentCost     = used + unused
 *     onDemandRemainder  = uncovered
 *     coverage           = covered ÷ (coveredAll + uncovered)
 *     eligibleCoverage   = covered ÷ (coveredAll + uncoveredEligible)
 *     utilization        = used ÷ (used + unused)
 *     onDemandEquivalent = coveredOnDemand + (covered − coveredMeasured)
 *     netSavings         = (coveredOnDemand − coveredMeasured) − unused
 *     effectiveSavingsRate = netSavings ÷ (onDemandEquivalent + uncovered)
 *
 * `coveredAll` differs from `covered` only under a commitment filter: the
 * denominator keeps usage other commitments covered, so "share of usage this
 * savings plan covers" stays a share of all usage. `uncoveredEligible` is
 * uncovered usage in (provider, service, region) cells that had any covered
 * usage in the report window: coverage is a range, exactly as in the feed,
 * and `eligibleCoverage` is its upper bound.
 *
 * A ratio with a non-positive denominator is `null`, never 0: "nothing to
 * measure" and "measured nothing" must not print the same. Net savings is
 * `null` when there was covered usage and none of it had an on-demand
 * equivalent, and the effective savings rate inherits that.
 */
import type { CommitmentKind } from "@infrawrench/plugin-base";

import type { CostDateRange, CostRangePreset } from "./costs";
import { COST_RANGE_PRESETS } from "./costs";
import type { CloudFetch } from "./fetch";

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * Every metric a report computes. All of them are in every table row; the
 * config's `metric` only picks the one the chart draws.
 */
export const COMMITMENT_REPORT_METRICS = [
  "coverage",
  "eligibleCoverage",
  "utilization",
  "effectiveSavingsRate",
  "netSavings",
  "onDemandRemainder",
  "commitmentCost",
  "usedCommitmentCost",
  "unusedCommitmentCost",
] as const;
export type CommitmentReportMetric = (typeof COMMITMENT_REPORT_METRICS)[number];

/** Metrics that are ratios (0 to 1, rendered as %); the rest are money. */
export const COMMITMENT_REPORT_RATIO_METRICS: ReadonlySet<CommitmentReportMetric> = new Set([
  "coverage",
  "eligibleCoverage",
  "utilization",
  "effectiveSavingsRate",
]);

export function isCommitmentRatioMetric(metric: CommitmentReportMetric): boolean {
  return COMMITMENT_REPORT_RATIO_METRICS.has(metric);
}

/** English labels; UI surfaces translate them (`useDataString`), the CLI prints them. */
export const COMMITMENT_REPORT_METRIC_LABELS: Record<CommitmentReportMetric, string> = {
  coverage: "Coverage",
  eligibleCoverage: "Coverage of eligible usage",
  utilization: "Utilization",
  effectiveSavingsRate: "Effective savings rate",
  netSavings: "Net savings vs on-demand",
  onDemandRemainder: "On-demand remainder",
  commitmentCost: "Commitment cost",
  usedCommitmentCost: "Used commitment cost",
  unusedCommitmentCost: "Unused commitment cost",
};

/**
 * Bucket sizes. **No hourly**: spend is stored one row per UTC day (the
 * plugin contract's `CostRow.date` is a day), so an hourly bucket would put
 * each day's spend at midnight and draw 23 empty hours. The ids match the
 * cost graphs' `CostBinningId`, so the same label helpers apply.
 */
export const COMMITMENT_REPORT_GRANULARITIES = ["daily", "weekly", "monthly", "quarterly"] as const;
export type CommitmentReportGranularity = (typeof COMMITMENT_REPORT_GRANULARITIES)[number];

/**
 * What a report can split by. `commitment_type` and `commitment` are
 * *commitment* dimensions: they partition the commitment side (covered usage
 * and unused fees) by holding, and put uncovered usage in its own
 * {@link COMMITMENT_REPORT_ON_DEMAND_KEY} group. The rest partition every row.
 *
 * Instance family is deliberately absent: no collector stores it on cost rows
 * (Cost Explorer's `INSTANCE_TYPE_FAMILY` is not requested), so a split by it
 * could only be invented. The inventory shows each holding's own scope.
 */
export const COMMITMENT_REPORT_GROUP_BYS = [
  "none",
  "provider",
  "commitment_type",
  "commitment",
  "service",
  "account",
  "region",
] as const;
export type CommitmentReportGroupBy = (typeof COMMITMENT_REPORT_GROUP_BYS)[number];

export const COMMITMENT_REPORT_GROUP_BY_LABELS: Record<CommitmentReportGroupBy, string> = {
  none: "No grouping",
  provider: "Provider",
  commitment_type: "Commitment type",
  commitment: "Commitment",
  service: "Service",
  account: "Account",
  region: "Region",
};

export const COMMITMENT_REPORT_GRANULARITY_LABELS: Record<CommitmentReportGranularity, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
};

export const COMMITMENT_KIND_LABELS: Record<CommitmentKind, string> = {
  reservation: "Reservations",
  savings_plan: "Savings plans",
  committed_use: "Committed-use discounts",
};

export function isCommitmentReportGroupByCommitment(groupBy: CommitmentReportGroupBy): boolean {
  return groupBy === "commitment" || groupBy === "commitment_type";
}

/** Group key of uncovered usage under a commitment grouping. */
export const COMMITMENT_REPORT_ON_DEMAND_KEY = "__on_demand__";
/**
 * Group key of covered usage (or an unused fee) the provider did not tie to a
 * specific commitment. AWS's Cost Explorer cannot group by
 * `SAVINGS_PLAN_ARN` / `RESERVATION_ID`, so all of AWS lands here under a
 * commitment grouping: shown, labelled, never guessed at.
 */
export const COMMITMENT_REPORT_UNATTRIBUTED_KEY = "__unattributed__";
/** Group key of a commitment id the inventory does not (or no longer) hold. */
export const COMMITMENT_REPORT_UNKNOWN_KIND_KEY = "__unknown_kind__";

/* ------------------------------------------------------------------ *
 * Saved report
 * ------------------------------------------------------------------ */

export const COMMITMENT_REPORT_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  /** Values per filter list. */
  maxFilterValues: 200,
  /** Longest window any report may cover, in days (three years). */
  maxRangeDays: 1096,
  /** Longest window a daily report may cover: a year plus a leap day. */
  maxDailyRangeDays: 366,
} as const;

/**
 * Filters, every list AND-composed with the others and OR within itself.
 * An absent or empty list does not filter.
 *
 * `commitmentTypes` and `commitmentIds` narrow the commitment side only: the
 * covered usage and unused fees counted are those of the selected holdings,
 * while uncovered usage stays in, because it is the rest of the coverage
 * denominator. Covered usage with no commitment id (all of AWS) matches no
 * commitment filter.
 */
export interface CommitmentReportFilters {
  /** Plugin ids: `aws`, `azure`, `gcp`. */
  providers?: string[];
  commitmentTypes?: CommitmentKind[];
  services?: string[];
  accountIds?: string[];
  regions?: string[];
  /** Provider-native commitment ids, as the inventory lists them. */
  commitmentIds?: string[];
}

export interface CommitmentReportConfig {
  version: 1;
  dateRange: CostDateRange;
  granularity: CommitmentReportGranularity;
  groupBy: CommitmentReportGroupBy;
  filters: CommitmentReportFilters;
  /** The metric the chart draws; the table always carries every metric. */
  metric: CommitmentReportMetric;
}

export const DEFAULT_COMMITMENT_REPORT_CONFIG: CommitmentReportConfig = {
  version: 1,
  dateRange: { kind: "relative", preset: "90d" },
  granularity: "weekly",
  groupBy: "none",
  filters: {},
  metric: "coverage",
};

export interface CommitmentReportInput {
  name: string;
  description?: string | null;
  config: CommitmentReportConfig;
  /** A report folder (the same tree cost reports live in); null is the top level. */
  folderId?: string | null;
}

export interface CommitmentReport {
  id: string;
  name: string;
  description: string | null;
  config: CommitmentReportConfig;
  folderId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}

/** Inclusive day count of an ISO range (1 for a single day). */
export function commitmentReportRangeDays(from: string, to: string): number {
  return (
    Math.round(
      (new Date(`${to}T00:00:00Z`).valueOf() - new Date(`${from}T00:00:00Z`).valueOf()) / DAY_MS,
    ) + 1
  );
}

export type CommitmentReportValidation<T> = { ok: true; value: T } | { ok: false; error: string };

function stringList(
  raw: unknown,
  field: string,
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: `filters.${field} must be a list.` };
  if (raw.length > COMMITMENT_REPORT_LIMITS.maxFilterValues) {
    return {
      ok: false,
      error: `filters.${field} takes at most ${COMMITMENT_REPORT_LIMITS.maxFilterValues} values.`,
    };
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.trim() === "") {
      return { ok: false, error: `filters.${field} must contain non-empty strings.` };
    }
    if (!out.includes(v)) out.push(v);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

const COMMITMENT_KINDS: readonly CommitmentKind[] = [
  "reservation",
  "savings_plan",
  "committed_use",
];

/**
 * Parse and normalize a config from untrusted JSON. Unknown keys are refused
 * rather than dropped, so a typo in a Terraform or API body is an error and
 * not a silently different report. Range limits are checked here for
 * absolute ranges; a relative preset is checked against its resolved range
 * when the report runs.
 */
export function normalizeCommitmentReportConfig(
  raw: unknown,
): CommitmentReportValidation<CommitmentReportConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config must be an object." };
  }
  const c = raw as Record<string, unknown>;
  const allowed = new Set(["version", "dateRange", "granularity", "groupBy", "filters", "metric"]);
  const unknown = Object.keys(c).find((k) => !allowed.has(k));
  if (unknown) return { ok: false, error: `Unknown config field "${unknown}".` };
  if (c["version"] !== 1) return { ok: false, error: "config.version must be 1." };

  const range = c["dateRange"] as Record<string, unknown> | undefined;
  let dateRange: CostDateRange;
  if (!range || typeof range !== "object") {
    return { ok: false, error: "config.dateRange is required." };
  } else if (range["kind"] === "relative") {
    if (!COST_RANGE_PRESETS.includes(range["preset"] as CostRangePreset)) {
      return {
        ok: false,
        error: `config.dateRange.preset must be one of ${COST_RANGE_PRESETS.join(", ")}.`,
      };
    }
    dateRange = { kind: "relative", preset: range["preset"] as CostRangePreset };
  } else if (range["kind"] === "absolute") {
    const from = range["from"];
    const to = range["to"];
    if (!isIsoDay(from) || !isIsoDay(to)) {
      return { ok: false, error: "config.dateRange.from and .to must be YYYY-MM-DD days." };
    }
    if (from > to) return { ok: false, error: "config.dateRange.from must not be after .to." };
    dateRange = { kind: "absolute", from, to };
  } else {
    return { ok: false, error: 'config.dateRange.kind must be "relative" or "absolute".' };
  }

  const granularity = c["granularity"];
  if (!COMMITMENT_REPORT_GRANULARITIES.includes(granularity as CommitmentReportGranularity)) {
    return {
      ok: false,
      error:
        granularity === "hourly"
          ? "Hourly is not available: spend is collected one row per day, so an hourly bucket would be invented."
          : `config.granularity must be one of ${COMMITMENT_REPORT_GRANULARITIES.join(", ")}.`,
    };
  }
  const groupBy = c["groupBy"] ?? "none";
  if (!COMMITMENT_REPORT_GROUP_BYS.includes(groupBy as CommitmentReportGroupBy)) {
    return {
      ok: false,
      error: `config.groupBy must be one of ${COMMITMENT_REPORT_GROUP_BYS.join(", ")}.`,
    };
  }
  const metric = c["metric"] ?? "coverage";
  if (!COMMITMENT_REPORT_METRICS.includes(metric as CommitmentReportMetric)) {
    return {
      ok: false,
      error: `config.metric must be one of ${COMMITMENT_REPORT_METRICS.join(", ")}.`,
    };
  }

  const rawFilters = c["filters"] ?? {};
  if (typeof rawFilters !== "object" || Array.isArray(rawFilters) || rawFilters === null) {
    return { ok: false, error: "config.filters must be an object." };
  }
  const f = rawFilters as Record<string, unknown>;
  const filterKeys = [
    "providers",
    "commitmentTypes",
    "services",
    "accountIds",
    "regions",
    "commitmentIds",
  ] as const;
  const unknownFilter = Object.keys(f).find((k) => !(filterKeys as readonly string[]).includes(k));
  if (unknownFilter) return { ok: false, error: `Unknown filter "${unknownFilter}".` };
  const filters: CommitmentReportFilters = {};
  for (const key of filterKeys) {
    const parsed = stringList(f[key], key);
    if (!parsed.ok) return parsed;
    if (parsed.value) filters[key] = parsed.value as CommitmentKind[] & string[];
  }
  if (filters.commitmentTypes?.some((k) => !COMMITMENT_KINDS.includes(k))) {
    return {
      ok: false,
      error: `filters.commitmentTypes must contain ${COMMITMENT_KINDS.join(", ")}.`,
    };
  }

  const config: CommitmentReportConfig = {
    version: 1,
    dateRange,
    granularity: granularity as CommitmentReportGranularity,
    groupBy: groupBy as CommitmentReportGroupBy,
    filters,
    metric: metric as CommitmentReportMetric,
  };
  if (dateRange.kind === "absolute") {
    const problem = commitmentReportRangeProblem(dateRange.from, dateRange.to, config.granularity);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, value: config };
}

/** Why a resolved window cannot run at this granularity, or null when it can. */
export function commitmentReportRangeProblem(
  from: string,
  to: string,
  granularity: CommitmentReportGranularity,
): string | null {
  const days = commitmentReportRangeDays(from, to);
  if (days > COMMITMENT_REPORT_LIMITS.maxRangeDays) {
    return `A report covers at most ${COMMITMENT_REPORT_LIMITS.maxRangeDays} days.`;
  }
  if (granularity === "daily" && days > COMMITMENT_REPORT_LIMITS.maxDailyRangeDays) {
    return `A daily report covers at most ${COMMITMENT_REPORT_LIMITS.maxDailyRangeDays} days; use weekly or monthly for longer windows.`;
  }
  return null;
}

/** Parse and normalize a create/update body. */
export function normalizeCommitmentReportInput(
  raw: unknown,
): CommitmentReportValidation<CommitmentReportInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Expected a JSON object." };
  }
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).find(
    (k) => !["name", "description", "config", "folderId"].includes(k),
  );
  if (unknown) return { ok: false, error: `Unknown field "${unknown}".` };
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (!name) return { ok: false, error: "name is required." };
  if (name.length > COMMITMENT_REPORT_LIMITS.maxNameLength) {
    return {
      ok: false,
      error: `name is at most ${COMMITMENT_REPORT_LIMITS.maxNameLength} characters.`,
    };
  }
  const rawDescription = body["description"];
  if (
    rawDescription !== undefined &&
    rawDescription !== null &&
    typeof rawDescription !== "string"
  ) {
    return { ok: false, error: "description must be a string." };
  }
  const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
  if (description.length > COMMITMENT_REPORT_LIMITS.maxDescriptionLength) {
    return {
      ok: false,
      error: `description is at most ${COMMITMENT_REPORT_LIMITS.maxDescriptionLength} characters.`,
    };
  }
  const folderId = body["folderId"];
  if (folderId !== undefined && folderId !== null && typeof folderId !== "string") {
    return { ok: false, error: "folderId must be a string or null." };
  }
  const config = normalizeCommitmentReportConfig(body["config"]);
  if (!config.ok) return config;
  return {
    ok: true,
    value: {
      name,
      description: description || null,
      config: config.value,
      folderId: folderId ? folderId : null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/** The summed amortized inputs of one bucket of one group (see the module header). */
export interface CommitmentReportTotals {
  /** Covered consumption of the selected commitments: used commitment cost. */
  covered: number;
  /** Covered consumption of any commitment: the coverage denominator's covered half. */
  coveredAll: number;
  /** Unused commitment fees of the selected commitments. */
  unused: number;
  /** Uncovered consumption: the on-demand remainder. */
  uncovered: number;
  /** Uncovered consumption in cells a commitment covered at some point in the window. */
  uncoveredEligible: number;
  /** Σ reported on-demand equivalent of covered rows that have one. */
  coveredOnDemand: number;
  /** Σ amortized amount of those same rows. */
  coveredMeasured: number;
}

export function emptyCommitmentReportTotals(): CommitmentReportTotals {
  return {
    covered: 0,
    coveredAll: 0,
    unused: 0,
    uncovered: 0,
    uncoveredEligible: 0,
    coveredOnDemand: 0,
    coveredMeasured: 0,
  };
}

export function addCommitmentReportTotals(
  into: CommitmentReportTotals,
  add: CommitmentReportTotals,
): CommitmentReportTotals {
  into.covered += add.covered;
  into.coveredAll += add.coveredAll;
  into.unused += add.unused;
  into.uncovered += add.uncovered;
  into.uncoveredEligible += add.uncoveredEligible;
  into.coveredOnDemand += add.coveredOnDemand;
  into.coveredMeasured += add.coveredMeasured;
  return into;
}

/** Every metric, computed from one totals record. Money in the series currency. */
export interface CommitmentReportMetricValues {
  coverage: number | null;
  eligibleCoverage: number | null;
  utilization: number | null;
  effectiveSavingsRate: number | null;
  netSavings: number | null;
  onDemandRemainder: number;
  commitmentCost: number;
  usedCommitmentCost: number;
  unusedCommitmentCost: number;
  /** What the covered usage would have cost on demand (unmeasured rows at cost). */
  onDemandEquivalent: number;
  /** Share of covered spend whose on-demand equivalent the provider reported; null without covered spend. */
  savingsMeasuredShare: number | null;
}

/**
 * Denominators for the coverage ratios when they are not the group's own.
 * Under a commitment grouping each group is a slice of one bucket's usage, so
 * its coverage is its covered amount over the *bucket's* usage: the groups'
 * coverages then add up to the bucket's.
 */
export interface CommitmentCoverageBase {
  usage: number;
  eligibleUsage: number;
}

/** Floating-point dust below this is zero for ratio denominators. */
const EPSILON = 1e-9;

function ratio(numerator: number, denominator: number): number | null {
  return denominator > EPSILON ? numerator / denominator : null;
}

/**
 * The metric definitions. Pure; the single implementation every surface uses.
 * See the module header for each formula and why it is shaped that way.
 */
export function computeCommitmentReportMetrics(
  t: CommitmentReportTotals,
  coverageBase?: CommitmentCoverageBase,
): CommitmentReportMetricValues {
  const usage = coverageBase ? coverageBase.usage : t.coveredAll + t.uncovered;
  const eligibleUsage = coverageBase
    ? coverageBase.eligibleUsage
    : t.coveredAll + t.uncoveredEligible;
  const commitmentCost = t.covered + t.unused;
  const unmeasured = t.covered - t.coveredMeasured;
  const onDemandEquivalent = t.coveredOnDemand + unmeasured;
  const hasCovered = Math.abs(t.covered) > EPSILON;
  const savingsMeasuredShare = hasCovered ? t.coveredMeasured / t.covered : null;
  // Covered usage with no on-demand equivalent at all: the saving is unknown,
  // and "unknown" must not print as "lost the unused fee".
  const netSavings =
    hasCovered && Math.abs(t.coveredMeasured) <= EPSILON
      ? null
      : t.coveredOnDemand - t.coveredMeasured - t.unused;
  return {
    coverage: ratio(t.covered, usage),
    eligibleCoverage: ratio(t.covered, eligibleUsage),
    utilization: ratio(t.covered, commitmentCost),
    effectiveSavingsRate:
      netSavings === null ? null : ratio(netSavings, onDemandEquivalent + t.uncovered),
    netSavings,
    onDemandRemainder: t.uncovered,
    commitmentCost,
    usedCommitmentCost: t.covered,
    unusedCommitmentCost: t.unused,
    onDemandEquivalent,
    savingsMeasuredShare,
  };
}

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

/**
 * One aggregate the server's query returns: a bucket of a group in a
 * currency. Groups under a commitment grouping are already resolved to their
 * final key (a commitment id, a kind, or a sentinel).
 */
export interface CommitmentReportCell extends CommitmentReportTotals {
  bucket: string;
  groupKey: string;
  currency: string;
}

export interface CommitmentReportPoint {
  bucket: string;
  totals: CommitmentReportTotals;
  metrics: CommitmentReportMetricValues;
}

export interface CommitmentReportSeries {
  /** Group key (`""` without grouping) plus currency: unique within a result. */
  id: string;
  groupKey: string;
  /** Human label from the server (an account name, a holding's description). */
  label: string;
  currency: string;
  points: CommitmentReportPoint[];
  total: { totals: CommitmentReportTotals; metrics: CommitmentReportMetricValues };
}

/**
 * What a provider in scope can contribute. `measured`: cost rows distinguish
 * covered usage, so every metric is computed. `inventory_only`: holdings are
 * collected but cost rows carry no coverage signal (GCP today: its collector
 * declares no charge types), so the provider is left out of every metric
 * rather than read as 0% covered.
 */
export interface CommitmentReportProvider {
  pluginId: string;
  displayName: string;
  status: "measured" | "inventory_only";
  accountCount: number;
}

export type CommitmentReportNotice =
  /** AWS lands a month's unused commitment fee on the 1st (or the purchase day) in daily data. */
  | "unused_lumped_monthly"
  /** Covered usage the provider could not tie to a commitment is in the Unattributed group. */
  | "unattributed_commitment_usage"
  /** Some covered usage had no on-demand equivalent; savings treat it as saving nothing. */
  | "partial_savings_measurement"
  /** No account in scope can measure coverage at all. */
  | "no_measurable_accounts";

export interface CommitmentReportResult {
  from: string;
  to: string;
  granularity: CommitmentReportGranularity;
  groupBy: CommitmentReportGroupBy;
  /** Every bucket start in the window, gaps included, ascending. */
  buckets: string[];
  /** One per group and currency, largest commitment cost first. */
  series: CommitmentReportSeries[];
  /** All groups combined, one per currency: the report's headline. */
  overall: CommitmentReportSeries[];
  providers: CommitmentReportProvider[];
  notices: CommitmentReportNotice[];
}

/** A run of a saved report: the result plus which report it was. */
export interface CommitmentReportRunResult extends CommitmentReportResult {
  reportId: string;
  name: string;
}

/** Picker values for the editor, all scoped to what the caller may see. */
export interface CommitmentReportOptions {
  providers: Array<{
    pluginId: string;
    displayName: string;
    status: "measured" | "inventory_only";
  }>;
  accounts: Array<{ id: string; name: string; pluginId: string }>;
  services: string[];
  regions: string[];
  commitments: Array<{
    commitmentId: string;
    accountId: string;
    pluginId: string;
    kind: CommitmentKind;
    description: string;
    state: string;
  }>;
}

/** The start (ISO day) of the bucket a day falls in. Weeks start on Monday. */
export function commitmentReportBucketOf(
  day: string,
  granularity: CommitmentReportGranularity,
): string {
  if (granularity === "daily") return day;
  const d = new Date(`${day}T00:00:00Z`);
  if (granularity === "weekly") {
    const dow = (d.getUTCDay() + 6) % 7;
    return new Date(d.valueOf() - dow * DAY_MS).toISOString().slice(0, 10);
  }
  const month = granularity === "monthly" ? d.getUTCMonth() : Math.floor(d.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(d.getUTCFullYear(), month, 1)).toISOString().slice(0, 10);
}

/** Every bucket start from the bucket holding `from` to the one holding `to`. */
export function commitmentReportBuckets(
  from: string,
  to: string,
  granularity: CommitmentReportGranularity,
): string[] {
  const out: string[] = [];
  const last = commitmentReportBucketOf(to, granularity);
  let cur = commitmentReportBucketOf(from, granularity);
  while (cur <= last) {
    out.push(cur);
    const d = new Date(`${cur}T00:00:00Z`);
    if (granularity === "daily") d.setUTCDate(d.getUTCDate() + 1);
    else if (granularity === "weekly") d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + (granularity === "monthly" ? 1 : 3));
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}

export interface BuildCommitmentReportContext {
  from: string;
  to: string;
  granularity: CommitmentReportGranularity;
  groupBy: CommitmentReportGroupBy;
  /** Label per group key; absent keys fall back to the key itself. */
  labels?: ReadonlyMap<string, string>;
  providers?: CommitmentReportProvider[];
  notices?: CommitmentReportNotice[];
}

function seriesFrom(
  groupKey: string,
  currency: string,
  label: string,
  buckets: readonly string[],
  byBucket: ReadonlyMap<string, CommitmentReportTotals>,
  bases: ReadonlyMap<string, CommitmentCoverageBase> | null,
  totalBase: CommitmentCoverageBase | null,
): CommitmentReportSeries {
  const total = emptyCommitmentReportTotals();
  const points = buckets.map((bucket) => {
    const totals = { ...(byBucket.get(bucket) ?? emptyCommitmentReportTotals()) };
    addCommitmentReportTotals(total, totals);
    const base = bases?.get(`${bucket}\u0000${currency}`);
    return { bucket, totals, metrics: computeCommitmentReportMetrics(totals, base) };
  });
  return {
    id: `${groupKey}\u0000${currency}`,
    groupKey,
    label,
    currency,
    points,
    total: {
      totals: total,
      metrics: computeCommitmentReportMetrics(total, totalBase ?? undefined),
    },
  };
}

/**
 * Assemble cells into series. Pure: the server calls it after its query, and
 * tests call it directly. Every bucket of the window appears in every series
 * (an empty bucket has zero money and null ratios). Under a commitment
 * grouping the coverage ratios use the bucket's whole usage as denominator,
 * and groups with no activity of their own (an unselected commitment that
 * only contributed to that denominator) are dropped.
 */
export function buildCommitmentReport(
  cells: readonly CommitmentReportCell[],
  ctx: BuildCommitmentReportContext,
): CommitmentReportResult {
  const buckets = commitmentReportBuckets(ctx.from, ctx.to, ctx.granularity);
  const byGroup = new Map<string, Map<string, CommitmentReportTotals>>();
  const overallByCurrency = new Map<string, Map<string, CommitmentReportTotals>>();
  const groupMeta = new Map<string, { groupKey: string; currency: string }>();

  for (const cell of cells) {
    const bucket = commitmentReportBucketOf(cell.bucket, ctx.granularity);
    const id = `${cell.groupKey}\u0000${cell.currency}`;
    groupMeta.set(id, { groupKey: cell.groupKey, currency: cell.currency });
    for (const [map, key] of [
      [byGroup, id],
      [overallByCurrency, cell.currency],
    ] as const) {
      let perBucket = map.get(key);
      if (!perBucket) {
        perBucket = new Map();
        map.set(key, perBucket);
      }
      const t = perBucket.get(bucket) ?? emptyCommitmentReportTotals();
      addCommitmentReportTotals(t, cell);
      perBucket.set(bucket, t);
    }
  }

  const commitmentGrouping = isCommitmentReportGroupByCommitment(ctx.groupBy);
  // Bucket-level coverage denominators, for a commitment grouping.
  let bases: Map<string, CommitmentCoverageBase> | null = null;
  const totalBases = new Map<string, CommitmentCoverageBase>();
  if (commitmentGrouping) {
    bases = new Map();
    for (const [currency, perBucket] of overallByCurrency) {
      const totalBase = { usage: 0, eligibleUsage: 0 };
      for (const [bucket, t] of perBucket) {
        const base = {
          usage: t.coveredAll + t.uncovered,
          eligibleUsage: t.coveredAll + t.uncoveredEligible,
        };
        bases.set(`${bucket}\u0000${currency}`, base);
        totalBase.usage += base.usage;
        totalBase.eligibleUsage += base.eligibleUsage;
      }
      totalBases.set(currency, totalBase);
    }
  }

  const series: CommitmentReportSeries[] = [];
  for (const [id, perBucket] of byGroup) {
    const meta = groupMeta.get(id)!;
    const s = seriesFrom(
      meta.groupKey,
      meta.currency,
      ctx.labels?.get(meta.groupKey) ?? meta.groupKey,
      buckets,
      perBucket,
      bases,
      totalBases.get(meta.currency) ?? null,
    );
    if (commitmentGrouping && meta.groupKey !== COMMITMENT_REPORT_ON_DEMAND_KEY) {
      const t = s.total.totals;
      if (Math.abs(t.covered) <= EPSILON && Math.abs(t.unused) <= EPSILON) continue;
    }
    series.push(s);
  }
  // Biggest commitment first, then the on-demand remainder, then by label:
  // the reader's eye goes to the holding that costs the most.
  series.sort(
    (a, b) =>
      b.total.metrics.commitmentCost - a.total.metrics.commitmentCost ||
      b.total.metrics.onDemandRemainder - a.total.metrics.onDemandRemainder ||
      a.label.localeCompare(b.label),
  );

  const overall = [...overallByCurrency.entries()]
    .map(([currency, perBucket]) =>
      seriesFrom("", currency, currency, buckets, perBucket, null, null),
    )
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const notices = [...(ctx.notices ?? [])];
  const unattributed = series.some(
    (s) =>
      s.groupKey === COMMITMENT_REPORT_UNATTRIBUTED_KEY &&
      (s.total.totals.covered > EPSILON || s.total.totals.unused > EPSILON),
  );
  if (commitmentGrouping && unattributed && !notices.includes("unattributed_commitment_usage")) {
    notices.push("unattributed_commitment_usage");
  }
  const partial = overall.some((s) => {
    const share = s.total.metrics.savingsMeasuredShare;
    return share !== null && share < 1 - 1e-6;
  });
  if (partial && !notices.includes("partial_savings_measurement")) {
    notices.push("partial_savings_measurement");
  }

  return {
    from: ctx.from,
    to: ctx.to,
    granularity: ctx.granularity,
    groupBy: ctx.groupBy,
    buckets,
    series,
    overall,
    providers: ctx.providers ?? [],
    notices,
  };
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/**
 * One CSV cell. Numbers go out bare; text is RFC 4180 quoted, and text that
 * starts like a formula gets a leading tab, because group labels come from
 * customers' clouds and a spreadsheet must not execute them.
 */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const guarded = /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Round money to cents and ratios to six places, so the file is readable. */
function csvNumber(value: number | null, isRatio: boolean): number | null {
  if (value === null) return null;
  const scale = isRatio ? 1e6 : 100;
  return Math.round(value * scale) / scale;
}

/**
 * The report as CSV: one row per series per bucket, every metric a column,
 * ratios as fractions (0.85, not "85%") so a spreadsheet can do arithmetic on
 * them. An empty ratio cell means "not measurable", never zero. Ends with one
 * total row per series (bucket `total`).
 */
export function commitmentReportToCsv(result: CommitmentReportResult): string {
  const header = [
    "bucket",
    "group",
    "currency",
    ...COMMITMENT_REPORT_METRICS,
    "onDemandEquivalent",
    "savingsMeasuredShare",
  ];
  const lines = [header.map(csvCell).join(",")];
  const source = result.groupBy === "none" ? result.overall : result.series;
  const row = (bucket: string, s: CommitmentReportSeries, m: CommitmentReportMetricValues) =>
    [
      csvCell(bucket),
      csvCell(result.groupBy === "none" ? "" : s.label),
      csvCell(s.currency),
      ...COMMITMENT_REPORT_METRICS.map((metric) =>
        csvCell(csvNumber(m[metric], isCommitmentRatioMetric(metric))),
      ),
      csvCell(csvNumber(m.onDemandEquivalent, false)),
      csvCell(csvNumber(m.savingsMeasuredShare, true)),
    ].join(",");
  for (const s of source) {
    for (const p of s.points) lines.push(row(p.bucket, s, p.metrics));
  }
  for (const s of source) lines.push(row("total", s, s.total.metrics));
  return `${lines.join("\r\n")}\r\n`;
}

/** A file name for a report's CSV: the name, slugged, plus the window. */
export function commitmentReportCsvFileName(name: string, from: string, to: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "commitment-report";
  return `${slug}-${from}-to-${to}.csv`;
}

/* ------------------------------------------------------------------ *
 * Fetch helpers (mobile, and anything else on a CloudFetch)
 * ------------------------------------------------------------------ */

/** Saved commitment reports the caller may open (`costs:read`). */
export async function fetchCommitmentReports(
  api: CloudFetch,
  orgId: string,
): Promise<CommitmentReport[] | null> {
  return api.org<CommitmentReport[]>(orgId, "/commitments/reports");
}

/** Run a saved report (`costs:read`). */
export async function runCommitmentReport(
  api: CloudFetch,
  orgId: string,
  reportId: string,
): Promise<CommitmentReportRunResult | null> {
  return api.org<CommitmentReportRunResult>(
    orgId,
    `/commitments/reports/${encodeURIComponent(reportId)}/run`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
}
