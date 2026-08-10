/**
 * Zod schemas for cost widgets — what the web API validates request bodies and
 * stored widget configs against, and what the config editors build.
 *
 * The *types* those schemas describe live in `@infrawrench/client-core` so
 * mobile (which doesn't depend on this package) shares one definition; they are
 * re-exported here so every existing `from "./config.js"` import keeps working.
 * The assertions at the bottom fail the build if a schema drifts from the type.
 */
import { z } from "zod";
import {
  COST_ALERT_LIMITS,
  COST_ANOMALY_LIMITS,
  COST_ANOMALY_SMS_MODES,
  COST_BASES,
  COST_CHANGE_CADENCES,
  COST_CHANGE_DIRECTIONS,
  type CostAlertInput,
  COST_BINNINGS,
  COST_CHARGE_TYPES,
  COST_CHART_TYPES,
  COST_DIMENSIONS,
  COST_QUERY_MAX_LENGTH,
  COST_RANGE_PRESETS,
  COST_REPORT_LIMITS,
  COST_REPORT_FOLDER_LIMITS,
  type CostReportFolderInput,
  CURRENCY_CODE_PATTERN,
  EXCHANGE_RATE_LIMITS,
  type ExchangeRateInput,
  type OrgCurrencySettings,
  type BudgetInput,
  type CostAnomalySettings,
  type BudgetThreshold,
  type BudgetWidgetConfig,
  type CostFilter,
  type CostGraphConfig,
  type CostQueryRequest,
  type CostReportInput,
  type CostReportWidgetConfig,
  type CustomGraphWidgetConfig,
  type DashboardWidgetKind,
  TAG_POLICY_LIMITS,
  type AllocationRuleInput,
  type AllocationRuleMatch,
  type RequiredTag,
  type TagPolicy,
  SAVED_COST_FILTER_LIMITS,
  type SavedCostFilterInput,
} from "@infrawrench/client-core";

export {
  COST_DIMENSIONS,
  // The cost query language — the text front-end for `costFilterSchema`. Kept
  // in client-core so mobile, the CLI and the server share one parser;
  // re-exported here so cost code that already imports from "./config.js" does
  // not need a second import path.
  parseCostQuery,
  formatCostQuery,
  isValidCostQuery,
  CostQueryParseError,
  CostQueryFormatError,
  COST_QUERY_GRAMMAR,
  COST_QUERY_LANGUAGE_SUMMARY,
  COST_QUERY_MAX_LENGTH,
  COST_CHARGE_TYPES,
  COST_CHARGE_TYPE_LABELS,
  COST_BASES,
  COST_BASIS_LABELS,
  COST_RANGE_PRESETS,
  COST_CHART_TYPES,
  COST_BINNINGS,
  COST_ANOMALY_LIMITS,
  COST_ANOMALY_SMS_MODES,
  COST_ANOMALY_SMS_MODE_LABELS,
  COST_ALERT_LIMITS,
  COST_CHANGE_CADENCES,
  COST_CHANGE_CADENCE_LABELS,
  COST_CHANGE_CADENCE_DESCRIPTIONS,
  COST_CHANGE_DIRECTIONS,
  COST_CHANGE_DIRECTION_LABELS,
  DEFAULT_COST_ALERT_INPUT,
  costAlertEventDeltaLabel,
  type CostAlert,
  type CostAlertEvent,
  type CostAlertInput,
  type CostChangeCadence,
  type CostChangeDirection,
  DASHBOARD_WIDGET_KINDS,
  OTHER_GROUP_KEY,
  DEFAULT_COST_GRAPH_CONFIG,
  DEFAULT_BUDGET_INPUT,
  DEFAULT_COST_ANOMALY_SETTINGS,
  type CostAnomalySettings,
  type CostAnomalySettingsView,
  type CostAnomalySmsMode,
  COST_CHART_TYPE_LABELS,
  COST_BINNING_LABELS,
  COST_RANGE_PRESET_LABELS,
  COST_DIMENSION_LABELS,
  resolveCostDateRange,
  costQueryForConfig,
  type BudgetInput,
  type CostDimensionOption,
  type CostAccountStatus,
  type CostPollError,
  type CostDimensionId,
  type CostChargeType,
  type CostBasis,
  type CostFilter,
  type CostRangePreset,
  type CostDateRange,
  type CostChartType,
  type CostBinningId,
  type CostGraphConfig,
  type BudgetWidgetConfig,
  type BudgetThreshold,
  COST_REPORT_LIMITS,
  COST_REPORT_FOLDER_LIMITS,
  normalizeCostReportName,
  duplicateCostReportName,
  flattenCostReportFolderTree,
  costReportFolderPaths,
  costReportFolderMoveBlocker,
  type CostReport,
  type CostReportInput,
  type CostReportFolder,
  type CostReportFolderInput,
  type CostReportFolderTreeRow,
  type CostReportPlacement,
  type CostReportRunResult,
  type CostReportWidgetConfig,
  type DashboardWidgetKind,
  type DashboardWidget,
  type CostQueryRequest,
  type CostSeriesPoint,
  type CostQuerySeries,
  type CostQueryResponse,
  type CostConversion,
  type CostConvertedCurrency,
  type CostConversionRate,
  CURRENCY_CODE_PATTERN,
  EXCHANGE_RATE_LIMITS,
  normalizeCurrencyCode,
  buildExchangeRateTable,
  describeCostConversion,
  type OrgCurrencySettings,
  type OrgCurrencyConfig,
  type ExchangeRate,
  type ExchangeRateInput,
  type CustomGraphWidgetConfig,
  TAG_POLICY_LIMITS,
  ALLOCATION_RULE_LIMITS,
  UNALLOCATED_KEY,
  taggedSpendPercent,
  type RequiredTag,
  type TagPolicy,
  type TagPolicyViolation,
  type AccountTagCompliance,
  type TagComplianceReport,
  type CostCentre,
  type AllocationRuleMatch,
  type AllocationRule,
  type AllocationRuleInput,
  type UntaggedSpendReport,
  type ShowbackReportCentre,
  type ShowbackReport,
  // Saved cost filters — the named, referenced-by-id form of `CostFilter[]`.
  SAVED_COST_FILTER_LIMITS,
  resolveSavedCostFilterInput,
  describeSavedCostFilterReferents,
  type SavedCostFilter,
  type SavedCostFilterInput,
  type SavedCostFilterReferent,
  type SavedCostFilterReferentKind,
} from "@infrawrench/client-core";

export const costFilterSchema = z.object({
  dimension: z.enum(COST_DIMENSIONS),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  /** Required when dimension === "tag". */
  tagKey: z.string().optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const costDateRangeSchema = z.union([
  z.object({ kind: z.literal("relative"), preset: z.enum(COST_RANGE_PRESETS) }),
  z.object({ kind: z.literal("absolute"), from: isoDate, to: isoDate }),
]);

export const costGraphConfigSchema = z.object({
  version: z.literal(1),
  chartType: z.enum(COST_CHART_TYPES),
  binning: z.enum(COST_BINNINGS),
  dateRange: costDateRangeSchema,
  groupBy: z.enum(["none", ...COST_DIMENSIONS]),
  /** Required when groupBy === "tag". */
  groupByTagKey: z.string().optional(),
  filters: z.array(costFilterSchema).default([]),
  /**
   * A saved cost filter applied by reference (resolved server-side at query
   * time) and AND-composed with `filters`. Optional, never defaulted: absent
   * means none, and every config written before this existed stays byte-stable.
   */
  savedFilterId: z.string().min(1).optional(),
  /** Groups beyond the top N fold into an "Other" series. */
  topN: z.number().int().min(1).max(15).default(5),
  comparePreviousPeriod: z.boolean().default(false),
  showForecast: z.boolean().default(false),
  /**
   * Optional rather than defaulted: an absent basis is "cash", and defaulting
   * it here would rewrite every stored widget config the first time it is
   * re-saved, for no change in what it draws.
   */
  costBasis: z.enum(COST_BASES).optional(),
});

/** A budget widget is a dashboard view onto a budgets row — alerts outlive it. */
export const budgetWidgetConfigSchema = z.object({
  version: z.literal(1),
  budgetId: z.string().min(1),
});

/**
 * A cost_report widget is a dashboard view onto a cost_reports row. It holds no
 * config of its own on purpose: the whole point of the report object is that
 * editing it once updates every dashboard showing it.
 */
export const costReportWidgetConfigSchema = z.object({
  version: z.literal(1),
  reportId: z.string().min(1),
});

/**
 * Create/update body for a report (POST/PUT /cost-reports).
 *
 * `folderId` files the report in a cost-report folder; the server verifies the
 * folder belongs to the org. Nullable rather than merely optional because
 * "move this out of its folder" has to be expressible.
 */
export const costReportInputSchema = z.object({
  name: z.string().min(1).max(COST_REPORT_LIMITS.maxNameLength),
  description: z.string().max(COST_REPORT_LIMITS.maxDescriptionLength).optional(),
  config: costGraphConfigSchema,
  folderId: z.string().min(1).nullable().optional(),
});

/**
 * Create/update body for a report folder (POST/PUT /cost-report-folders).
 *
 * Shape-only validation: whether `parentFolderId` exists, stays inside the org,
 * respects the nesting depth limit and never forms a cycle is the server's job
 * (`costReportFolderMoveBlocker`), because only the server sees the whole tree.
 */
export const costReportFolderInputSchema = z.object({
  name: z.string().min(1).max(COST_REPORT_FOLDER_LIMITS.maxNameLength),
  parentFolderId: z.string().min(1).nullable().optional(),
});

export const budgetThresholdSchema = z.object({
  type: z.enum(["actual", "forecast"]),
  /** Percent of the budget amount at which this threshold fires (1–1000). */
  percent: z.number().int().min(1).max(1000),
});

export const budgetInputSchema = z.object({
  name: z.string().min(1).max(120),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default("USD"),
  filters: z.array(costFilterSchema).default([]),
  /**
   * A saved cost filter applied by reference and AND-composed with `filters`
   * at evaluation time. A PUT that omits it clears it — budget updates are
   * full replaces.
   */
  savedFilterId: z.string().min(1).optional(),
  thresholds: z.array(budgetThresholdSchema).min(1).max(10),
  /** Which number the budget tracks; absent is cash. */
  costBasis: z.enum(COST_BASES).optional(),
});

/**
 * Create/update body for a change-based cost alert (POST/PUT /cost-alerts).
 *
 * The refinements are the contract, not decoration: an alert with no
 * threshold at all would fire on every wobble (or never — either way it is a
 * mis-set form, and the evaluator additionally refuses to judge such a row),
 * and a tag grouping without a tag key has nothing to group on.
 */
export const costAlertInputSchema = z
  .object({
    name: z.string().min(1).max(COST_ALERT_LIMITS.maxNameLength),
    filters: z.array(costFilterSchema).default([]),
    /** Null watches one total; a dimension watches each group separately. */
    groupBy: z.enum(COST_DIMENSIONS).nullable().default(null),
    /** Required when groupBy === "tag". */
    groupByTagKey: z.string().min(1).optional(),
    cadence: z.enum(COST_CHANGE_CADENCES),
    thresholdPercent: z
      .number()
      .int()
      .min(COST_ALERT_LIMITS.minPercent)
      .max(COST_ALERT_LIMITS.maxPercent)
      .nullable()
      .default(null),
    thresholdAmountCents: z.number().int().positive().nullable().default(null),
    direction: z.enum(COST_CHANGE_DIRECTIONS),
    enabled: z.boolean().default(true),
  })
  .refine((v) => v.thresholdPercent !== null || v.thresholdAmountCents !== null, {
    message: "Set a percent threshold, an amount threshold, or both",
    path: ["thresholdPercent"],
  })
  .refine((v) => v.groupBy !== "tag" || !!v.groupByTagKey?.trim(), {
    message: "groupByTagKey is required when groupBy is tag",
    path: ["groupByTagKey"],
  });

/**
 * Per-org anomaly tuning (PUT /costs/anomaly-settings).
 *
 * The bounds are the point of this schema, not a formality. A `sigmas` of 0
 * makes "mean + 0σ" the bar, so every day a cent above average pages someone;
 * anything under 1σ flags roughly a third of ordinary days. A floor of zero or
 * less removes the noise filter that keeps $0.02 spends quiet. The upper
 * bounds stop a typo (a floor of "100000" meaning dollars, not cents) from
 * silently switching detection off.
 *
 * `sigmas` is rounded to one decimal so the stored value matches what the
 * form's step shows — an org cannot end up with 2.9999999999 and wonder why.
 */
export const costAnomalySettingsSchema = z.object({
  sigmas: z
    .number()
    .min(COST_ANOMALY_LIMITS.sigmasMin)
    .max(COST_ANOMALY_LIMITS.sigmasMax)
    .transform((v) => Math.round(v * 10) / 10),
  minDeltaCents: z
    .number()
    .int()
    .min(COST_ANOMALY_LIMITS.minDeltaCentsMin)
    .max(COST_ANOMALY_LIMITS.minDeltaCentsMax),
  newSourceMinCents: z
    .number()
    .int()
    .min(COST_ANOMALY_LIMITS.newSourceMinCentsMin)
    .max(COST_ANOMALY_LIMITS.newSourceMinCentsMax),
  /**
   * SMS paging is the one setting here that costs money and wakes people, so it
   * is an explicit enum with no default: a PUT that omits it is rejected rather
   * than quietly resolving to "off" (which would let an older client silently
   * switch a deliberate opt-in back off on every save).
   */
  smsAlerts: z.enum(COST_ANOMALY_SMS_MODES),
});

/** A custom-graph widget is a dashboard view onto a custom_graphs row. */
export const customGraphWidgetConfigSchema = z.object({
  version: z.literal(1),
  graphId: z.string().min(1),
});

const widgetConfigSchemas = {
  cost_graph: costGraphConfigSchema,
  cost_report: costReportWidgetConfigSchema,
  budget: budgetWidgetConfigSchema,
  custom_graph: customGraphWidgetConfigSchema,
} as const satisfies Record<DashboardWidgetKind, z.ZodTypeAny>;

export function widgetConfigSchemaFor(kind: DashboardWidgetKind) {
  return widgetConfigSchemas[kind];
}

/** One required tag in the org policy: a key, optionally with allowed values. */
export const requiredTagSchema = z.object({
  key: z.string().min(1).max(TAG_POLICY_LIMITS.maxKeyLength),
  allowedValues: z
    .array(z.string().min(1).max(TAG_POLICY_LIMITS.maxValueLength))
    .max(TAG_POLICY_LIMITS.maxAllowedValues)
    .optional(),
});

/** The org tag policy (PUT /tag-policy). */
export const tagPolicySchema = z.object({
  requiredTags: z.array(requiredTagSchema).max(TAG_POLICY_LIMITS.maxRequiredTags),
  enforceOnCreate: z.boolean(),
});

export const costCentreInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

/** All set fields must match; an empty match is a catch-all. */
export const allocationRuleMatchSchema = z
  .object({
    tagKey: z.string().min(1).max(TAG_POLICY_LIMITS.maxKeyLength).optional(),
    tagValue: z.string().max(TAG_POLICY_LIMITS.maxValueLength).optional(),
    accountId: z.string().min(1).optional(),
    pluginId: z.string().min(1).optional(),
    service: z.string().min(1).optional(),
  })
  .refine((m) => !m.tagValue?.trim() || !!m.tagKey?.trim(), {
    message: "tagValue requires tagKey",
    path: ["tagValue"],
  });

export const allocationRuleInputSchema = z.object({
  costCentreId: z.string().min(1),
  priority: z.number().int().min(0).max(100_000),
  match: allocationRuleMatchSchema,
});

/** The cost query the API accepts — a graph config resolved to concrete dates. */
export const costQueryRequestSchema = z.object({
  from: isoDate,
  to: isoDate,
  binning: z.enum(COST_BINNINGS),
  groupBy: z.enum(["none", ...COST_DIMENSIONS]),
  groupByTagKey: z.string().optional(),
  filters: z.array(costFilterSchema).default([]),
  /**
   * The same filter in the cost query language — `provider = 'aws' AND
   * tag['env'] != 'dev'`. Compiled server-side to exactly `filters`; a parse
   * failure is a 400 carrying the offset. Sending both this and a non-empty
   * `filters` is rejected rather than resolved by a precedence rule.
   *
   * Bounded so a runaway string cannot be handed to the tokenizer; the limit is
   * far above any hand-written filter and well below anything worth worrying
   * about.
   */
  query: z.string().max(COST_QUERY_MAX_LENGTH).optional(),
  /**
   * A saved cost filter resolved server-side and AND-composed with whichever
   * inline spelling is present — unlike `query`/`filters` it is a composition,
   * not an alternative. An id that does not resolve is a 400, never a silent
   * fall-through to unfiltered spend.
   */
  savedFilterId: z.string().min(1).optional(),
  topN: z.number().int().min(1).max(15).default(5),
  comparePreviousPeriod: z.boolean().default(false),
  forecast: z.boolean().default(false),
  /** Which number to sum; absent is cash, the basis every older client sends. */
  costBasis: z.enum(COST_BASES).optional(),
  /** Restrict to these charge types; absent is all of them. */
  chargeTypes: z.array(z.enum(COST_CHARGE_TYPES)).optional(),
  /**
   * Fold currencies the org holds a rate for into this one. Optional rather
   * than defaulted, like `costBasis` above: absent must keep meaning "no
   * conversion", so an older client — and a stored widget config written before
   * this field existed — gets the unconverted per-currency answer it expects.
   */
  displayCurrency: z.string().regex(CURRENCY_CODE_PATTERN).optional(),
});

/* ------------------------------------------------------------------ *
 * Org currency settings — PUT /currency and PUT /currency/rates.
 * ------------------------------------------------------------------ */

const currencyCode = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .pipe(z.string().regex(CURRENCY_CODE_PATTERN, "expected a three-letter code, e.g. USD"));

/**
 * The display currency, or `null` for "do not convert".
 *
 * Nullable and *required*, not optional: a PUT that omits the field is rejected
 * rather than quietly clearing a setting the org deliberately turned on. Same
 * reasoning as `smsAlerts` above — a field with org-wide consequences should
 * never be settable by accident.
 */
export const currencySettingsSchema = z.object({
  displayCurrency: currencyCode.nullable(),
});

/**
 * One stated rate.
 *
 * `rate` is validated as a *decimal string*, never coerced to a number here:
 * the value is stored in a `numeric` column precisely so the org's own digits
 * survive, and parsing it to a float at the API edge would throw that away
 * before it ever reached the database.
 */
/**
 * Create/update body for a saved cost filter (POST/PUT /saved-cost-filters).
 *
 * Shape-only, deliberately: the semantic rules — `filters` XOR `query`, the
 * result non-empty, every tag term carrying its key so the filter is always
 * expressible in query text — live in `resolveSavedCostFilterInput`
 * (client-core), which the service runs on every write. Keeping them out of
 * the schema means the editors and the API share one implementation of the
 * rules and one set of messages.
 */
export const savedCostFilterInputSchema = z.object({
  name: z.string().min(1).max(SAVED_COST_FILTER_LIMITS.maxNameLength),
  description: z.string().max(SAVED_COST_FILTER_LIMITS.maxDescriptionLength).optional(),
  filters: z.array(costFilterSchema).max(SAVED_COST_FILTER_LIMITS.maxFilters).default([]),
  /** The same filter as query text — an alternative spelling of `filters`. */
  query: z.string().max(COST_QUERY_MAX_LENGTH).optional(),
});

export const exchangeRateInputSchema = z.object({
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  rate: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "expected a positive decimal, e.g. 1.0850")
    .refine((v) => {
      const n = Number(v);
      return n >= EXCHANGE_RATE_LIMITS.rateMin && n <= EXCHANGE_RATE_LIMITS.rateMax;
    }, "rate must be greater than 0"),
  effectiveFrom: isoDate,
});

/**
 * Compile-time proof that each schema still parses to exactly the shared type.
 * Drift here is a type error at build time rather than a runtime surprise on a
 * client that trusted the contract.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export type SchemasMatchCostContract = [
  Exact<z.infer<typeof costFilterSchema>, CostFilter>,
  Exact<z.infer<typeof costGraphConfigSchema>, CostGraphConfig>,
  Exact<z.infer<typeof budgetWidgetConfigSchema>, BudgetWidgetConfig>,
  Exact<z.infer<typeof costReportWidgetConfigSchema>, CostReportWidgetConfig>,
  Exact<z.infer<typeof costReportInputSchema>, CostReportInput>,
  Exact<z.infer<typeof costReportFolderInputSchema>, CostReportFolderInput>,
  Exact<z.infer<typeof budgetThresholdSchema>, BudgetThreshold>,
  Exact<z.infer<typeof budgetInputSchema>, BudgetInput>,
  Exact<z.infer<typeof costAlertInputSchema>, CostAlertInput>,
  Exact<z.infer<typeof costAnomalySettingsSchema>, CostAnomalySettings>,
  Exact<z.infer<typeof costQueryRequestSchema>, CostQueryRequest>,
  Exact<z.infer<typeof customGraphWidgetConfigSchema>, CustomGraphWidgetConfig>,
  Exact<z.infer<typeof requiredTagSchema>, RequiredTag>,
  Exact<z.infer<typeof tagPolicySchema>, TagPolicy>,
  Exact<z.infer<typeof allocationRuleMatchSchema>, AllocationRuleMatch>,
  Exact<z.infer<typeof allocationRuleInputSchema>, AllocationRuleInput>,
  Exact<z.infer<typeof currencySettingsSchema>, OrgCurrencySettings>,
  Exact<z.infer<typeof exchangeRateInputSchema>, ExchangeRateInput>,
  Exact<z.infer<typeof savedCostFilterInputSchema>, SavedCostFilterInput>,
];
