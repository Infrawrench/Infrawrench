import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const CostDimension = z
  .enum(["provider", "account", "service", "region", "resource", "tag"])
  .openapi("CostDimension");

const CostFilter = strict({
  dimension: CostDimension,
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  tagKey: z.string().optional(),
}).openapi("CostFilter");

const CostQueryRequest = strict({
  from: IsoDate,
  to: IsoDate,
  binning: z.enum(["daily", "weekly", "monthly", "cumulative"]),
  groupBy: z.enum(["none", "provider", "account", "service", "region", "resource", "tag"]),
  groupByTagKey: z.string().optional(),
  filters: z.array(CostFilter).optional(),
  topN: z.number().int().min(1).max(15).optional(),
  comparePreviousPeriod: z.boolean().optional(),
  forecast: z.boolean().optional(),
}).openapi("CostQueryRequest");

const CostSeriesPoint = strict({
  bucket: IsoDate,
  amount: z.number(),
}).openapi("CostSeriesPoint");

const CostQuerySeries = strict({
  key: z.string(),
  label: z.string(),
  currency: z.string(),
  points: z.array(CostSeriesPoint),
}).openapi("CostQuerySeries");

const CostQueryResponse = strict({
  series: z.array(CostQuerySeries),
  comparison: z.array(CostQuerySeries).optional(),
  forecast: z.array(CostSeriesPoint).optional(),
  currencies: z.array(z.string()),
  totals: z.record(z.number()),
  previousTotals: z.record(z.number()).optional(),
}).openapi("CostQueryResponse");

const CostDimensionValues = strict({
  values: z.array(z.union([z.string(), strict({ value: z.string(), label: z.string() })])),
}).openapi("CostDimensionValues");

const CostAccountStatus = strict({
  accountId: Uuid,
  pluginId: z.string(),
  displayName: z.string(),
  supportsCosts: z.boolean(),
  periodNative: z.boolean(),
  dimensions: z.array(z.enum(["service", "region", "resource", "tag"])),
  costLastPolledAt: IsoDateTime.nullable(),
  costBackfilledAt: IsoDateTime.nullable(),
  costPollFailureCount: z.number().int(),
  costPollError: strict({
    message: z.string(),
    helpLink: strict({ label: z.string(), url: z.string() }).nullable(),
  })
    .nullable()
    .describe(
      "Last cost-collection failure for this account, cleared on the next success. " +
        "`helpLink` points at the provider page that fixes a setup problem when the " +
        "plugin can identify one (e.g. GCP's billing export console).",
    ),
  coverage: strict({ firstDay: IsoDate, lastDay: IsoDate }).nullable(),
}).openapi("CostAccountStatus");

const CostAnomaly = strict({
  id: Uuid,
  day: IsoDate.describe("The anomalous UTC day."),
  kind: z
    .enum(["spike", "new_source"])
    .describe(
      "Which detection produced the row. `spike` is spend far above the key's own trailing " +
        "baseline; `new_source` is a provider or service with no spend at all across the " +
        "trailing window that suddenly has material spend — it can never be a `spike`, since " +
        "a zero baseline has no mean or deviation to exceed. Rows written before new-source " +
        "detection existed read as `spike`.",
    ),
  dimension: z.enum(["provider", "service"]),
  dimensionKey: z.string().describe("The dimension's value — a plugin id or a service name."),
  currency: z.string(),
  actualCents: z.number().int(),
  baselineCents: z
    .number()
    .int()
    .describe(
      "Mean daily spend over the trailing 28-day baseline, in cents. Zero, or near it, for a " +
        "`new_source` — clients must not compute a percentage change from it.",
    ),
  thresholdCents: z
    .number()
    .int()
    .describe(
      "The detection bar the day cleared, in cents: baseline mean + N·stddev for a `spike`, " +
        "the new-source floor for a `new_source`.",
    ),
  detectedAt: IsoDateTime,
  notifiedAt: IsoDateTime.nullable().describe(
    "When the anomaly was delivered to a notification channel; null when delivery " +
      "failed or a recent anomaly for the same key suppressed it.",
  ),
}).openapi("CostAnomaly");

const CostAnomalySettings = strict({
  sigmas: z
    .number()
    .min(1)
    .max(10)
    .describe(
      "Standard deviations above a key's own trailing mean that count as a spike. " +
        "Lower is more sensitive. Bounded at 1 — below that roughly a third of ordinary " +
        "days clear the bar — and at 10, above which nothing short of a 10x jump fires. " +
        "Defaults to 3.",
    ),
  minDeltaCents: z
    .number()
    .int()
    .min(100)
    .max(10_000_000)
    .describe(
      "Minimum rise over the baseline mean before a spike alerts, in USD cents (converted " +
        "per series, so it means the same real amount in every currency). Defaults to 1000 ($10).",
    ),
  newSourceMinCents: z
    .number()
    .int()
    .min(100)
    .max(10_000_000)
    .describe(
      "Minimum first-day spend before a new spend source alerts, in USD cents. A key with no " +
        "prior spend has no statistical bar to clear, so this absolute floor is the only thing " +
        "keeping a new $0.02/day service quiet. Defaults to 2500 ($25).",
    ),
}).openapi("CostAnomalySettings");

const PushedCostRow = strict({
  date: IsoDate.describe("UTC day the spend belongs to."),
  currency: z.string().length(3).openapi({ example: "USD" }),
  amount: z.number().describe("Money for this day/dimension combination. Negative for credits."),
  service: z
    .string()
    .max(256)
    .optional()
    .openapi({ example: "Snowflake Compute", description: "Becomes a group/filter value." }),
  region: z.string().max(256).optional(),
  resourceId: z
    .string()
    .max(256)
    .optional()
    .describe("Opaque id of the thing being billed; groups the `resource` dimension."),
  tags: z
    .record(z.string())
    .optional()
    .describe(
      "Cost-allocation tags, at most 32. Keys starting with `infrawrench:` are reserved and rejected.",
    ),
  usageAmount: z.number().optional(),
  usageUnit: z.string().max(256).optional(),
  accountId: Uuid.optional().describe(
    "Attribute this row to a connected account. Must belong to the calling organization. " +
      "Omit to attribute it to the source itself.",
  ),
}).openapi("PushedCostRow");

const CostPushRequest = strict({
  source: z
    .string()
    .max(64)
    .openapi({
      example: "snowflake-invoices",
      description:
        "Stable slug naming the system that owns these rows: letters, digits, `.`, `_` and `-`. " +
        "It groups the rows under an `External` provider and an `external:<source>` account, " +
        "and re-pushing the same source over the same days restates only its own rows.",
    }),
  rows: z.array(PushedCostRow).max(5000),
}).openapi("CostPushRequest");

const CostPushResponse = strict({
  written: z.number().int(),
}).openapi("CostPushResponse");

export function registerCostPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/costs/rows",
    tags: ["Costs"],
    summary: "Push cost rows from your own systems",
    description:
      "Reports spend Infrawrench has no provider plugin for — a parsed SaaS invoice, an internal " +
      "chargeback, a colo bill — into the same store the provider collectors write to, so it " +
      "appears in cost graphs, dimension filters, and budgets alongside everything else.\n\n" +
      "Rows are grouped under a caller-chosen `source`. Writes are idempotent per " +
      "`(source, day, service, region, resourceId, tags, currency)`: pushing the same day again " +
      "restates that day rather than adding to it, so a nightly job can safely re-push a trailing " +
      "window. Rows pushed under a source can never overwrite rows a provider collector wrote.\n\n" +
      "The whole batch is validated before anything is stored, so a 400 means nothing was written.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostPushRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Rows written",
        content: { "application/json": { schema: CostPushResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/costs/query",
    tags: ["Costs"],
    summary: "Query aggregated cost series",
    description:
      "Aggregates collected provider spend into per-bucket, per-group series for cost graphs. " +
      "Currencies are never merged; mixed-currency orgs get one series per currency. " +
      "Optionally returns a previous-period comparison and a trend forecast.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostQueryRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Cost series",
        content: { "application/json": { schema: CostQueryResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/dimensions",
    tags: ["Costs"],
    summary: "List distinct values for a cost dimension",
    description:
      "Feeds the filter and group-by pickers. Pass dimension=tag-keys for tag keys; " +
      "dimension=tag requires tagKey.",
    request: {
      params: OrgIdParam,
      query: strict({
        dimension: z.enum([
          "provider",
          "account",
          "service",
          "region",
          "resource",
          "tag",
          "tag-keys",
        ]),
        tagKey: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Values",
        content: { "application/json": { schema: CostDimensionValues } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/anomalies",
    tags: ["Costs"],
    summary: "List recently detected cost anomalies",
    description:
      "Spend anomalies detected by the daily background pass. Two kinds share the list: a " +
      "`spike`, where a provider's or service's spend exceeded its trailing 28-day baseline " +
      "by a statistical threshold (mean + N·stddev, with an absolute floor to ignore " +
      "penny-scale noise), and a `new_source`, where a provider or service with no spend at " +
      "all across that window suddenly billed a material amount. Thresholds are per " +
      "organization — see GET /costs/anomaly-settings. Newest day first, capped at 200 rows.",
    request: {
      params: OrgIdParam,
      query: strict({
        days: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Window in days over anomalous days, 1-90. Defaults to 30."),
      }),
    },
    responses: {
      200: {
        description: "Anomalies",
        content: {
          "application/json": { schema: strict({ anomalies: z.array(CostAnomaly) }) },
        },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/anomaly-settings",
    tags: ["Costs"],
    summary: "Get the organization's anomaly detection thresholds",
    description:
      "The tunable part of cost anomaly detection. Everything else about the model — the " +
      "28-day baseline, the 7-day notification cooldown, the minimum history a baseline needs " +
      "— is fixed. An organization that has never changed a threshold reads back the defaults.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Anomaly settings",
        content: { "application/json": { schema: CostAnomalySettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/costs/anomaly-settings",
    tags: ["Costs"],
    summary: "Update the organization's anomaly detection thresholds",
    description:
      "Takes effect on the next detection pass (which runs after each cost collection). " +
      "Anomalies already stored are not re-judged. All three fields are required — this is a " +
      "PUT of the whole settings object, not a patch.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostAnomalySettings } }, required: true },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: CostAnomalySettings } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/status",
    tags: ["Costs"],
    summary: "Per-account cost collection status",
    description:
      "Which accounts support cost collection, whether their history backfill has completed, " +
      "and the ingested date coverage.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Status",
        content: {
          "application/json": { schema: strict({ accounts: z.array(CostAccountStatus) }) },
        },
      },
    },
  });
}
