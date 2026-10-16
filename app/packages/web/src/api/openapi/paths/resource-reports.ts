import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { CostDateRange } from "./cost-reports";
import { CostReportFolder } from "./cost-report-folders";
import { CostBasis } from "./costs";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const ColumnId = z
  .string()
  .min(1)
  .openapi({
    description:
      "`<kind>:<key>`. `core:name|type|provider|account|region|status|created|external_id`; " +
      "`field:<key>` a key of the resource's synced fields (offered by `GET /resource-reports/" +
      "options`); `tag:<key>` a provider tag; `vtag:<key>` a virtual tag, read from the " +
      "resource's own cost rows over `costRange` (the value holding the most spend); " +
      "`cost:range|mtd|previous_month` spend joined by provider resource id.",
    example: "cost:range",
  });

const TagFilter = strict({
  source: z
    .enum(["tag", "virtual_tag"])
    .describe("Provider tags (from the resource) or virtual tags (from its cost rows)."),
  key: z.string().min(1),
  op: z
    .enum(["in", "not_in", "exists", "missing"])
    .describe("`exists` and `missing` take no values; `in` and `not_in` need at least one."),
  values: z.array(z.string()).max(200),
}).openapi("ResourceReportTagFilter");

const Filters = strict({
  pluginIds: z.array(z.string()).max(200).describe("Providers; empty does not filter."),
  accountIds: z.array(z.string()).max(200),
  resourceTypes: z
    .array(strict({ pluginId: z.string(), resourceTypeId: z.string() }))
    .max(200)
    .describe("Resource types, each with its plugin, since type ids repeat across plugins."),
  regions: z.array(z.string()).max(200).describe("Matched exactly, as synced."),
  statuses: z.array(z.string()).max(200).describe("Matched ignoring case."),
  tags: z.array(TagFilter).max(10).describe("AND-ed."),
  nameContains: z.string().max(200).nullable(),
  createdFrom: IsoDate.nullable().describe("Inclusive UTC day on the created column."),
  createdTo: IsoDate.nullable(),
}).openapi("ResourceReportFilters");

const Sort = strict({
  column: ColumnId,
  direction: z.enum(["asc", "desc"]),
}).openapi("ResourceReportSort");

const Config = strict({
  version: z.literal(1),
  filters: Filters,
  columns: z.array(ColumnId).min(1).max(40).describe("Shown columns, in display order."),
  sort: Sort.nullable().describe("Null sorts by name, ascending."),
  costRange: CostDateRange,
  costBasis: CostBasis,
  pageSize: z.number().int().min(1).max(500),
}).openapi("ResourceReportConfig");

const ReportFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  config: Config,
  folderId: Uuid.nullable().describe(
    "A report folder (the tree cost reports use); null is the top level.",
  ),
};

const ResourceReport = strict({
  id: Uuid,
  name: ReportFields.name,
  description: ReportFields.description.nullable(),
  config: Config,
  folderId: ReportFields.folderId,
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("ResourceReport");

const ResourceReportInput = strict({
  name: ReportFields.name,
  description: ReportFields.description.optional(),
  config: Config,
  folderId: ReportFields.folderId.optional(),
}).openapi("ResourceReportInput");

const Money = strict({ currency: z.string(), amount: z.number() }).openapi("ResourceReportMoney");

const Column = strict({
  id: ColumnId,
  kind: z.enum(["core", "field", "tag", "vtag", "cost"]),
  key: z.string(),
  label: z.string().describe("English label, as the CSV header prints it."),
}).openapi("ResourceReportColumn");

const Row = strict({
  id: z.string().describe("The resource id the resource detail view is addressed by."),
  accountId: Uuid,
  pluginId: z.string(),
  resourceTypeId: z.string(),
  values: z
    .record(z.string(), z.string().nullable())
    .describe("Text per non-cost column id; null when the resource has no value."),
  costs: z
    .record(z.string(), z.array(Money))
    .describe(
      "Spend per cost column id, one entry per currency, largest first. Empty when the " +
        "resource had no cost rows in the window.",
    ),
}).openapi("ResourceReportRow");

const CostWindow = z.enum(["range", "mtd", "previous_month"]);

const RowsResult = strict({
  columns: z.array(Column),
  rows: z.array(Row),
  total: z.number().int().describe("Matching resources; a lower bound when `truncated`."),
  offset: z.number().int(),
  limit: z.number().int(),
  truncated: z
    .boolean()
    .describe(
      "A filter or the sort needed the in-memory scan and it stopped at 100,000 resources.",
    ),
  sort: Sort,
  cost: strict({
    available: z
      .boolean()
      .describe(
        "False without `costs:read` or a cost store: cost and virtual tag cells are empty.",
      ),
    reason: z.string().nullable(),
    basis: CostBasis,
    windows: z.array(strict({ window: CostWindow, from: IsoDate, to: IsoDate })),
  })
    .nullable()
    .describe("Null when the report has no cost or virtual tag column."),
}).openapi("ResourceReportRows");

const Counted = strict({ value: z.string(), label: z.string(), count: z.number().int() });

const Options = strict({
  providers: z.array(Counted),
  accounts: z.array(Counted.extend({ pluginId: z.string() })),
  resourceTypes: z.array(
    strict({
      pluginId: z.string(),
      resourceTypeId: z.string(),
      label: z.string(),
      count: z.number().int(),
    }),
  ),
  regions: z.array(Counted),
  statuses: z.array(Counted),
  fields: z
    .array(
      strict({
        key: z.string(),
        label: z.string(),
        count: z.number().int(),
        declared: z
          .boolean()
          .describe("Declared by a resource type, not only seen on synced resources."),
      }),
    )
    .describe("Metadata fields the requested resource types expose."),
  tagKeys: z.array(z.string()),
  preferredTagKeys: z.array(z.string()),
  virtualTagKeys: z.array(z.string()).describe("Empty without `costs:read`."),
  costAvailable: z.boolean(),
}).openapi("ResourceReportOptions");

const QueryRequest = strict({
  config: Config,
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).openapi("ResourceReportQueryRequest");

export function registerResourceReportPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["Resource reports"];
  const IdParam = OrgIdParam.extend({ id: Uuid });
  const json = <T extends z.ZodTypeAny>(schema: T) => ({ "application/json": { schema } });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resource-reports",
    tags,
    summary: "List resource reports",
    description: "The saved inventory reports the caller's sharing lets them open, by name.",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "The reports", content: json(z.array(ResourceReport)) },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resource-reports",
    tags,
    summary: "Create a resource report",
    description:
      "The creator is the report's implicit owner for sharing. Filing it in a folder needs " +
      "editor access to the folder. Audit-logged.",
    request: { params: OrgIdParam, body: { content: json(ResourceReportInput) } },
    responses: {
      201: { description: "The created report", content: json(ResourceReport) },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resource-reports/folders",
    tags,
    summary: "List report folders for resource reports",
    description:
      "The report folders the caller can see. Resource reports share the folder tree cost " +
      "reports use; create and rename folders through `/cost-report-folders`.",
    request: { params: OrgIdParam },
    responses: { 200: { description: "Folders", content: json(z.array(CostReportFolder)) } },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resource-reports/options",
    tags,
    summary: "What a resource report can filter and show",
    description:
      "Providers, accounts, resource types, regions and statuses with resource counts, the " +
      "metadata fields the given types expose (from the type definitions and the newest " +
      "synced resources), provider tag keys and, with `costs:read`, virtual tag keys.",
    request: {
      params: OrgIdParam,
      query: z.object({
        types: z
          .string()
          .optional()
          .describe("Comma-separated `pluginId/resourceTypeId` pairs narrowing `fields`."),
      }),
    },
    responses: { 200: { description: "Picker options", content: json(Options) } },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resource-reports/tag-values",
    tags,
    summary: "Values one tag key takes",
    description:
      "Provider tag values from synced resources, or virtual tag values from spend " +
      "(empty without `costs:read`), most common first.",
    request: {
      params: OrgIdParam,
      query: z.object({
        source: z.enum(["tag", "virtual_tag"]).optional(),
        key: z.string().min(1),
      }),
    },
    responses: {
      200: { description: "Values", content: json(strict({ values: z.array(z.string()) })) },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resource-reports/query",
    tags,
    summary: "Run an unsaved resource report config",
    description:
      "A read despite the method. Returns one page of rows. Cost and virtual tag cells need " +
      "`costs:read` and respect the caller's cost visibility scope.",
    request: { params: OrgIdParam, body: { content: json(QueryRequest) } },
    responses: {
      200: { description: "One page of rows", content: json(RowsResult) },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resource-reports/csv",
    tags,
    summary: "Export an unsaved resource report config as CSV",
    description:
      "Every matching row up to 50,000, with tag and cost columns (one numeric column per " +
      "cost column and currency). A cut file ends with a `# Truncated` line.",
    request: {
      params: OrgIdParam,
      body: {
        content: json(strict({ config: Config, name: z.string().optional() })),
      },
    },
    responses: {
      200: { description: "CSV", content: { "text/csv": { schema: z.string() } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resource-reports/{id}",
    tags,
    summary: "Read a resource report",
    request: { params: IdParam },
    responses: {
      200: { description: "The report", content: json(ResourceReport) },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/resource-reports/{id}",
    tags,
    summary: "Replace a resource report",
    description: "Name, description, config and folder together. Needs editor. Audit-logged.",
    request: { params: IdParam, body: { content: json(ResourceReportInput) } },
    responses: {
      200: { description: "The updated report", content: json(ResourceReport) },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/resource-reports/{id}",
    tags,
    summary: "Delete a resource report",
    description: "Soft delete; its sharing goes with it. Audit-logged.",
    request: { params: IdParam },
    responses: { 200: { description: "Deleted", content: json(Ok) }, 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resource-reports/{id}/rows",
    tags,
    summary: "Run a saved resource report",
    description:
      "One page of rows. `sort` and `direction` override the saved sort for this request only.",
    request: {
      params: IdParam,
      query: z.object({
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        sort: ColumnId.optional(),
        direction: z.enum(["asc", "desc"]).optional(),
      }),
    },
    responses: {
      200: { description: "One page of rows", content: json(RowsResult) },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resource-reports/{id}/csv",
    tags,
    summary: "Export a saved resource report as CSV",
    description: "Every matching row up to 50,000; a cut file ends with a `# Truncated` line.",
    request: { params: IdParam },
    responses: {
      200: { description: "CSV", content: { "text/csv": { schema: z.string() } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
