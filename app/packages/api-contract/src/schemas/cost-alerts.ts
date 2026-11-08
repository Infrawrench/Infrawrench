/** Change-based cost alert bodies (POST/PUT /cost-alerts), as Effect schemas. */
import { Effect, Schema } from "effect";
import {
  COST_ALERT_LIMITS,
  COST_CHANGE_CADENCES,
  COST_CHANGE_DIRECTIONS,
  isKeyedCostDimension,
  type CostAlertInput as CostAlertInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { AlertEmailRecipients } from "./alert-email";
import { CostDimension, CostFilter } from "./cost-filter";
import { NonEmptyString } from "./primitives";

/** An alert's filter terms are documented under their own component name. */
export const CostAlertFilter = CostFilter.annotate({ identifier: "CostAlertFilter" });

export const CostChangeCadence = Schema.Literals(COST_CHANGE_CADENCES).annotate({
  identifier: "CostChangeCadence",
  description:
    "Which window is compared to which, in complete UTC days (the accruing current day never " +
    "counts). daily: one complete day vs the same weekday one week earlier. weekly: the last " +
    "7 complete days vs the 7 before them. monthly: month-to-date vs the same number of days " +
    "at the start of the prior month; never MTD vs the full prior month.",
});

export const CostChangeDirection = Schema.Literals(COST_CHANGE_DIRECTIONS).annotate({
  identifier: "CostChangeDirection",
});

/**
 * Create/update body for a change-based cost alert. The checks are the
 * contract, not decoration: an alert with no threshold would fire on every
 * wobble (or never), and a tag grouping without a key has nothing to group on.
 */
export const CostAlertInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(COST_ALERT_LIMITS.maxNameLength)),
  filters: Schema.mutable(Schema.Array(CostAlertFilter)).pipe(
    Schema.withDecodingDefaultKey(Effect.sync(() => [])),
  ),
  groupBy: Schema.NullOr(CostDimension)
    .annotate({
      description:
        "Per-group fan-out. Null watches the scope's one total; a dimension watches each group " +
        "against its own prior window, and each offending group fires its own event.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  groupByTagKey: Schema.optionalKey(
    NonEmptyString.annotate({ description: "Required when groupBy is tag." }),
  ),
  cadence: CostChangeCadence,
  thresholdPercent: Schema.NullOr(
    Schema.Int.check(
      Schema.isBetween({
        minimum: COST_ALERT_LIMITS.minPercent,
        maximum: COST_ALERT_LIMITS.maxPercent,
      }),
    ),
  )
    .annotate({
      description:
        "Percent of the prior window's spend the change must reach. At least one of the two " +
        "thresholds must be set; when both are, BOTH must hold before the alert fires.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  thresholdAmountCents: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))
    .annotate({ description: "Cents the change must reach." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  direction: CostChangeDirection,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** Absent leaves the stored recipients alone. */
  emailRecipients: Schema.optionalKey(AlertEmailRecipients),
})
  .check(
    Schema.makeFilter((v) =>
      v.thresholdPercent !== null || v.thresholdAmountCents !== null
        ? undefined
        : {
            path: ["thresholdPercent"],
            issue: "Set a percent threshold, an amount threshold, or both",
          },
    ),
    Schema.makeFilter((v) =>
      v.groupBy === null || !isKeyedCostDimension(v.groupBy) || !!v.groupByTagKey?.trim()
        ? undefined
        : {
            path: ["groupByTagKey"],
            issue: "groupByTagKey is required when groupBy is tag or virtual_tag",
          },
    ),
  )
  .annotate({ identifier: "CostAlertInput" });

export type CostAlertSchemasMatchContract = [
  Exact<typeof CostAlertInput.Type, CostAlertInputContract>,
];
[true] satisfies CostAlertSchemasMatchContract;
