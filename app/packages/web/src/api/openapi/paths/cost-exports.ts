import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-08-07" });

const CostDimension = z.enum([
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "tag",
  "charge_type",
  "commitment",
]);

const ExportCostFilter = strict({
  dimension: CostDimension,
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  tagKey: z.string().optional(),
}).openapi("CostExportFilter");

const CostExportQuery = strict({
  version: z.literal(1),
  dimensions: z
    .array(CostDimension)
    .describe(
      "Row-identity columns kept in the output. Dropping one aggregates over it — an export " +
        "grouped to provider + service is orders of magnitude smaller than a per-resource one.",
    ),
  tagKeys: z.array(z.string()).describe("Tag keys emitted as their own `tag_<key>` columns."),
  filters: z.array(ExportCostFilter),
  chargeTypes: z
    .array(
      z.enum([
        "usage",
        "commitment_covered_usage",
        "commitment_fee",
        "commitment_discount",
        "credit",
        "tax",
        "refund",
        "adjustment",
        "support",
        "other",
      ]),
    )
    .optional(),
  costBasis: z.enum(["cash", "amortized"]).optional(),
})
  .describe(
    "The rows a run selects. Reuses the same `CostFilter` and dimension vocabulary the " +
      "dashboards, budgets and cost reports store, so a filter means the same thing everywhere.",
  )
  .openapi("CostExportQuery");

const CostExportDestination = z
  .union([
    strict({
      kind: z.literal("s3"),
      bucket: z.string(),
      prefix: z.string().describe("Key prefix, no leading or trailing slash."),
      region: z.string().describe("AWS-style region. Cloudflare R2 wants `auto`."),
      endpoint: z
        .string()
        .describe(
          "S3 API origin. Empty means AWS S3 proper. Set it for R2, Spaces, Scaleway, B2 or MinIO.",
        ),
      forcePathStyle: z
        .boolean()
        .describe("Address the bucket as a path segment. MinIO needs this; AWS and R2 do not."),
    }),
    strict({
      kind: z.literal("http"),
      method: z.enum(["POST", "PUT"]),
      urlHint: z
        .string()
        .describe(
          "Redacted marker for the stored URL. The URL itself is a bearer credential and is " +
            "never returned.",
        ),
    }),
    strict({
      kind: z.literal("warehouse"),
      pluginId: z
        .string()
        .describe(
          "Plugin whose warehouse receives the rows: `snowflake` or `databricks`. See " +
            "`GET /cost-exports/warehouse-sinks`.",
        ),
      accountId: z
        .string()
        .describe(
          "Connected account of that plugin. Its stored credentials load the rows; the export " +
            "carries no credential of its own.",
        ),
      target: z
        .record(z.string(), z.string())
        .describe(
          "The plugin's target fields. Snowflake: `warehouse` (optional), `database`, `schema`, " +
            "`table`. Databricks: `warehouseId`, `catalog`, `schema`, `table`. A table that does " +
            "not exist is created on the first run.",
        ),
    }),
  ])
  .openapi("CostExportDestination");

const SCHEMA_DESCRIPTION =
  "Which columns an object carries. `native` is Infrawrench's own layout, shaped by " +
  "`query.dimensions` and `query.tagKeys`. `focus-1.3` writes the FinOps Open Cost and Usage " +
  "Specification v1.3 columns at the full row grain, with `BilledCost` (cash) and " +
  "`EffectiveCost` (amortized) side by side; `query.dimensions`, `query.tagKeys` and " +
  "`query.costBasis` do not apply to it, `query.filters` and `query.chargeTypes` still do.";

const CostExportSchema = z.enum(["native", "focus-1.3"]).openapi("CostExportSchema");

const CostExportInput = strict({
  name: z.string().min(1).max(120),
  format: z.enum(["csv", "ndjson"]),
  schema: CostExportSchema.optional().describe(
    `${SCHEMA_DESCRIPTION} Omitted keeps the stored value (\`native\` on create).`,
  ),
  query: CostExportQuery,
  cadence: z
    .enum(["daily", "weekly", "monthly"])
    .describe(
      "How often a run happens and — because a run writes one object per period — what a " +
        "period is: a calendar day, an ISO week (Monday-start), or a calendar month.",
    ),
  hour: z.number().int().min(0).max(23).describe("Local hour in `timezone` a run fires at."),
  timezone: z.string().describe("IANA zone, e.g. `Europe/Berlin`. Validated against `Intl`."),
  restatementDays: z
    .number()
    .int()
    .min(0)
    .max(90)
    .describe(
      "Trailing days of already-written periods each run re-exports. Providers restate spend " +
        "for days after the fact, so the object written for yesterday is not final; every " +
        "period overlapping this window is rebuilt in full at its existing key, which " +
        "overwrites rather than duplicates. 0 disables it and is only correct for an org " +
        "whose providers never revise.",
    ),
  enabled: z.boolean(),
  destination: CostExportDestination,
  accessKeyId: z
    .string()
    .optional()
    .describe("S3 only. Write-only; omit on update to keep the stored credential."),
  secretAccessKey: z.string().optional().describe("S3 only. Write-only, never returned."),
  url: z
    .string()
    .optional()
    .describe(
      "HTTPS destinations only. Write-only, never returned — a signed URL carries its own " +
        "signature, so it is treated as a bearer credential.",
    ),
}).openapi("CostExportInput");

const CostExport = strict({
  id: Uuid,
  name: z.string(),
  format: z.enum(["csv", "ndjson"]),
  schema: CostExportSchema.describe(SCHEMA_DESCRIPTION),
  query: CostExportQuery,
  cadence: z.enum(["daily", "weekly", "monthly"]),
  hour: z.number().int(),
  timezone: z.string(),
  restatementDays: z.number().int(),
  enabled: z.boolean(),
  destination: CostExportDestination,
  hasCredentials: z.boolean(),
  credentialHint: z
    .string()
    .nullable()
    .describe("Redacted marker, e.g. `AKIA…7F2Q`. No route ever returns the credential itself."),
  lastRunAt: IsoDateTime.nullable(),
  lastStatus: z.enum(["pending", "succeeded", "failed"]),
  lastError: z
    .string()
    .nullable()
    .describe("Why the last run failed, verbatim from the destination where possible."),
  lastObjectCount: z.number().int().nullable(),
  lastRowCount: z.number().int().nullable(),
  nextRunAt: IsoDateTime.nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CostExport");

const CostExportObject = strict({
  periodStart: IsoDate.describe("The period's first day, in the export's own timezone."),
  from: IsoDate,
  to: IsoDate,
  key: z
    .string()
    .describe(
      "`{prefix}/cost-export/{exportId}/{cadence}/{periodStart}.{format}`. Deterministic, so " +
        "re-exporting a restated period overwrites this object instead of adding a second copy. " +
        "For a warehouse destination, the table and the period's days (`byteCount` is 0).",
    ),
  rowCount: z.number().int(),
  byteCount: z.number().int(),
}).openapi("CostExportObject");

const CostExportRunResult = strict({
  exportId: Uuid,
  status: z.enum(["pending", "succeeded", "failed"]),
  objects: z.array(CostExportObject),
  rowCount: z.number().int(),
  collectionWatermark: IsoDate.nullable().describe(
    "The newest day every cost-reporting account in the org had data for when the run started. " +
      "Stamped into every row as `collection_watermark`; rows dated after it are still arriving.",
  ),
  error: z.string().nullable(),
}).openapi("CostExportRunResult");

const WarehouseTargetField = strict({
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  dependsOn: z.array(z.string()),
  optional: z.boolean(),
  allowCustom: z
    .boolean()
    .describe("A value outside the listed options is accepted (a table created on first run)."),
  placeholder: z.string().nullable(),
  emptyLabel: z.string().nullable(),
}).openapi("CostExportWarehouseTargetField");

const WarehouseSink = strict({
  pluginId: z.string(),
  displayName: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  targetFields: z.array(WarehouseTargetField),
  accounts: z.array(strict({ id: z.string(), name: z.string() })),
}).openapi("CostExportWarehouseSink");

const WarehouseTarget = z.record(z.string(), z.string());

const WarehouseOption = strict({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
}).openapi("CostExportWarehouseOption");

const WarehouseSetup = strict({
  sql: z.string().describe("GRANT statements to run once, with comments."),
  notes: z.array(z.string()),
}).openapi("CostExportWarehouseSetup");

export function registerCostExportPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParam = () =>
    OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-exports",
    tags: ["Cost exports"],
    summary: "List scheduled cost exports",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Exports, with destination credentials redacted",
        content: { "application/json": { schema: z.array(CostExport) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-exports",
    tags: ["Cost exports"],
    summary: "Create a cost export",
    description:
      "Credentials are required on create for S3 and HTTPS destinations. They are encrypted at " +
      "rest and no route ever returns them; responses carry a redacted `credentialHint` " +
      "instead. A warehouse destination takes none: it loads with the connected account's " +
      "credentials.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostExportInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: CostExport } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-exports/warehouse-sinks",
    tags: ["Cost exports"],
    summary: "List warehouse destination types",
    description:
      "Plugins that can load an export into a table in their own warehouse (Snowflake, " +
      "Databricks), each with the organization's connected accounts and the target fields to fill.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Warehouse sinks",
        content: { "application/json": { schema: strict({ sinks: z.array(WarehouseSink) }) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-exports/warehouse-options",
    tags: ["Cost exports"],
    summary: "List options for a warehouse target field",
    description:
      "Reads the provider live with the account's credentials (warehouses, databases or " +
      "catalogs, schemas, tables). A provider refusal is a 400 carrying its message.",
    request: {
      params: OrgIdParam,
      body: {
        content: {
          "application/json": {
            schema: strict({
              accountId: z.string(),
              field: z.string(),
              target: WarehouseTarget.optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Options",
        content: { "application/json": { schema: strict({ options: z.array(WarehouseOption) }) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-exports/warehouse-setup",
    tags: ["Cost exports"],
    summary: "Least-privilege setup for a warehouse target",
    description:
      "The GRANT statements the connected role or principal needs for a target, plus any " +
      "non-SQL steps (for Databricks, CAN USE on the SQL warehouse).",
    request: {
      params: OrgIdParam,
      body: {
        content: {
          "application/json": {
            schema: strict({ accountId: z.string(), target: WarehouseTarget.optional() }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: { description: "Setup", content: { "application/json": { schema: WarehouseSetup } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-exports/{id}",
    tags: ["Cost exports"],
    summary: "Get a cost export",
    request: { params: idParam() },
    responses: {
      200: { description: "Export", content: { "application/json": { schema: CostExport } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-exports/{id}",
    tags: ["Cost exports"],
    summary: "Update a cost export",
    description:
      "Replaces everything but the credential. Omit `accessKeyId`/`secretAccessKey`/`url` to " +
      "keep the stored credential; changing the destination type requires supplying a new one. " +
      "Saving reschedules the export from now.",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: CostExportInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: CostExport } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-exports/{id}",
    tags: ["Cost exports"],
    summary: "Delete a cost export",
    description: "Soft delete. Objects already written to the destination are left alone.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-exports/{id}/run",
    tags: ["Cost exports"],
    summary: "Run a cost export now",
    description:
      "Runs the export immediately against the same code path the poller uses, writing every " +
      'period in the restatement window. Answers 200 with `status: "failed"` and a message ' +
      "rather than an error status when the destination rejects the write — the caller wants " +
      "the reason, and the same failure is recorded on the export.",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Run result",
        content: { "application/json": { schema: CostExportRunResult } },
      },
      404: ErrorResponses[404],
    },
  });
}
