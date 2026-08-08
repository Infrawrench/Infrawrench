import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { CostQueryResponse } from "./costs";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const ReportCostFilter = strict({
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
}).openapi("CostReportFilter");

const CostDateRange = z
  .union([
    strict({
      kind: z.literal("relative"),
      preset: z.enum(["7d", "30d", "90d", "mtd", "last_month", "qtd", "ytd", "12m"]),
    }),
    strict({ kind: z.literal("absolute"), from: IsoDate, to: IsoDate }),
  ])
  .describe(
    "A relative preset resolves against today every time the report runs, so a saved report " +
      "keeps meaning 'the last 30 days'; an absolute range pins it to fixed dates.",
  )
  .openapi("CostDateRange");

const CostGraphConfig = strict({
  version: z.literal(1),
  chartType: z.enum(["stacked_bar", "multi_bar", "line", "area", "pie"]),
  binning: z.enum(["daily", "weekly", "monthly", "cumulative"]),
  dateRange: CostDateRange,
  groupBy: z.enum([
    "none",
    "provider",
    "account",
    "service",
    "region",
    "resource",
    "tag",
    "charge_type",
    "commitment",
  ]),
  groupByTagKey: z.string().optional(),
  filters: z.array(ReportCostFilter).optional(),
  topN: z.number().int().min(1).max(15).optional(),
  comparePreviousPeriod: z.boolean().optional(),
  showForecast: z.boolean().optional(),
  costBasis: z.enum(["cash", "amortized"]).optional(),
})
  .describe(
    "The saved graph. Identical to the config an ad-hoc `cost_graph` dashboard widget stores " +
      "inline — a report is that config given a name and an id.",
  )
  .openapi("CostGraphConfig");

const FolderId = z
  .string()
  .nullable()
  .describe(
    "Reserved for report folders, which do not exist yet: the column is stored and round-tripped " +
      "but nothing reads it, and there is no folders endpoint to obtain an id from.",
  );

const CostReportInput = strict({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  config: CostGraphConfig,
  folderId: FolderId.optional(),
}).openapi("CostReportInput");

const CostReportPlacement = strict({
  widgetId: Uuid,
  dashboardId: Uuid,
  dashboardName: z.string(),
}).openapi("CostReportPlacement");

const CostReport = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  config: CostGraphConfig,
  folderId: FolderId,
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  placements: z
    .array(CostReportPlacement)
    .describe(
      "The dashboards carrying a `cost_report` card for this report. Empty is normal — a report " +
        "exists, and can be run, whether or not any dashboard shows it. Deleting the report " +
        "removes these cards; removing a card leaves the report alone.",
    ),
}).openapi("CostReport");

const CostReportRunResult = strict({
  reportId: Uuid,
  name: z.string(),
  from: IsoDate,
  to: IsoDate,
  result: CostQueryResponse,
}).openapi("CostReportRunResult");

export function registerCostReportPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () => params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-reports",
    tags: ["Cost reports"],
    summary: "List saved cost reports",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Reports",
        content: { "application/json": { schema: z.array(CostReport) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-reports",
    tags: ["Cost reports"],
    summary: "Create a cost report",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostReportInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: CostReport } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-reports/{id}",
    tags: ["Cost reports"],
    summary: "Get a cost report",
    request: { params: idParam() },
    responses: {
      200: { description: "Report", content: { "application/json": { schema: CostReport } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-reports/{id}",
    tags: ["Cost reports"],
    summary: "Update a cost report",
    description:
      "Replaces the report's name, description, config and folder. Every dashboard showing the " +
      "report picks up the new config — that is what referencing a report by id buys.",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: CostReportInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: CostReport } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-reports/{id}",
    tags: ["Cost reports"],
    summary: "Delete a cost report",
    description:
      "Soft delete. Every dashboard card pointing at the report is removed with it — a card whose " +
      "report is gone could only ever render as an unavailable tile.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-reports/{id}/run",
    tags: ["Cost reports"],
    summary: "Run a cost report",
    description:
      "Executes the report's saved config and returns the series, along with the inclusive " +
      "window a relative preset resolved to. Takes no body: the report *is* the query, so a " +
      "caller never has to reassemble its config to get the numbers.",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Result",
        content: { "application/json": { schema: CostReportRunResult } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
