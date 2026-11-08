/**
 * What a cost query answers with (`POST /costs/query`), and the billing-rule
 * summary every adjusted cost answer carries.
 *
 * Shared because more than one domain documents them: running a saved report
 * (`POST /cost-reports/:id/run`) returns exactly a cost query result, and the
 * showback report embeds the same adjustment summary. `CostQueryResponse` is
 * also the VS Code and Raycast extensions', the desktop's, the mobile app's
 * and the chat tools' contract, so it states exactly the fields the
 * hand-written spec did and nothing more: the handlers send the service's
 * value untouched through `respond`.
 */
import { Schema } from "effect";
import { BILLING_RULE_KINDS } from "@infrawrench/client-core";
import { CostDimension, pattern } from "../../schemas";
import { Uuid } from "./common";

/** A calendar day, `YYYY-MM-DD`; annotated before the check so a description survives. */
export const costDay = (annotations: { readonly description?: string } = {}) =>
  Schema.String.annotate({ examples: ["2026-07-01"], ...annotations }).check(
    pattern(/^\d{4}-\d{2}-\d{2}$/),
  );

/** One of the cost dimensions a filter, a group-by or an X axis names. */
/** The one `CostDimension` component, shared with the request schemas. */
export { CostDimension };

/** A currency code to an amount, described for one use. */
const amounts = (description: string) =>
  Schema.Record(Schema.String, Schema.Finite).annotate({ description });

export const CostAdjustmentSummary = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      id: Uuid,
      name: Schema.String,
      kind: Schema.Literals(BILLING_RULE_KINDS),
      summary: Schema.String.annotate({ examples: ["+15% on tag team=platform"] }),
    }),
  ).annotate({ description: "The enabled rules in force for this answer, in evaluation order." }),
  rawTotals: amounts(
    "The collected, unadjusted totals for exactly the same rows, summed in the same scan. " +
      "Always present on an adjusted answer; this is the figure that reconciles against an " +
      "invoice. Per-series raw figures are deliberately not offered: after a reallocation the " +
      "series are a different partition of the same money.",
  ),
  fixedTotals: amounts(
    "Fixed-amount charges over the period, pro-rated. On a cost query these are reported " +
      "here and **not** folded into `totals`, which stays the sum of the series; the figure an " +
      "organisation reports internally is the adjusted total plus this. On a showback report " +
      "they are additionally booked onto the cost centre the rule names.",
  ),
}).annotate({
  identifier: "CostAdjustmentSummary",
  description:
    "What an adjusted answer did. Present whenever the request asked to be adjusted, even for " +
    "an organisation with no rules; its absence means, and can only mean, that every figure " +
    "in the response is exactly what the providers charged.",
});

export const CostSeriesPoint = Schema.Struct({
  bucket: Schema.String.annotate({
    description:
      "The bin's start date (YYYY-MM-DD), or, when the request set `xAxis`, the dimension " +
      "value this point belongs to (`__other__` for the folded remainder).",
    examples: ["2026-07-01"],
  }),
  amount: Schema.Finite,
}).annotate({ identifier: "CostSeriesPoint" });

const CostXAxisInfo = Schema.Struct({
  dimension: CostDimension,
  tagKey: Schema.optionalKey(Schema.String),
  segment: Schema.Literals(["none", "dimension", "date"]).annotate({
    description:
      "What each series is: one per `groupBy` value (`dimension`), one per date bin (`date`; " +
      "the series key is the bin start), or one unsegmented series per currency (`none`).",
  }),
  values: Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String })).annotate({
    description: "The axis values in drawing order: ranked by spend, then `__other__`.",
  }),
}).annotate({
  identifier: "CostXAxisInfo",
  description:
    "Set when the request put a dimension on the X axis. Every series point (and every " +
    "comparison point) is then keyed by dimension value rather than date, and the comparison " +
    "is folded onto the current period's values so each value is compared with itself.",
});

const CostForecastSeriesPoint = Schema.Struct({
  bucket: costDay(),
  amount: Schema.Finite.annotate({ description: "The trend's expected amount for the day." }),
  low: Schema.optionalKey(
    Schema.Finite.annotate({
      description:
        "Lower end of the day's prediction interval at `forecastConfidenceLevel` (the classical " +
        "least-squares interval, widening with distance from the data), clamped at zero.",
    }),
  ),
  high: Schema.optionalKey(
    Schema.Finite.annotate({ description: "Upper end of the day's prediction interval." }),
  ),
}).annotate({ identifier: "CostForecastSeriesPoint" });

const CostQuerySeries = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  currency: Schema.String,
  points: Schema.Array(CostSeriesPoint),
}).annotate({ identifier: "CostQuerySeries" });

const CostScenarioResult = Schema.Struct({
  modelId: Uuid,
  modelName: Schema.String,
  currency: Schema.String,
  points: Schema.Array(CostSeriesPoint).annotate({
    description:
      "The adjusted projection; exactly the same days as `forecast`, never one more or fewer. " +
      "A scenario modifies the projected region; it does not extend it, and it can never " +
      "touch a day that already has recorded spend behind it.",
  }),
  contributions: Schema.Array(
    Schema.Struct({
      adjustmentId: Schema.String,
      label: Schema.String,
      kind: Schema.Literals(["one_off", "recurring", "rate_change"]),
      amount: Schema.Finite,
    }),
  ).annotate({
    description: "Signed total each adjustment added across the horizon, in model order.",
  }),
  totalDelta: Schema.Finite.annotate({
    description: "Signed difference from the baseline across the horizon.",
  }),
  convertedFrom: Schema.optionalKey(
    Schema.String.annotate({
      description: "Set when the model's amounts were converted at the org's stated rates.",
    }),
  ),
  outOfScope: Schema.Array(Schema.String).annotate({
    description:
      "Adjustments this chart's own filters exclude, by label; a GCP commitment on an " +
      "AWS-filtered chart is correctly left out, and saying so is what makes the number " +
      "trustworthy rather than quietly assumed broken.",
  }),
}).annotate({ identifier: "CostScenarioResult" });

export const CostQueryResponse = Schema.Struct({
  series: Schema.Array(CostQuerySeries),
  comparison: Schema.optionalKey(Schema.Array(CostQuerySeries)),
  forecast: Schema.optionalKey(
    Schema.Array(CostForecastSeriesPoint).annotate({
      description:
        "The **unadjusted trend** projection. Stays the trend even when a scenario is applied, " +
        "so a reader can always see what the fit said before anybody's assumptions touched it.",
    }),
  ),
  forecastConfidenceLevel: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Two-sided level, in percent, of the `low`/`high` band on `forecast` (80).",
    }),
  ),
  scenario: Schema.optionalKey(CostScenarioResult),
  currencies: Schema.Array(Schema.String),
  totals: amounts(
    "Period total per currency, and always exactly the sum of `series`. Fixed-amount " +
      "billing-rule charges are deliberately **not** folded in here; they have no series " +
      "behind them and are reported in `adjustment.fixedTotals` instead.",
  ),
  previousTotals: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  adjustment: Schema.optionalKey(CostAdjustmentSummary),
  measure: Schema.optionalKey(
    Schema.Literals(["usage", "count"]).annotate({
      description:
        "Set when the request measured something other than money; absent means every amount " +
        'is money in its series\' currency. For both, series carry `currency: ""` and the ' +
        'totals are keyed by `""`.',
    }),
  ),
  usageUnit: Schema.optionalKey(
    Schema.String.annotate({ description: "The unit a `usage` response is in." }),
  ),
  xAxis: Schema.optionalKey(CostXAxisInfo),
}).annotate({ identifier: "CostQueryResponse" });
