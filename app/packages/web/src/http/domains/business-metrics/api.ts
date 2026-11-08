/**
 * Business metrics and unit costs: `/api/org/:orgId/business-metrics`, the
 * endpoint definitions.
 *
 * A business metric is the denominator a unit cost divides by (customers,
 * requests, GB, revenue) reported by the org itself. CRUD on the definition,
 * a batch write for the values (actual and forecasted), the unit-cost query
 * that puts the two together, and importers that pull a metric's values from
 * a connected account on a schedule.
 *
 * Reads are `costs:read` and writes `costs:write`, matching saved cost filters
 * and the cost-push endpoint: a business metric is a statement about cost
 * data, not dashboard furniture. Configuring, previewing and running an
 * importer needs `resources:execute` on top of `costs:write`, the query
 * monitors' permission: an importer runs a query with the account's
 * credentials.
 *
 * The bodies are the shared schemas the metric editor, the unit-cost card and
 * the importer form validate with (`@infrawrench/ui/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  BUSINESS_METRIC_LIMITS,
  BUSINESS_METRIC_VALUE_SOURCES,
  COST_BINNINGS,
  UNIT_COST_GAP_REASONS,
} from "@infrawrench/client-core";
import {
  BusinessMetricForecastValuesBody,
  BusinessMetricImportAggregation,
  BusinessMetricImporterInput,
  BusinessMetricImportPreviewRequest,
  BusinessMetricImportRunRequest,
  BusinessMetricImportSchedule,
  BusinessMetricInput,
  BusinessMetricKind,
  BusinessMetricLabelMapping,
  BusinessMetricLabels,
  BusinessMetricLabelTarget,
  BusinessMetricScopeTerm,
  BusinessMetricSourceOptionsRequest,
  BusinessMetricValuesBody,
  pattern,
  UnitCostExportRequest,
  UnitCostMode,
  UnitCostQueryRequest,
  UnitCostScale,
  UnitCostThreshold,
} from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs, optionalRequestBody } from "../../schemas/documented";
import { numericQuery } from "../../schemas/query";

/** `:id` on a metric route: the metric's id or its key. */
const MetricParams = {
  orgId: OrgId,
  id: Schema.String.annotate({ description: "Metric id or key" }),
} as const;

const ForecastDay = Schema.String.check(pattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
  examples: ["2026-11-01"],
});

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

const BusinessMetricCoverage = Schema.Struct({
  firstDay: Schema.String.annotate({ description: "Earliest reported day, YYYY-MM-DD." }),
  lastDay: Schema.String,
  reportedDays: Schema.Int.annotate({
    description: "Days carrying a value; compare against the span to spot a sparse series.",
  }),
}).annotate({ identifier: "BusinessMetricCoverage" });

const ImportStatus = Schema.NullOr(Schema.Literals(["success", "error"]));

const BusinessMetricImporterSummary = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.NullOr(Schema.String),
  pluginId: Schema.NullOr(Schema.String),
  sourceLabel: Schema.NullOr(Schema.String).annotate({
    description: 'The source plugin\'s name for itself, e.g. "CloudWatch metric".',
  }),
  enabled: Schema.Boolean,
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastStatus: ImportStatus,
  lastError: Schema.NullOr(Schema.String),
}).annotate({ identifier: "BusinessMetricImporterSummary" });

export const BusinessMetric = Schema.Struct({
  id: Uuid,
  key: Schema.String,
  name: Schema.String,
  unit: Schema.String,
  description: Schema.NullOr(Schema.String),
  kind: BusinessMetricKind,
  currency: Schema.NullOr(Schema.String),
  costScope: Schema.Array(BusinessMetricScopeTerm),
  savedFilterId: Schema.NullOr(Uuid),
  labelMappings: Schema.Array(BusinessMetricLabelMapping),
  thresholds: Schema.Array(UnitCostThreshold),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  coverage: Schema.NullOr(BusinessMetricCoverage).annotate({
    description:
      "Null when the metric has no values at all; not an error, but every unit-cost chart drawn " +
      "from it is one continuous gap.",
  }),
  importer: Schema.NullOr(BusinessMetricImporterSummary).annotate({
    description:
      "The scheduled importer feeding this metric, or null when its values are only pushed.",
  }),
}).annotate({ identifier: "BusinessMetric" });

export const BusinessMetricList = Schema.Struct({ metrics: Schema.Array(BusinessMetric) });

export const BusinessMetricValue = Schema.Struct({
  day: Schema.String.annotate({ description: "UTC day, YYYY-MM-DD." }),
  value: Schema.Finite,
  label: Schema.NullOr(Schema.String).annotate({
    description:
      "The single breakdown label: the `label` key of `labels`, or null. Kept for clients that predate multi-dimensional labels.",
  }),
  labels: BusinessMetricLabels,
  source: Schema.Literals(BUSINESS_METRIC_VALUE_SOURCES),
  updatedAt: IsoDateTime,
}).annotate({ identifier: "BusinessMetricValue" });

export const BusinessMetricValueList = Schema.Struct({ values: Schema.Array(BusinessMetricValue) });

export const BusinessMetricValuesWritten = Schema.Struct({
  written: Schema.Int.annotate({ description: "Days written, counting restatements." }),
});

const BusinessMetricLabelSummary = Schema.Struct({
  key: Schema.String,
  values: Schema.Array(Schema.String).annotate({
    description: "Distinct values, alphabetical, at most 500.",
  }),
  truncated: Schema.Boolean,
  mapping: Schema.NullOr(BusinessMetricLabelTarget),
}).annotate({ identifier: "BusinessMetricLabelSummary" });

export const BusinessMetricLabelList = Schema.Struct({
  labels: Schema.Array(BusinessMetricLabelSummary),
});

/* -- forecasted values -- */

const BusinessMetricForecastValue = Schema.Struct({
  day: ForecastDay,
  value: Schema.Finite,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "BusinessMetricForecastValue" });

export const BusinessMetricForecastValueList = Schema.Struct({
  values: Schema.Array(BusinessMetricForecastValue),
});

export const BusinessMetricForecastValuesWritten = Schema.Struct({ written: Schema.Int });

export const BusinessMetricForecastValuesDeleted = Schema.Struct({ deleted: Schema.Int });

/** `?from=&to=`, read as sent: `parseForecastValueRange` answers a bad one with its own 400. */
const ForecastRangeQuery = {
  from: Schema.optionalKey(documentedAs(ForecastDay)),
  to: Schema.optionalKey(documentedAs(ForecastDay)),
};

/* -- importers -- */

export const BusinessMetricImporter = Schema.Struct({
  id: Uuid,
  metricId: Uuid,
  accountId: Schema.String,
  accountName: Schema.NullOr(Schema.String),
  pluginId: Schema.NullOr(Schema.String),
  sourceLabel: Schema.NullOr(Schema.String),
  params: Schema.Record(Schema.String, Schema.String),
  schedule: BusinessMetricImportSchedule,
  backfillDays: Schema.Int,
  timezone: Schema.String,
  aggregation: BusinessMetricImportAggregation,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastStatus: ImportStatus,
  lastError: Schema.NullOr(Schema.String),
  consecutiveFailures: Schema.Int.annotate({
    description: "Failed runs in a row; scheduling backs off on it and a success resets it.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "BusinessMetricImporter" });

export const BusinessMetricImporterResult = Schema.Struct({
  importer: Schema.NullOr(BusinessMetricImporter),
});

export const BusinessMetricImportRun = Schema.Struct({
  id: Uuid,
  importerId: Uuid,
  trigger: Schema.Literals(["schedule", "manual"]),
  status: Schema.Literals(["running", "success", "error"]),
  from: Schema.String.annotate({
    description: "First day, inclusive, in the importer's timezone.",
  }),
  to: Schema.String,
  pointsRead: Schema.Int,
  daysWritten: Schema.Int,
  error: Schema.NullOr(Schema.String),
  notes: Schema.Array(Schema.String),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "BusinessMetricImportRun" });

export const BusinessMetricImportRunList = Schema.Struct({
  runs: Schema.Array(BusinessMetricImportRun),
});

const SourceOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
});

const BusinessMetricSourceField = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["select", "sql", "text", "number"]),
  required: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  defaultValue: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(SourceOption)),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  allowCustom: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "BusinessMetricSourceField" });

const BusinessMetricSourceAccount = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
  source: Schema.Struct({
    label: Schema.String,
    description: Schema.optionalKey(Schema.String),
    kind: Schema.Literals(["sql", "metric"]),
    fields: Schema.Array(BusinessMetricSourceField),
    sqlDialect: Schema.optionalKey(Schema.String),
    readOnly: Schema.optionalKey(Schema.Literals(["enforced", "validated"])),
    supportsDryRun: Schema.optionalKey(Schema.Boolean),
  }),
}).annotate({ identifier: "BusinessMetricSourceAccount" });

export const BusinessMetricSourceList = Schema.Struct({
  sources: Schema.Array(BusinessMetricSourceAccount),
});

export const BusinessMetricSourceOptions = Schema.Struct({ options: Schema.Array(SourceOption) });

export const BusinessMetricImportPreview = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  values: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      value: Schema.Finite,
      label: Schema.optionalKey(Schema.String),
    }),
  ),
  pointsRead: Schema.Int,
  days: Schema.Int,
  notes: Schema.Array(Schema.String),
  durationMs: Schema.Int,
  dryRun: Schema.optionalKey(
    Schema.Struct({
      valid: Schema.Boolean,
      message: Schema.String,
      bytesProcessed: Schema.optionalKey(Schema.Finite),
    }),
  ),
}).annotate({ identifier: "BusinessMetricImportPreview" });

/* -- unit costs -- */

const UnitCostPoint = Schema.Struct({
  bucket: Schema.String.annotate({ description: "Bucket start date, YYYY-MM-DD." }),
  value: Schema.NullOr(Schema.Finite).annotate({
    description:
      "The ratio, or **null for a gap**. Never 0 and never infinite: a bucket with no reported " +
      "metric value is unknown, not free, and rendering it as 0 would say the opposite of the " +
      "truth. A zero numerator over a positive denominator is a real 0 and is returned as one.",
  }),
  cost: Schema.Finite.annotate({
    description: "Spend summed over the bucket, in the series' currency.",
  }),
  metricValue: Schema.NullOr(Schema.Finite).annotate({
    description:
      "The denominator summed over the bucket (the metric, or usage for `usage_unit_cost`), " +
      "unscaled, or null when nothing was reported.",
  }),
  absoluteMargin: Schema.optionalKey(
    Schema.NullOr(Schema.Finite).annotate({
      description: "`margin` only: revenue − spend in the series currency; null on a gap.",
    }),
  ),
  gap: Schema.optionalKey(
    Schema.Literals(UNIT_COST_GAP_REASONS).annotate({
      description: "Set exactly when `value` is null.",
    }),
  ),
  reportedDays: Schema.Int.annotate({
    description:
      "Days in the bucket carrying a reported value, out of `bucketDays`. When it is smaller, " +
      "the denominator covers only part of the bucket and the ratio there reads high.",
  }),
  bucketDays: Schema.Int,
}).annotate({ identifier: "UnitCostPoint" });

const UnitCostSeries = Schema.Struct({
  currency: Schema.String,
  label: Schema.optionalKey(
    Schema.Struct({
      key: Schema.String,
      value: Schema.NullOr(Schema.String).annotate({
        description: "Null for values carrying no such label, or for `Other`.",
      }),
      other: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "True for the fold of values past the group cap." }),
      ),
    }).annotate({ description: "Set when the query grouped by a label." }),
  ),
  points: Schema.Array(UnitCostPoint),
  overallValue: Schema.NullOr(Schema.Finite).annotate({
    description:
      "The period ratio: **summed numerator ÷ summed denominator**, not the mean of the " +
      "per-bucket ratios: the mean weights a quiet Sunday exactly as heavily as a peak " +
      "Monday. Only buckets that produced a ratio contribute, on both sides.",
  }),
  overallCost: Schema.Finite,
  overallMetricValue: Schema.NullOr(Schema.Finite),
  overallAbsoluteMargin: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
}).annotate({ identifier: "UnitCostSeries" });

export const UnitCostQueryResponse = Schema.Struct({
  metric: Schema.NullOr(
    Schema.Struct({
      id: Uuid,
      key: Schema.String,
      name: Schema.String,
      unit: Schema.String,
      kind: BusinessMetricKind,
      currency: Schema.NullOr(Schema.String),
    }),
  ).annotate({
    description: "Null for `usage_unit_cost`, which divides by provider usage instead.",
  }),
  mode: UnitCostMode,
  binning: Schema.Literals(COST_BINNINGS),
  scale: UnitCostScale,
  usageUnit: Schema.optionalKey(Schema.String),
  groupByLabel: Schema.optionalKey(Schema.String),
  costPerLabel: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Set when grouped. False means every label series carries the whole scope's spend (a raw " +
        "metric grouped by an unmapped label), so draw that spend once.",
    }),
  ),
  series: Schema.Array(UnitCostSeries).annotate({
    description:
      "One series per currency the numerator ended up in, usually one. More than one means " +
      "the organization has spend in a currency it holds no rate for; rather than dropping " +
      "that spend (understating every unit cost) or adding it to another currency (inventing " +
      "a number), each currency divides the same denominator on its own.",
  }),
  conversion: Schema.optionalKey(
    Schema.Struct({
      displayCurrency: Schema.String,
      converted: Schema.Array(
        Schema.Struct({
          currency: Schema.String,
          rates: Schema.Array(Schema.Struct({ effectiveFrom: Schema.String, rate: Schema.Finite })),
        }),
      ),
      unconverted: Schema.Array(Schema.String),
    }).annotate({
      description: "Set only when spend currencies were folded together; absent means untouched.",
    }),
  ),
  gapBuckets: Schema.Int.annotate({
    description: "Buckets on the axis that produced no ratio at all.",
  }),
  partialBuckets: Schema.Int.annotate({
    description: "Buckets whose denominator covers only part of the bucket.",
  }),
}).annotate({ identifier: "UnitCostQueryResponse" });

export const UsageUnitList = Schema.Struct({
  units: Schema.Array(
    Schema.Struct({
      unit: Schema.String,
      usage: Schema.Finite,
      services: Schema.Array(Schema.String),
    }),
  ),
});

/** The export file: CSV by default, NDJSON when asked. */
const UnitCostExportFile = [
  Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" })),
  Schema.String.annotate({}).pipe(HttpApiSchema.asText({ contentType: "application/x-ndjson" })),
] as const;

const EXPORT_DESCRIPTION =
  "One row per bucket per series (and per label value when grouped), columns in this order: " +
  "`bucket`, `bucket_days`, `reported_days`, `partial`, `label_key`, `label_value`, " +
  "`label_other`, `currency`, `mode`, `scale`, `metric_key`, `metric_unit`, `usage_unit`, " +
  "`cost` (summed spend), `metric_value` (summed denominator, unscaled), `value` (the ratio, " +
  "already scaled), `absolute_margin`, `gap`. A gap is an **empty** `value` with its reason " +
  "in `gap`, never 0, and `partial` flags a bucket whose denominator covers only some of its " +
  "days. Text cells starting with `=`, `+`, `-` or `@` are prefixed with `'` so a spreadsheet " +
  "does not run them. NDJSON carries the same keys, with `null` for empty.";

export class BusinessMetricsGroup extends HttpApiGroup.make("businessMetrics")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: BusinessMetricList,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List business metrics")
      .annotate(
        OpenApi.Description,
        "The organization's declared denominators, by key, each with the range of days it has " +
          "values for.",
      )
      .annotate(SuccessDescription, "Metrics, by key"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: BusinessMetricInput,
      success: BusinessMetric,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a business metric")
      .annotate(
        OpenApi.Description,
        "Keys must be unique per organization among live metrics; they are how workflows and the " +
          "CLI address the metric. A key collision is a 409.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid business metric"),
    HttpApiEndpoint.get("importerSources", "/importer-sources", {
      params: OrgParams,
      success: BusinessMetricSourceList,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List importer sources")
      .annotate(
        OpenApi.Description,
        "Connected accounts whose plugin can feed a business metric on a schedule, each with the " +
          "plugin's importer form: which fields to fill and which are pickers.",
      )
      .annotate(SuccessDescription, "Sources"),
    HttpApiEndpoint.post("importerOptions", "/importer-options", {
      params: OrgParams,
      payload: BusinessMetricSourceOptionsRequest,
      success: BusinessMetricSourceOptions,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "List an importer picker's choices")
      .annotate(
        OpenApi.Description,
        "Choices for one `select` field of a source's form, given the values picked so far. Needs " +
          "`resources:execute` and `costs:write`: it calls the provider with the account's credentials.",
      )
      .annotate(SuccessDescription, "Choices")
      .annotate(InvalidRequestMessage, "Invalid options request"),
    HttpApiEndpoint.post("importerPreview", "/importer-preview", {
      params: OrgParams,
      payload: BusinessMetricImportPreviewRequest,
      success: BusinessMetricImportPreview,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Preview an importer")
      .annotate(
        OpenApi.Description,
        "Run a source over a window and return the values it would write, writing nothing; or, " +
          "with `dryRun`, validate the query with the provider without reading data. Read-only " +
          "queries only, with the same row limit and timeout as a scheduled run.",
      )
      .annotate(SuccessDescription, "Preview")
      .annotate(InvalidRequestMessage, "Invalid preview request"),
    HttpApiEndpoint.get("usageUnits", "/usage-units", {
      params: OrgParams,
      success: UsageUnitList,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List usage units")
      .annotate(
        OpenApi.Description,
        "The provider usage units the organization's cost rows carry over the last 90 days, most " +
          "spend first, with a few of the services reporting each. Backs the per-usage-unit picker.",
      )
      .annotate(SuccessDescription, "Usage units"),
    HttpApiEndpoint.post("usageUnitCosts", "/usage-unit-costs", {
      params: OrgParams,
      payload: UnitCostQueryRequest,
      success: UnitCostQueryResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Query cost per usage unit")
      .annotate(
        OpenApi.Description,
        "Spend divided by the usage quantity providers report in one `usageUnit`, with no business " +
          "metric involved. Both halves come from the same cost rows (those reported in that unit), " +
          "so the numerator is exactly the spend that bought the denominator. A bucket with no usage " +
          "is a gap (`no_usage`), never 0. Labels do not apply.",
      )
      .annotate(SuccessDescription, "Unit-cost series")
      .annotate(InvalidRequestMessage, "Invalid unit-cost query"),
    HttpApiEndpoint.post("exportUsageUnitCosts", "/usage-unit-costs/export", {
      params: OrgParams,
      payload: UnitCostExportRequest,
      success: UnitCostExportFile,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Export cost per usage unit as a file")
      .annotate(
        OpenApi.Description,
        `The query \`POST /business-metrics/usage-unit-costs\` answers, as CSV or NDJSON. ${EXPORT_DESCRIPTION}`,
      )
      .annotate(SuccessDescription, "The file")
      .annotate(InvalidRequestMessage, "Invalid unit-cost export"),
    HttpApiEndpoint.get("get", "/:id", {
      params: MetricParams,
      success: BusinessMetric,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a business metric")
      .annotate(OpenApi.Description, "`id` accepts either the metric's id or its key.")
      .annotate(SuccessDescription, "Metric"),
    HttpApiEndpoint.put("update", "/:id", {
      params: MetricParams,
      payload: BusinessMetricInput,
      success: BusinessMetric,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a business metric")
      .annotate(
        OpenApi.Description,
        "Replaces the whole definition. Changing `key` never orphans history (values are keyed on " +
          "the metric's id) but it does break a workflow still writing to the old key, which is why " +
          "the key is separate from the display name in the first place.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid business metric"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: MetricParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a business metric")
      .annotate(
        OpenApi.Description,
        "Soft delete. Not refused when a dashboard card references the metric, unlike a saved cost " +
          "filter: a unit-cost card whose metric is gone fails its query and says so, whereas a card " +
          "that quietly reverted to plain spend would be a chart claiming to be something it is not.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("values", "/:id/values", {
      params: MetricParams,
      // Read as sent: the handler parses `limit` and answers its own 400.
      query: {
        limit: Schema.optionalKey(
          documentedAs(Schema.String.annotate({ description: "Default 90." })),
        ),
      },
      success: BusinessMetricValueList,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a metric's reported values")
      .annotate(OpenApi.Description, "Newest day first.")
      .annotate(
        OpenApi.Transform,
        numericQuery({
          limit: { type: "integer", minimum: 1, maximum: BUSINESS_METRIC_LIMITS.maxValuesPageSize },
        }),
      )
      .annotate(SuccessDescription, "Values, newest first"),
    HttpApiEndpoint.post("writeValues", "/:id/values", {
      params: MetricParams,
      payload: BusinessMetricValuesBody,
      success: BusinessMetricValuesWritten,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Report metric values")
      .annotate(
        OpenApi.Description,
        "Write a batch of days. **Re-reporting a day restates it rather than accumulating**, which " +
          "is what makes a nightly job safe to retry. Nothing lands unless the whole batch validates, " +
          "so a bad row is a 400 rather than half a month restated. The same guarantees back " +
          "`infra.businessMetrics.write(...)` in a workflow; both go through one validator.",
      )
      .annotate(SuccessDescription, "Written")
      .annotate(InvalidRequestMessage, "Invalid values"),
    HttpApiEndpoint.get("forecastValues", "/:id/forecast-values", {
      params: MetricParams,
      query: ForecastRangeQuery,
      success: BusinessMetricForecastValueList,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a metric's forecasted values")
      .annotate(
        OpenApi.Description,
        "Planned values, kept apart from the reported actuals: no unit cost, threshold or " +
          "coverage figure ever reads them. Day order.",
      )
      .annotate(SuccessDescription, "Forecasted values"),
    HttpApiEndpoint.post("writeForecastValues", "/:id/forecast-values", {
      params: MetricParams,
      payload: BusinessMetricForecastValuesBody,
      success: BusinessMetricForecastValuesWritten,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Write forecasted metric values")
      .annotate(OpenApi.Description, "Re-sending a day restates it. Values must be non-negative.")
      .annotate(SuccessDescription, "Written")
      .annotate(InvalidRequestMessage, "Invalid values"),
    HttpApiEndpoint.delete("deleteForecastValues", "/:id/forecast-values", {
      params: MetricParams,
      query: ForecastRangeQuery,
      success: BusinessMetricForecastValuesDeleted,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete forecasted metric values")
      .annotate(
        OpenApi.Description,
        "Removes planned days in `[from, to]`; omit both to clear every planned day.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("importer", "/:id/importer", {
      params: MetricParams,
      success: BusinessMetricImporterResult,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a metric's importer")
      .annotate(OpenApi.Description, "`importer` is null when the metric's values are only pushed.")
      .annotate(SuccessDescription, "Importer"),
    HttpApiEndpoint.put("saveImporter", "/:id/importer", {
      params: MetricParams,
      payload: BusinessMetricImporterInput,
      success: BusinessMetricImporter,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Create or replace a metric's importer")
      .annotate(
        OpenApi.Description,
        "One importer per metric. A full replace: omitted fields take their defaults. Each run " +
          "restates whole days (every label a day carried is replaced by what the source returned), " +
          "never touches days the source returned nothing for, and ignores points outside the " +
          "window. Changing the account, the params or the schedule makes it due immediately.",
      )
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid importer"),
    HttpApiEndpoint.delete("deleteImporter", "/:id/importer", {
      params: MetricParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a metric's importer")
      .annotate(
        OpenApi.Description,
        "Stops importing and drops the run history. Values already imported stay.",
      )
      .annotate(SuccessDescription, "Deleted"),
    // An empty body is "the importer's own window".
    HttpApiEndpoint.post("runImporter", "/:id/importer/run", {
      params: MetricParams,
      payload: BusinessMetricImportRunRequest,
      success: BusinessMetricImportRun,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Run a metric's importer now")
      .annotate(
        OpenApi.Description,
        "Runs synchronously and returns the finished run, failed or not. With no body it reads the " +
          "importer's own window; `from`/`to` backfill a wider one (at most 730 days).",
      )
      .annotate(SuccessDescription, "Run")
      .annotate(InvalidRequestMessage, "Invalid run request")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("importRuns", "/:id/importer/runs", {
      params: MetricParams,
      // Read as sent: the handler parses `limit` and answers its own 400.
      query: {
        limit: Schema.optionalKey(
          documentedAs(Schema.String.annotate({ description: "Default 20." })),
        ),
      },
      success: BusinessMetricImportRunList,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a metric's import runs")
      .annotate(OpenApi.Description, "Newest first; the most recent 50 are kept.")
      .annotate(
        OpenApi.Transform,
        numericQuery({ limit: { type: "integer", minimum: 1, maximum: 50 } }),
      )
      .annotate(SuccessDescription, "Runs"),
    HttpApiEndpoint.post("unitCosts", "/:id/unit-costs", {
      params: MetricParams,
      payload: UnitCostQueryRequest,
      success: UnitCostQueryResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Query unit costs or margin")
      .annotate(
        OpenApi.Description,
        "Divide spend by the metric, bucketed as asked. Three properties of the answer are worth " +
          "knowing before reading it:\n\n" +
          "- **The ratio is computed at the requested bucket**, from a summed numerator and a summed " +
          "denominator: never a mean of daily ratios, which weights a quiet day as heavily as a " +
          "peak one. The same holds for `overallValue`.\n" +
          "- **A missing or non-positive denominator is a gap** (`value: null` with a `gap` reason), " +
          "never 0 and never infinite.\n" +
          "- **Currencies are never merged.** Spend in a currency with no stated rate keeps its own " +
          "series rather than being dropped or added to another.\n\n" +
          "There is no spend `groupBy`: a per-group ratio needs a per-group denominator. Split by a " +
          "metric label with `groupByLabel` instead; in a ratio mode the label must be mapped to the " +
          "cost dimension its values name (`labelMappings` on the metric), so each label value's " +
          "spend is divided by its own volume.",
      )
      .annotate(SuccessDescription, "Unit-cost series")
      .annotate(InvalidRequestMessage, "Invalid unit-cost query"),
    HttpApiEndpoint.get("labels", "/:id/labels", {
      params: MetricParams,
      success: BusinessMetricLabelList,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a metric's labels")
      .annotate(
        OpenApi.Description,
        "The label keys the metric's values carry, each with its distinct values (at most 500) and " +
          "its cost mapping. A mapped label nobody has reported yet is listed with no values.",
      )
      .annotate(SuccessDescription, "Labels, by key"),
    HttpApiEndpoint.post("exportUnitCosts", "/:id/unit-costs/export", {
      params: MetricParams,
      payload: UnitCostExportRequest,
      success: UnitCostExportFile,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Export unit costs or margin as a file")
      .annotate(
        OpenApi.Description,
        `The query \`POST /business-metrics/{id}/unit-costs\` answers, as CSV or NDJSON. ${EXPORT_DESCRIPTION}`,
      )
      .annotate(SuccessDescription, "The file")
      .annotate(InvalidRequestMessage, "Invalid unit-cost export"),
  )
  .prefix("/api/org/:orgId/business-metrics")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Business metrics") {}

export class BusinessMetricsApi extends withApiDefaults(
  HttpApi.make("business-metrics").add(BusinessMetricsGroup),
) {}
