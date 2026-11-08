/**
 * Scheduled cost exports: `/api/org/:orgId/cost-exports`, the endpoint
 * definitions.
 *
 * An export is a saved cost query plus a schedule plus a destination; the
 * poller runs it and writes one object per period. Reads are `costs:read`.
 * Writes, "run now" and the warehouse helpers are `org:settings:write`, a
 * deliberate step up from `costs:write`: an export is standing authorisation
 * to ship the organization's billing history to a destination the creator
 * chose. Cost-scoped callers are refused the whole prefix by the auth chain
 * (`COST_SCOPE_DENY_RULES`).
 *
 * No response carries a destination credential: `GET` answers with a
 * redacted `credentialHint`, and an omitted credential on `PUT` keeps the
 * stored one.
 */
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  COST_CHARGE_TYPES,
  COST_EXPORT_CADENCES,
  COST_EXPORT_FORMATS,
  COST_EXPORT_SCHEMAS,
  COST_EXPORT_STATUSES,
  costFilterOpError,
} from "@infrawrench/client-core";
import {
  CostBasisValue,
  CostDimension,
  CostFilterOperator,
  maxLength,
  minLength,
  pattern,
} from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";

const isoDay = (description?: string) =>
  Schema.String.annotate({
    ...(description === undefined ? {} : { description }),
    examples: ["2026-08-07"],
  }).check(pattern(/^\d{4}-\d{2}-\d{2}$/));

/** A filter term, with the bounds and operator rules the route checks. */
const CostExportFilter = Schema.Struct({
  dimension: CostDimension,
  op: CostFilterOperator,
  values: Schema.mutable(Schema.Array(Schema.String.check(maxLength(512))))
    .annotate({
      description:
        "Values to compare with. At least one, except for `is_set` and `is_not_set`, which take " +
        "an empty list. The text operators refuse an empty string.",
    })
    .check(maxLength(500)),
  tagKey: Schema.optionalKey(Schema.String.check(maxLength(255))),
})
  .check(
    Schema.makeFilter((filter) => {
      const problem = costFilterOpError(filter);
      return problem ? { path: ["values"], issue: problem } : undefined;
    }),
  )
  .annotate({ identifier: "CostExportFilter" });

const CostExportQuery = Schema.Struct({
  version: Schema.Literal(1),
  dimensions: Schema.mutable(Schema.Array(CostDimension))
    .annotate({
      description:
        "Row-identity columns kept in the output. Dropping one aggregates over it; an export " +
        "grouped to provider + service is orders of magnitude smaller than a per-resource one.",
    })
    .check(maxLength(8)),
  tagKeys: Schema.mutable(Schema.Array(Schema.String.check(minLength(1), maxLength(255))))
    .annotate({ description: "Tag keys emitted as their own `tag_<key>` columns." })
    .check(maxLength(25)),
  virtualTagKeys: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String.check(minLength(1), maxLength(64))))
      .annotate({
        description:
          "Virtual tag keys emitted as their own `vtag_<key>` columns. A row a split rule divides " +
          "is exported once per share with weighted amounts, so the file still sums to the total.",
      })
      .check(maxLength(25)),
  ),
  filters: Schema.mutable(Schema.Array(CostExportFilter)).check(maxLength(25)),
  chargeTypes: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Literals(COST_CHARGE_TYPES)))),
  costBasis: Schema.optionalKey(CostBasisValue),
}).annotate({
  identifier: "CostExportQuery",
  description:
    "The rows a run selects. Reuses the same `CostFilter` and dimension vocabulary the " +
    "dashboards, budgets and cost reports store, so a filter means the same thing everywhere.",
});

const S3Destination = Schema.Struct({
  kind: Schema.Literal("s3"),
  bucket: Schema.String.check(minLength(1), maxLength(255)),
  prefix: Schema.String.annotate({
    description: "Key prefix, no leading or trailing slash.",
  }).check(maxLength(512)),
  region: Schema.String.annotate({
    description: "AWS-style region. Cloudflare R2 wants `auto`.",
  }).check(maxLength(64)),
  endpoint: Schema.String.annotate({
    description:
      "S3 API origin. Empty means AWS S3 proper. Set it for R2, Spaces, Scaleway, B2 or MinIO.",
  }).check(maxLength(255)),
  forcePathStyle: Schema.Boolean.annotate({
    description: "Address the bucket as a path segment. MinIO needs this; AWS and R2 do not.",
  }),
});

const UrlHint = Schema.String.annotate({
  description:
    "Redacted marker for the stored URL. The URL itself is a bearer credential and is " +
    "never returned.",
}).check(maxLength(255));

const httpDestinationFields = {
  kind: Schema.Literal("http"),
  method: Schema.Literals(["POST", "PUT"]),
};

const WarehouseDestination = Schema.Struct({
  kind: Schema.Literal("warehouse"),
  pluginId: Schema.String.annotate({
    description:
      "Plugin whose warehouse receives the rows: `snowflake` or `databricks`. See " +
      "`GET /cost-exports/warehouse-sinks`.",
  }).check(minLength(1), maxLength(64)),
  accountId: Schema.String.annotate({
    description:
      "Connected account of that plugin. Its stored credentials load the rows; the export " +
      "carries no credential of its own.",
  }).check(minLength(1), maxLength(128)),
  target: Schema.Record(Schema.String, Schema.String.check(maxLength(255))).annotate({
    description:
      "The plugin's target fields. Snowflake: `warehouse` (optional), `database`, `schema`, " +
      "`table`. Databricks: `warehouseId`, `catalog`, `schema`, `table`. A table that does " +
      "not exist is created on the first run.",
  }),
});

/** Where a run writes, as every read returns it and the input documents it. */
const CostExportDestination = Schema.Union([
  S3Destination,
  Schema.Struct({ ...httpDestinationFields, urlHint: UrlHint }),
  WarehouseDestination,
]).annotate({ identifier: "CostExportDestination" });

/**
 * The destination as the route decodes it: an HTTPS destination's `urlHint`
 * may be left out (the server recomputes it whenever a URL is supplied, so a
 * client cannot use it to claim a destination it has not proved it holds the
 * URL for), which the store reads as empty.
 */
const CostExportDestinationBody = Schema.Union([
  S3Destination,
  Schema.Struct({
    ...httpDestinationFields,
    urlHint: UrlHint.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  }),
  WarehouseDestination,
]);

const SCHEMA_DESCRIPTION =
  "Which columns an object carries. `native` is Infrawrench's own layout, shaped by " +
  "`query.dimensions` and `query.tagKeys`. `focus-1.4` and `focus-1.3` write the FinOps Open " +
  "Cost and Usage Specification columns of that version at the full row grain (1.4 drops the " +
  "deprecated `ProviderName` and `PublisherName`), with `BilledCost` (cash) and " +
  "`EffectiveCost` (amortized) side by side; `query.dimensions`, `query.tagKeys` and " +
  "`query.costBasis` do not apply to it, `query.filters` and `query.chargeTypes` still do.";

const CostExportSchema = Schema.Literals(COST_EXPORT_SCHEMAS).annotate({
  identifier: "CostExportSchema",
  description: SCHEMA_DESCRIPTION,
});

const CostExportCadence = Schema.Literals(COST_EXPORT_CADENCES);
const CostExportFormat = Schema.Literals(COST_EXPORT_FORMATS);
const CostExportStatus = Schema.Literals(COST_EXPORT_STATUSES);

const costExportInputFields = <D extends Schema.Top>(destination: D) => ({
  name: Schema.String.check(minLength(1), maxLength(120)),
  format: CostExportFormat,
  schema: Schema.optionalKey(CostExportSchema).annotateKey({
    description: `${SCHEMA_DESCRIPTION} Omitted keeps the stored value (\`native\` on create).`,
  }),
  query: CostExportQuery,
  cadence: CostExportCadence.annotate({
    description:
      "How often a run happens and (because a run writes one object per period) what a " +
      "period is: a calendar day, an ISO week (Monday-start), or a calendar month.",
  }),
  hour: Schema.Int.annotate({ description: "Local hour in `timezone` a run fires at." }).check(
    Schema.isBetween({ minimum: 0, maximum: 23 }),
  ),
  timezone: Schema.String.annotate({
    description: "IANA zone, e.g. `Europe/Berlin`. Validated against `Intl`.",
  }).check(minLength(1), maxLength(64)),
  restatementDays: Schema.Int.annotate({
    description:
      "Trailing days of already-written periods each run re-exports. Providers restate spend " +
      "for days after the fact, so the object written for yesterday is not final; every " +
      "period overlapping this window is rebuilt in full at its existing key, which " +
      "overwrites rather than duplicates. 0 disables it and is only correct for an org " +
      "whose providers never revise.",
  }).check(Schema.isBetween({ minimum: 0, maximum: 90 })),
  enabled: Schema.Boolean,
  destination,
  accessKeyId: Schema.optionalKey(
    Schema.String.annotate({
      description: "S3 only. Write-only; omit on update to keep the stored credential.",
    }).check(minLength(1), maxLength(255)),
  ),
  secretAccessKey: Schema.optionalKey(
    Schema.String.annotate({ description: "S3 only. Write-only, never returned." }).check(
      minLength(1),
      maxLength(1024),
    ),
  ),
  url: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "HTTPS destinations only. Write-only, never returned; a signed URL carries its own " +
        "signature, so it is treated as a bearer credential.",
    }).check(minLength(1), maxLength(2048)),
  ),
});

/** The create and update body, as documented. */
const CostExportInput = Schema.Struct(costExportInputFields(CostExportDestination)).annotate({
  identifier: "CostExportInput",
});

/** The create and update body, as the handlers decode it (see {@link CostExportDestinationBody}). */
export const CostExportInputBody = Schema.Struct(costExportInputFields(CostExportDestinationBody));

export const CostExport = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  format: CostExportFormat,
  schema: CostExportSchema,
  query: CostExportQuery,
  cadence: CostExportCadence,
  hour: Schema.Int,
  timezone: Schema.String,
  restatementDays: Schema.Int,
  enabled: Schema.Boolean,
  destination: CostExportDestination,
  hasCredentials: Schema.Boolean,
  credentialHint: Schema.NullOr(Schema.String).annotate({
    description: "Redacted marker, e.g. `AKIA…7F2Q`. No route ever returns the credential itself.",
  }),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastStatus: CostExportStatus,
  lastError: Schema.NullOr(Schema.String).annotate({
    description: "Why the last run failed, verbatim from the destination where possible.",
  }),
  lastObjectCount: Schema.NullOr(Schema.Int),
  lastRowCount: Schema.NullOr(Schema.Int),
  nextRunAt: Schema.NullOr(IsoDateTime),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CostExport" });

const CostExportObject = Schema.Struct({
  periodStart: isoDay("The period's first day, in the export's own timezone."),
  from: isoDay(),
  to: isoDay(),
  key: Schema.String.annotate({
    description:
      "`{prefix}/cost-export/{exportId}/{cadence}/{periodStart}.{format}`. Deterministic, so " +
      "re-exporting a restated period overwrites this object instead of adding a second copy. " +
      "For a warehouse destination, the table and the period's days (`byteCount` is 0).",
  }),
  rowCount: Schema.Int,
  byteCount: Schema.Int,
}).annotate({ identifier: "CostExportObject" });

export const CostExportRunResult = Schema.Struct({
  exportId: Uuid,
  status: CostExportStatus,
  objects: Schema.Array(CostExportObject),
  rowCount: Schema.Int,
  collectionWatermark: Schema.NullOr(isoDay()).annotate({
    description:
      "The newest day every cost-reporting account in the org had data for when the run started. " +
      "Stamped into every row as `collection_watermark`; rows dated after it are still arriving.",
  }),
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CostExportRunResult" });

const WarehouseTargetField = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  optional: Schema.Boolean,
  allowCustom: Schema.Boolean.annotate({
    description: "A value outside the listed options is accepted (a table created on first run).",
  }),
  placeholder: Schema.NullOr(Schema.String),
  emptyLabel: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CostExportWarehouseTargetField" });

const WarehouseSink = Schema.Struct({
  pluginId: Schema.String,
  displayName: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  targetFields: Schema.Array(WarehouseTargetField),
  accounts: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
}).annotate({ identifier: "CostExportWarehouseSink" });

export const WarehouseSinks = Schema.Struct({ sinks: Schema.Array(WarehouseSink) });

/**
 * Values chosen so far, for fields that depend on them. Absent is none. Keys
 * are at most 64 characters, checked rather than stated as `propertyNames`.
 */
const WarehouseTarget = Schema.Record(Schema.String, Schema.String.check(maxLength(255)))
  .check(
    Schema.makeFilter((target) =>
      Object.keys(target).every((key) => key.length <= 64)
        ? undefined
        : "target keys must be at most 64 characters",
    ),
  )
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed({})));

const WarehouseOptionsRequest = Schema.Struct({
  accountId: Schema.String.check(minLength(1), maxLength(128)),
  field: Schema.String.check(minLength(1), maxLength(64)),
  target: WarehouseTarget,
});

const WarehouseSetupRequest = Schema.Struct({
  accountId: Schema.String.check(minLength(1), maxLength(128)),
  target: WarehouseTarget,
});

const WarehouseOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CostExportWarehouseOption" });

export const WarehouseOptions = Schema.Struct({ options: Schema.Array(WarehouseOption) });

export const WarehouseSetup = Schema.Struct({
  sql: Schema.String.annotate({ description: "GRANT statements to run once, with comments." }),
  notes: Schema.Array(Schema.String),
}).annotate({ identifier: "CostExportWarehouseSetup" });

export class CostExportsGroup extends HttpApiGroup.make("costExports")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(CostExport),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List scheduled cost exports")
      .annotate(SuccessDescription, "Exports, with destination credentials redacted"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CostExportInput,
      success: CostExport,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create a cost export")
      .annotate(
        OpenApi.Description,
        "Credentials are required on create for S3 and HTTPS destinations. They are encrypted at " +
          "rest and no route ever returns them; responses carry a redacted `credentialHint` " +
          "instead. A warehouse destination takes none: it loads with the connected account's " +
          "credentials.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid cost export"),
    HttpApiEndpoint.get("warehouseSinks", "/warehouse-sinks", {
      params: OrgParams,
      success: WarehouseSinks,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List warehouse destination types")
      .annotate(
        OpenApi.Description,
        "Plugins that can load an export into a table in their own warehouse (Snowflake, " +
          "Databricks), each with the organization's connected accounts and the target fields to fill.",
      )
      .annotate(SuccessDescription, "Warehouse sinks"),
    HttpApiEndpoint.post("warehouseOptions", "/warehouse-options", {
      params: OrgParams,
      payload: WarehouseOptionsRequest,
      success: WarehouseOptions,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List options for a warehouse target field")
      .annotate(
        OpenApi.Description,
        "Reads the provider live with the account's credentials (warehouses, databases or " +
          "catalogs, schemas, tables). A provider refusal is a 400 carrying its message.",
      )
      .annotate(SuccessDescription, "Options"),
    HttpApiEndpoint.post("warehouseSetup", "/warehouse-setup", {
      params: OrgParams,
      payload: WarehouseSetupRequest,
      success: WarehouseSetup,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Least-privilege setup for a warehouse target")
      .annotate(
        OpenApi.Description,
        "The GRANT statements the connected role or principal needs for a target, plus any " +
          "non-SQL steps (for Databricks, CAN USE on the SQL warehouse).",
      )
      .annotate(SuccessDescription, "Setup"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: CostExport,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a cost export")
      .annotate(SuccessDescription, "Export"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: CostExportInput,
      success: CostExport,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update a cost export")
      .annotate(
        OpenApi.Description,
        "Replaces everything but the credential. Omit `accessKeyId`/`secretAccessKey`/`url` to " +
          "keep the stored credential; changing the destination type requires supplying a new one. " +
          "Saving reschedules the export from now.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid cost export"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a cost export")
      .annotate(
        OpenApi.Description,
        "Soft delete. Objects already written to the destination are left alone.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("run", "/:id/run", {
      params: OrgIdParams,
      success: CostExportRunResult,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Run a cost export now")
      .annotate(
        OpenApi.Description,
        "Runs the export immediately against the same code path the poller uses, writing every " +
          'period in the restatement window. Answers 200 with `status: "failed"` and a message ' +
          "rather than an error status when the destination rejects the write; the caller wants " +
          "the reason, and the same failure is recorded on the export.",
      )
      .annotate(SuccessDescription, "Run result"),
  )
  .prefix("/api/org/:orgId/cost-exports")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost exports") {}

export class CostExportsApi extends withApiDefaults(
  HttpApi.make("cost-exports").add(CostExportsGroup),
) {}
