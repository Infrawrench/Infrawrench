/**
 * A saved cost graph (the config a `cost_graph` card, a report and a canvas
 * chart all store) and a report run's one-off overrides, as Effect schemas.
 */
import { Effect, Schema } from "effect";
import {
  COST_CHART_TYPES,
  COST_COMPARISON_STYLES,
  COST_DIMENSIONS,
  costDisplayProblem,
  type CostGraphConfig as CostGraphConfigContract,
  type CostReportRunOverrides as CostReportRunOverridesContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import {
  CostBasisValue,
  CostBinning,
  CostCumulative,
  CostDateRange,
  CostGroupBy,
  CostMeasure,
  CostSegmentByDate,
  CostUsageUnit,
  CostXAxis,
  CostXAxisTagKey,
} from "./cost-enums";
import { CostFilter } from "./cost-filter";
import { NonEmptyString } from "./primitives";
import {
  businessMetricLabelKey,
  UnitCostLabelFilter,
  UnitCostMode,
  UnitCostScaleValue,
} from "./unit-costs";

/** A report's (and a saved graph's) filter terms, under the component name reports use. */
export const CostReportFilter = CostFilter.annotate({ identifier: "CostReportFilter" });

/**
 * The fields of a saved graph. Everything after `showForecast` is optional
 * and never defaulted: absent is what every config written before the field
 * existed draws, and a default would rewrite those configs on their next save.
 */
export const costGraphConfigFields = {
  version: Schema.Literal(1),
  chartType: Schema.Literals(COST_CHART_TYPES).annotate({
    description:
      "How the series are drawn. `pie` and `donut` draw period totals per group; `table` lists " +
      "every bucket as a row with a column per series and a total.",
  }),
  binning: CostBinning,
  dateRange: CostDateRange,
  groupBy: CostGroupBy,
  /** Required when groupBy is "tag". */
  groupByTagKey: Schema.optionalKey(Schema.String),
  filters: Schema.mutable(Schema.Array(CostReportFilter)).pipe(
    Schema.withDecodingDefaultKey(Effect.sync(() => [])),
  ),
  savedFilterId: Schema.optionalKey(
    NonEmptyString.annotate({
      description:
        "A saved cost filter (see /saved-cost-filters) applied by reference and AND-composed " +
        "with `filters` at query time, server-side. Editing the saved filter changes every " +
        "graph, report and budget referencing it; a reference that fails to resolve makes " +
        "the query error rather than silently run unfiltered.",
    }),
  ),
  /** Groups beyond the top N fold into an "Other" series. */
  topN: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 15 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(5)),
  ),
  comparePreviousPeriod: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  showForecast: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  scenarioModelId: Schema.optionalKey(
    NonEmptyString.annotate({
      description:
        "A scenario model (see /cost-scenarios) overlaid on the forecast; known future cost the " +
        "trend cannot see, drawn as a second dashed line beside the trend rather than instead " +
        "of it. Only meaningful alongside `showForecast`.",
    }),
  ),
  costBasis: Schema.optionalKey(CostBasisValue),
  unitCostMetricId: Schema.optionalKey(
    NonEmptyString.annotate({
      description:
        "Divide spend by this business metric (an id, so a key rename never re-points the graph).",
    }),
  ),
  unitCostMode: Schema.optionalKey(UnitCostMode).annotateKey({
    description:
      "The calculation. `usage_unit_cost` needs `unitCostUsageUnit` instead of a metric; the " +
      "others need `unitCostMetricId`.",
  }),
  unitCostScale: Schema.optionalKey(
    UnitCostScaleValue.annotate({
      description: '"Per N units" for a ratio, or the unit a raw metric is shown in. Absent is 1.',
    }),
  ),
  unitCostUsageUnit: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(120)).annotate({
      description: "`usage_unit_cost` only: the provider usage unit to divide by.",
    }),
  ),
  unitCostLabelFilters: Schema.optionalKey(
    Schema.mutable(Schema.Array(UnitCostLabelFilter))
      .check(maxLength(10))
      .annotate({ description: "Keep only metric values carrying these labels." }),
  ),
  unitCostGroupByLabel: Schema.optionalKey(
    businessMetricLabelKey({ description: "One line per value of this metric label." }),
  ),
  adjusted: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Draw the org's billing rules applied." }),
  ),
  measure: Schema.optionalKey(CostMeasure),
  usageUnit: Schema.optionalKey(CostUsageUnit),
  cumulative: Schema.optionalKey(CostCumulative),
  xAxis: Schema.optionalKey(CostXAxis),
  xAxisTagKey: Schema.optionalKey(CostXAxisTagKey),
  segmentByDate: Schema.optionalKey(CostSegmentByDate),
  comparisonStyle: Schema.optionalKey(
    Schema.Literals(COST_COMPARISON_STYLES).annotate({
      description:
        "How `comparePreviousPeriod` is drawn: `line` (omitted) is the dashed totals line, " +
        "`bars` a previous-period bar beside each bar (bar charts only). Tables always list " +
        "previous, change and change % columns.",
    }),
  ),
};

/**
 * The cross-field rules `costDisplayProblem` states (a usage card names its
 * unit, a count card has a group-by, neither carries a forecast), on `xAxis`
 * when the axis is what has to change and on `measure` otherwise, so an
 * editor highlights the field to fix.
 */
export const costGraphConfigCheck = Schema.makeFilter(
  (config: Schema.Struct.Type<typeof costGraphConfigFields>) => {
    const problem = costDisplayProblem({ ...config, forecast: config.showForecast });
    if (!problem) return undefined;
    const onAxis =
      config.xAxis !== undefined &&
      !costDisplayProblem({ ...config, forecast: config.showForecast, xAxis: undefined });
    return { path: [onAxis ? "xAxis" : "measure"], issue: problem };
  },
);

/** zod's `costGraphConfigSchema`. */
export const CostGraphConfig = Schema.Struct(costGraphConfigFields)
  // Described before the check: a description annotated after one lands on
  // the check, which the JSON Schema drops.
  .annotate({
    description:
      "The saved graph. Identical to the config an ad-hoc `cost_graph` dashboard widget stores " +
      "inline: a report is that config given a name and an id.",
  })
  .check(costGraphConfigCheck)
  .annotate({ identifier: "CostGraphConfig" });

/** Body of `POST /cost-reports/:id/run`: one-off display overrides, never saved. */
export const CostReportRunOverrides = Schema.Struct({
  measure: Schema.optionalKey(CostMeasure),
  usageUnit: Schema.optionalKey(CostUsageUnit),
  binning: Schema.optionalKey(CostBinning),
  cumulative: Schema.optionalKey(CostCumulative),
  xAxis: Schema.optionalKey(
    Schema.Literals(["date", ...COST_DIMENSIONS]).annotate({
      description:
        "Put a dimension on the X axis for this run, or `date` to put the date bins back on a " +
        "report saved with a dimension axis. A dimension axis drops the saved forecast and " +
        "scenario for the run; a count or running total falls back to the date axis.",
    }),
  ),
  xAxisTagKey: Schema.optionalKey(CostXAxisTagKey),
}).annotate({ identifier: "CostReportRunOverrides" });

export type CostGraphSchemasMatchContract = [
  Exact<typeof CostGraphConfig.Type, CostGraphConfigContract>,
  Exact<typeof CostReportRunOverrides.Type, CostReportRunOverridesContract>,
];
[true, true] satisfies CostGraphSchemasMatchContract;
