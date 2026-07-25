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

export function registerCostPaths(ctx: BuildContext) {
  const { registry } = ctx;

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
