/**
 * Resource reports: `/api/org/:orgId/resource-reports`, the endpoint
 * definitions. Saved inventory tables with cost.
 *
 * Reads are `resources:read` and writes `resources:write`, the probes and SLO
 * precedent: a report is a view over the inventory. Cost and virtual tag
 * cells additionally need `costs:read`, checked by the handlers: without it a
 * run still answers, with those cells empty and `cost.reason` saying why, and
 * the caller's cost visibility scope applies to every figure that does come
 * back. Request bodies are the shared schemas the editor validates with
 * (`@infrawrench/api-contract/schemas`), decoded strictly as the zod twins were.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  CostBasis,
  IsoDate as IsoDay,
  ResourceReportConfig,
  ResourceReportInput,
  ResourceReportQueryRequest,
  ResourceReportSort,
  STRICT_PARSE_OPTIONS,
  maxLength,
  minLength,
} from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { CostReportFolder } from "../http/schemas/cost-report-folder";
import { documentedAs, optionalRequestBody, requiredQuery } from "../http/schemas/documented";
import { enumQuery, numericQuery } from "../http/schemas/query";

const strictBody = { ...STRICT_PARSE_OPTIONS, errors: "all" } as const;

const ReportDay = IsoDay.annotate({ examples: ["2026-07-01"] });

/** The column id the saved sort names, as the config documents it. */
const ColumnId = ResourceReportSort.fields.column;

export const ResourceReport = Schema.Struct({
  id: Uuid,
  name: Schema.String.check(minLength(1), maxLength(120)),
  description: Schema.NullOr(Schema.String.check(maxLength(2000))),
  config: ResourceReportConfig,
  folderId: Schema.NullOr(Uuid).annotate({
    description: "A report folder (the tree cost reports use); null is the top level.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ResourceReport" });

const ResourceReportMoney = Schema.Struct({
  currency: Schema.String,
  amount: Schema.Finite,
}).annotate({ identifier: "ResourceReportMoney" });

const ResourceReportColumn = Schema.Struct({
  id: ColumnId,
  kind: Schema.Literals(["core", "field", "tag", "vtag", "cost"]),
  key: Schema.String,
  label: Schema.String.annotate({ description: "English label, as the CSV header prints it." }),
}).annotate({ identifier: "ResourceReportColumn" });

const ResourceReportRow = Schema.Struct({
  id: Schema.String.annotate({
    description: "The resource id the resource detail view is addressed by.",
  }),
  accountId: Uuid,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  values: Schema.Record(Schema.String, Schema.NullOr(Schema.String)).annotate({
    description: "Text per non-cost column id; null when the resource has no value.",
  }),
  costs: Schema.Record(Schema.String, Schema.Array(ResourceReportMoney)).annotate({
    description:
      "Spend per cost column id, one entry per currency, largest first. Empty when the " +
      "resource had no cost rows in the window.",
  }),
}).annotate({ identifier: "ResourceReportRow" });

const CostWindow = Schema.Literals(["range", "mtd", "previous_month"]);

export const ResourceReportRows = Schema.Struct({
  columns: Schema.Array(ResourceReportColumn),
  rows: Schema.Array(ResourceReportRow),
  total: Schema.Int.annotate({
    description: "Matching resources; a lower bound when `truncated`.",
  }),
  offset: Schema.Int,
  limit: Schema.Int,
  truncated: Schema.Boolean.annotate({
    description:
      "A filter or the sort needed the in-memory scan and it stopped at 100,000 resources.",
  }),
  sort: ResourceReportSort,
  cost: Schema.NullOr(
    Schema.Struct({
      available: Schema.Boolean.annotate({
        description:
          "False without `costs:read` or a cost store: cost and virtual tag cells are empty.",
      }),
      reason: Schema.NullOr(Schema.String),
      basis: CostBasis,
      windows: Schema.Array(Schema.Struct({ window: CostWindow, from: ReportDay, to: ReportDay })),
    }),
  ).annotate({ description: "Null when the report has no cost or virtual tag column." }),
}).annotate({ identifier: "ResourceReportRows" });

const countedFields = { value: Schema.String, label: Schema.String, count: Schema.Int };
const Counted = Schema.Struct(countedFields);

export const ResourceReportOptions = Schema.Struct({
  providers: Schema.Array(Counted),
  accounts: Schema.Array(Schema.Struct({ ...countedFields, pluginId: Schema.String })),
  resourceTypes: Schema.Array(
    Schema.Struct({
      pluginId: Schema.String,
      resourceTypeId: Schema.String,
      label: Schema.String,
      count: Schema.Int,
    }),
  ),
  regions: Schema.Array(Counted),
  statuses: Schema.Array(Counted),
  fields: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      label: Schema.String,
      count: Schema.Int,
      declared: Schema.Boolean.annotate({
        description: "Declared by a resource type, not only seen on synced resources.",
      }),
    }),
  ).annotate({ description: "Metadata fields the requested resource types expose." }),
  tagKeys: Schema.Array(Schema.String),
  preferredTagKeys: Schema.Array(Schema.String),
  virtualTagKeys: Schema.Array(Schema.String).annotate({
    description: "Empty without `costs:read`.",
  }),
  costAvailable: Schema.Boolean,
}).annotate({ identifier: "ResourceReportOptions" });

export const ResourceReportTagValues = Schema.Struct({ values: Schema.Array(Schema.String) });

/** `POST /csv`: the config is decoded strictly; the rest of the body is read leniently. */
const ResourceReportCsvRequest = Schema.Struct({
  config: ResourceReportConfig,
  name: Schema.optionalKey(Schema.String),
});

const Csv = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" }));

export class ResourceReportsGroup extends HttpApiGroup.make("resourceReports")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(ResourceReport),
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List resource reports")
      .annotate(
        OpenApi.Description,
        "The saved inventory reports the caller's sharing lets them open, by name.",
      )
      .annotate(SuccessDescription, "The reports"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: ResourceReportInput,
      success: ResourceReport.pipe(HttpApiSchema.status(201)),
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(InvalidRequestMessage, "Invalid resource report")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Create a resource report")
      .annotate(
        OpenApi.Description,
        "The creator is the report's implicit owner for sharing. Filing it in a folder needs " +
          "editor access to the folder. Audit-logged.",
      )
      .annotate(SuccessDescription, "The created report")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("folders", "/folders", {
      params: OrgParams,
      success: Schema.Array(CostReportFolder),
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List report folders for resource reports")
      .annotate(
        OpenApi.Description,
        "The report folders the caller can see. Resource reports share the folder tree cost " +
          "reports use; create and rename folders through `/cost-report-folders`.",
      )
      .annotate(SuccessDescription, "Folders"),
    HttpApiEndpoint.get("options", "/options", {
      params: OrgParams,
      query: {
        types: Schema.optionalKey(
          Schema.String.annotate({
            description: "Comma-separated `pluginId/resourceTypeId` pairs narrowing `fields`.",
          }),
        ),
      },
      success: ResourceReportOptions,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "What a resource report can filter and show")
      .annotate(
        OpenApi.Description,
        "Providers, accounts, resource types, regions and statuses with resource counts, the " +
          "metadata fields the given types expose (from the type definitions and the newest " +
          "synced resources), provider tag keys and, with `costs:read`, virtual tag keys.",
      )
      .annotate(SuccessDescription, "Picker options"),
    HttpApiEndpoint.get("tagValues", "/tag-values", {
      params: OrgParams,
      // Read raw: anything but `virtual_tag` is a provider tag, and a missing
      // or blank key reaches the handler's own 400.
      query: {
        source: Schema.optionalKey(Schema.String),
        key: Schema.optionalKey(documentedAs(Schema.String.check(minLength(1)))),
      },
      success: ResourceReportTagValues,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Values one tag key takes")
      .annotate(
        OpenApi.Description,
        "Provider tag values from synced resources, or virtual tag values from spend " +
          "(empty without `costs:read`), most common first.",
      )
      .annotate(SuccessDescription, "Values")
      .annotate(OpenApi.Transform, (op) =>
        requiredQuery(["key"])(enumQuery({ source: ["tag", "virtual_tag"] })(op)),
      ),
    HttpApiEndpoint.post("query", "/query", {
      params: OrgParams,
      payload: ResourceReportQueryRequest,
      success: ResourceReportRows,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(InvalidRequestMessage, "Invalid resource report query")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Run an unsaved resource report config")
      .annotate(
        OpenApi.Description,
        "A read despite the method. Returns one page of rows. Cost and virtual tag cells need " +
          "`costs:read` and respect the caller's cost visibility scope.",
      )
      .annotate(SuccessDescription, "One page of rows")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("csv", "/csv", {
      params: OrgParams,
      payload: ResourceReportCsvRequest,
      success: Csv,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(InvalidRequestMessage, "Invalid resource report config")
      .annotate(OpenApi.Summary, "Export an unsaved resource report config as CSV")
      .annotate(
        OpenApi.Description,
        "Every matching row up to 50,000, with tag and cost columns (one numeric column per " +
          "cost column and currency). A cut file ends with a `# Truncated` line.",
      )
      .annotate(SuccessDescription, "CSV")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: ResourceReport,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Read a resource report")
      .annotate(SuccessDescription, "The report"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: ResourceReportInput,
      success: ResourceReport,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(InvalidRequestMessage, "Invalid resource report")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Replace a resource report")
      .annotate(
        OpenApi.Description,
        "Name, description, config and folder together. Needs editor. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated report")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a resource report")
      .annotate(OpenApi.Description, "Soft delete; its sharing goes with it. Audit-logged.")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("rows", "/:id/rows", {
      params: OrgIdParams,
      // Read raw: offset and limit are clamped rather than refused, and an
      // unknown sort column is the handler's own 400.
      query: {
        offset: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.String),
        sort: Schema.optionalKey(documentedAs(ColumnId)),
        direction: Schema.optionalKey(documentedAs(Schema.Literals(["asc", "desc"]))),
      },
      success: ResourceReportRows,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Run a saved resource report")
      .annotate(
        OpenApi.Description,
        "One page of rows. `sort` and `direction` override the saved sort for this request only.",
      )
      .annotate(SuccessDescription, "One page of rows")
      .annotate(
        OpenApi.Transform,
        numericQuery({
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        }),
      ),
    HttpApiEndpoint.get("csvSaved", "/:id/csv", {
      params: OrgIdParams,
      success: Csv,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Export a saved resource report as CSV")
      .annotate(
        OpenApi.Description,
        "Every matching row up to 50,000; a cut file ends with a `# Truncated` line.",
      )
      .annotate(SuccessDescription, "CSV"),
  )
  .prefix("/api/org/:orgId/resource-reports")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Resource reports") {}

export class ResourceReportsApi extends withApiDefaults(
  HttpApi.make("resourceReports").add(ResourceReportsGroup),
) {}
