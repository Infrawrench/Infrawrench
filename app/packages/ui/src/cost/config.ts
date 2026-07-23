/**
 * Shared config schemas + types for cost widgets. Single source of truth for
 * the web API (request/config validation), the widget config editors, and the
 * card renderers — web and desktop-cloud-mode both consume these through
 * `@infrawrench/ui/cost`.
 */
import { z } from "zod";

export const COST_DIMENSIONS = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "tag",
] as const;
export type CostDimensionId = (typeof COST_DIMENSIONS)[number];

export const costFilterSchema = z.object({
  dimension: z.enum(COST_DIMENSIONS),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  /** Required when dimension === "tag". */
  tagKey: z.string().optional(),
});
export type CostFilter = z.infer<typeof costFilterSchema>;

export const COST_RANGE_PRESETS = [
  "7d",
  "30d",
  "90d",
  "mtd",
  "last_month",
  "qtd",
  "ytd",
  "12m",
] as const;
export type CostRangePreset = (typeof COST_RANGE_PRESETS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const costDateRangeSchema = z.union([
  z.object({ kind: z.literal("relative"), preset: z.enum(COST_RANGE_PRESETS) }),
  z.object({ kind: z.literal("absolute"), from: isoDate, to: isoDate }),
]);
export type CostDateRange = z.infer<typeof costDateRangeSchema>;

export const COST_CHART_TYPES = ["stacked_bar", "multi_bar", "line", "area", "pie"] as const;
export type CostChartType = (typeof COST_CHART_TYPES)[number];

export const COST_BINNINGS = ["daily", "weekly", "monthly", "cumulative"] as const;
export type CostBinningId = (typeof COST_BINNINGS)[number];

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
});
export type CostGraphConfig = z.infer<typeof costGraphConfigSchema>;

/** A budget widget is a dashboard view onto a budgets row — alerts outlive it. */
export const budgetWidgetConfigSchema = z.object({
  version: z.literal(1),
  budgetId: z.string().min(1),
});
export type BudgetWidgetConfig = z.infer<typeof budgetWidgetConfigSchema>;

export const budgetThresholdSchema = z.object({
  type: z.enum(["actual", "forecast"]),
  /** Percent of the budget amount at which this threshold fires (1–1000). */
  percent: z.number().int().min(1).max(1000),
});
export type BudgetThreshold = z.infer<typeof budgetThresholdSchema>;

export const budgetInputSchema = z.object({
  name: z.string().min(1).max(120),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default("USD"),
  filters: z.array(costFilterSchema).default([]),
  thresholds: z.array(budgetThresholdSchema).min(1).max(10),
});
export type BudgetInput = z.infer<typeof budgetInputSchema>;

export const DASHBOARD_WIDGET_KINDS = ["cost_graph", "budget"] as const;
export type DashboardWidgetKind = (typeof DASHBOARD_WIDGET_KINDS)[number];

export function widgetConfigSchemaFor(kind: DashboardWidgetKind) {
  return kind === "cost_graph" ? costGraphConfigSchema : budgetWidgetConfigSchema;
}

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
});
export type CostQueryRequest = z.infer<typeof costQueryRequestSchema>;

export interface CostSeriesPoint {
  /** Bucket start date, YYYY-MM-DD. */
  bucket: string;
  amount: number;
}

export interface CostQuerySeries {
  /** Group value ("" when ungrouped); "__other__" for the folded remainder. */
  key: string;
  /** Display label resolved server-side (account names, provider names). */
  label: string;
  currency: string;
  points: CostSeriesPoint[];
}

export interface CostQueryResponse {
  series: CostQuerySeries[];
  /** Same query shifted back one full period, when requested. */
  comparison?: CostQuerySeries[];
  /** Projected daily totals beyond the last observed day, when requested. */
  forecast?: CostSeriesPoint[];
  /** Distinct currencies present — length > 1 means mixed-currency display. */
  currencies: string[];
  /** Period total per currency. */
  totals: Record<string, number>;
  previousTotals?: Record<string, number>;
}

/** Sentinel group key for the folded "Other" series. */
export const OTHER_GROUP_KEY = "__other__";

/**
 * Resolve a widget date range to inclusive ISO dates. Relative presets are
 * anchored to `today` (UTC). Exported for reuse by the API layer so server
 * and client agree on preset semantics.
 */
export function resolveCostDateRange(
  range: CostDateRange,
  today = new Date(),
): { from: string; to: string } {
  if (range.kind === "absolute") return { from: range.from, to: range.to };
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const to = iso(today);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  switch (range.preset) {
    case "7d":
      return { from: iso(new Date(today.getTime() - 6 * 86_400_000)), to };
    case "30d":
      return { from: iso(new Date(today.getTime() - 29 * 86_400_000)), to };
    case "90d":
      return { from: iso(new Date(today.getTime() - 89 * 86_400_000)), to };
    case "mtd":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to };
    case "last_month":
      return {
        from: iso(new Date(Date.UTC(y, m - 1, 1))),
        to: iso(new Date(Date.UTC(y, m, 0))),
      };
    case "qtd":
      return { from: iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1))), to };
    case "ytd":
      return { from: iso(new Date(Date.UTC(y, 0, 1))), to };
    case "12m":
      return { from: iso(new Date(Date.UTC(y - 1, m, today.getUTCDate()))), to };
  }
}

/** Widget row shape shared by API responses and the dashboard UIs. */
export interface DashboardWidget {
  id: string;
  dashboardId: string;
  kind: DashboardWidgetKind;
  title: string;
  config: CostGraphConfig | BudgetWidgetConfig;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}
