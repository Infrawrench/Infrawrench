/**
 * Cost annotation bodies, as Effect schemas: a dated note on cost charts, and
 * the one-sentence explanation of an anomaly that becomes one.
 *
 * Shape only, deliberately: the semantic rules (a non-empty note, an end that
 * is not before the start, a span under a year) are `costAnnotationInputError`
 * and `costAnomalyExplanationError` (client-core), which the editors and the
 * service both run, so a form refuses exactly what the API refuses.
 */
import { Schema } from "effect";
import {
  COST_ANNOTATION_LIMITS,
  type CostAnnotationInput as CostAnnotationInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { IsoDate, NonEmptyString } from "./primitives";

const AnnotationDay = IsoDate.annotate({ examples: ["2026-07-15"] });

/** Create/update body for a cost annotation (POST/PUT /cost-annotations). */
export const CostAnnotationInput = Schema.Struct({
  startDate: AnnotationDay.annotate({
    description:
      "Inclusive first day (UTC) the note is about. Mapped to whichever bucket holds it at the " +
      "chart's binning: daily and cumulative use the day itself, weekly the Monday that starts " +
      "its week, monthly the first of its month.",
  }),
  endDate: Schema.optionalKey(
    Schema.NullOr(AnnotationDay).annotate({
      description:
        "Inclusive last day, or null for a note about a single moment. A deploy is a moment; a " +
        "migration is a week, and a week spelled as seven notes misstates how many things happened. " +
        "An end equal to the start is stored as null; the same fact has one spelling.",
    }),
  ),
  text: Schema.String.check(minLength(1), maxLength(COST_ANNOTATION_LIMITS.maxTextLength)),
  /** Nullable so "make this note org-wide again" can be said; null is every chart. */
  costReportId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description:
        "The report this note is scoped to, or null for **org-wide**. Null is the useful default: " +
        'an org-wide note is drawn on every cost chart, because "we changed instance types" is ' +
        "not a fact about one report. An id from another org is a 400.",
    }),
  ),
}).annotate({ identifier: "CostAnnotationInput" });

/**
 * Body for acknowledging an anomaly (POST /costs/anomalies/:id/acknowledge).
 * One field: the note's date is the anomalous day and its scope org-wide,
 * both derived from the finding. Documented inline, under no component name.
 */
export const CostAnomalyAcknowledge = Schema.Struct({
  explanation: Schema.String.check(
    minLength(1),
    maxLength(COST_ANNOTATION_LIMITS.maxTextLength),
  ).annotate({
    description:
      "One sentence on what caused the spend. Becomes the annotation's text, so " +
      "the annotation's 500-character ceiling applies.",
  }),
});

export type CostAnnotationSchemasMatchContract = [
  Exact<typeof CostAnnotationInput.Type, CostAnnotationInputContract>,
];
[true] satisfies CostAnnotationSchemasMatchContract;
