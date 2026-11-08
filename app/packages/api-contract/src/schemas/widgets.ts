/**
 * Dashboard widget configs, as Effect schemas: what a card stores, keyed by
 * its kind, and the body of the KPI preview route.
 *
 * Most kinds are a view onto an object of their own (a budget, a report, a
 * custom graph, a canvas) and hold its id and nothing else: editing the
 * object once updates every dashboard showing it.
 */
import { Schema } from "effect";
import {
  KPI_AGGREGATIONS,
  KPI_BUDGET_MEASURES,
  KPI_COMMITMENT_MEASURES,
  KPI_REPORT_MEASURES,
  REALIZED_SAVINGS_GROUPINGS,
  REALIZED_SAVINGS_WIDGET_LIMITS,
  SAVINGS_EVENT_KINDS,
  TEXT_WIDGET_LIMITS,
  kpiWidgetConfigProblem,
  type BudgetWidgetConfig as BudgetWidgetConfigContract,
  type CostCanvasWidgetConfig as CostCanvasWidgetConfigContract,
  type CostReportWidgetConfig as CostReportWidgetConfigContract,
  type CustomGraphWidgetConfig as CustomGraphWidgetConfigContract,
  type DashboardWidgetKind,
  type KpiWidgetConfig as KpiWidgetConfigContract,
  type RealizedSavingsWidgetConfig as RealizedSavingsWidgetConfigContract,
  type TextWidgetConfig as TextWidgetConfigContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { CostDateRange } from "./cost-enums";
import { CostGraphConfig } from "./cost-graph";
import { NonEmptyString } from "./primitives";

/** A budget card is a view onto a budgets row: its alerts outlive the card. */
export const BudgetWidgetConfig = Schema.Struct({
  version: Schema.Literal(1),
  budgetId: NonEmptyString,
});

/** A `cost_report` card is a view onto a cost_reports row, with no config of its own. */
export const CostReportWidgetConfig = Schema.Struct({
  version: Schema.Literal(1),
  reportId: NonEmptyString,
});

/** A custom-graph card is a view onto a custom_graphs row. */
export const CustomGraphWidgetConfig = Schema.Struct({
  version: Schema.Literal(1),
  graphId: NonEmptyString,
});

/** A cost-canvas card is a view onto a cost_canvases row. */
export const CostCanvasWidgetConfig = Schema.Struct({
  version: Schema.Literal(1),
  canvasId: NonEmptyString,
});

/** A `realized_savings` card: which breakdown, how many months back. One report per org. */
export const RealizedSavingsWidgetConfig = Schema.Struct({
  version: Schema.Literal(1),
  grouping: Schema.Literals(REALIZED_SAVINGS_GROUPINGS),
  months: Schema.Int.check(
    Schema.isBetween({
      minimum: REALIZED_SAVINGS_WIDGET_LIMITS.minMonths,
      maximum: REALIZED_SAVINGS_WIDGET_LIMITS.maxMonths,
    }),
  ),
});

/** Where a KPI card's figure comes from. Ids only, never a query string. */
export const KpiWidgetSource = Schema.Union(
  [
    Schema.Struct({
      kind: Schema.Literal("cost_report"),
      reportId: NonEmptyString,
      measure: Schema.Literals(KPI_REPORT_MEASURES),
      aggregation: Schema.Literals(KPI_AGGREGATIONS),
      usageUnit: Schema.optionalKey(Schema.String.check(minLength(1), maxLength(64))),
    }),
    Schema.Struct({
      kind: Schema.Literal("budget"),
      budgetId: NonEmptyString,
      measure: Schema.Literals(KPI_BUDGET_MEASURES),
    }),
    Schema.Struct({
      kind: Schema.Literal("commitments"),
      measure: Schema.Literals(KPI_COMMITMENT_MEASURES),
    }),
    Schema.Struct({
      kind: Schema.Literal("realized_savings"),
      eventKind: Schema.optionalKey(Schema.Literals(SAVINGS_EVENT_KINDS)),
    }),
  ],
  { mode: "oneOf" },
).annotate({
  identifier: "KpiWidgetSource",
  description:
    "Where a KPI's figure comes from. A saved report brings its filters, saved filter, cost " +
    "basis and billing-rule choice; `unit_cost` and `business_metric` need a report with a " +
    "business metric attached, `count` a report grouped by a dimension. A budget follows its " +
    "own period. Commitment coverage and utilization are read over the commitments " +
    "service's trailing window; `savings` is the realized savings of kind `commitment`.",
});

const kpiWidgetConfigFields = {
  version: Schema.Literal(1),
  source: KpiWidgetSource,
  dateRange: Schema.optionalKey(CostDateRange).annotateKey({
    description:
      "The window. Absent follows the source (a report's own range, the last 30 days for " +
      "savings); refused for a budget and for commitment coverage and utilization.",
  }),
  comparePreviousPeriod: Schema.Boolean,
  upIsGood: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Which direction the change badge colours as good; absent derives it.",
    }),
  ),
};

/** zod's `kpiWidgetConfigObjectSchema`: the shape, without the cross-field rules. */
export const KpiWidgetConfigObject = Schema.Struct(kpiWidgetConfigFields);

/** A `kpi` card. The cross-field rules are `kpiWidgetConfigProblem`, shared with both editors and the evaluator. */
export const KpiWidgetConfig = Schema.Struct(kpiWidgetConfigFields)
  .check(Schema.makeFilter((config) => kpiWidgetConfigProblem(config) ?? undefined))
  .annotate({ identifier: "KpiWidgetConfig" });

/** A `text` card: markdown, sanitised where it is drawn rather than here. */
export const TextWidgetConfig = Schema.Struct({
  version: Schema.Literal(1),
  markdown: Schema.String.check(maxLength(TEXT_WIDGET_LIMITS.maxLength)),
});

/** POST /dashboards/kpi: evaluate one KPI config (a saved card's, or an editor's preview). */
export const DashboardKpiRequest = Schema.Struct({ config: KpiWidgetConfig }).annotate({
  identifier: "DashboardKpiRequest",
});

/** zod's `widgetConfigSchemaFor`'s table: each widget kind's stored config. */
export const WIDGET_CONFIG_SCHEMAS = {
  cost_graph: CostGraphConfig,
  cost_report: CostReportWidgetConfig,
  budget: BudgetWidgetConfig,
  custom_graph: CustomGraphWidgetConfig,
  cost_canvas: CostCanvasWidgetConfig,
  realized_savings: RealizedSavingsWidgetConfig,
  kpi: KpiWidgetConfig,
  text: TextWidgetConfig,
} as const satisfies Record<DashboardWidgetKind, Schema.Top>;

export function widgetConfigFor<K extends DashboardWidgetKind>(
  kind: K,
): (typeof WIDGET_CONFIG_SCHEMAS)[K] {
  return WIDGET_CONFIG_SCHEMAS[kind];
}

export type WidgetSchemasMatchContract = [
  Exact<typeof BudgetWidgetConfig.Type, BudgetWidgetConfigContract>,
  Exact<typeof CostReportWidgetConfig.Type, CostReportWidgetConfigContract>,
  Exact<typeof CustomGraphWidgetConfig.Type, CustomGraphWidgetConfigContract>,
  Exact<typeof CostCanvasWidgetConfig.Type, CostCanvasWidgetConfigContract>,
  Exact<typeof RealizedSavingsWidgetConfig.Type, RealizedSavingsWidgetConfigContract>,
  Exact<typeof KpiWidgetConfig.Type, KpiWidgetConfigContract>,
  Exact<typeof TextWidgetConfig.Type, TextWidgetConfigContract>,
];
[true, true, true, true, true, true, true] satisfies WidgetSchemasMatchContract;
