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
