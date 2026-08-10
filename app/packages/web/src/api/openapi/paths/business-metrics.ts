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
  ]),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  tagKey: z.string().optional(),
}).openapi("BusinessMetricScopeTerm");

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
}).openapi("BusinessMetricInput");

const BusinessMetricCoverage = strict({
  firstDay: z.string().describe("Earliest reported day, YYYY-MM-DD."),
  lastDay: z.string(),
  reportedDays: z
    .number()
    .int()
    .describe("Days carrying a value — compare against the span to spot a sparse series."),
}).openapi("BusinessMetricCoverage");

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
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  coverage: BusinessMetricCoverage.nullable().describe(
    "Null when the metric has no values at all — not an error, but every unit-cost chart drawn " +
      "from it is one continuous gap.",
  ),
}).openapi("BusinessMetric");

const BusinessMetricValue = strict({
  day: z.string().describe("UTC day, YYYY-MM-DD."),
  value: z.number(),
  source: z.enum(["api", "workflow"]),
  updatedAt: IsoDateTime,
}).openapi("BusinessMetricValue");

const BusinessMetricValuesInput = strict({
  values: z
    .array(strict({ date: z.string(), value: z.number() }))
    .max(5000)
    .describe(
      "Days to report. **Re-reporting a day restates it rather than adding to it**, so an " +
        "unattended nightly job is safe to retry — an accumulating write would double every " +
        "number the first time the job re-ran. A batch naming the same day twice keeps the last " +
        "value, applying the same rule within a batch that restatement applies between them.",
    ),
}).openapi("BusinessMetricValuesInput");

const UnitCostQueryRequest = strict({
  from: z.string().describe("Inclusive, YYYY-MM-DD."),
  to: z.string(),
  binning: z.enum(["daily", "weekly", "monthly", "cumulative"]),
  mode: z
    .enum(["unit_cost", "margin"])
    .optional()
    .describe(
      "Absent is `unit_cost` (spend ÷ metric value). `margin` is `(revenue − spend) ÷ revenue` " +
        "as a fraction, and is a 400 for a metric whose `kind` is not `currency`.",
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
  costBasis: z.enum(["cash", "amortized"]).optional(),
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
    .describe("Metric value summed over the bucket, or null when nothing was reported."),
  gap: z
    .enum(["no_metric_value", "non_positive_metric_value", "unconvertible_currency"])
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
}).openapi("UnitCostSeries");

const UnitCostQueryResponse = strict({
  metric: strict({
    id: Uuid,
    key: z.string(),
    name: z.string(),
    unit: z.string(),
    kind: BusinessMetricKind,
    currency: z.string().nullable(),
  }),
  mode: z.enum(["unit_cost", "margin"]),
  binning: z.enum(["daily", "weekly", "monthly", "cumulative"]),
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
      // `in: "query"` override then collides with that at registration time —
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
      "There is no `groupBy`: a per-group ratio would need a per-group denominator, and dividing " +
      "each service's spend by the whole customer count produces numbers that do not sum to the " +
      "real one.",
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
}
