/**
 * The cost query (`POST /costs/query`, a graph config resolved to concrete
 * dates) and the two downloads scoped the same way: the ad-hoc FOCUS export
 * and an export job.
 */
import { Effect, Schema } from "effect";
import {
  COST_EXPORT_JOB_FORMATS,
  COST_QUERY_MAX_LENGTH,
  FOCUS_VERSIONS,
  type CostExportJobRequest as CostExportJobRequestContract,
  type CostQueryRequest as CostQueryRequestContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import {
  CostBasis,
  CostBinning,
  CostChargeType,
  CostCumulative,
  CostGroupBy,
  CostMeasure,
  CostSegmentByDate,
  CostUsageUnit,
  CostXAxis,
  CostXAxisTagKey,
} from "./cost-enums";
import { CostFilter } from "./cost-filter";
import { CurrencyCode, IsoDate, NonEmptyString } from "./primitives";

/** The query's filter terms, registered as `CostFilter`. */
export const CostQueryFilter = CostFilter.annotate({ identifier: "CostFilter" });

const QueryDay = IsoDate.annotate({ examples: ["2026-07-01"] });

const CostQueryText = Schema.String.check(maxLength(COST_QUERY_MAX_LENGTH));

const costQueryRequestFields = {
  from: QueryDay,
  to: QueryDay,
  binning: CostBinning,
  groupBy: CostGroupBy,
  groupByTagKey: Schema.optionalKey(Schema.String),
  filters: Schema.mutable(Schema.Array(CostQueryFilter)).pipe(
    Schema.withDecodingDefaultKey(Effect.sync(() => [])),
  ),
  /**
   * The same filter in the cost query language, compiled server-side to
   * exactly `filters`. Bounded so a runaway string never reaches the tokenizer.
   */
  query: Schema.optionalKey(
    CostQueryText.annotate({
      description:
        "The same filter written as text, in the cost query language; an alternative to " +
        "`filters`, compiled server-side into exactly that structure.\n\n" +
        "Grammar: a conjunction of equality terms joined by `AND`. A term is " +
        "`dimension = 'value'`, `dimension != 'value'`, `dimension IN ('a','b')` or " +
        "`dimension NOT IN ('a','b')`; the tag dimension takes its key in brackets, " +
        "`tag['owner'] = 'platform'`. Keywords are case-insensitive, strings may be single- or " +
        "double-quoted, and a quote inside a value is escaped by doubling it (`'it''s'`) or " +
        "with a backslash (`'it\\'s'`).\n\n" +
        "`OR` is deliberately not supported: the stored filter is a conjunction, so several " +
        "values of one dimension go in an `IN` list and unrelated alternatives need separate " +
        "queries. Anything the structured filter cannot express is a parse error rather than a " +
        "second execution path.\n\n" +
        "Sending both `query` and a non-empty `filters` is a 400, not a precedence rule. A " +
        "parse failure is a 400 whose body carries `queryError` with the character `offset`, " +
        "the `length` of the offending span, and the `expected` alternatives there.",
      examples: ["provider = 'aws' AND tag['env'] != 'dev'"],
    }),
  ),
  savedFilterId: Schema.optionalKey(
    NonEmptyString.annotate({
      description:
        "A saved cost filter (see /saved-cost-filters) applied by reference. Resolved " +
        "server-side at query time and AND-composed with whichever of `filters`/`query` is " +
        "present: unlike those two it is a composition, not an alternative. An id that does " +
        "not resolve to a live filter is a 400; the query is never silently run unfiltered.",
    }),
  ),
  topN: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 15 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(5)),
  ),
  comparePreviousPeriod: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  forecast: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  scenarioModelId: Schema.optionalKey(
    NonEmptyString.annotate({
      description:
        "Apply a scenario model (see /cost-scenarios) to the projection: known future cost the " +
        "trend cannot see. Requires `forecast: true`: sending it without one is a 400, not a " +
        "no-op, because a caller who asked for assumptions and silently got none back is the " +
        "failure this feature exists to prevent. The adjusted projection comes back as " +
        "`scenario`, **alongside** the untouched `forecast`, never instead of it. An id that " +
        "does not resolve is a 400.",
    }),
  ),
  costBasis: Schema.optionalKey(CostBasis),
  chargeTypes: Schema.optionalKey(
    Schema.mutable(Schema.Array(CostChargeType)).annotate({
      description:
        "Restrict to these kinds of charge. Omitted is all of them, which is what makes an " +
        "unfiltered total net rather than gross; credits, refunds and commitment discounts are " +
        "included. Rows collected before charge types existed, and rows from providers that " +
        "cannot distinguish them, are `usage`.",
    }),
  ),
  /**
   * Fold currencies the org holds a rate for into this one. Optional rather
   * than defaulted: absent keeps meaning "no conversion".
   */
  displayCurrency: Schema.optionalKey(CurrencyCode),
  adjusted: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Apply the organization's billing rules (see /billing-rules); markups, discounts, " +
        "reallocations. Omitted (the default, and what every unattended reader sends) is raw " +
        "collected spend. Present, the response carries `adjustment` with the collected totals " +
        "beside the adjusted ones and the rules that moved them; it is set even for an " +
        "organization with no rules, because the absence of that field is the only signal that " +
        "a figure is unadjusted.",
    }),
  ),
  measure: Schema.optionalKey(CostMeasure),
  usageUnit: Schema.optionalKey(CostUsageUnit),
  cumulative: Schema.optionalKey(CostCumulative),
  xAxis: Schema.optionalKey(CostXAxis),
  xAxisTagKey: Schema.optionalKey(CostXAxisTagKey),
  segmentByDate: Schema.optionalKey(CostSegmentByDate),
};

/**
 * zod's `costQueryRequestSchema`. A plain struct on purpose: the cross-field
 * rules (a usage query names its unit, a count query has a group-by, neither
 * carries a forecast; a keyed axis names its key) are the service's, through
 * `costDisplayProblem`.
 */
export const CostQueryRequest = Schema.Struct(costQueryRequestFields).annotate({
  identifier: "CostQueryRequest",
});

/**
 * `POST /costs/focus-export`: exactly the query's scope fields (range, filter
 * in either spelling, saved filter, charge types) and nothing about drawing a
 * graph, plus the FOCUS version.
 */
export const FocusExportRequest = Schema.Struct({
  from: costQueryRequestFields.from,
  to: costQueryRequestFields.to,
  filters: costQueryRequestFields.filters,
  query: costQueryRequestFields.query,
  savedFilterId: costQueryRequestFields.savedFilterId,
  chargeTypes: costQueryRequestFields.chargeTypes,
  version: Schema.optionalKey(
    Schema.Literals(FOCUS_VERSIONS).annotate({
      description: "The FOCUS version to write. Omitted means `1.3`.",
    }),
  ),
}).annotate({ identifier: "FocusExportRequest" });

const ColumnKeys = Schema.mutable(
  Schema.Array(Schema.String.check(minLength(1), maxLength(256))),
).check(maxLength(20));

/**
 * `POST /costs/exports/jobs`. Shape only; the cross-field rules (exactly one
 * of `reportId` and `query`, a range with `query`, the span cap) are the
 * service's, so they come back as one readable 400.
 */
export const CostExportJobRequest = Schema.Struct({
  reportId: Schema.optionalKey(
    NonEmptyString.annotate({
      description:
        "Export a saved cost report's scope: its filters (with its saved filter expanded), its " +
        "group-by as the row identity, its cost basis, and its unit cost when it draws one.",
    }),
  ),
  query: Schema.optionalKey(
    Schema.Struct({
      filters: Schema.optionalKey(
        Schema.mutable(Schema.Array(CostQueryFilter)).check(maxLength(50)),
      ),
      query: Schema.optionalKey(
        CostQueryText.annotate({ description: "Cost query language text." }),
      ),
      savedFilterId: Schema.optionalKey(NonEmptyString),
      chargeTypes: Schema.optionalKey(Schema.mutable(Schema.Array(CostChargeType))),
      costBasis: Schema.optionalKey(CostBasis),
      dimensions: Schema.optionalKey(
        Schema.mutable(Schema.Array(Schema.String.check(minLength(1), maxLength(40))))
          .check(maxLength(8))
          .annotate({
            description:
              "Row identity for the native layouts. Empty: one row per day and currency.",
          }),
      ),
      tagKeys: Schema.optionalKey(
        ColumnKeys.annotate({ description: "Tag keys written as `tag_<key>` columns." }),
      ),
      virtualTagKeys: Schema.optionalKey(
        ColumnKeys.annotate({ description: "Virtual tag keys written as `vtag_<key>` columns." }),
      ),
    }).annotate({ description: "An ad-hoc scope instead of a saved report." }),
  ),
  format: Schema.Literals(COST_EXPORT_JOB_FORMATS).annotate({
    description:
      "`csv` / `ndjson`: Infrawrench's own columns (`day`, the group-by dimension or tag " +
      "columns, `currency`, `amount`, `usage_amount`, `usage_unit`, `exported_at`, " +
      "`collection_watermark`), plus per-day unit-cost columns (`unit_cost_metric`, " +
      "`unit_cost_mode`, `unit_cost_scope_cost`, `unit_cost_metric_value`, `unit_cost_value`, " +
      "`unit_cost_gap`) when the exported report draws a unit cost. `focus`: the FOCUS layout " +
      "at full row grain, as CSV.",
  }),
  focusVersion: Schema.optionalKey(
    Schema.Literals(FOCUS_VERSIONS).annotate({
      description: "FOCUS version for `format: focus`. Omitted means the latest (`1.4`).",
    }),
  ),
  from: Schema.optionalKey(
    IsoDate.annotate({
      description:
        "First day, `YYYY-MM-DD`. Required with `query`; a report defaults to its own range.",
    }),
  ),
  to: Schema.optionalKey(IsoDate.annotate({ description: "Last day, inclusive." })),
}).annotate({ identifier: "CostExportJobRequest" });

export type CostQuerySchemasMatchContract = [
  Exact<typeof CostQueryRequest.Type, CostQueryRequestContract>,
  Exact<typeof CostExportJobRequest.Type, CostExportJobRequestContract>,
];
[true, true] satisfies CostQuerySchemasMatchContract;
