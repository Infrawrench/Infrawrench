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
  COST_ANOMALY_LIMITS,
  COST_ANOMALY_SMS_MODES,
  COST_BASES,
  COST_BINNINGS,
  COST_CHARGE_TYPES,
  COST_CHART_TYPES,
  COST_DIMENSIONS,
  COST_RANGE_PRESETS,
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
} from "@infrawrench/client-core";

export {
  COST_DIMENSIONS,
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
  normalizeCostReportName,
  duplicateCostReportName,
  type CostReport,
  type CostReportInput,
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
 * `folderId` is accepted and stored now so a client can round-trip it; the
 * folders table it will reference does not exist yet, so nothing else reads it.
 * Nullable rather than merely optional because "move this out of its folder"
 * has to be expressible.
 */
export const costReportInputSchema = z.object({
  name: z.string().min(1).max(COST_REPORT_LIMITS.maxNameLength),
  description: z.string().max(COST_REPORT_LIMITS.maxDescriptionLength).optional(),
  config: costGraphConfigSchema,
  folderId: z.string().min(1).nullable().optional(),
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
  thresholds: z.array(budgetThresholdSchema).min(1).max(10),
  /** Which number the budget tracks; absent is cash. */
  costBasis: z.enum(COST_BASES).optional(),
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
  topN: z.number().int().min(1).max(15).default(5),
  comparePreviousPeriod: z.boolean().default(false),
  forecast: z.boolean().default(false),
  /** Which number to sum; absent is cash, the basis every older client sends. */
  costBasis: z.enum(COST_BASES).optional(),
  /** Restrict to these charge types; absent is all of them. */
  chargeTypes: z.array(z.enum(COST_CHARGE_TYPES)).optional(),
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
  Exact<z.infer<typeof budgetThresholdSchema>, BudgetThreshold>,
  Exact<z.infer<typeof budgetInputSchema>, BudgetInput>,
  Exact<z.infer<typeof costAnomalySettingsSchema>, CostAnomalySettings>,
  Exact<z.infer<typeof costQueryRequestSchema>, CostQueryRequest>,
  Exact<z.infer<typeof customGraphWidgetConfigSchema>, CustomGraphWidgetConfig>,
  Exact<z.infer<typeof requiredTagSchema>, RequiredTag>,
  Exact<z.infer<typeof tagPolicySchema>, TagPolicy>,
  Exact<z.infer<typeof allocationRuleMatchSchema>, AllocationRuleMatch>,
  Exact<z.infer<typeof allocationRuleInputSchema>, AllocationRuleInput>,
];
