import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const BusinessMetricScopeTerm = strict({
  dimension: z.enum([
    "provider",
    "account",
    "service",
    "region",
    "resource",
    "tag",
    "charge_type",
    "commitment",
    "virtual_tag",
  ]),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  tagKey: z.string().optional(),
}).openapi("BusinessMetricScopeTerm");

const UnitCostMode = z
  .enum(["unit_cost", "margin", "usage_unit_cost", "raw_metric"])
  .openapi("UnitCostMode", {
    description:
      "`unit_cost` is spend ÷ metric value. `margin` is `(revenue − spend) ÷ revenue` as a " +
      "fraction, with the absolute margin beside it, and needs a `currency` metric. " +
      "`usage_unit_cost` is spend ÷ the usage quantity providers report in one `usageUnit`, and " +
      "needs no metric (use `POST /business-metrics/usage-unit-costs`). `raw_metric` plots the " +
      "metric itself beside spend, where zero and negative values are real points.",
  });

const UnitCostScale = z
  .union([z.literal(1), z.literal(100), z.literal(1000), z.literal(1000000), z.literal(1000000000)])
  .openapi("UnitCostScale", {
    description:
      '"Per N units": multiplies a ratio (cost per 1,000 requests) and divides a raw metric. ' +
      "Margin ignores it. Absent is 1.",
  });

const BusinessMetricLabelKey = z
  .string()
  .min(1)
  .max(64)
  .describe("A label key: a lowercase slug, normalised (trimmed, lowercased) on write.")
  .openapi({ example: "customer" });

const BusinessMetricLabels = z.record(z.string(), z.string()).openapi("BusinessMetricLabels", {
  description:
    'A value\'s labels, e.g. `{ "customer": "acme", "plan": "pro" }`. At most 8, keys are ' +
    "slugs, values up to 200 characters. Rows partition the metric: a day's total is the sum of " +
    "every row for it, so report a breakdown or a total, never both. The same day with the " +
    "same labels restates; different labels are a different row.",
});

const BusinessMetricLabelTarget = z
  .discriminatedUnion("kind", [
    strict({
      kind: z.literal("dimension"),
      dimension: BusinessMetricScopeTerm.shape.dimension,
      tagKey: z.string().optional().describe("Required for keyed dimensions (tags)."),
    }),
    strict({ kind: z.literal("cost_centre") }),
  ])
  .openapi("BusinessMetricLabelTarget", {
    description:
      "Where a label's values live on the cost side. A `dimension` target matches label values to " +
      "dimension values exactly; `cost_centre` matches a centre by id or, case-insensitively, by " +
      "name.",
  });

const BusinessMetricLabelMapping = strict({
  label: BusinessMetricLabelKey,
  target: BusinessMetricLabelTarget,
}).openapi("BusinessMetricLabelMapping", {
  description:
    "Joins a label to a cost dimension so unit cost and margin can be computed per label value " +
    "(cost per customer). Ratio modes refuse an unmapped label: without a per-value numerator " +
    "the only spend available is the whole scope's.",
});

const UnitCostThreshold = strict({
  mode: z.enum(["unit_cost", "margin"]),
  direction: z.enum(["above", "below"]),
  value: z
    .number()
    .describe(
      "Currency units per `scale` metric units for `unit_cost`; a percentage (30 for 30%) for " +
        "`margin`.",
    ),
  scale: UnitCostScale.optional(),
  groupByLabel: BusinessMetricLabelKey.optional().describe(
    "Evaluate per value of this label. The label must be mapped.",
  ),
  windowDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe("Trailing complete days the ratio is summed over. Default 7."),
}).openapi("UnitCostThreshold", {
  description:
    "A standing limit, evaluated daily on the summed ratio over the trailing window and routed " +
    "under the unit-cost alert trigger. A window with fewer than half its days reported is not " +
    "judged.",
});

const BusinessMetricKind = z.enum(["count", "currency"]).openapi("BusinessMetricKind", {
  description:
    "What the metric's numbers are. `count` is a unit-less quantity (customers, requests, GB) " +
    "and supports unit cost only. `currency` is money the business took in, denominated in the " +
    "metric's own `currency`, and is the only kind margin can be computed against — " +
    "`(revenue − cost) ÷ revenue` subtracts money from money and is undefined otherwise.",
});

const BusinessMetricInput = strict({
  key: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Stable lowercase slug (letters, digits, `_ . -`) that workflows and the CLI address the " +
        "metric by. Unique per organization among live metrics, and independent of `name` so a " +
        "rename never breaks a running job.",
    )
    .openapi({ example: "active-customers" }),
  name: z.string().min(1).max(120),
  unit: z
    .string()
    .min(1)
    .max(32)
    .describe('Singular unit label used for display — the noun in "USD per customer".')
    .openapi({ example: "customer" }),
  description: z.string().max(2000).optional(),
  kind: BusinessMetricKind,
  currency: z
    .string()
    .length(3)
    .optional()
    .describe(
      "ISO-4217 code. **Required when `kind` is `currency`, and rejected otherwise** — a " +
        "revenue metric with no currency cannot have margin computed against it, and a count " +
        "metric carrying one would suggest its numbers are money when they are requests.",
    ),
  costScope: z
    .array(BusinessMetricScopeTerm)
    .max(50)
    .optional()
    .describe(
      "The spend this metric divides, in the same filter vocabulary cost graphs and budgets " +
        "use. Empty (the default) is all of the organization's spend. A unit-cost query may " +
        "narrow this further but can never widen it: the scope is part of what the metric " +
        "means, and a caller who could drop it would be answering a different question under " +
        "the same name.",
    ),
  savedFilterId: Uuid.optional().describe(
    "A saved cost filter AND-composed with `costScope`, resolved server-side at query time. A " +
      "reference that fails to resolve errors the unit-cost query rather than silently widening " +
      "the numerator to all spend.",
  ),
  labelMappings: z
    .array(BusinessMetricLabelMapping)
    .max(8)
    .optional()
    .describe("Which value labels name a cost dimension. One mapping per label."),
  thresholds: z
    .array(UnitCostThreshold)
    .max(10)
    .optional()
    .describe("Standing unit-cost or margin limits. Margin thresholds need a `currency` metric."),
}).openapi("BusinessMetricInput");

const BusinessMetricCoverage = strict({
  firstDay: z.string().describe("Earliest reported day, YYYY-MM-DD."),
  lastDay: z.string(),
  reportedDays: z
    .number()
    .int()
    .describe("Days carrying a value — compare against the span to spot a sparse series."),
}).openapi("BusinessMetricCoverage");

const BusinessMetricImporterSummary = strict({
  accountId: z.string(),
  accountName: z.string().nullable(),
  pluginId: z.string().nullable(),
  sourceLabel: z
    .string()
    .nullable()
    .describe('The source plugin\'s name for itself, e.g. "CloudWatch metric".'),
  enabled: z.boolean(),
  lastRunAt: IsoDateTime.nullable(),
  lastStatus: z.enum(["success", "error"]).nullable(),
  lastError: z.string().nullable(),
}).openapi("BusinessMetricImporterSummary");

const BusinessMetric = strict({
  id: Uuid,
  key: z.string(),
  name: z.string(),
  unit: z.string(),
  description: z.string().nullable(),
  kind: BusinessMetricKind,
  currency: z.string().nullable(),
  costScope: z.array(BusinessMetricScopeTerm),
  savedFilterId: Uuid.nullable(),
  labelMappings: z.array(BusinessMetricLabelMapping),
  thresholds: z.array(UnitCostThreshold),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  coverage: BusinessMetricCoverage.nullable().describe(
    "Null when the metric has no values at all — not an error, but every unit-cost chart drawn " +
      "from it is one continuous gap.",
  ),
  importer: BusinessMetricImporterSummary.nullable().describe(
    "The scheduled importer feeding this metric, or null when its values are only pushed.",
  ),
}).openapi("BusinessMetric");

const ImportSchedule = z
  .enum(["every_6_hours", "every_12_hours", "daily", "weekly"])
  .openapi("BusinessMetricImportSchedule");
const ImportAggregation = z
  .enum(["sum", "average", "min", "max", "last", "count"])
  .openapi("BusinessMetricImportAggregation", {
    description:
      "How several points the source returns for one day (and label) become that day's value. " +
      "A SQL query grouped by day returns one row per day and every choice agrees.",
  });
const SourceParams = z
  .record(z.string(), z.string())
  .describe(
    "The source plugin's form values, keyed by field (see `GET /business-metrics/importer-sources`). " +
      "SQL fields must be a single SELECT or WITH statement; `{{from}}`, `{{to}}`, `{{to_exclusive}}` " +
      "and `{{timezone}}` are replaced with quoted literals.",
  );

const BusinessMetricImporterInput = strict({
  accountId: z
    .string()
    .describe("A connected account whose plugin declares a business-metric source."),
  params: SourceParams,
  schedule: ImportSchedule.optional().describe("Absent is `daily`."),
  backfillDays: z
    .number()
    .int()
    .min(1)
    .max(730)
    .optional()
    .describe("Trailing closed days each scheduled run restates, ending yesterday. Absent is 7."),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone the days are counted in. Absent is `UTC`.")
    .openapi({ example: "America/New_York" }),
  aggregation: ImportAggregation.optional().describe("Absent is `sum`."),
  enabled: z.boolean().optional().describe("Absent is true."),
}).openapi("BusinessMetricImporterInput");

const BusinessMetricImporter = strict({
  id: Uuid,
  metricId: Uuid,
  accountId: z.string(),
  accountName: z.string().nullable(),
  pluginId: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  params: z.record(z.string(), z.string()),
  schedule: ImportSchedule,
  backfillDays: z.number().int(),
  timezone: z.string(),
  aggregation: ImportAggregation,
  enabled: z.boolean(),
  nextRunAt: IsoDateTime.nullable(),
  lastRunAt: IsoDateTime.nullable(),
  lastStatus: z.enum(["success", "error"]).nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z
    .number()
    .int()
    .describe("Failed runs in a row; scheduling backs off on it and a success resets it."),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("BusinessMetricImporter");

const BusinessMetricImportRun = strict({
  id: Uuid,
  importerId: Uuid,
  trigger: z.enum(["schedule", "manual"]),
  status: z.enum(["running", "success", "error"]),
  from: z.string().describe("First day, inclusive, in the importer's timezone."),
  to: z.string(),
  pointsRead: z.number().int(),
  daysWritten: z.number().int(),
  error: z.string().nullable(),
  notes: z.array(z.string()),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  durationMs: z.number().int().nullable(),
}).openapi("BusinessMetricImportRun");

const SourceField = strict({
  key: z.string(),
  label: z.string(),
  type: z.enum(["select", "sql", "text", "number"]),
  required: z.boolean().optional(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  options: z
    .array(strict({ id: z.string(), label: z.string(), description: z.string().optional() }))
    .optional(),
  dependsOn: z.array(z.string()).optional(),
  allowCustom: z.boolean().optional(),
}).openapi("BusinessMetricSourceField");

const BusinessMetricSourceAccount = strict({
  accountId: z.string(),
  accountName: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  source: strict({
    label: z.string(),
    description: z.string().optional(),
    kind: z.enum(["sql", "metric"]),
    fields: z.array(SourceField),
    sqlDialect: z.string().optional(),
    readOnly: z.enum(["enforced", "validated"]).optional(),
    supportsDryRun: z.boolean().optional(),
  }),
}).openapi("BusinessMetricSourceAccount");

const ImportValue = strict({
  date: z.string(),
  value: z.number(),
  label: z.string().optional(),
});

const BusinessMetricImportPreviewRequest = strict({
  accountId: z.string(),
  params: SourceParams,
  from: z.string().optional().describe("Default: 14 days ending yesterday."),
  to: z.string().optional(),
  timezone: z.string().optional(),
  aggregation: ImportAggregation.optional(),
  dryRun: z
    .boolean()
    .optional()
    .describe("Validate with the provider without reading data, where the source supports it."),
}).openapi("BusinessMetricImportPreviewRequest");

const BusinessMetricImportPreview = strict({
  from: z.string(),
  to: z.string(),
  values: z.array(ImportValue),
  pointsRead: z.number().int(),
  days: z.number().int(),
  notes: z.array(z.string()),
  durationMs: z.number().int(),
  dryRun: strict({
    valid: z.boolean(),
    message: z.string(),
    bytesProcessed: z.number().optional(),
  }).optional(),
}).openapi("BusinessMetricImportPreview");

const BusinessMetricValue = strict({
  day: z.string().describe("UTC day, YYYY-MM-DD."),
  value: z.number(),
  label: z
    .string()
    .nullable()
    .describe(
      "The single breakdown label: the `label` key of `labels`, or null. Kept for clients that predate multi-dimensional labels.",
    ),
  labels: BusinessMetricLabels,
  source: z.enum(["api", "workflow", "import"]),
  updatedAt: IsoDateTime,
}).openapi("BusinessMetricValue");

const BusinessMetricValuesInput = strict({
  values: z
    .array(
      strict({
        date: z.string(),
        value: z.number(),
        label: z
          .string()
          .max(200)
          .optional()
          .describe("A single breakdown label, stored as `{ label: <value> }`; `labels` wins."),
        labels: BusinessMetricLabels.optional(),
      }),
    )
    .max(5000)
    .describe(
      "Days to report. **Re-reporting a day (with the same labels) restates it rather than " +
        "adding to it**, so an unattended nightly job is safe to retry — an accumulating write " +
        "would double every number the first time the job re-ran. A batch naming the same day " +
        "and labels twice keeps the last value, applying the same rule within a batch that " +
        "restatement applies between them.",
    ),
}).openapi("BusinessMetricValuesInput");

const BusinessMetricLabelSummary = strict({
  key: z.string(),
  values: z.array(z.string()).describe("Distinct values, alphabetical, at most 500."),
  truncated: z.boolean(),
  mapping: BusinessMetricLabelTarget.nullable(),
}).openapi("BusinessMetricLabelSummary");

const UnitCostLabelFilter = strict({
  key: BusinessMetricLabelKey,
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1).max(200),
}).openapi("UnitCostLabelFilter");

const UnitCostQueryRequest = strict({
  from: z.string().describe("Inclusive, YYYY-MM-DD."),
  to: z.string(),
  binning: z.enum(["hourly", "daily", "weekly", "monthly", "quarterly", "cumulative"]),
  mode: UnitCostMode.optional().describe(
    "Absent is `unit_cost` on the metric route and `usage_unit_cost` on the usage route. " +
      "`margin` is a 400 for a metric whose `kind` is not `currency`.",
  ),
  scale: UnitCostScale.optional(),
  labelFilters: z
    .array(UnitCostLabelFilter)
    .max(10)
    .optional()
    .describe(
      "Keep only values carrying these labels. In a ratio mode each label must be mapped, and " +
        "the spend is narrowed to the same values on the mapped dimension.",
    ),
  groupByLabel: BusinessMetricLabelKey.optional().describe(
    "One series per value of this label (the 25 largest by metric total; the rest fold into " +
      "`Other`). In a ratio mode the label must be mapped.",
  ),
  usageUnit: z
    .string()
    .max(120)
    .optional()
    .describe(
      "`usage_unit_cost` only, and required there: the provider usage unit to divide by. " +
        "See `GET /business-metrics/usage-units`.",
    ),
  filters: z
    .array(BusinessMetricScopeTerm)
    .optional()
    .describe(
      "Narrowing on top of the metric's own `costScope` — AND-composed, never a replacement.",
    ),
  query: z
    .string()
    .max(4000)
    .optional()
    .describe("The same narrowing as cost-query-language text."),
  savedFilterId: Uuid.optional(),
  costBasis: z.enum(["cash", "amortized", "blended"]).optional(),
  chargeTypes: z.array(z.string()).optional(),
  displayCurrency: z
    .string()
    .length(3)
    .optional()
    .describe(
      "Fold spend currencies the organization holds a rate for into this one before dividing. " +
        "Ignored for `margin`, which always converts to the metric's own currency.",
    ),
}).openapi("UnitCostQueryRequest");

const UnitCostPoint = strict({
  bucket: z.string().describe("Bucket start date, YYYY-MM-DD."),
  value: z
    .number()
    .nullable()
    .describe(
      "The ratio, or **null for a gap**. Never 0 and never infinite: a bucket with no reported " +
        "metric value is unknown, not free, and rendering it as 0 would say the opposite of the " +
        "truth. A zero numerator over a positive denominator is a real 0 and is returned as one.",
    ),
  cost: z.number().describe("Spend summed over the bucket, in the series' currency."),
  metricValue: z
    .number()
    .nullable()
    .describe(
      "The denominator summed over the bucket (the metric, or usage for `usage_unit_cost`), " +
        "unscaled, or null when nothing was reported.",
    ),
  absoluteMargin: z
    .number()
    .nullable()
    .optional()
    .describe("`margin` only: revenue − spend in the series currency; null on a gap."),
  gap: z
    .enum(["no_metric_value", "non_positive_metric_value", "unconvertible_currency", "no_usage"])
    .optional()
    .describe("Set exactly when `value` is null."),
  reportedDays: z
    .number()
    .int()
    .describe(
      "Days in the bucket carrying a reported value, out of `bucketDays`. When it is smaller, " +
        "the denominator covers only part of the bucket and the ratio there reads high.",
    ),
  bucketDays: z.number().int(),
}).openapi("UnitCostPoint");

const UnitCostSeries = strict({
  currency: z.string(),
  label: strict({
    key: z.string(),
    value: z
      .string()
      .nullable()
      .describe("Null for values carrying no such label, or for `Other`."),
    other: z.boolean().optional().describe("True for the fold of values past the group cap."),
  })
    .optional()
    .describe("Set when the query grouped by a label."),
  points: z.array(UnitCostPoint),
  overallValue: z
    .number()
    .nullable()
    .describe(
      "The period ratio: **summed numerator ÷ summed denominator**, not the mean of the " +
        "per-bucket ratios — the mean weights a quiet Sunday exactly as heavily as a peak " +
        "Monday. Only buckets that produced a ratio contribute, on both sides.",
    ),
  overallCost: z.number(),
  overallMetricValue: z.number().nullable(),
  overallAbsoluteMargin: z.number().nullable().optional(),
}).openapi("UnitCostSeries");

const UnitCostQueryResponse = strict({
  metric: strict({
    id: Uuid,
    key: z.string(),
    name: z.string(),
    unit: z.string(),
    kind: BusinessMetricKind,
    currency: z.string().nullable(),
  })
    .nullable()
    .describe("Null for `usage_unit_cost`, which divides by provider usage instead."),
  mode: UnitCostMode,
  binning: z.enum(["hourly", "daily", "weekly", "monthly", "quarterly", "cumulative"]),
  scale: UnitCostScale,
  usageUnit: z.string().optional(),
  groupByLabel: z.string().optional(),
  costPerLabel: z
    .boolean()
    .optional()
    .describe(
      "Set when grouped. False means every label series carries the whole scope's spend (a raw " +
        "metric grouped by an unmapped label), so draw that spend once.",
    ),
  series: z
    .array(UnitCostSeries)
    .describe(
      "One series per currency the numerator ended up in — usually one. More than one means " +
        "the organization has spend in a currency it holds no rate for; rather than dropping " +
        "that spend (understating every unit cost) or adding it to another currency (inventing " +
        "a number), each currency divides the same denominator on its own.",
    ),
  conversion: z
    .object({
      displayCurrency: z.string(),
      converted: z.array(
        z.object({
          currency: z.string(),
          rates: z.array(z.object({ effectiveFrom: z.string(), rate: z.number() })),
        }),
      ),
      unconverted: z.array(z.string()),
    })
    .optional()
    .describe("Set only when spend currencies were folded together; absent means untouched."),
  gapBuckets: z.number().int().describe("Buckets on the axis that produced no ratio at all."),
  partialBuckets: z
    .number()
    .int()
    .describe("Buckets whose denominator covers only part of the bucket."),
}).openapi("UnitCostQueryResponse");

export function registerBusinessMetricPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () =>
    params({
      id: z
        .string()
        .openapi({ param: { name: "id", in: "path" }, description: "Metric id or key" }),
    });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/business-metrics",
    tags: ["Business metrics"],
    summary: "List business metrics",
    description:
      "The organization's declared denominators, by key, each with the range of days it has " +
      "values for.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Metrics, by key",
        content: {
          "application/json": { schema: strict({ metrics: z.array(BusinessMetric) }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/business-metrics",
    tags: ["Business metrics"],
    summary: "Create a business metric",
    description:
      "Keys must be unique per organization among live metrics — they are how workflows and the " +
      "CLI address the metric. A key collision is a 409.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: BusinessMetricInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: BusinessMetric } } },
      400: ErrorResponses[400],
      409: {
        description: "A live metric already uses this key.",
        content: { "application/json": { schema: strict({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/business-metrics/{id}",
    tags: ["Business metrics"],
    summary: "Get a business metric",
    description: "`id` accepts either the metric's id or its key.",
    request: { params: idParam() },
    responses: {
      200: { description: "Metric", content: { "application/json": { schema: BusinessMetric } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/business-metrics/{id}",
    tags: ["Business metrics"],
    summary: "Update a business metric",
    description:
      "Replaces the whole definition. Changing `key` never orphans history — values are keyed on " +
      "the metric's id — but it does break a workflow still writing to the old key, which is why " +
      "the key is separate from the display name in the first place.",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: BusinessMetricInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: BusinessMetric } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "A live metric already uses this key.",
        content: { "application/json": { schema: strict({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/business-metrics/{id}",
    tags: ["Business metrics"],
    summary: "Delete a business metric",
    description:
      "Soft delete. Not refused when a dashboard card references the metric, unlike a saved cost " +
      "filter: a unit-cost card whose metric is gone fails its query and says so, whereas a card " +
      "that quietly reverted to plain spend would be a chart claiming to be something it is not.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/business-metrics/{id}/values",
    tags: ["Business metrics"],
    summary: "List a metric's reported values",
    description: "Newest day first.",
    request: {
      params: idParam(),
      // `limit` is a query parameter, so it belongs in `query` rather than
      // `params`. Declaring it inside `params` marks it `in: "path"`, and the
      // `in: "query"` override then collides with that at registration time,
      // which fails the whole spec build, not just this operation.
      query: strict({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .openapi({ description: "Default 90." }),
      }),
    },
    responses: {
      200: {
        description: "Values, newest first",
        content: {
          "application/json": { schema: strict({ values: z.array(BusinessMetricValue) }) },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/business-metrics/{id}/values",
    tags: ["Business metrics"],
    summary: "Report metric values",
    description:
      "Write a batch of days. **Re-reporting a day restates it rather than accumulating**, which " +
      "is what makes a nightly job safe to retry. Nothing lands unless the whole batch validates, " +
      "so a bad row is a 400 rather than half a month restated. The same guarantees back " +
      "`infra.businessMetrics.write(...)` in a workflow — both go through one validator.",
    request: {
      params: idParam(),
      body: {
        content: { "application/json": { schema: BusinessMetricValuesInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Written",
        content: {
          "application/json": {
            schema: strict({
              written: z.number().int().describe("Days written, counting restatements."),
            }),
          },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/business-metrics/importer-sources",
    tags: ["Business metrics"],
    summary: "List importer sources",
    description:
      "Connected accounts whose plugin can feed a business metric on a schedule, each with the " +
      "plugin's importer form: which fields to fill and which are pickers.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Sources",
        content: {
          "application/json": { schema: strict({ sources: z.array(BusinessMetricSourceAccount) }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/business-metrics/importer-options",
    tags: ["Business metrics"],
    summary: "List an importer picker's choices",
    description:
      "Choices for one `select` field of a source's form, given the values picked so far. Needs " +
      "`resources:execute` and `costs:write`: it calls the provider with the account's credentials.",
    request: {
      params: OrgIdParam,
      body: {
        content: {
          "application/json": {
            schema: strict({ accountId: z.string(), fieldKey: z.string(), params: SourceParams }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Choices",
        content: {
          "application/json": {
            schema: strict({
              options: z.array(
                strict({ id: z.string(), label: z.string(), description: z.string().optional() }),
              ),
            }),
          },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/business-metrics/importer-preview",
    tags: ["Business metrics"],
    summary: "Preview an importer",
    description:
      "Run a source over a window and return the values it would write, writing nothing; or, " +
      "with `dryRun`, validate the query with the provider without reading data. Read-only " +
      "queries only, with the same row limit and timeout as a scheduled run.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: BusinessMetricImportPreviewRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Preview",
        content: { "application/json": { schema: BusinessMetricImportPreview } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/business-metrics/{id}/importer",
    tags: ["Business metrics"],
    summary: "Get a metric's importer",
    description: "`importer` is null when the metric's values are only pushed.",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Importer",
        content: {
          "application/json": {
            schema: strict({ importer: BusinessMetricImporter.nullable() }),
          },
        },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/business-metrics/{id}/importer",
    tags: ["Business metrics"],
    summary: "Create or replace a metric's importer",
    description:
      "One importer per metric. A full replace: omitted fields take their defaults. Each run " +
      "restates whole days (every label a day carried is replaced by what the source returned), " +
      "never touches days the source returned nothing for, and ignores points outside the " +
      "window. Changing the account, the params or the schedule makes it due immediately.",
    request: {
      params: idParam(),
      body: {
        content: { "application/json": { schema: BusinessMetricImporterInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Saved",
        content: { "application/json": { schema: BusinessMetricImporter } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/business-metrics/{id}/importer",
    tags: ["Business metrics"],
    summary: "Delete a metric's importer",
    description: "Stops importing and drops the run history. Values already imported stay.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/business-metrics/{id}/importer/run",
    tags: ["Business metrics"],
    summary: "Run a metric's importer now",
    description:
      "Runs synchronously and returns the finished run, failed or not. With no body it reads the " +
      "importer's own window; `from`/`to` backfill a wider one (at most 730 days).",
    request: {
      params: idParam(),
      body: {
        content: {
          "application/json": {
            schema: strict({ from: z.string().optional(), to: z.string().optional() }),
          },
        },
        required: false,
      },
    },
    responses: {
      200: {
        description: "Run",
        content: { "application/json": { schema: BusinessMetricImportRun } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/business-metrics/{id}/importer/runs",
    tags: ["Business metrics"],
    summary: "List a metric's import runs",
    description: "Newest first; the most recent 50 are kept.",
    request: {
      params: idParam(),
      query: strict({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .openapi({ description: "Default 20." }),
      }),
    },
    responses: {
      200: {
        description: "Runs",
        content: {
          "application/json": { schema: strict({ runs: z.array(BusinessMetricImportRun) }) },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/business-metrics/{id}/unit-costs",
    tags: ["Business metrics"],
    summary: "Query unit costs or margin",
    description:
      "Divide spend by the metric, bucketed as asked. Three properties of the answer are worth " +
      "knowing before reading it:\n\n" +
      "- **The ratio is computed at the requested bucket**, from a summed numerator and a summed " +
      "denominator — never a mean of daily ratios, which weights a quiet day as heavily as a " +
      "peak one. The same holds for `overallValue`.\n" +
      "- **A missing or non-positive denominator is a gap** (`value: null` with a `gap` reason), " +
      "never 0 and never infinite.\n" +
      "- **Currencies are never merged.** Spend in a currency with no stated rate keeps its own " +
      "series rather than being dropped or added to another.\n\n" +
      "There is no spend `groupBy`: a per-group ratio needs a per-group denominator. Split by a " +
      "metric label with `groupByLabel` instead; in a ratio mode the label must be mapped to the " +
      "cost dimension its values name (`labelMappings` on the metric), so each label value's " +
      "spend is divided by its own volume.",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: UnitCostQueryRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Unit-cost series",
        content: { "application/json": { schema: UnitCostQueryResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/business-metrics/{id}/labels",
    tags: ["Business metrics"],
    summary: "List a metric's labels",
    description:
      "The label keys the metric's values carry, each with its distinct values (at most 500) and " +
      "its cost mapping. A mapped label nobody has reported yet is listed with no values.",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Labels, by key",
        content: {
          "application/json": { schema: strict({ labels: z.array(BusinessMetricLabelSummary) }) },
        },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/business-metrics/usage-units",
    tags: ["Business metrics"],
    summary: "List usage units",
    description:
      "The provider usage units the organization's cost rows carry over the last 90 days, most " +
      "spend first, with a few of the services reporting each. Backs the per-usage-unit picker.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Usage units",
        content: {
          "application/json": {
            schema: strict({
              units: z.array(
                strict({
                  unit: z.string(),
                  usage: z.number(),
                  services: z.array(z.string()),
                }),
              ),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/business-metrics/usage-unit-costs",
    tags: ["Business metrics"],
    summary: "Query cost per usage unit",
    description:
      "Spend divided by the usage quantity providers report in one `usageUnit`, with no business " +
      "metric involved. Both halves come from the same cost rows (those reported in that unit), " +
      "so the numerator is exactly the spend that bought the denominator. A bucket with no usage " +
      "is a gap (`no_usage`), never 0. Labels do not apply.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: UnitCostQueryRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Unit-cost series",
        content: { "application/json": { schema: UnitCostQueryResponse } },
      },
      400: ErrorResponses[400],
    },
  });
}
