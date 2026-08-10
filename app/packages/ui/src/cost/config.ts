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
  COST_ANNOTATION_LIMITS,
  type CostAnnotationInput,
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
  COST_SCENARIO_ADJUSTMENT_KINDS,
  COST_SCENARIO_LIMITS,
  COST_SCENARIO_PERIODS,
  type CostScenarioAdjustment,
  type CostScenarioModelInput,
  BILLING_RULE_KINDS,
  BILLING_RULE_FIXED_PERIODS,
  BILLING_RULE_TARGET_KINDS,
  BILLING_RULE_LIMITS,
  type BillingRuleAdjustment,
  type BillingRuleInput,
  type BillingRuleMatch,
  BUSINESS_METRIC_KEY_PATTERN,
  BUSINESS_METRIC_KINDS,
  BUSINESS_METRIC_LIMITS,
  UNIT_COST_MODES,
  type BusinessMetricInput,
  type BusinessMetricValueInput,
  type UnitCostQueryRequest,
  MANAGED_ACCOUNT_LIMITS,
  MANAGED_INVOICE_LIMITS,
  type ManagedInvoiceUpdate,
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
  // Cost annotations — dated notes drawn over a chart, never part of its data.
  COST_ANNOTATION_LIMITS,
  costAnnotationInputError,
  bucketCostAnnotations,
  formatCostAnnotationDates,
  describeCostAnnotationScope,
  type CostAnnotation,
  type CostAnnotationInput,
  type CostAnnotationMarker,
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
  // Cost centres nest; the tree rules are shared so the UI disables exactly
  // what the server rejects, and the rollup is one implementation.
  COST_CENTRE_LIMITS,
  costCentreDepths,
  costCentrePaths,
  costCentreMoveBlocker,
  orderAllocationRules,
  buildShowbackCentres,
  type CostCentrePathRow,
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
  // Scenario models — known future cost overlaid on a forecast. The arithmetic
  // (`applyCostScenario`) is shared with the server, which is what keeps a
  // chart's scenario line and a budget's adjusted threshold in agreement.
  COST_SCENARIO_ADJUSTMENT_KINDS,
  COST_SCENARIO_ADJUSTMENT_KIND_LABELS,
  COST_SCENARIO_ADJUSTMENT_KIND_DESCRIPTIONS,
  COST_SCENARIO_PERIODS,
  COST_SCENARIO_PERIOD_LABELS,
  COST_SCENARIO_LIMITS,
  DEFAULT_COST_SCENARIO_MODEL_INPUT,
  costScenarioModelInputError,
  applyCostScenario,
  describeCostScenarioAdjustment,
  describeCostScenarioModel,
  describeCostScenarioReferents,
  type CostScenarioAdjustment,
  type CostScenarioAdjustmentKind,
  type CostScenarioContribution,
  type CostScenarioModel,
  type CostScenarioModelInput,
  type CostScenarioPeriod,
  type CostScenarioProjection,
  type CostScenarioReferent,
  type CostScenarioReferentKind,
  // Billing rules — the org's own adjustments to collected spend. The
  // arithmetic and the ordering model are shared with the server, which is what
  // keeps an adjusted chart and an adjusted budget in agreement.
  BILLING_RULE_KINDS,
  BILLING_RULE_KIND_LABELS,
  BILLING_RULE_KIND_DESCRIPTIONS,
  BILLING_RULE_FIXED_PERIODS,
  BILLING_RULE_TARGET_KINDS,
  BILLING_RULE_LIMITS,
  DEFAULT_BILLING_RULE_INPUT,
  billingRuleInputError,
  normalizeBillingRuleInput,
  orderBillingRules,
  describeBillingRule,
  describeBillingRuleMatch,
  describeBillingRuleAdjustment,
  fixedRuleAmountForRange,
  type BillingRule,
  type BillingRuleAdjustment,
  type BillingRuleFixedPeriod,
  type BillingRuleInput,
  type BillingRuleKind,
  type BillingRuleMatch,
  type BillingRuleTargetKind,
  type CostAdjustmentRule,
  type CostAdjustmentSummary,
  // Business metrics — the denominators unit costs divide by. Re-exported here
  // so cost components keep importing one module.
  BUSINESS_METRIC_KINDS,
  BUSINESS_METRIC_KIND_LABELS,
  BUSINESS_METRIC_KIND_DESCRIPTIONS,
  BUSINESS_METRIC_LIMITS,
  BUSINESS_METRIC_KEY_PATTERN,
  BUSINESS_METRIC_KEY_HELP,
  DEFAULT_BUSINESS_METRIC_INPUT,
  normalizeBusinessMetricKey,
  unitCostQueryForConfig,
  UNIT_COST_MODES,
  UNIT_COST_MODE_LABELS,
  UNIT_COST_GAP_REASONS,
  UNIT_COST_GAP_REASON_LABELS,
  isPartialUnitCostPoint,
  unitCostUnitLabel,
  formatUnitCostValue,
  describeUnitCostCaveats,
  type BusinessMetric,
  type BusinessMetricCoverage,
  type BusinessMetricInput,
  type BusinessMetricKind,
  type BusinessMetricValue,
  type BusinessMetricValueInput,
  type BusinessMetricValueSource,
  type BusinessMetricWriteResult,
  type UnitCostGapReason,
  type UnitCostMode,
  type UnitCostPoint,
  type UnitCostQueryRequest,
  type UnitCostQueryResponse,
  type UnitCostSeries,
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
   * Overlay a scenario model on the forecast. Optional, never defaulted:
   * absent means the graph draws the bare trend, which is what every config
   * written before scenarios existed does.
   */
  scenarioModelId: z.string().min(1).optional(),
  /**
   * Optional rather than defaulted: an absent basis is "cash", and defaulting
   * it here would rewrite every stored widget config the first time it is
   * re-saved, for no change in what it draws.
   */
  costBasis: z.enum(COST_BASES).optional(),
  /**
   * Divide this graph's spend by a business metric and draw cost per unit.
   * Optional for the same reason `costBasis` is: absent means "a spend graph",
   * which is what every config written before unit costs existed is.
   */
  unitCostMetricId: z.string().min(1).optional(),
  unitCostMode: z.enum(UNIT_COST_MODES).optional(),
  /**
   * Draw the org's billing rules applied. Optional, never defaulted: absent
   * means collected spend, which is what every card written before billing
   * rules existed draws — and the card labels itself from the response's
   * `adjustment` field whenever this is on.
   */
  adjusted: z.boolean().optional(),
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

/**
 * Create/update body for a cost annotation (POST/PUT /cost-annotations).
 *
 * Shape-only, deliberately: the semantic rules — a non-empty note, an end date
 * that isn't before the start, a span that isn't a year long — live in
 * `costAnnotationInputError` (client-core), which both the editors and the
 * service run, so a form refuses exactly what the API refuses and in the same
 * words.
 *
 * `costReportId` is nullable rather than merely optional because "make this note
 * org-wide again" has to be expressible; null (the default) puts the note on
 * every cost chart.
 */
export const costAnnotationInputSchema = z.object({
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  text: z.string().min(1).max(COST_ANNOTATION_LIMITS.maxTextLength),
  costReportId: z.string().min(1).nullable().optional(),
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
  /**
   * Opt this budget's **forecast** thresholds into a scenario model. Absent —
   * the default — keeps them on the bare trend. A PUT that omits it clears the
   * opt-in, which is the safe direction.
   */
  scenarioModelId: z.string().min(1).optional(),
  thresholds: z.array(budgetThresholdSchema).min(1).max(10),
  /** Which number the budget tracks; absent is cash. */
  costBasis: z.enum(COST_BASES).optional(),
  /**
   * Measure this budget against billing-rule-adjusted spend. Absent — the
   * default, and every budget nobody opted in — measures what the providers
   * charged. A PUT that omits it clears the opt-in, the safe direction.
   */
  useAdjustedSpend: z.boolean().optional(),
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
  /**
   * Nest this centre under another. `null` is the top level; **omitting** it on
   * an update leaves the centre where it is, so a client that predates nesting
   * cannot promote a centre to the root just by renaming it.
   */
  parentId: z.string().min(1).nullable().optional(),
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
  /**
   * Apply a scenario model to the projection, returning it alongside the
   * untouched trend. Requires `forecast: true` — the server refuses the
   * combination rather than silently returning no scenario.
   */
  scenarioModelId: z.string().min(1).optional(),
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
  /**
   * Apply the org's billing rules. Absent — the default and what every
   * unattended reader sends — is raw collected spend. Present, the response
   * carries `adjustment` with the collected totals beside the adjusted ones,
   * so no client can render an adjusted figure without being handed what it
   * needs to label it.
   */
  adjusted: z.boolean().optional(),
});

/* ------------------------------------------------------------------ *
 * Billing rules — POST/PUT /billing-rules.
 * ------------------------------------------------------------------ */

/**
 * The allocation match vocabulary plus `chargeType`. Shape-only, deliberately:
 * the cross-field rules (a percentage rule cannot carry an amount, a
 * reallocation rule must name a target) live in `billingRuleInputError` in
 * client-core, so the settings form and the API refuse in identical words.
 */
export const billingRuleMatchSchema = z
  .object({
    tagKey: z.string().min(1).max(TAG_POLICY_LIMITS.maxKeyLength).optional(),
    tagValue: z.string().max(TAG_POLICY_LIMITS.maxValueLength).optional(),
    accountId: z.string().min(1).optional(),
    pluginId: z.string().min(1).optional(),
    service: z.string().min(1).optional(),
    chargeType: z.enum(COST_CHARGE_TYPES).optional(),
  })
  .refine((m) => !m.tagValue?.trim() || !!m.tagKey?.trim(), {
    message: "tagValue requires tagKey",
    path: ["tagValue"],
  });

/**
 * Every kind-specific field is `.nullable().default(null)` so a PUT round-trip
 * of a rule this client did not create still parses — the same rule
 * `costScenarioAdjustmentSchema` follows.
 */
export const billingRuleAdjustmentSchema = z.object({
  kind: z.enum(BILLING_RULE_KINDS),
  percent: z
    .number()
    .min(BILLING_RULE_LIMITS.minPercent)
    .max(BILLING_RULE_LIMITS.maxPercent)
    .nullable()
    .default(null),
  amount: z
    .number()
    .min(-BILLING_RULE_LIMITS.maxFixedAmount)
    .max(BILLING_RULE_LIMITS.maxFixedAmount)
    .nullable()
    .default(null),
  currency: z.string().regex(CURRENCY_CODE_PATTERN).nullable().default(null),
  period: z.enum(BILLING_RULE_FIXED_PERIODS).nullable().default(null),
  targetKind: z.enum(BILLING_RULE_TARGET_KINDS).nullable().default(null),
  targetId: z.string().min(1).nullable().default(null),
});

export const billingRuleInputSchema = z.object({
  name: z.string().min(1).max(BILLING_RULE_LIMITS.maxNameLength),
  description: z.string().max(BILLING_RULE_LIMITS.maxDescriptionLength).nullable().default(null),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100_000),
  match: billingRuleMatchSchema,
  adjustment: billingRuleAdjustmentSchema,
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

/**
 * One adjustment inside a scenario model.
 *
 * Shape-only, deliberately: the semantic rules — which fields each `kind` may
 * carry, that a model holds one currency, that an end date is not before its
 * start — live in `costScenarioModelInputError` (client-core), which both the
 * editors and the service run. Keeping them out of the schema means a form
 * refuses exactly what the API refuses, in the same words, rather than
 * rendering a zod union's account of three failed branches.
 *
 * Every kind-specific field is `.nullable().default(null)`: each of the three
 * kinds leaves most of them unset, so "unset" and "explicitly null" must both
 * parse (a client round-tripping a stored model through a PUT sends nulls) —
 * and defaulting rather than merely allowing `undefined` is what makes the
 * parsed output exactly `CostScenarioAdjustment`, which the assertion at the
 * bottom of this file checks.
 */
export const costScenarioAdjustmentSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(COST_SCENARIO_LIMITS.maxLabelLength),
  kind: z.enum(COST_SCENARIO_ADJUSTMENT_KINDS),
  startDate: isoDate,
  endDate: isoDate.nullable().default(null),
  amountCents: z.number().int().nullable().default(null),
  currency: z.string().regex(CURRENCY_CODE_PATTERN).nullable().default(null),
  period: z.enum(COST_SCENARIO_PERIODS).nullable().default(null),
  percent: z.number().finite().nullable().default(null),
  scope: z.array(costFilterSchema).max(COST_SCENARIO_LIMITS.maxScopeFilters).default([]),
});

/** Create/update body for a scenario model (POST/PUT /cost-scenarios). */
export const costScenarioModelInputSchema = z.object({
  name: z.string().min(1).max(COST_SCENARIO_LIMITS.maxNameLength),
  description: z.string().max(COST_SCENARIO_LIMITS.maxDescriptionLength).optional(),
  /** The one currency every amount in the model is denominated in. */
  currency: z.string().regex(CURRENCY_CODE_PATTERN),
  adjustments: z
    .array(costScenarioAdjustmentSchema)
    .max(COST_SCENARIO_LIMITS.maxAdjustments)
    .default([]),
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
  Exact<z.infer<typeof costAnnotationInputSchema>, CostAnnotationInput>,
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
  Exact<z.infer<typeof costScenarioAdjustmentSchema>, CostScenarioAdjustment>,
  Exact<z.infer<typeof costScenarioModelInputSchema>, CostScenarioModelInput>,
  Exact<z.infer<typeof billingRuleMatchSchema>, BillingRuleMatch>,
  Exact<z.infer<typeof billingRuleAdjustmentSchema>, BillingRuleAdjustment>,
  Exact<z.infer<typeof billingRuleInputSchema>, BillingRuleInput>,
];

/* ------------------------------------------------------------------ *
 * Business metrics and unit costs — POST/PUT /business-metrics,
 * POST /business-metrics/{id}/values, POST /business-metrics/{id}/unit-costs.
 * ------------------------------------------------------------------ */

const businessMetricKey = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1)
      .max(BUSINESS_METRIC_LIMITS.maxKeyLength)
      .regex(BUSINESS_METRIC_KEY_PATTERN, "expected a lowercase slug, e.g. active-customers"),
  );

/**
 * Create/update body for a business metric.
 *
 * Shape-only for the currency rule, deliberately: "a revenue metric must state
 * a currency, and a count metric must not" is enforced in
 * `services/business-metrics.ts` (and by a database check constraint) so the
 * message is one sentence explaining *why* rather than a zod union's rendering
 * of two failed branches.
 */
export const businessMetricInputSchema = z.object({
  key: businessMetricKey,
  name: z.string().min(1).max(BUSINESS_METRIC_LIMITS.maxNameLength),
  /** Singular unit label — "customer", "request", "GB". Purely display. */
  unit: z.string().min(1).max(BUSINESS_METRIC_LIMITS.maxUnitLength),
  description: z.string().max(BUSINESS_METRIC_LIMITS.maxDescriptionLength).optional(),
  kind: z.enum(BUSINESS_METRIC_KINDS),
  /** Required when `kind` is "currency", rejected otherwise. */
  currency: z.string().regex(CURRENCY_CODE_PATTERN).optional(),
  costScope: z.array(costFilterSchema).max(BUSINESS_METRIC_LIMITS.maxScopeFilters).optional(),
  savedFilterId: z.string().min(1).optional(),
});

/**
 * One reported day. Re-reporting a day restates it rather than accumulating —
 * see `server-core/cost/metric-ingest.ts` for why that is the only ingest
 * semantics an unattended nightly job can safely retry.
 */
export const businessMetricValueInputSchema = z.object({
  date: isoDate,
  value: z.number().finite(),
});

/** The batch envelope for `POST /business-metrics/{id}/values`. */
export const businessMetricValuesBodySchema = z.object({
  values: z.array(businessMetricValueInputSchema).max(BUSINESS_METRIC_LIMITS.maxValuesPerCall),
});

/**
 * The unit-cost query.
 *
 * There is no `groupBy` and no `topN`, and their absence is the contract: a
 * per-group ratio needs a per-group denominator, and the org has declared one
 * series of values. Offering the field would let a caller divide each service's
 * spend by the *whole* customer count and get numbers that do not sum to the
 * real one.
 */
export const unitCostQueryRequestSchema = z.object({
  from: isoDate,
  to: isoDate,
  binning: z.enum(COST_BINNINGS),
  /** Absent is "unit_cost". */
  mode: z.enum(UNIT_COST_MODES).optional(),
  /** Narrowing on top of the metric's own scope — never a replacement for it. */
  filters: z.array(costFilterSchema).optional(),
  query: z.string().max(COST_QUERY_MAX_LENGTH).optional(),
  savedFilterId: z.string().min(1).optional(),
  costBasis: z.enum(COST_BASES).optional(),
  chargeTypes: z.array(z.enum(COST_CHARGE_TYPES)).optional(),
  /** Ignored for `margin`, which always converts to the metric's currency. */
  displayCurrency: z.string().regex(CURRENCY_CODE_PATTERN).optional(),
});

/** Same compile-time proof as above, for the unit-cost half of the contract. */
export type SchemasMatchBusinessMetricContract = [
  Exact<z.infer<typeof businessMetricInputSchema>, BusinessMetricInput>,
  Exact<z.infer<typeof businessMetricValueInputSchema>, BusinessMetricValueInput>,
  Exact<z.infer<typeof unitCostQueryRequestSchema>, UnitCostQueryRequest>,
];

/* ------------------------------------------------------------------ *
 * Managed accounts and invoices — POST/PUT /managed-accounts,
 * POST/PUT /invoices, POST /invoices/{id}/void.
 * ------------------------------------------------------------------ */

/**
 * A managed account is a customer. Note what is *not* in this schema: no tag
 * match, no priority, no rule of any kind. Which spend belongs to a customer is
 * already answered by cost centres and their allocation rules, and a second
 * vocabulary over the same columns would eventually give the organisation two
 * answers to one question.
 *
 * The semantic rules — the scope ids existing, and belonging to no other
 * customer — live in `server-core/src/cost/managed-accounts.ts`, because they
 * are questions about other rows that no schema can answer.
 */
export const managedAccountInputSchema = z.object({
  name: z.string().min(1).max(MANAGED_ACCOUNT_LIMITS.maxNameLength),
  contactName: z.string().max(MANAGED_ACCOUNT_LIMITS.maxContactNameLength).nullish(),
  contactEmail: z.string().max(MANAGED_ACCOUNT_LIMITS.maxContactEmailLength).nullish(),
  billingAddress: z.string().max(MANAGED_ACCOUNT_LIMITS.maxAddressLength).nullish(),
  billingCurrency: z.string().regex(CURRENCY_CODE_PATTERN),
  costBasis: z.enum(COST_BASES).optional(),
  applyBillingRules: z.boolean().optional(),
  notes: z.string().max(MANAGED_ACCOUNT_LIMITS.maxNotesLength).nullish(),
  costCentreIds: z.array(z.string().min(1)).max(MANAGED_ACCOUNT_LIMITS.maxCostCentres).default([]),
  accountIds: z.array(z.string().min(1)).max(MANAGED_ACCOUNT_LIMITS.maxAccounts).default([]),
});

/**
 * Raising an invoice. No status field: a new invoice is always a draft, because
 * generating and issuing are two acts and letting one call do both would mean a
 * mistyped period could reach a customer with nobody having read the numbers.
 *
 * No currency or scope either — both come from the customer, so an invoice
 * cannot be raised over a scope its customer does not own.
 */
export const managedInvoiceInputSchema = z.object({
  managedAccountId: z.string().min(1),
  periodFrom: isoDate,
  periodTo: isoDate,
  notes: z.string().max(MANAGED_INVOICE_LIMITS.maxNotesLength).nullish(),
  supersedesInvoiceId: z.string().min(1).nullish(),
});

/** Editing a draft. Accepted only while the invoice is a draft; see the service. */
export const managedInvoiceUpdateSchema = z.object({
  periodFrom: isoDate,
  periodTo: isoDate,
  notes: z.string().max(MANAGED_INVOICE_LIMITS.maxNotesLength).nullish(),
});

/**
 * Voiding. `reason` is required and non-empty: it is the only record of why a
 * customer was sent an invoice that was then withdrawn.
 *
 * `supersede` raises the corrective draft in the same act, linked both ways to
 * the original — the common case, and doing it in one call is what keeps the
 * pair from being left half-made by a failed second request.
 */
export const managedInvoiceVoidSchema = z.object({
  reason: z.string().min(1).max(MANAGED_INVOICE_LIMITS.maxVoidReasonLength),
  supersede: z.boolean().default(false),
});

/**
 * Sending. The body exists for one flag, and the flag exists because the two
 * reasons to press Send twice are not the same act:
 *
 * - a **retry** after a delivery that reached nobody needs no confirmation, and
 *   the server allows it without this flag;
 * - a **second copy** of an invoice that already landed does need one, because
 *   the customer's inbox is the thing being written to.
 *
 * `resend` is the caller saying, in as many words, that they mean the second.
 */
export const managedInvoiceSendSchema = z.object({
  resend: z.boolean().default(false),
});

/**
 * Compile-time proof that the invoice schemas still parse to exactly the wire
 * types in client-core. Same trick as the cost contract above.
 */
export type SchemasMatchManagedAccountContract = [
  Exact<z.infer<typeof managedInvoiceUpdateSchema>, ManagedInvoiceUpdate>,
];
