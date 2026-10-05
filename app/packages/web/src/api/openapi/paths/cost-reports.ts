import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import {
  CostBinning,
  CostCumulative,
  CostMeasure,
  CostQueryResponse,
  CostUsageUnit,
} from "./costs";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

export const ReportCostFilter = strict({
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
}).openapi("CostReportFilter");

export const CostDateRange = z
  .union([
    strict({
      kind: z.literal("relative"),
      preset: z.enum(["7d", "30d", "90d", "mtd", "last_month", "qtd", "ytd", "6m", "12m"]),
    }),
    strict({ kind: z.literal("absolute"), from: IsoDate, to: IsoDate }),
  ])
  .describe(
    "A relative preset resolves against today every time the report runs, so a saved report " +
      "keeps meaning 'the last 30 days'; an absolute range pins it to fixed dates.",
  )
  .openapi("CostDateRange");

export const CostGraphConfig = strict({
  version: z.literal(1),
  chartType: z
    .enum(["stacked_bar", "multi_bar", "line", "area", "pie", "donut", "table"])
    .describe(
      "How the series are drawn. `pie` and `donut` draw period totals per group; `table` lists " +
        "every bucket as a row with a column per series and a total.",
    ),
  binning: CostBinning,
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
    "virtual_tag",
  ]),
  groupByTagKey: z.string().optional(),
  filters: z.array(ReportCostFilter).optional(),
  savedFilterId: z
    .string()
    .optional()
    .describe(
      "A saved cost filter (see /saved-cost-filters) applied by reference and AND-composed " +
        "with `filters` at query time, server-side. Editing the saved filter changes every " +
        "graph, report and budget referencing it; a reference that fails to resolve makes " +
        "the query error rather than silently run unfiltered.",
    ),
  topN: z.number().int().min(1).max(15).optional(),
  comparePreviousPeriod: z.boolean().optional(),
  showForecast: z.boolean().optional(),
  scenarioModelId: z
    .string()
    .optional()
    .describe(
      "A scenario model (see /cost-scenarios) overlaid on the forecast — known future cost the " +
        "trend cannot see, drawn as a second dashed line beside the trend rather than instead " +
        "of it. Only meaningful alongside `showForecast`.",
    ),
  costBasis: z.enum(["cash", "amortized", "blended"]).optional(),
  measure: CostMeasure.optional(),
  usageUnit: CostUsageUnit.optional(),
  cumulative: CostCumulative.optional(),
  unitCostMetricId: z
    .string()
    .optional()
    .describe(
      "Divide spend by this business metric (an id, so a key rename never re-points the graph).",
    ),
  unitCostMode: z
    .enum(["unit_cost", "margin", "usage_unit_cost", "raw_metric"])
    .optional()
    .describe(
      "The calculation. `usage_unit_cost` needs `unitCostUsageUnit` instead of a metric; the " +
        "others need `unitCostMetricId`.",
    ),
  unitCostScale: z
    .union([
      z.literal(1),
      z.literal(100),
      z.literal(1000),
      z.literal(1000000),
      z.literal(1000000000),
    ])
    .optional()
    .describe('"Per N units" for a ratio, or the unit a raw metric is shown in. Absent is 1.'),
  unitCostUsageUnit: z
    .string()
    .optional()
    .describe("`usage_unit_cost` only: the provider usage unit to divide by."),
  unitCostLabelFilters: z
    .array(
      strict({
        key: z.string(),
        op: z.enum(["in", "not_in"]),
        values: z.array(z.string()).min(1),
      }),
    )
    .max(10)
    .optional()
    .describe("Keep only metric values carrying these labels."),
  unitCostGroupByLabel: z.string().optional().describe("One line per value of this metric label."),
  adjusted: z.boolean().optional().describe("Draw the org's billing rules applied."),
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
    "Folder the report is filed under (see /cost-report-folders); null is the top level of the " +
      "Reports list. Moving a report is this same PUT with a different folderId; an id from " +
      "another org is a 400. Deleting a folder never deletes its reports — they fall back to " +
      "the top level.",
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

const CostReportRunOverrides = strict({
  measure: CostMeasure.optional(),
  usageUnit: CostUsageUnit.optional(),
  binning: CostBinning.optional(),
  cumulative: CostCumulative.optional(),
}).openapi("CostReportRunOverrides");

const CostReportRunResult = strict({
  reportId: Uuid,
  name: z.string(),
  from: IsoDate,
  to: IsoDate,
  result: CostQueryResponse,
}).openapi("CostReportRunResult");

const BulkIds = z.array(Uuid).max(500);

const CostReportBulkRequest = z
  .union([
    strict({
      action: z.literal("move"),
      reportIds: BulkIds,
      folderIds: BulkIds,
      targetFolderId: Uuid.nullable().describe(
        "Destination folder; null is the top level. Reports are filed into it and folders " +
          "become its direct children. Needs editor on the destination, because a folder's " +
          "sharing extends to what is filed in it.",
      ),
    }),
    strict({ action: z.literal("delete"), reportIds: BulkIds, folderIds: BulkIds }),
  ])
  .describe(
    "At least one id and at most 500 in total. Reports and folders are validated together " +
      "against the tree as it will be after every move, then applied in one transaction.",
  )
  .openapi("CostReportBulkRequest");

const CostReportBulkResult = strict({
  action: z.enum(["move", "delete"]),
  reports: z.number().int().describe("Reports moved or deleted."),
  folders: z.number().int().describe("Folders moved or deleted."),
}).openapi("CostReportBulkResult");

const CostReportBulkProblem = strict({
  kind: z.enum(["report", "folder", "target"]),
  id: z.string(),
  name: z
    .string()
    .nullable()
    .describe("The item's name, or null when it does not exist or is not visible to the caller."),
  message: z.string(),
}).openapi("CostReportBulkProblem");

const CostReportBulkError = strict({
  error: z.string(),
  problems: z
    .array(CostReportBulkProblem)
    .optional()
    .describe("Every item that blocked the request. Present when the body was well-formed."),
  issues: z.array(z.unknown()).optional(),
}).openapi("CostReportBulkError");

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
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-reports/bulk",
    tags: ["Cost reports"],
    summary: "Move or delete many reports and folders at once",
    description:
      "All or nothing. Every item is checked first: it exists, the caller's per-object sharing " +
      "allows the action (editor to move, owner to delete, or editor when nobody owns it), and " +
      "for a move, the folder tree that would result keeps every folder within the three-level " +
      "nesting limit and free of cycles. Any problem is a 400 listing each blocking item, and " +
      "nothing is written. Deleting a report removes its dashboard cards and pauses its " +
      "delivery schedules; deleting a folder drops whatever remains inside it to the top level. " +
      "One audit entry is written per item.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostReportBulkRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Applied",
        content: { "application/json": { schema: CostReportBulkResult } },
      },
      400: {
        description: "Refused; nothing was changed",
        content: { "application/json": { schema: CostReportBulkError } },
      },
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
      403: ErrorResponses[403],
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
      "window a relative preset resolved to. The body is optional: the report *is* the query, " +
      "so a caller never has to reassemble its config to get the numbers. It may carry " +
      "one-off display overrides (`measure`, `usageUnit`, `binning`, `cumulative`) that apply " +
      "to this run only and are never saved; switching a run to `usage` or `count` drops the " +
      "saved forecast, scenario and billing rules, which only apply to money.",
    request: {
      params: idParam(),
      body: {
        required: false,
        content: { "application/json": { schema: CostReportRunOverrides } },
      },
    },
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
