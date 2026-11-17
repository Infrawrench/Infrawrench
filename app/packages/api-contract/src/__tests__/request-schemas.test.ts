/**
 * The decisions the request schemas in `src/schemas/` make: which inputs each
 * accepts and refuses, and what an accepted input decodes to (defaults
 * filled, strings trimmed, numbers rounded, unknown keys dropped).
 *
 * These began as a parity suite against the zod schemas the Effect ones
 * replaced; the fixtures are that suite's, the decoded values in the
 * snapshot are the ones both libraries agreed on, and the form messages are
 * the sentences zod wrote. Inputs are JSON values, what the API receives.
 */
import { Result, Schema, type SchemaAST } from "effect";
import { describe, expect, it } from "vitest";
import {
  BUDGET_LIMITS,
  DEFAULT_BILLING_RULE_INPUT,
  DEFAULT_BUDGET_INPUT,
  DEFAULT_COST_ALERT_INPUT,
  DEFAULT_COST_ANOMALY_SETTINGS,
  DEFAULT_COST_EFFICIENCY_SETTINGS,
  DEFAULT_COST_GRAPH_CONFIG,
  DEFAULT_K8S_EFFICIENCY_CONFIG,
  DEFAULT_KPI_WIDGET_CONFIG,
  DEFAULT_MANAGED_ACCOUNT_PRICING,
  DEFAULT_METRIC_ALERT_INPUT,
  DEFAULT_RESOURCE_REPORT_CONFIG,
} from "@infrawrench/client-core";
import * as E from "../schemas";

type Outcome = { ok: true; value: unknown } | { ok: false };

function viaEffect(
  schema: Schema.ConstraintDecoder<unknown>,
  input: unknown,
  options?: SchemaAST.ParseOptions,
): Outcome {
  const decoded = Schema.decodeUnknownResult(schema)(input, options);
  return Result.isSuccess(decoded) ? { ok: true, value: decoded.success } : { ok: false };
}

interface Pair {
  readonly name: string;
  readonly effect: Schema.ConstraintDecoder<unknown>;
  /** Decode options for the Effect side: the strict bodies' `STRICT_PARSE_OPTIONS`. */
  readonly options?: SchemaAST.ParseOptions;
  readonly accept: ReadonlyArray<unknown>;
  readonly reject: ReadonlyArray<unknown>;
}

const s = (n: number, c = "x") => c.repeat(n);
const DAY = "2026-07-01";
const F = { dimension: "service", op: "in", values: ["AmazonEC2"] };
const TAG_F = { dimension: "tag", op: "in", tagKey: "env", values: ["prod"] };
const BAD_F = { dimension: "service", op: "in", values: [] };
const RANGE = { kind: "relative", preset: "30d" };
const GRAPH = DEFAULT_COST_GRAPH_CONFIG;
const MIN_GRAPH = {
  version: 1,
  chartType: "line",
  binning: "daily",
  dateRange: RANGE,
  groupBy: "none",
};
const RECIPIENTS = { userIds: ["u1"], addresses: ["finance@example.com"] };
const BUDGET = { ...DEFAULT_BUDGET_INPUT, name: "Platform" };
const ALERT = { ...DEFAULT_COST_ALERT_INPUT, name: "Spend jump" };
const ANOMALY = { ...DEFAULT_COST_ANOMALY_SETTINGS };
const EFFICIENCY = { ...DEFAULT_COST_EFFICIENCY_SETTINGS };
const BILLING_RULE = { ...DEFAULT_BILLING_RULE_INPUT, name: "Overhead" };
const PRICING = DEFAULT_MANAGED_ACCOUNT_PRICING;
const KPI = {
  ...DEFAULT_KPI_WIDGET_CONFIG,
  source: { ...DEFAULT_KPI_WIDGET_CONFIG.source, reportId: "r1" },
};
const K8S = DEFAULT_K8S_EFFICIENCY_CONFIG;
const RR = DEFAULT_RESOURCE_REPORT_CONFIG;
const METRIC_RULE = { ...DEFAULT_METRIC_ALERT_INPUT, name: "CPU", metricKey: "CPU %" };
const SCENARIO_ADJ = { id: "a1", label: "New cluster", kind: "one_off", startDate: DAY };
const VT_RULE = { kind: "value", value: "payments" };
const CANVAS_SPEC = {
  version: 1,
  blocks: [
    { id: "spend", kind: "kpi", title: "Spend", metric: { type: "spend", dateRange: RANGE } },
    { id: "intro", kind: "text", text: "Spend is {{spend}}." },
    { id: "chart", kind: "chart", title: "Daily", config: GRAPH },
    {
      id: "table",
      kind: "table",
      title: "Top",
      query: { dateRange: RANGE, binning: "none", groupBy: "service" },
    },
    { id: "anoms", kind: "anomalies", title: "Anomalies" },
  ],
};
const STRICT = E.STRICT_PARSE_OPTIONS;

const pairs: ReadonlyArray<Pair> = [
  {
    name: "costFilter",
    effect: E.CostFilter,
    accept: [
      F,
      TAG_F,
      { dimension: "tag", op: "is_set", tagKey: "env", values: [] },
      { ...F, extra: 1 },
    ],
    reject: [
      BAD_F,
      { ...F, dimension: "colour" },
      { ...F, op: "like" },
      { dimension: "service", op: "contains", values: [""] },
    ],
  },
  {
    name: "costDateRange",
    effect: E.CostDateRange,
    accept: [RANGE, { kind: "absolute", from: DAY, to: "2026-07-31" }],
    reject: [
      { kind: "relative", preset: "2y" },
      { kind: "absolute", from: "2026-7-1", to: DAY },
      { kind: "both" },
    ],
  },
  {
    name: "costGraphConfig",
    effect: E.CostGraphConfig,
    accept: [
      GRAPH,
      MIN_GRAPH,
      { ...MIN_GRAPH, unknown: true },
      { ...GRAPH, filters: [F, TAG_F], topN: 15, costBasis: "amortized" },
      { ...GRAPH, measure: "usage", usageUnit: "Hrs" },
      {
        ...GRAPH,
        unitCostMetricId: "m1",
        unitCostGroupByLabel: "  Customer ",
        unitCostScale: 1000,
      },
      { ...GRAPH, unitCostLabelFilters: [{ key: " Plan ", op: "in", values: ["pro"] }] },
      { ...GRAPH, xAxis: "service", groupBy: "none" },
    ],
    reject: [
      { ...GRAPH, topN: 0 },
      { ...GRAPH, topN: 16 },
      { ...GRAPH, topN: 1.5 },
      { ...GRAPH, version: 2 },
      { ...GRAPH, filters: [BAD_F] },
      { ...GRAPH, savedFilterId: "" },
      { ...GRAPH, measure: "usage" },
      { ...GRAPH, measure: "count", groupBy: "none" },
      { ...GRAPH, xAxis: "service", showForecast: true },
      { ...GRAPH, unitCostScale: 10 },
      { ...GRAPH, unitCostGroupByLabel: "Not A Slug" },
      { ...GRAPH, unitCostLabelFilters: [{ key: "plan", op: "in", values: [] }] },
      { ...GRAPH, xAxisTagKey: s(257) },
    ],
  },
  {
    name: "costReportRunOverrides",
    effect: E.CostReportRunOverrides,
    accept: [
      {},
      { measure: "usage", usageUnit: "Hrs", binning: "monthly", xAxis: "date" },
      { cumulative: true },
    ],
    reject: [{ xAxis: "colour" }, { usageUnit: "" }, { usageUnit: s(65) }, { binning: "yearly" }],
  },
  {
    name: "budgetWidgetConfig",
    effect: E.BudgetWidgetConfig,
    accept: [{ version: 1, budgetId: "b1" }],
    reject: [{ version: 1, budgetId: "" }, { version: 2, budgetId: "b1" }, { version: 1 }],
  },
  {
    name: "costReportWidgetConfig",
    effect: E.CostReportWidgetConfig,
    accept: [{ version: 1, reportId: "r1" }],
    reject: [{ version: 1, reportId: "" }, { version: 1 }],
  },
  {
    name: "costReportInput",
    effect: E.CostReportInput,
    accept: [
      { name: "Spend", config: GRAPH },
      { name: "Spend", description: "", config: MIN_GRAPH, folderId: null },
      { name: s(120), config: GRAPH, folderId: "f1" },
    ],
    reject: [
      { name: "", config: GRAPH },
      { name: s(121), config: GRAPH },
      { name: "Spend", config: { version: 1 } },
      { name: "Spend", config: GRAPH, folderId: "" },
      { name: "Spend", config: GRAPH, description: s(2001) },
    ],
  },
  {
    name: "costReportFolderInput",
    effect: E.CostReportFolderInput,
    accept: [
      { name: "Finance" },
      { name: "Finance", parentFolderId: null },
      { name: "Finance", parentFolderId: "p" },
    ],
    reject: [{ name: "" }, { name: "Finance", parentFolderId: "" }, { name: s(121) }],
  },
  {
    name: "costReportBulkRequest",
    effect: E.CostReportBulkRequest,
    accept: [
      { action: "delete", reportIds: ["r1"], folderIds: [] },
      { action: "move", reportIds: [], folderIds: ["f1"], targetFolderId: null },
      { action: "move", reportIds: ["r1"], folderIds: ["f1"], targetFolderId: "f2" },
    ],
    reject: [
      { action: "delete", reportIds: [], folderIds: [] },
      { action: "move", reportIds: ["r1"], folderIds: [] },
      { action: "archive", reportIds: ["r1"], folderIds: [] },
      {
        action: "delete",
        reportIds: Array.from({ length: 300 }, (_, i) => `r${i}`),
        folderIds: Array.from({ length: 300 }, (_, i) => `f${i}`),
      },
      { action: "delete", reportIds: [""], folderIds: [] },
    ],
  },
  {
    name: "costAnnotationInput",
    effect: E.CostAnnotationInput,
    accept: [
      { startDate: DAY, text: "Migrated" },
      { startDate: DAY, endDate: null, text: "Migrated", costReportId: null },
      { startDate: DAY, endDate: "2026-07-08", text: "Migrated", costReportId: "r1" },
    ],
    reject: [
      { startDate: "July 1", text: "Migrated" },
      { startDate: DAY, text: "" },
      { startDate: DAY, text: s(501) },
      { startDate: DAY, text: "x", costReportId: "" },
    ],
  },
  {
    name: "costAnomalyAcknowledge",
    effect: E.CostAnomalyAcknowledge,
    accept: [{ explanation: "Planned load test" }],
    reject: [{ explanation: "" }, { explanation: s(501) }, {}],
  },
  {
    name: "budgetAlertNote",
    effect: E.BudgetAlertNoteInput,
    accept: [{ note: "Expected" }],
    reject: [{ note: "" }, { note: s(501) }],
  },
  {
    name: "budgetThreshold",
    effect: E.BudgetThreshold,
    accept: [
      { type: "actual", percent: 1 },
      { type: "forecast", percent: 1000 },
    ],
    reject: [
      { type: "actual", percent: 0 },
      { type: "actual", percent: 1001 },
      { type: "actual", percent: 50.5 },
      { type: "maybe", percent: 50 },
    ],
  },
  {
    name: "alertEmailRecipients",
    effect: E.AlertEmailRecipients,
    accept: [RECIPIENTS, { userIds: [], addresses: [] }],
    reject: [{ userIds: [""], addresses: [] }, { userIds: [], addresses: ["ab"] }, { userIds: [] }],
  },
  {
    name: "budgetPeriod",
    effect: E.BudgetPeriod,
    accept: [
      { kind: "recurring", unit: "month", interval: 3, startDate: DAY },
      { kind: "explicit", periods: [{ start: DAY, end: "2026-07-31", amountCents: 100 }] },
    ],
    reject: [
      { kind: "recurring", unit: "month", interval: 0, startDate: DAY },
      { kind: "explicit", periods: [] },
      { kind: "explicit", periods: [{ start: DAY, end: DAY, amountCents: 0 }] },
      { kind: "weekly" },
    ],
  },
  {
    name: "budgetInput",
    effect: E.BudgetInput,
    accept: [
      BUDGET,
      { name: "Bare", thresholds: [{ type: "actual", percent: 100 }] },
      { ...BUDGET, measure: "usage", usageUnit: "  Hrs  ", usageAmount: 10 },
      { ...BUDGET, usageUnit: `  ${s(BUDGET_LIMITS.maxUsageUnitLength)}  ` },
      {
        ...BUDGET,
        emailRecipients: RECIPIENTS,
        period: { kind: "recurring", unit: "week", interval: 2, startDate: DAY },
      },
    ],
    reject: [
      { ...BUDGET, name: "" },
      { ...BUDGET, thresholds: [] },
      { ...BUDGET, currency: "US" },
      { ...BUDGET, amountCents: -1 },
      { ...BUDGET, usageUnit: "   " },
      { ...BUDGET, usageAmount: 0 },
      { ...BUDGET, filters: [BAD_F] },
    ],
  },
  {
    name: "costAlertInput",
    effect: E.CostAlertInput,
    accept: [
      ALERT,
      { name: "Min", cadence: "daily", direction: "both", thresholdPercent: 10 },
      { ...ALERT, groupBy: "tag", groupByTagKey: "team", emailRecipients: RECIPIENTS },
      { ...ALERT, thresholdPercent: null },
    ],
    reject: [
      { name: "Min", cadence: "daily", direction: "both" },
      { ...ALERT, thresholdPercent: null, thresholdAmountCents: null },
      { ...ALERT, groupBy: "tag" },
      { ...ALERT, groupBy: "virtual_tag", groupByTagKey: "" },
      { ...ALERT, thresholdAmountCents: 0 },
      { ...ALERT, cadence: "hourly" },
    ],
  },
  {
    name: "costAnomalySettings",
    effect: E.CostAnomalySettings,
    accept: [
      ANOMALY,
      { ...ANOMALY, sigmas: 2.96 },
      { ...ANOMALY, sigmas: 1.04, feedbackTuning: false, emailRecipients: RECIPIENTS },
    ],
    reject: [
      { ...ANOMALY, sigmas: 0.5 },
      { ...ANOMALY, sigmas: 11 },
      { ...ANOMALY, minDeltaCents: 99 },
      { ...ANOMALY, smsAlerts: undefined },
      { sigmas: 3, minDeltaCents: 1000, newSourceMinCents: 2500 },
    ],
  },
  {
    name: "costAnomalySuppressionInput",
    effect: E.CostAnomalySuppressionInput,
    accept: [
      {
        scope: "service",
        scopeKey: "AmazonEC2",
        recurrence: "weekly",
        anchorDay: DAY,
        expiresOn: "2026-12-31",
      },
      {
        scope: "tag",
        scopeKey: "prod",
        tagKey: "env",
        recurrence: "one_off",
        anchorDay: DAY,
        startsOn: DAY,
        expiresOn: DAY,
        reason: null,
        note: null,
      },
      {
        scope: "provider",
        scopeKey: "aws",
        recurrence: "seasonal",
        anchorDay: DAY,
        expiresOn: DAY,
        reason: "seasonal",
        note: "Black Friday",
      },
    ],
    reject: [
      { scope: "service", scopeKey: "", recurrence: "weekly", anchorDay: DAY, expiresOn: DAY },
      { scope: "region", scopeKey: "x", recurrence: "weekly", anchorDay: DAY, expiresOn: DAY },
      { scope: "service", scopeKey: "x", recurrence: "weekly", anchorDay: DAY },
      {
        scope: "service",
        scopeKey: "x",
        recurrence: "weekly",
        anchorDay: DAY,
        expiresOn: DAY,
        note: s(501),
      },
    ],
  },
  {
    name: "costAnomalyFeedback",
    effect: E.CostAnomalyFeedbackInput,
    accept: [
      { verdict: "expected" },
      { verdict: "unexpected", reason: null, note: null, explain: true },
      {
        verdict: "expected",
        suppress: { recurrence: "monthly", scope: "service", scopeKey: "EC2", expiresOn: DAY },
      },
    ],
    reject: [
      { verdict: "maybe" },
      { verdict: "expected", suppress: { scope: "service" } },
      { verdict: "expected", reason: "boredom" },
    ],
  },
  {
    name: "costEfficiencySettings",
    effect: E.CostEfficiencySettings,
    accept: [
      EFFICIENCY,
      { ...EFFICIENCY, commitmentExpiryHorizonDays: [7, 30, 30, 60] },
      { ...EFFICIENCY, emailRecipients: RECIPIENTS },
    ],
    reject: [
      { ...EFFICIENCY, commitmentExpiryHorizonDays: [] },
      { ...EFFICIENCY, commitmentExpiryHorizonDays: [1, 2, 3, 4, 5, 6, 7] },
      { ...EFFICIENCY, commitmentExpiryHorizonDays: [0] },
      { ...EFFICIENCY, commitmentIdleThresholdPercent: 100 },
      { ...EFFICIENCY, unitCostEnabled: true, unitCostRegressionEnabled: undefined },
    ],
  },
  {
    name: "customGraphWidgetConfig",
    effect: E.CustomGraphWidgetConfig,
    accept: [{ version: 1, graphId: "g1" }],
    reject: [{ version: 1, graphId: "" }],
  },
  {
    name: "costCanvasWidgetConfig",
    effect: E.CostCanvasWidgetConfig,
    accept: [{ version: 1, canvasId: "c1" }],
    reject: [{ version: 1, canvasId: "" }],
  },
  {
    name: "realizedSavingsWidgetConfig",
    effect: E.RealizedSavingsWidgetConfig,
    accept: [{ version: 1, grouping: "kind", months: 6 }],
    reject: [
      { version: 1, grouping: "kind", months: 0 },
      { version: 1, grouping: "colour", months: 6 },
    ],
  },
  {
    name: "kpiWidgetConfigObject",
    effect: E.KpiWidgetConfigObject,
    accept: [
      KPI,
      { ...KPI, source: { kind: "budget", budgetId: "b1", measure: "actual" }, dateRange: RANGE },
    ],
    reject: [
      { ...KPI, source: { kind: "budget", measure: "actual" } },
      { ...KPI, comparePreviousPeriod: undefined },
    ],
  },
  {
    name: "kpiWidgetConfig",
    effect: E.KpiWidgetConfig,
    accept: [
      KPI,
      { ...KPI, source: { kind: "realized_savings" }, upIsGood: true },
      { ...KPI, source: { kind: "commitments", measure: "savings" }, dateRange: RANGE },
    ],
    reject: [
      DEFAULT_KPI_WIDGET_CONFIG,
      { ...KPI, source: { kind: "budget", budgetId: "b1", measure: "actual" }, dateRange: RANGE },
      { ...KPI, source: { kind: "fx" } },
    ],
  },
  {
    name: "textWidgetConfig",
    effect: E.TextWidgetConfig,
    accept: [
      { version: 1, markdown: "" },
      { version: 1, markdown: "# Hi" },
    ],
    reject: [{ version: 1, markdown: s(100_001) }, { version: 1 }],
  },
  {
    name: "dashboardKpiRequest",
    effect: E.DashboardKpiRequest,
    accept: [{ config: KPI }],
    reject: [{ config: DEFAULT_KPI_WIDGET_CONFIG }, {}],
  },
  {
    name: "realizedSavingsSettings",
    effect: E.RealizedSavingsSettings,
    accept: [{ horizonMonths: 12, shortfallThresholdPercent: 70, baselineWindowDays: 14 }],
    reject: [
      { horizonMonths: 0, shortfallThresholdPercent: 70, baselineWindowDays: 14 },
      { horizonMonths: 12, shortfallThresholdPercent: 70 },
    ],
  },
  {
    name: "savingsEventInput",
    effect: E.SavingsEventInput,
    accept: [
      {
        title: "  Rightsized db  ",
        occurredOn: DAY,
        projectedMonthlyAmount: 120.5,
        currency: "USD",
      },
      {
        title: "X",
        note: null,
        occurredOn: DAY,
        endedOn: null,
        projectedMonthlyAmount: 1,
        currency: "EUR",
        resourceId: null,
        accountId: "a1",
        costCentreId: null,
        horizonMonths: null,
      },
      { title: `  ${s(200)}  `, occurredOn: DAY, projectedMonthlyAmount: 1, currency: "USD" },
    ],
    reject: [
      { title: "   ", occurredOn: DAY, projectedMonthlyAmount: 1, currency: "USD" },
      { title: "X", occurredOn: DAY, projectedMonthlyAmount: 0, currency: "USD" },
      { title: "X", occurredOn: DAY, projectedMonthlyAmount: 1, currency: "usd" },
      { title: "X", occurredOn: DAY, projectedMonthlyAmount: 1, currency: "USD", resourceId: "" },
    ],
  },
  {
    name: "savingsEventAnnotation",
    effect: E.SavingsEventAnnotation,
    accept: [{}, { note: null, costCentreId: "c1", horizonMonths: 6, endedOn: DAY }],
    reject: [{ horizonMonths: 0 }, { endedOn: "soon" }, { costCentreId: "" }],
  },
  {
    name: "requiredTag",
    effect: E.RequiredTag,
    accept: [{ key: "owner" }, { key: "env", allowedValues: ["prod", "dev"] }],
    reject: [{ key: "" }, { key: "env", allowedValues: [""] }],
  },
  {
    name: "tagPolicy",
    effect: E.TagPolicy,
    accept: [{ requiredTags: [{ key: "owner" }], enforceOnCreate: true }],
    reject: [{ requiredTags: [] }, { requiredTags: [{ key: "" }], enforceOnCreate: false }],
  },
  {
    name: "tagKeySettings",
    effect: E.TagKeySettings,
    accept: [
      { hidden: ["  aws:cloudformation:*  ", "Name"], preferred: [" team ", "env"] },
      { hidden: [], preferred: [] },
    ],
    reject: [
      { hidden: ["*"], preferred: [] },
      { hidden: ["a*b"], preferred: [] },
      { hidden: [], preferred: ["team*"] },
      { hidden: ["   "], preferred: [] },
      { hidden: [] },
    ],
  },
  {
    name: "costCentreInput",
    effect: E.CostCentreInput,
    accept: [
      { name: "Platform" },
      { name: "Platform", description: "", parentId: null },
      { name: "Web", parentId: "c1" },
    ],
    reject: [
      { name: "" },
      { name: "Platform", parentId: "" },
      { name: "Platform", description: s(2001) },
    ],
  },
  {
    name: "allocationRuleMatch",
    effect: E.AllocationRuleMatch,
    accept: [
      {},
      { tagKey: "team", tagValue: "web" },
      { tagValue: "  " },
      { virtualTagKey: "team", virtualTagValue: "web", accountId: "a1" },
    ],
    reject: [{ tagValue: "web" }, { virtualTagValue: "web" }, { tagKey: "" }, { pluginId: "" }],
  },
  {
    name: "allocationRuleInput",
    effect: E.AllocationRuleInput,
    accept: [
      { costCentreId: "c1", priority: 0, match: {} },
      { costCentreId: "c1", priority: 100_000, match: { service: "EC2" } },
    ],
    reject: [
      { costCentreId: "c1", priority: -1, match: {} },
      { costCentreId: "", priority: 0, match: {} },
      { costCentreId: "c1", priority: 0, match: { tagValue: "x" } },
    ],
  },
  {
    name: "costQueryRequest",
    effect: E.CostQueryRequest,
    accept: [
      { from: DAY, to: "2026-07-31", binning: "daily", groupBy: "none" },
      {
        from: DAY,
        to: DAY,
        binning: "monthly",
        groupBy: "tag",
        groupByTagKey: "env",
        filters: [TAG_F],
        forecast: true,
        topN: 15,
      },
      {
        from: DAY,
        to: DAY,
        binning: "daily",
        groupBy: "none",
        query: "provider = 'aws'",
        chargeTypes: ["usage", "credit"],
        displayCurrency: "EUR",
        measure: "usage",
        usageUnit: "Hrs",
      },
    ],
    reject: [
      { from: DAY, binning: "daily", groupBy: "none" },
      { from: DAY, to: DAY, binning: "daily", groupBy: "colour" },
      { from: DAY, to: DAY, binning: "daily", groupBy: "none", displayCurrency: "eur" },
      { from: DAY, to: DAY, binning: "daily", groupBy: "none", chargeTypes: ["gift"] },
      { from: DAY, to: DAY, binning: "daily", groupBy: "none", query: s(4001) },
      { from: DAY, to: DAY, binning: "daily", groupBy: "none", topN: 0 },
    ],
  },
  {
    name: "focusExportRequest",
    effect: E.FocusExportRequest,
    accept: [
      { from: DAY, to: DAY },
      { from: DAY, to: DAY, filters: [F], version: "1.4", binning: "daily" },
    ],
    reject: [{ from: DAY, to: DAY, version: "2.0" }, { from: DAY }],
  },
  {
    name: "costExportJobRequest",
    effect: E.CostExportJobRequest,
    accept: [
      { format: "csv", reportId: "r1" },
      {
        format: "focus",
        focusVersion: "1.3",
        from: DAY,
        to: DAY,
        query: { filters: [F], dimensions: ["service"], tagKeys: ["env"] },
      },
    ],
    reject: [
      { format: "xlsx" },
      { format: "csv", query: { dimensions: Array.from({ length: 9 }, () => "service") } },
      { format: "csv", from: "yesterday" },
    ],
  },
  {
    name: "billingRuleMatch",
    effect: E.BillingRuleMatch,
    accept: [{}, { tagKey: "team", tagValue: "web", chargeType: "usage" }],
    reject: [{ tagValue: "web" }, { chargeType: "gift" }],
  },
  {
    name: "billingRuleAdjustment",
    effect: E.BillingRuleAdjustment,
    accept: [
      { kind: "percentage", percent: 15 },
      {
        kind: "fixed",
        amount: -50,
        currency: "USD",
        period: "monthly",
        targetKind: "account",
        targetId: "a1",
      },
      {
        kind: "tiered",
        currency: "USD",
        tiers: [
          { upTo: 1000, percent: 5 },
          { upTo: null, percent: 2 },
        ],
        tierMode: "marginal",
        tierScope: "overall",
      },
      { kind: "expression", expression: "cost * 1.1" },
    ],
    reject: [
      { kind: "percentage", percent: -101 },
      { kind: "fixed", amount: 2_000_000_000 },
      { kind: "fixed", currency: "usd" },
      { kind: "tiered", tiers: [{ upTo: 0, percent: 5 }] },
      { kind: "magic" },
    ],
  },
  {
    name: "billingRuleInput",
    effect: E.BillingRuleInput,
    accept: [
      BILLING_RULE,
      { name: "Min", priority: 1, match: {}, adjustment: { kind: "percentage", percent: 1 } },
    ],
    reject: [
      { ...BILLING_RULE, name: "" },
      { ...BILLING_RULE, priority: 100_001 },
      { ...BILLING_RULE, managedAccountIds: [""] },
    ],
  },
  {
    name: "billingRuleReorder",
    effect: E.BillingRuleReorder,
    accept: [{ ids: ["a", "b"] }],
    reject: [{ ids: [] }, { ids: [""] }],
  },
  {
    name: "managedAccountPricing",
    effect: E.ManagedAccountPricing,
    accept: [
      PRICING,
      {
        ...PRICING,
        rerate: {
          enabled: true,
          scope: [{ pluginId: "aws", service: null }, { pluginId: "gcp" }],
          fallbackUpliftPercent: 5,
          uplifts: [{ pluginId: "aws", percent: 3 }],
        },
        discounts: { mode: "partial", passThroughPercent: 50 },
      },
    ],
    reject: [
      { ...PRICING, rerate: { ...PRICING.rerate, fallbackUpliftPercent: -200 } },
      { ...PRICING, credits: { mode: "keep" } },
      { ...PRICING, rerate: { ...PRICING.rerate, scope: [{ pluginId: "" }] } },
    ],
  },
  {
    name: "pricingPreviewRequest",
    effect: E.PricingPreviewRequest,
    accept: [
      {},
      { rule: BILLING_RULE, ruleId: null, managedAccountId: "m1", pricing: null, month: "2026-09" },
      { month: null },
    ],
    reject: [{ month: "2026-13" }, { month: "2026-9" }, { rule: { name: "" } }],
  },
  {
    name: "virtualTagSource",
    effect: E.VirtualTagSource,
    accept: [
      { tagKey: "Environment" },
      { tagKey: "env", valuePrefix: "az-", query: "provider = 'azure'" },
    ],
    reject: [{ tagKey: "" }, { tagKey: "env", valuePrefix: s(65) }],
  },
  {
    name: "virtualTagAllocation",
    effect: E.VirtualTagAllocation,
    accept: [{ value: "web" }, { value: "web", percent: 100, metricId: null }],
    reject: [{ value: "web", percent: 0 }, { value: "web", percent: 101 }, { value: "" }],
  },
  {
    name: "virtualTagRule",
    effect: E.VirtualTagRule,
    accept: [
      VT_RULE,
      {
        kind: "split",
        allocations: [
          { value: "a", percent: 50 },
          { value: "b", percent: 50 },
        ],
        startsOn: DAY,
        endsOn: null,
      },
    ],
    reject: [
      { kind: "guess" },
      { kind: "value", startsOn: "tomorrow" },
      { kind: "tag", valueTransform: "title" },
    ],
  },
  {
    name: "virtualTagInput",
    effect: E.VirtualTagInput,
    accept: [
      { key: "team", name: "Team", rules: [VT_RULE] },
      { key: "a:b/c.d-e_f", name: "X", description: null, defaultValue: null, rules: [] },
    ],
    reject: [
      { key: "-team", name: "Team", rules: [] },
      { key: "team", name: "", rules: [] },
      { key: "", name: "T", rules: [] },
      { key: "t", name: "T" },
    ],
  },
  {
    name: "currencySettings",
    effect: E.CurrencySettingsInput,
    accept: [
      { displayCurrency: null },
      { displayCurrency: " eur ", autoRates: true, rateBasis: "month_end" },
    ],
    reject: [{}, { displayCurrency: "euro" }, { displayCurrency: "USD", rateBasis: "weekly" }],
  },
  {
    name: "exchangeRateInput",
    effect: E.ExchangeRateInput,
    accept: [
      { fromCurrency: "eur", toCurrency: " usd ", rate: " 1.0850 ", effectiveFrom: DAY },
      {
        fromCurrency: "JPY",
        toCurrency: "USD",
        rate: "0.0067",
        effectiveFrom: DAY,
        effectiveTo: null,
      },
    ],
    reject: [
      { fromCurrency: "EUR", toCurrency: "USD", rate: "0", effectiveFrom: DAY },
      { fromCurrency: "EUR", toCurrency: "USD", rate: "-1", effectiveFrom: DAY },
      { fromCurrency: "EUR", toCurrency: "USD", rate: "1,08", effectiveFrom: DAY },
      { fromCurrency: "EURO", toCurrency: "USD", rate: "1", effectiveFrom: DAY },
    ],
  },
  {
    name: "exchangeRateImportRequest",
    effect: E.ExchangeRateImportRequest,
    accept: [{ csv: "from,to,rate\n" }, { csv: "", dryRun: true, skipInvalid: false }],
    reject: [{ csv: s(512 * 1024 + 1) }, {}],
  },
  {
    name: "savedCostFilterInput",
    effect: E.SavedCostFilterInput,
    accept: [
      { name: "Prod" },
      { name: "Prod", filters: [TAG_F], description: "" },
      { name: "Prod", query: "tag['env'] = 'prod'" },
    ],
    reject: [
      { name: "" },
      { name: "Prod", filters: [BAD_F] },
      { name: "Prod", filters: Array.from({ length: 51 }, () => F) },
    ],
  },
  {
    name: "costScenarioAdjustment",
    effect: E.CostScenarioAdjustment,
    accept: [
      SCENARIO_ADJ,
      { ...SCENARIO_ADJ, kind: "rate_change", percent: -20, scope: [F], endDate: null },
    ],
    reject: [
      { ...SCENARIO_ADJ, id: "" },
      { ...SCENARIO_ADJ, amountCents: 1.5 },
      { ...SCENARIO_ADJ, currency: "usd" },
    ],
  },
  {
    name: "costScenarioModelInput",
    effect: E.CostScenarioModelInput,
    accept: [
      { name: "Q4", currency: "USD" },
      { name: "Q4", currency: "USD", adjustments: [SCENARIO_ADJ] },
    ],
    reject: [
      { name: "Q4", currency: "us" },
      { name: "", currency: "USD" },
    ],
  },
  {
    name: "businessMetricInput",
    effect: E.BusinessMetricInput,
    accept: [
      { key: "  Active-Customers ", name: "Customers", unit: "customer", kind: "count" },
      {
        key: "revenue",
        name: "Revenue",
        unit: "USD",
        kind: "currency",
        currency: "USD",
        costScope: [F],
        labelMappings: [
          {
            label: " Customer ",
            target: { kind: "dimension", dimension: "tag", tagKey: "customer" },
          },
        ],
        thresholds: [
          {
            mode: "margin",
            direction: "below",
            value: 30,
            groupByLabel: "customer",
            windowDays: 7,
          },
        ],
      },
    ],
    reject: [
      { key: "has space", name: "X", unit: "u", kind: "count" },
      { key: "   ", name: "X", unit: "u", kind: "count" },
      { key: "k", name: "X", unit: "u", kind: "ratio" },
      {
        key: "k",
        name: "X",
        unit: "u",
        kind: "count",
        thresholds: [{ mode: "unit_cost", direction: "above", value: 1, windowDays: 0 }],
      },
      {
        key: "k",
        name: "X",
        unit: "u",
        kind: "count",
        labelMappings: [{ label: "x", target: { kind: "account" } }],
      },
    ],
  },
  {
    name: "businessMetricValueInput",
    effect: E.BusinessMetricValueInput,
    accept: [
      { date: DAY, value: 0 },
      { date: DAY, value: -3.5, label: "acme", labels: { plan: "pro" } },
    ],
    reject: [
      { date: DAY, value: "1" },
      { date: "1 July", value: 1 },
      { date: DAY, value: 1, labels: { plan: 1 } },
    ],
  },
  {
    name: "businessMetricValuesBody",
    effect: E.BusinessMetricValuesBody,
    accept: [{ values: [] }, { values: [{ date: DAY, value: 1 }] }],
    reject: [{}, { values: [{ date: DAY }] }],
  },
  {
    name: "unitCostQueryRequest",
    effect: E.UnitCostQueryRequest,
    accept: [
      { from: DAY, to: DAY, binning: "daily" },
      {
        from: DAY,
        to: DAY,
        binning: "weekly",
        mode: "margin",
        scale: 100,
        labelFilters: [{ key: " Plan", op: "not_in", values: ["free"] }],
        groupByLabel: "Customer",
        filters: [F],
        displayCurrency: "USD",
      },
    ],
    reject: [
      { from: DAY, to: DAY, binning: "daily", scale: 7 },
      { from: DAY, to: DAY, binning: "daily", usageUnit: "" },
      { from: DAY, to: DAY, binning: "daily", groupByLabel: "a b" },
    ],
  },
  {
    name: "unitCostExportRequest",
    effect: E.UnitCostExportRequest,
    accept: [{ from: DAY, to: DAY, binning: "daily", format: "ndjson" }],
    reject: [{ from: DAY, to: DAY, binning: "daily", format: "pdf" }],
  },
  {
    name: "businessMetricImporterInput",
    effect: E.BusinessMetricImporterInput,
    accept: [
      { accountId: "a1", params: {} },
      {
        accountId: "a1",
        params: { query: "select 1" },
        schedule: "weekly",
        backfillDays: 30,
        timezone: "UTC",
        aggregation: "max",
        enabled: false,
      },
    ],
    reject: [
      { accountId: "a1", params: { "": "x" } },
      { accountId: "a1", params: { [s(65)]: "x" } },
      {
        accountId: "a1",
        params: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])),
      },
      { accountId: "a1", params: { q: s(20_001) } },
      { accountId: "a1", params: {}, backfillDays: 0 },
      { accountId: "", params: {} },
    ],
  },
  {
    name: "businessMetricImportRunRequest",
    effect: E.BusinessMetricImportRunRequest,
    accept: [{}, { from: DAY, to: DAY }],
    reject: [{ from: "now" }],
  },
  {
    name: "businessMetricImportPreviewRequest",
    effect: E.BusinessMetricImportPreviewRequest,
    accept: [{ accountId: "a1", params: { q: "x" }, dryRun: true }],
    reject: [{ accountId: "a1", params: { q: "x" }, timezone: "" }, { accountId: "a1" }],
  },
  {
    name: "businessMetricSourceOptionsRequest",
    effect: E.BusinessMetricSourceOptionsRequest,
    accept: [{ accountId: "a1", fieldKey: "table", params: {} }],
    reject: [{ accountId: "a1", fieldKey: "", params: {} }],
  },
  {
    name: "costForecastInput",
    effect: E.CostForecastInput,
    accept: [
      { name: "Plan" },
      {
        name: "Plan",
        description: null,
        scenarioModelIds: ["s1"],
        driverMetricId: null,
        isDefault: true,
      },
    ],
    reject: [
      { name: "" },
      { name: "Plan", scenarioModelIds: [""] },
      { name: "Plan", scenarioModelIds: Array.from({ length: 11 }, (_, i) => `s${i}`) },
    ],
  },
  {
    name: "costForecastRunRequest",
    effect: E.CostForecastRunRequest,
    accept: [
      {},
      {
        from: DAY,
        to: DAY,
        forecastId: "baseline",
        providers: ["aws"],
        services: ["EC2"],
        confidenceLevel: 95,
        all: true,
      },
    ],
    reject: [{ confidenceLevel: 85 }, { providers: [""] }],
  },
  {
    name: "businessMetricForecastValueInput",
    effect: E.BusinessMetricForecastValueInput,
    accept: [{ date: DAY, value: 0 }],
    reject: [{ date: DAY, value: -1 }],
  },
  {
    name: "businessMetricForecastValuesBody",
    effect: E.BusinessMetricForecastValuesBody,
    accept: [{ values: [{ date: DAY, value: 1 }] }],
    reject: [{ values: [] }],
  },
  {
    name: "managedAccountInput",
    effect: E.ManagedAccountInput,
    accept: [
      { name: "Northwind", billingCurrency: "GBP" },
      {
        name: "Northwind",
        billingCurrency: "GBP",
        contactName: null,
        contactEmail: "a@b.c",
        costBasis: "blended",
        applyBillingRules: false,
        pricing: PRICING,
        billingProfileId: null,
        costCentreIds: ["c1"],
        accountIds: ["a1"],
      },
    ],
    reject: [
      { name: "Northwind", billingCurrency: "gbp" },
      { name: "", billingCurrency: "GBP" },
      { name: "N", billingCurrency: "GBP", costCentreIds: [""] },
    ],
  },
  {
    name: "managedInvoiceInput",
    effect: E.ManagedInvoiceInput,
    accept: [
      { managedAccountId: "m1", periodFrom: DAY, periodTo: "2026-07-31" },
      {
        managedAccountId: "m1",
        periodFrom: DAY,
        periodTo: DAY,
        notes: null,
        supersedesInvoiceId: "i1",
      },
    ],
    reject: [
      { managedAccountId: "", periodFrom: DAY, periodTo: DAY },
      { managedAccountId: "m1", periodFrom: DAY },
    ],
  },
  {
    name: "managedInvoiceUpdate",
    effect: E.ManagedInvoiceUpdate,
    accept: [{ periodFrom: DAY, periodTo: DAY, notes: "x" }],
    reject: [{ periodFrom: DAY, periodTo: DAY, notes: s(4001) }],
  },
  {
    name: "managedInvoiceVoid",
    effect: E.ManagedInvoiceVoid,
    accept: [{ reason: "Wrong period" }, { reason: "Wrong period", supersede: true }],
    reject: [{ reason: "" }, {}],
  },
  {
    name: "managedInvoiceSend",
    effect: E.ManagedInvoiceSend,
    accept: [{}, { resend: true }],
    reject: [{ resend: "yes" }],
  },
  {
    name: "billingProfileInput",
    effect: E.BillingProfileInput,
    accept: [
      { name: "EU" },
      {
        name: "EU",
        legalName: null,
        toEmails: ["a@b.c"],
        currency: "EUR",
        paymentTermsDays: 30,
        numberPrefix: "INV",
        numberStart: 1,
        taxRates: [{ name: "VAT", rate: 20 }],
        bank: { iban: "GB00", bic: null },
        logo: null,
      },
    ],
    reject: [
      { name: "" },
      { name: "EU", paymentTermsDays: -1 },
      { name: "EU", taxRates: [{ name: "VAT", rate: 101 }] },
      { name: "EU", bank: { bic: s(12) } },
      { name: "EU", numberPrefix: "" },
    ],
  },
  {
    name: "managedAccountAssignment",
    effect: E.ManagedAccountAssignment,
    accept: [
      { managedAccountId: null },
      { managedAccountId: "m1", costCentreIds: ["c1"], accountIds: [] },
    ],
    reject: [{}, { managedAccountId: "" }],
  },
  {
    name: "managedAccountAssignmentPreview",
    effect: E.ManagedAccountAssignmentPreview,
    accept: [{ managedAccountId: "m1", periodFrom: DAY, periodTo: DAY }],
    reject: [{ managedAccountId: "m1", periodFrom: "last month" }],
  },
  {
    name: "costCanvasBlock",
    effect: E.CostCanvasBlock,
    options: STRICT,
    accept: [
      ...CANVAS_SPEC.blocks,
      { id: "r", kind: "cost_report", reportId: "r1" },
      { id: "b", kind: "budgets", title: "B", budgetIds: ["b1"] },
    ],
    reject: [
      { id: "bad id", kind: "text", text: "x" },
      { id: "t", kind: "text", text: "x", extra: true },
      { id: "c", kind: "chart", title: "C", config: { ...GRAPH, extra: true } },
      { id: "c", kind: "chart", title: "C", config: { ...GRAPH, measure: "usage" } },
      { id: "k", kind: "kpi", title: "K", metric: { type: "budget" } },
      {
        id: "k",
        kind: "kpi",
        title: "K",
        metric: { type: "spend", dateRange: RANGE, filters: [{ ...F, extra: 1 }] },
      },
      { id: "a", kind: "anomalies", title: "A", days: 0 },
      { id: "x", kind: "map", title: "M" },
    ],
  },
  {
    name: "costCanvasSpec",
    effect: E.CostCanvasSpec,
    options: STRICT,
    accept: [CANVAS_SPEC, { version: 1, blocks: [] }],
    reject: [
      { ...CANVAS_SPEC, extra: 1 },
      { version: 1, blocks: [CANVAS_SPEC.blocks[0], CANVAS_SPEC.blocks[0]] },
      { version: 1, blocks: [{ id: "t", kind: "text", text: "{{nope}}" }] },
      {
        version: 1,
        blocks: [
          {
            id: "k",
            kind: "kpi",
            title: "K",
            metric: { type: "budget", budgetId: "b" },
            comparePreviousPeriod: true,
          },
        ],
      },
      {
        version: 1,
        blocks: [
          {
            id: "k",
            kind: "kpi",
            title: "K",
            metric: { type: "forecast", filters: [{ dimension: "tag", op: "is_set", values: [] }] },
          },
        ],
      },
      {
        version: 1,
        blocks: [
          { id: "c", kind: "chart", title: "C", config: { ...GRAPH, scenarioModelId: "s1" } },
        ],
      },
      {
        version: 1,
        blocks: [
          {
            id: "t",
            kind: "table",
            title: "T",
            query: { dateRange: RANGE, binning: "none", groupBy: "tag" },
          },
        ],
      },
      {
        version: 1,
        blocks: Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, kind: "text", text: "x" })),
      },
    ],
  },
  {
    name: "costCanvasInput",
    effect: E.CostCanvasInput,
    options: STRICT,
    accept: [
      { name: "  Weekly  ", spec: CANVAS_SPEC },
      { name: "W", description: "", spec: { version: 1, blocks: [] } },
    ],
    reject: [
      { name: "   ", spec: CANVAS_SPEC },
      { name: "W", spec: CANVAS_SPEC, extra: 1 },
    ],
  },
  {
    name: "costCanvasDraftInput",
    effect: E.CostCanvasDraftInput,
    options: STRICT,
    accept: [{ prompt: "  spend by team  " }, { prompt: "x", name: " N ", model: "claude" }],
    reject: [{ prompt: "  " }, { prompt: "x", model: "" }, { prompt: "x", temperature: 1 }],
  },
  {
    name: "kubernetesEfficiencyConfig",
    effect: E.KubernetesEfficiencyConfig,
    accept: [
      K8S,
      {
        ...K8S,
        filters: [{ dimension: "tag", op: "in", values: ["web"], tagKey: "namespace" }],
        groupBy: "label",
        groupByLabelKey: "team",
        categories: ["cpu"],
      },
    ],
    reject: [
      { ...K8S, groupBy: "label" },
      { ...K8S, filters: [{ dimension: "service", op: "in", values: ["x"] }] },
      { ...K8S, filters: [{ dimension: "tag", op: "in", values: [] }] },
      { ...K8S, idle: "hide" },
    ],
  },
  {
    name: "kubernetesEfficiencyReportInput",
    effect: E.KubernetesEfficiencyReportInput,
    accept: [
      { name: " Clusters ", config: K8S },
      { name: "C", config: K8S, folderId: null, description: "" },
    ],
    reject: [
      { name: "  ", config: K8S },
      { name: "C", config: { ...K8S, granularity: "hour" } },
    ],
  },
  {
    name: "kubernetesEfficiencyQuery",
    effect: E.KubernetesEfficiencyQuery,
    accept: [{ config: K8S }],
    reject: [{}],
  },
  {
    name: "resourceReportTagFilter",
    effect: E.ResourceReportTagFilter,
    options: STRICT,
    accept: [
      { source: "tag", key: "env", op: "in", values: ["prod"] },
      { source: "virtual_tag", key: "team", op: "exists", values: [] },
    ],
    reject: [
      { source: "tag", key: "", op: "in", values: [] },
      { source: "tag", key: "k", op: "in", values: [], extra: 1 },
      { source: "label", key: "k", op: "in", values: [] },
    ],
  },
  {
    name: "resourceReportFilters",
    effect: E.ResourceReportFilters,
    options: STRICT,
    accept: [
      RR.filters,
      {
        ...RR.filters,
        resourceTypes: [{ pluginId: "aws", resourceTypeId: "ec2" }],
        createdFrom: DAY,
      },
    ],
    reject: [
      { ...RR.filters, nameContains: undefined },
      { ...RR.filters, resourceTypes: [{ pluginId: "aws", resourceTypeId: "ec2", extra: 1 }] },
      { ...RR.filters, createdTo: "now" },
    ],
  },
  {
    name: "resourceReportSort",
    effect: E.ResourceReportSort,
    options: STRICT,
    accept: [{ column: "core:name", direction: "asc" }],
    reject: [
      { column: "", direction: "asc" },
      { column: "core:name", direction: "up" },
    ],
  },
  {
    name: "resourceReportConfig",
    effect: E.ResourceReportConfig,
    options: STRICT,
    accept: [RR, { ...RR, sort: { column: "cost:range", direction: "desc" }, pageSize: 500 }],
    reject: [
      { ...RR, columns: [] },
      { ...RR, pageSize: 501 },
      { ...RR, extra: 1 },
      { ...RR, costBasis: "list" },
    ],
  },
  {
    name: "resourceReportInput",
    effect: E.ResourceReportInput,
    options: STRICT,
    accept: [
      { name: " Fleet ", config: RR },
      { name: "F", config: RR, description: "", folderId: null },
    ],
    reject: [
      { name: " ", config: RR },
      { name: "F", config: RR, folderId: "" },
    ],
  },
  {
    name: "resourceReportQueryRequest",
    effect: E.ResourceReportQueryRequest,
    options: STRICT,
    accept: [{ config: RR }, { config: RR, offset: 0, limit: 500 }],
    reject: [
      { config: RR, offset: -1 },
      { config: RR, limit: 0 },
      { config: RR, page: 2 },
    ],
  },
  {
    name: "metricAlertComparator",
    effect: E.MetricAlertComparator,
    accept: [">", "<="],
    reject: ["==", ""],
  },
  {
    name: "metricAlertSelector",
    effect: E.MetricAlertSelector,
    accept: [
      { pluginId: null, resourceTypeId: null, tagKey: null, tagValue: null },
      { pluginId: " aws ", resourceTypeId: "ec2", tagKey: "env", tagValue: "prod" },
    ],
    reject: [
      { pluginId: "  ", resourceTypeId: null, tagKey: null, tagValue: null },
      { pluginId: null, resourceTypeId: null, tagKey: null },
    ],
  },
  {
    name: "metricAlertRuleInput",
    effect: E.MetricAlertRuleInput,
    accept: [
      METRIC_RULE,
      { ...METRIC_RULE, name: `  ${s(120)}  `, threshold: -2.5, cooldownMinutes: 0 },
    ],
    reject: [
      { ...METRIC_RULE, name: "  " },
      { ...METRIC_RULE, forMinutes: 4 },
      { ...METRIC_RULE, cooldownMinutes: 10081 },
      { ...METRIC_RULE, comparator: "==" },
      { ...METRIC_RULE, threshold: "90" },
    ],
  },
];

describe("request schemas", () => {
  for (const pair of pairs) {
    describe(pair.name, () => {
      pair.accept.forEach((input, i) => {
        it(`accepts #${i}`, () => {
          const decoded = viaEffect(pair.effect, input, pair.options);
          expect(decoded.ok).toBe(true);
          expect(decoded).toMatchSnapshot();
        });
      });
      pair.reject.forEach((input, i) => {
        it(`refuses #${i}`, () => {
          expect(viaEffect(pair.effect, input, pair.options).ok).toBe(false);
        });
      });
    });
  }

  it("widgetConfigFor picks each kind's schema", () => {
    const inputs = {
      cost_graph: GRAPH,
      cost_report: { version: 1, reportId: "r1" },
      budget: { version: 1, budgetId: "b1" },
      custom_graph: { version: 1, graphId: "g1" },
      cost_canvas: { version: 1, canvasId: "c1" },
      realized_savings: { version: 1, grouping: "month", months: 12 },
      kpi: KPI,
      text: { version: 1, markdown: "hi" },
    } as const;
    for (const kind of Object.keys(inputs) as Array<keyof typeof inputs>) {
      const decoded = viaEffect(E.widgetConfigFor(kind), inputs[kind]);
      expect(decoded.ok).toBe(true);
      expect(decoded).toMatchSnapshot(kind);
      expect(viaEffect(E.widgetConfigFor(kind), { version: 2 }).ok).toBe(false);
    }
  });

  it("formats a canvas spec failure as one line per problem", () => {
    const spec = { version: 1, blocks: [{ id: "t", kind: "text", text: "{{nope}}" }] };
    const effect = Schema.decodeUnknownResult(E.CostCanvasSpec)(spec, { ...STRICT, errors: "all" });
    expect(Result.isFailure(effect)).toBe(true);
    if (Result.isFailure(effect)) {
      expect(E.formatCostCanvasSpecSchemaIssues(effect.failure.issue)).toBe(
        "blocks.0.text: {{nope}} does not name a kpi block",
      );
    }
  });
});

describe("decodeForm, the editors' safeParse", () => {
  it("drops undefined keys, as the JSON sent to the API does", () => {
    const input = {
      ...GRAPH,
      cumulative: undefined,
      segmentByDate: undefined,
      filters: [{ ...F, tagKey: undefined }],
    };
    // Schema.optionalKey refuses an undefined value; the form helper never hands it one.
    expect(viaEffect(E.CostGraphConfig, input).ok).toBe(false);
    const decoded = E.decodeForm(E.CostGraphConfig, input);
    expect(decoded.success).toBe(true);
    if (decoded.success) {
      expect(decoded.data).toEqual({
        version: 1,
        chartType: "stacked_bar",
        binning: "daily",
        dateRange: { kind: "relative", preset: "30d" },
        groupBy: "provider",
        filters: [{ dimension: "service", op: "in", values: ["AmazonEC2"] }],
        topN: 5,
        comparePreviousPeriod: false,
        showForecast: false,
      });
    }
  });

  const cases: ReadonlyArray<[string, string, Schema.ConstraintDecoder<unknown>, unknown]> = [
    [
      "empty budget name",
      "String must contain at least 1 character(s)",
      E.BudgetInput,
      { ...BUDGET, name: "" },
    ],
    [
      "long budget name",
      "String must contain at most 120 character(s)",
      E.BudgetInput,
      { ...BUDGET, name: s(121) },
    ],
    [
      "no thresholds",
      "Array must contain at least 1 element(s)",
      E.BudgetInput,
      { ...BUDGET, thresholds: [] },
    ],
    [
      "threshold out of range",
      "Number must be greater than or equal to 1",
      E.BudgetInput,
      { ...BUDGET, thresholds: [{ type: "actual", percent: 0 }] },
    ],
    [
      "threshold above range",
      "Number must be less than or equal to 1000",
      E.BudgetInput,
      { ...BUDGET, thresholds: [{ type: "actual", percent: 2000 }] },
    ],
    [
      "fractional threshold",
      "Expected integer, received float",
      E.BudgetInput,
      { ...BUDGET, thresholds: [{ type: "actual", percent: 1.5 }] },
    ],
    [
      "filter without values",
      "A filter needs at least one value.",
      E.BudgetInput,
      { ...BUDGET, filters: [BAD_F] },
    ],
    ["missing name", "Required", E.BudgetInput, { thresholds: BUDGET.thresholds }],
    ["mistyped name", "Expected string, received number", E.BudgetInput, { ...BUDGET, name: 7 }],
    [
      "usage without a unit",
      "Pick a usage unit: quantities in different units (hours, gigabytes, requests) cannot be added together.",
      E.CostGraphConfig,
      { ...GRAPH, measure: "usage" },
    ],
    [
      "axis with a forecast",
      "Forecasts project over time, so they need the date X axis.",
      E.CostGraphConfig,
      { ...GRAPH, xAxis: "service", showForecast: true },
    ],
    [
      "bad chart type",
      "Invalid enum value. Expected 'stacked_bar' | 'multi_bar' | 'line' | 'area' | 'pie' | 'donut' | 'table', received 'radar'",
      E.CostGraphConfig,
      { ...GRAPH, chartType: "radar" },
    ],
    [
      "topN too large",
      "Number must be less than or equal to 15",
      E.CostGraphConfig,
      { ...GRAPH, topN: 16 },
    ],
    [
      "no threshold",
      "Set a percent threshold, an amount threshold, or both",
      E.CostAlertInput,
      { ...ALERT, thresholdPercent: null, thresholdAmountCents: null },
    ],
    [
      "tag group without key",
      "groupByTagKey is required when groupBy is tag or virtual_tag",
      E.CostAlertInput,
      { ...ALERT, groupBy: "tag" },
    ],
    [
      "empty alert name",
      "String must contain at least 1 character(s)",
      E.CostAlertInput,
      { ...ALERT, name: "" },
    ],
    [
      "blank rule name",
      "String must contain at least 1 character(s)",
      E.MetricAlertRuleInput,
      { ...METRIC_RULE, name: "   " },
    ],
    [
      "window too short",
      "Number must be greater than or equal to 5",
      E.MetricAlertRuleInput,
      { ...METRIC_RULE, forMinutes: 1 },
    ],
    [
      "blank metric",
      "String must contain at least 1 character(s)",
      E.MetricAlertRuleInput,
      { ...METRIC_RULE, metricKey: "" },
    ],
    [
      "bad comparator",
      "Invalid enum value. Expected '>' | '>=' | '<' | '<=', received '=='",
      E.MetricAlertRuleInput,
      { ...METRIC_RULE, comparator: "==" },
    ],
  ];

  for (const [name, expected, effectSchema, input] of cases) {
    it(`words the first problem as zod did: ${name}`, () => {
      const decoded = E.decodeForm(effectSchema, input);
      expect(decoded.success).toBe(false);
      if (!decoded.success) expect(decoded.message).toBe(expected);
    });
  }
});
