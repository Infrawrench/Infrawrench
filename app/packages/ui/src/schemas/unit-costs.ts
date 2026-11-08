/**
 * The unit-cost vocabulary a saved graph and the unit-cost query share: the
 * calculation, its scale, and the metric labels that narrow or split it.
 */
import { Schema } from "effect";
import {
  BUSINESS_METRIC_KEY_PATTERN,
  BUSINESS_METRIC_LIMITS,
  UNIT_COST_MODES,
  UNIT_COST_SCALES,
  type UnitCostLabelFilter as UnitCostLabelFilterContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, normalized, pattern } from "./checks";
import type { Exact } from "./contract";

export const UnitCostMode = Schema.Literals(UNIT_COST_MODES).annotate({
  identifier: "UnitCostMode",
  description:
    "`unit_cost` is spend ÷ metric value. `margin` is `(revenue − spend) ÷ revenue` as a " +
    "fraction, with the absolute margin beside it, and needs a `currency` metric. " +
    "`usage_unit_cost` is spend ÷ the usage quantity providers report in one `usageUnit`, and " +
    "needs no metric (use `POST /business-metrics/usage-unit-costs`). `raw_metric` plots the " +
    "metric itself beside spend, where zero and negative values are real points.",
});

/** zod's `unitCostScaleSchema`, undocumented: the saved graph lists it inline. */
export const UnitCostScaleValue = Schema.Literals(UNIT_COST_SCALES);

export const UnitCostScale = UnitCostScaleValue.annotate({
  identifier: "UnitCostScale",
  description:
    '"Per N units": multiplies a ratio (cost per 1,000 requests) and divides a raw metric. ' +
    "Margin ignores it. Absent is 1.",
});

/** A business-metric label key: trimmed and lower-cased, then the metric-key slug rule. */
export const BusinessMetricLabelKey = normalized(
  (value) => value.trim().toLowerCase(),
  [
    minLength(1),
    maxLength(BUSINESS_METRIC_LIMITS.maxLabelKeyLength),
    pattern(BUSINESS_METRIC_KEY_PATTERN, {
      message: "expected a lowercase slug, e.g. customer",
    }),
  ],
  {
    description: "A label key: a lowercase slug, normalised (trimmed, lowercased) on write.",
    examples: ["customer"],
  },
);

export const UnitCostLabelFilter = Schema.Struct({
  key: BusinessMetricLabelKey,
  op: Schema.Literals(["in", "not_in"]),
  values: Schema.mutable(
    Schema.Array(
      Schema.String.check(minLength(1), maxLength(BUSINESS_METRIC_LIMITS.maxLabelValueLength)),
    ),
  ).check(minLength(1), maxLength(200)),
}).annotate({ identifier: "UnitCostLabelFilter" });

export type UnitCostSchemasMatchContract = [
  Exact<typeof UnitCostLabelFilter.Type, UnitCostLabelFilterContract>,
];
[true] satisfies UnitCostSchemasMatchContract;
