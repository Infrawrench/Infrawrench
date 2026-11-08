/**
 * Business metrics and unit costs, as Effect schemas: a metric, its reported
 * values, the unit-cost query and export, and metric importers.
 */
import { Schema } from "effect";
import {
  BUSINESS_METRIC_IMPORT_AGGREGATIONS,
  BUSINESS_METRIC_IMPORT_LIMITS,
  BUSINESS_METRIC_IMPORT_SCHEDULES,
  BUSINESS_METRIC_KEY_PATTERN,
  BUSINESS_METRIC_KINDS,
  BUSINESS_METRIC_LIMITS,
  COST_BINNINGS,
  COST_CHARGE_TYPES,
  COST_QUERY_MAX_LENGTH,
  UNIT_COST_EXPORT_FORMATS,
  UNIT_COST_THRESHOLD_DIRECTIONS,
  UNIT_COST_THRESHOLD_MODES,
  type BusinessMetricImporterInput as BusinessMetricImporterInputContract,
  type BusinessMetricImportPreviewRequest as BusinessMetricImportPreviewRequestContract,
  type BusinessMetricImportRunRequest as BusinessMetricImportRunRequestContract,
  type BusinessMetricInput as BusinessMetricInputContract,
  type BusinessMetricLabelMapping as BusinessMetricLabelMappingContract,
  type BusinessMetricSourceOptionsRequest as BusinessMetricSourceOptionsRequestContract,
  type BusinessMetricValueInput as BusinessMetricValueInputContract,
  type UnitCostExportRequest as UnitCostExportRequestContract,
  type UnitCostQueryRequest as UnitCostQueryRequestContract,
  type UnitCostThreshold as UnitCostThresholdContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, normalized, pattern } from "./checks";
import type { Exact } from "./contract";
import { CostBasisValue } from "./cost-enums";
import { CostDimension, CostFilter } from "./cost-filter";
import { CurrencyCode, IsoDate, NonEmptyString } from "./primitives";
import {
  BusinessMetricLabelKey,
  UnitCostLabelFilter,
  UnitCostMode,
  UnitCostScale,
} from "./unit-costs";

const L = BUSINESS_METRIC_LIMITS;
const IL = BUSINESS_METRIC_IMPORT_LIMITS;

export const BusinessMetricScopeTerm = CostFilter.annotate({
  identifier: "BusinessMetricScopeTerm",
});

/** A metric key: trimmed and lower-cased, then the slug rule. */
const BusinessMetricKey = normalized(
  (value) => value.trim().toLowerCase(),
  [
    minLength(1),
    maxLength(L.maxKeyLength),
    pattern(BUSINESS_METRIC_KEY_PATTERN, {
      message: "expected a lowercase slug, e.g. active-customers",
    }),
  ],
  {
    description:
      "Stable lowercase slug (letters, digits, `_ . -`) that workflows and the CLI address the " +
      "metric by. Unique per organization among live metrics, and independent of `name` so a " +
      "rename never breaks a running job.",
    examples: ["active-customers"],
  },
);

/** Where a label's values live on the cost side. */
export const BusinessMetricLabelTarget = Schema.Union(
  [
    Schema.Struct({
      kind: Schema.Literal("dimension"),
      dimension: CostDimension,
      tagKey: Schema.optionalKey(
        Schema.String.check(minLength(1), maxLength(200)).annotate({
          description: "Required for keyed dimensions (tags).",
        }),
      ),
    }),
    Schema.Struct({ kind: Schema.Literal("cost_centre") }),
  ],
  { mode: "oneOf" },
).annotate({
  identifier: "BusinessMetricLabelTarget",
  description:
    "Where a label's values live on the cost side. A `dimension` target matches label values to " +
    "dimension values exactly; `cost_centre` matches a centre by id or, case-insensitively, by " +
    "name.",
});

export const BusinessMetricLabelMapping = Schema.Struct({
  label: BusinessMetricLabelKey,
  target: BusinessMetricLabelTarget,
}).annotate({
  identifier: "BusinessMetricLabelMapping",
  description:
    "Joins a label to a cost dimension so unit cost and margin can be computed per label value " +
    "(cost per customer). Ratio modes refuse an unmapped label: without a per-value numerator " +
    "the only spend available is the whole scope's.",
});

/** A standing limit on a metric's unit cost or margin. */
export const UnitCostThreshold = Schema.Struct({
  mode: Schema.Literals(UNIT_COST_THRESHOLD_MODES),
  direction: Schema.Literals(UNIT_COST_THRESHOLD_DIRECTIONS),
  value: Schema.Finite.annotate({
    description:
      "Currency units per `scale` metric units for `unit_cost`; a percentage (30 for 30%) for " +
      "`margin`.",
  }),
  scale: Schema.optionalKey(UnitCostScale),
  groupByLabel: Schema.optionalKey(BusinessMetricLabelKey).annotateKey({
    description: "Evaluate per value of this label. The label must be mapped.",
  }),
  windowDays: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: L.minThresholdWindowDays, maximum: L.maxThresholdWindowDays }),
    ).annotate({ description: "Trailing complete days the ratio is summed over. Default 7." }),
  ),
}).annotate({
  identifier: "UnitCostThreshold",
  description:
    "A standing limit, evaluated daily on the summed ratio over the trailing window and routed " +
    "under the unit-cost alert trigger. A window with fewer than half its days reported is not " +
    "judged.",
});

export const BusinessMetricKind = Schema.Literals(BUSINESS_METRIC_KINDS).annotate({
  identifier: "BusinessMetricKind",
  description:
    "What the metric's numbers are. `count` is a unit-less quantity (customers, requests, GB) " +
    "and supports unit cost only. `currency` is money the business took in, denominated in the " +
    "metric's own `currency`, and is the only kind margin can be computed against, " +
    "`(revenue − cost) ÷ revenue` subtracts money from money and is undefined otherwise.",
});

/**
 * Create/update body for a business metric. Shape only for the currency rule
 * ("a revenue metric states a currency, a count metric must not"), which the
 * service enforces in one sentence explaining why.
 */
export const BusinessMetricInput = Schema.Struct({
  key: BusinessMetricKey,
  name: Schema.String.check(minLength(1), maxLength(L.maxNameLength)),
  /** Singular unit label: "customer", "request", "GB". Purely display. */
  unit: Schema.String.check(minLength(1), maxLength(L.maxUnitLength)).annotate({
    description: 'Singular unit label used for display; the noun in "USD per customer".',
    examples: ["customer"],
  }),
  description: Schema.optionalKey(Schema.String.check(maxLength(L.maxDescriptionLength))),
  kind: BusinessMetricKind,
  currency: Schema.optionalKey(
    CurrencyCode.annotate({
      description:
        "ISO-4217 code. **Required when `kind` is `currency`, and rejected otherwise**; a " +
        "revenue metric with no currency cannot have margin computed against it, and a count " +
        "metric carrying one would suggest its numbers are money when they are requests.",
    }),
  ),
  costScope: Schema.optionalKey(
    Schema.mutable(Schema.Array(BusinessMetricScopeTerm))
      .check(maxLength(L.maxScopeFilters))
      .annotate({
        description:
          "The spend this metric divides, in the same filter vocabulary cost graphs and budgets " +
          "use. Empty (the default) is all of the organization's spend. A unit-cost query may " +
          "narrow this further but can never widen it: the scope is part of what the metric " +
          "means, and a caller who could drop it would be answering a different question under " +
          "the same name.",
      }),
  ),
  savedFilterId: Schema.optionalKey(
    NonEmptyString.annotate({
      description:
        "A saved cost filter AND-composed with `costScope`, resolved server-side at query time. A " +
        "reference that fails to resolve errors the unit-cost query rather than silently widening " +
        "the numerator to all spend.",
    }),
  ),
  labelMappings: Schema.optionalKey(
    Schema.mutable(Schema.Array(BusinessMetricLabelMapping))
      .check(maxLength(L.maxLabelMappings))
      .annotate({
        description: "Which value labels name a cost dimension. One mapping per label.",
      }),
  ),
  thresholds: Schema.optionalKey(
    Schema.mutable(Schema.Array(UnitCostThreshold)).check(maxLength(L.maxThresholds)).annotate({
      description:
        "Standing unit-cost or margin limits. Margin thresholds need a `currency` metric.",
    }),
  ),
}).annotate({ identifier: "BusinessMetricInput" });

export const BusinessMetricLabels = Schema.Record(Schema.String, Schema.String).annotate({
  identifier: "BusinessMetricLabels",
  description:
    'A value\'s labels, e.g. `{ "customer": "acme", "plan": "pro" }`. At most 8, keys are ' +
    "slugs, values up to 200 characters. Rows partition the metric: a day's total is the sum of " +
    "every row for it, so report a breakdown or a total, never both. The same day with the " +
    "same labels restates; different labels are a different row.",
});

/**
 * One reported day. Re-reporting a day restates it rather than accumulating.
 * Label keys and values are checked (and canonicalised) by the ingest itself,
 * so a workflow write and an API write fail with the same message.
 */
export const BusinessMetricValueInput = Schema.Struct({
  date: IsoDate,
  value: Schema.Finite,
  /** A single breakdown label, stored as `{ label: <value> }`. */
  label: Schema.optionalKey(
    Schema.String.check(maxLength(L.maxLabelValueLength)).annotate({
      description: "A single breakdown label, stored as `{ label: <value> }`; `labels` wins.",
    }),
  ),
  labels: Schema.optionalKey(BusinessMetricLabels),
});

/** The batch envelope for `POST /business-metrics/{id}/values`. */
export const BusinessMetricValuesBody = Schema.Struct({
  values: Schema.mutable(Schema.Array(BusinessMetricValueInput))
    .check(maxLength(L.maxValuesPerCall))
    .annotate({
      description:
        "Days to report. **Re-reporting a day (with the same labels) restates it rather than " +
        "adding to it**, so an unattended nightly job is safe to retry; an accumulating write " +
        "would double every number the first time the job re-ran. A batch naming the same day " +
        "and labels twice keeps the last value, applying the same rule within a batch that " +
        "restatement applies between them.",
    }),
}).annotate({ identifier: "BusinessMetricValuesInput" });

const unitCostQueryRequestFields = {
  from: IsoDate.annotate({ description: "Inclusive, YYYY-MM-DD." }),
  to: IsoDate,
  binning: Schema.Literals(COST_BINNINGS),
  mode: Schema.optionalKey(UnitCostMode).annotateKey({
    description:
      "Absent is `unit_cost` on the metric route and `usage_unit_cost` on the usage route. " +
      "`margin` is a 400 for a metric whose `kind` is not `currency`.",
  }),
  scale: Schema.optionalKey(UnitCostScale),
  labelFilters: Schema.optionalKey(
    Schema.mutable(Schema.Array(UnitCostLabelFilter))
      .check(maxLength(10))
      .annotate({
        description:
          "Keep only values carrying these labels. In a ratio mode each label must be mapped, and " +
          "the spend is narrowed to the same values on the mapped dimension.",
      }),
  ),
  groupByLabel: Schema.optionalKey(BusinessMetricLabelKey).annotateKey({
    description:
      "One series per value of this label (the 25 largest by metric total; the rest fold into " +
      "`Other`). In a ratio mode the label must be mapped.",
  }),
  usageUnit: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(120)).annotate({
      description:
        "`usage_unit_cost` only, and required there: the provider usage unit to divide by. " +
        "See `GET /business-metrics/usage-units`.",
    }),
  ),
  /** Narrowing on top of the metric's own scope, never a replacement for it. */
  filters: Schema.optionalKey(
    Schema.mutable(Schema.Array(BusinessMetricScopeTerm)).annotate({
      description:
        "Narrowing on top of the metric's own `costScope`: AND-composed, never a replacement.",
    }),
  ),
  query: Schema.optionalKey(
    Schema.String.check(maxLength(COST_QUERY_MAX_LENGTH)).annotate({
      description: "The same narrowing as cost-query-language text.",
    }),
  ),
  savedFilterId: Schema.optionalKey(NonEmptyString),
  costBasis: Schema.optionalKey(CostBasisValue),
  chargeTypes: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Literals(COST_CHARGE_TYPES)))),
  displayCurrency: Schema.optionalKey(
    CurrencyCode.annotate({
      description:
        "Fold spend currencies the organization holds a rate for into this one before dividing. " +
        "Ignored for `margin`, which always converts to the metric's own currency.",
    }),
  ),
};

/**
 * The unit-cost query. No spend `groupBy` and no `topN`, and their absence is
 * the contract: a per-group ratio needs a per-group denominator, so grouping
 * is by a metric label instead.
 */
export const UnitCostQueryRequest = Schema.Struct(unitCostQueryRequestFields).annotate({
  identifier: "UnitCostQueryRequest",
});

/** `POST …/unit-costs/export`: the same query, plus the file format. */
export const UnitCostExportRequest = Schema.Struct({
  ...unitCostQueryRequestFields,
  format: Schema.optionalKey(
    Schema.Literals(UNIT_COST_EXPORT_FORMATS).annotate({
      description: "File format. Default `csv`.",
    }),
  ),
}).annotate({ identifier: "UnitCostExportRequest" });

/** Plugin-defined source parameters: a bounded string map, checked against the form server-side. */
const BusinessMetricSourceParams = Schema.Record(
  Schema.String,
  Schema.String.check(maxLength(IL.maxParamValueLength)),
)
  .check(
    Schema.isPropertyNames(Schema.String.check(minLength(1), maxLength(IL.maxParamKeyLength))),
    Schema.isMaxProperties(IL.maxParams, { message: `at most ${IL.maxParams} parameters` }),
  )
  .annotate({
    description:
      "The source plugin's form values, keyed by field (see `GET /business-metrics/importer-sources`). " +
      "SQL fields must be a single SELECT or WITH statement; `{{from}}`, `{{to}}`, `{{to_exclusive}}` " +
      "and `{{timezone}}` are replaced with quoted literals.",
  });

export const BusinessMetricImportSchedule = Schema.Literals(
  BUSINESS_METRIC_IMPORT_SCHEDULES,
).annotate({ identifier: "BusinessMetricImportSchedule" });

export const BusinessMetricImportAggregation = Schema.Literals(
  BUSINESS_METRIC_IMPORT_AGGREGATIONS,
).annotate({
  identifier: "BusinessMetricImportAggregation",
  description:
    "How several points the source returns for one day (and label) become that day's value. " +
    "A SQL query grouped by day returns one row per day and every choice agrees.",
});

const ImportTimezone = Schema.String.check(minLength(1), maxLength(64));

/**
 * Create/replace body for `PUT /business-metrics/{id}/importer`. Which keys
 * `params` may carry, and which are required, is the account plugin's form;
 * that check (and the read-only SQL guard) is server-side.
 */
export const BusinessMetricImporterInput = Schema.Struct({
  accountId: NonEmptyString.annotate({
    description: "A connected account whose plugin declares a business-metric source.",
  }),
  params: BusinessMetricSourceParams,
  schedule: Schema.optionalKey(BusinessMetricImportSchedule).annotateKey({
    description: "Absent is `daily`.",
  }),
  backfillDays: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: IL.minBackfillDays, maximum: IL.maxBackfillDays }),
    ).annotate({
      description:
        "Trailing closed days each scheduled run restates, ending yesterday. Absent is 7.",
    }),
  ),
  timezone: Schema.optionalKey(
    ImportTimezone.annotate({
      description: "IANA timezone the days are counted in. Absent is `UTC`.",
      examples: ["America/New_York"],
    }),
  ),
  aggregation: Schema.optionalKey(BusinessMetricImportAggregation).annotateKey({
    description: "Absent is `sum`.",
  }),
  enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Absent is true." })),
}).annotate({ identifier: "BusinessMetricImporterInput" });

/** `POST /business-metrics/{id}/importer/run`. Documented inline. */
export const BusinessMetricImportRunRequest = Schema.Struct({
  from: Schema.optionalKey(IsoDate),
  to: Schema.optionalKey(IsoDate),
});

/** `POST /business-metrics/importer-preview`. */
export const BusinessMetricImportPreviewRequest = Schema.Struct({
  accountId: NonEmptyString,
  params: BusinessMetricSourceParams,
  from: Schema.optionalKey(IsoDate.annotate({ description: "Default: 14 days ending yesterday." })),
  to: Schema.optionalKey(IsoDate),
  timezone: Schema.optionalKey(ImportTimezone),
  aggregation: Schema.optionalKey(BusinessMetricImportAggregation),
  dryRun: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Validate with the provider without reading data, where the source supports it.",
    }),
  ),
}).annotate({ identifier: "BusinessMetricImportPreviewRequest" });

/** `POST /business-metrics/importer-options`. Documented inline. */
export const BusinessMetricSourceOptionsRequest = Schema.Struct({
  accountId: NonEmptyString,
  fieldKey: Schema.String.check(minLength(1), maxLength(IL.maxParamKeyLength)),
  params: BusinessMetricSourceParams,
});

export type BusinessMetricSchemasMatchContract = [
  Exact<typeof BusinessMetricInput.Type, BusinessMetricInputContract>,
  Exact<typeof BusinessMetricValueInput.Type, BusinessMetricValueInputContract>,
  Exact<typeof UnitCostQueryRequest.Type, UnitCostQueryRequestContract>,
  Exact<typeof UnitCostExportRequest.Type, UnitCostExportRequestContract>,
  Exact<typeof BusinessMetricImporterInput.Type, BusinessMetricImporterInputContract>,
  Exact<typeof BusinessMetricImportRunRequest.Type, BusinessMetricImportRunRequestContract>,
  Exact<typeof BusinessMetricImportPreviewRequest.Type, BusinessMetricImportPreviewRequestContract>,
  Exact<typeof BusinessMetricSourceOptionsRequest.Type, BusinessMetricSourceOptionsRequestContract>,
  Exact<typeof BusinessMetricLabelMapping.Type, BusinessMetricLabelMappingContract>,
  Exact<typeof UnitCostThreshold.Type, UnitCostThresholdContract>,
];
[
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
] satisfies BusinessMetricSchemasMatchContract;
