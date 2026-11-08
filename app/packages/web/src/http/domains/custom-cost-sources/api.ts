/**
 * Custom cost sources: `/api/org/:orgId/custom-cost-sources`, the endpoint
 * definitions.
 *
 * Spend from files (CSV or FOCUS), parsed on the client into daily rows and
 * sent as JSON chunks: nothing here is a multipart or raw upload. Reads ride
 * `costs:read`. Every write rides `costs:write`, the permission
 * `POST /costs/rows` already uses: an upload is the same act as a push, and a
 * source is only a name for where pushed spend goes.
 *
 * The bodies decode exactly what the routes' own validators accepted. The
 * service (`server-core/src/cost/custom-costs.ts`) and the shared ingest
 * module check the rest (a known format, a three-letter currency, every
 * row's fields) and refuse in their own words, so those fields are read as
 * sent and documented as what they must be (`documentedAs`).
 */
import { Predicate, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  COST_CHARGE_TYPES,
  CUSTOM_COST_FORMATS,
  CUSTOM_COST_LIMITS,
  CUSTOM_COST_UPLOAD_MODES,
} from "@infrawrench/client-core";
import { lengthBetween, maxLength, minLength, pattern } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgId, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs } from "../../schemas/documented";

const Day = Schema.String.check(pattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
  examples: ["2026-07-01"],
});

const Via = Schema.Literals(["web", "desktop", "cli", "api"]);

export const CustomCostSourceInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(CUSTOM_COST_LIMITS.maxNameLength)).annotate({
    examples: ["Colo invoices"],
    description:
      "Unique within the organization (case-insensitively). Shown as the provider name in " +
      "every cost report; renaming relabels the source's whole history.",
  }),
  description: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(CUSTOM_COST_LIMITS.maxDescriptionLength))),
  ),
  defaultCurrency: Schema.optionalKey(
    Schema.NullOr(
      documentedAs(
        Schema.String.check(...lengthBetween(3, 3)).annotate({
          examples: ["USD"],
          description:
            "ISO 4217 code applied to rows whose file has no currency column. Null means every " +
            "file must carry one.",
        }),
      ),
    ),
  ),
}).annotate({ identifier: "CustomCostSourceInput" });

export const CustomCostSource = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  defaultCurrency: Schema.NullOr(Schema.String),
  pluginId: Schema.String.annotate({
    examples: ["custom:0f8e…"],
    description:
      "The value this source's rows carry in the cost `provider` dimension. Use it in cost " +
      "filters, budgets, and allocation rules.",
  }),
  uploadCount: Schema.Int,
  lastUploadAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CustomCostSource" });

export const CustomCostUpload = Schema.Struct({
  id: Uuid,
  sourceId: Uuid,
  fileName: Schema.NullOr(Schema.String),
  format: Schema.Literals(CUSTOM_COST_FORMATS),
  mode: Schema.Literals(CUSTOM_COST_UPLOAD_MODES),
  status: Schema.Literals(["uploading", "complete", "replaced"]).annotate({
    description:
      "`uploading` until complete is called (an interrupted upload stays here and can be " +
      "deleted); `replaced` once a later replace upload superseded every row it held.",
  }),
  fromDate: Day,
  toDate: Day,
  rowCount: Schema.Int.annotate({ description: "Daily rows this upload still holds." }),
  totals: Schema.Record(Schema.String, Schema.Finite).annotate({
    description: "Currency code → cash amount this upload still holds.",
  }),
  uploadedBy: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
      email: Schema.NullOr(Schema.String),
    }),
  ),
  via: Via,
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "CustomCostUpload" });

export const CustomCostUploadCreate = Schema.Struct({
  fileName: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(CUSTOM_COST_LIMITS.maxFileNameLength))),
  ),
  format: documentedAs(Schema.Literals(CUSTOM_COST_FORMATS)),
  mode: Schema.optionalKey(
    documentedAs(
      Schema.Literals(CUSTOM_COST_UPLOAD_MODES).annotate({
        description:
          "What to do with spend this source already holds in the range. `append` adds to it; " +
          "`replace` zeroes it (from every earlier upload) when this upload completes. Required " +
          "when the range overlaps an earlier upload that still holds rows: omitted, that case is " +
          "a 409 listing the overlapping uploads.",
      }),
    ),
  ),
  via: Schema.optionalKey(documentedAs(Via)),
  fromDate: documentedAs(
    Day.annotate({ description: "Inclusive. Rows outside the range are rejected." }),
  ),
  toDate: documentedAs(Day),
}).annotate({ identifier: "CustomCostUploadCreate" });

const RowText = Schema.String.check(maxLength(256));

export const CustomCostRow = Schema.Struct({
  date: Day,
  currency: Schema.String.check(...lengthBetween(3, 3)),
  amount: Schema.Finite.annotate({ description: "Cash amount. Negative for credits." }),
  service: Schema.optionalKey(RowText),
  region: Schema.optionalKey(RowText),
  resourceId: Schema.optionalKey(RowText),
  subAccount: Schema.optionalKey(
    RowText.annotate({
      description: "The file's own account label; splits the account dimension within the source.",
    }),
  ),
  tags: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "At most 32. Keys starting with `infrawrench:` are reserved and rejected.",
    }),
  ),
  usageAmount: Schema.optionalKey(Schema.Finite),
  usageUnit: Schema.optionalKey(RowText),
  chargeType: Schema.optionalKey(Schema.Literals(COST_CHARGE_TYPES)),
  amortizedAmount: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Amortized (effective) cost, e.g. FOCUS EffectiveCost. Omit when unknown.",
    }),
  ),
  commitmentId: Schema.optionalKey(RowText),
}).annotate({
  identifier: "CustomCostRow",
  description:
    "One day of spend for one dimension combination. Clients aggregate file lines to this " +
    "grain before sending: two rows with the same date, dimensions, tags and currency in one " +
    "upload replace each other rather than adding.",
});

/**
 * One row as the envelope accepts it: any JSON object (the route's
 * `z.record(z.unknown())`), documented as {@link CustomCostRow}. The ingest
 * module checks every field of every row with its own messages (a chunk with
 * one bad row is a 400 naming it), so the row is typed as the documented row
 * it is about to be checked as, not decoded as one here, where a schema would
 * refuse it in different words.
 */
const isRowObject = (value: unknown): value is typeof CustomCostRow.Type =>
  Predicate.isObject(value) && !Array.isArray(value);

const EnvelopeRow = Schema.Any.pipe(
  Schema.refine(isRowObject, {
    representation: {
      id: "infrawrench/customCostRow",
      payload: null,
      schemas: [CustomCostRow.ast],
    },
    toJsonSchema: ({ schemas }) => schemas[0] ?? {},
  }),
);

/** Envelope only; per-row validation is the shared ingest module's. */
export const CustomCostRowsChunk = Schema.Struct({
  rows: Schema.mutable(Schema.Array(EnvelopeRow)).check(
    maxLength(CUSTOM_COST_LIMITS.maxRowsPerChunk),
  ),
});

export const CustomCostRowsWritten = Schema.Struct({ written: Schema.Int });

const deletedFields = { ok: Schema.Literal(true), zeroedRows: Schema.Int };

export const CustomCostDeleted = Schema.Struct(deletedFields).annotate({
  identifier: "CustomCostDeleted",
});

/** The range overlaps earlier uploads that still hold rows, and no `mode` was given. */
export class CustomCostOverlap extends Schema.Error<CustomCostOverlap>(
  "infrawrench/http/customCostSources/Overlap",
)(
  {
    error: Schema.String,
    code: Schema.Literal("overlap"),
    overlapping: Schema.Array(CustomCostUpload),
  },
  {
    httpApiStatus: 409,
    identifier: "CustomCostOverlap",
    description: "The range overlaps earlier uploads and no `mode` was given",
  },
) {}

const UploadParams = { orgId: OrgId, id: Uuid, uploadId: Uuid } as const;

export class CustomCostSourcesGroup extends HttpApiGroup.make("customCostSources")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(CustomCostSource),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List custom cost sources")
      .annotate(SuccessDescription, "Sources, name-sorted"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CustomCostSourceInput,
      success: CustomCostSource,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a custom cost source")
      .annotate(
        OpenApi.Description,
        "A named provider for spend Infrawrench has no plugin for. Fill it by uploading files " +
          "(CSV or FOCUS) from Settings, `infrawrench costs push --format csv|focus`, or the upload " +
          "endpoints below.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid custom cost source"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: CustomCostSource,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a custom cost source")
      .annotate(SuccessDescription, "The source"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: CustomCostSourceInput,
      success: CustomCostSource,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a custom cost source")
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid custom cost source"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: CustomCostDeleted,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a custom cost source and all of its spend")
      .annotate(
        OpenApi.Description,
        "Zeroes every cost row the source holds, then deletes it with its upload history. The " +
          "spend disappears from every report, budget and export.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("listUploads", "/:id/uploads", {
      params: OrgIdParams,
      success: Schema.Array(CustomCostUpload),
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a source's uploads")
      .annotate(SuccessDescription, "Upload history, newest first"),
    HttpApiEndpoint.post("createUpload", "/:id/uploads", {
      params: OrgIdParams,
      payload: CustomCostUploadCreate,
      success: CustomCostUpload,
      error: [BadRequest, NotFound, CustomCostOverlap],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Start an upload")
      .annotate(
        OpenApi.Description,
        "Declares the upload's date range and what happens to spend already held in it. Then send " +
          "rows with `…/rows` (up to 5,000 per call) and finish with `…/complete`.",
      )
      .annotate(SuccessDescription, "Opened")
      .annotate(InvalidRequestMessage, "Invalid upload"),
    HttpApiEndpoint.post("appendRows", "/:id/uploads/:uploadId/rows", {
      params: UploadParams,
      payload: CustomCostRowsChunk,
      success: CustomCostRowsWritten,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Send a chunk of rows to an open upload")
      .annotate(
        OpenApi.Description,
        "The chunk is validated whole: a 400 means none of it was written.",
      )
      .annotate(SuccessDescription, "Rows written")
      .annotate(InvalidRequestMessage, "Invalid body"),
    HttpApiEndpoint.post("completeUpload", "/:id/uploads/:uploadId/complete", {
      params: UploadParams,
      success: CustomCostUpload,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Finish an upload")
      .annotate(
        OpenApi.Description,
        "Applies `replace` (zeroing this source's rows from other uploads in the range) and " +
          "records what the upload holds.",
      )
      .annotate(SuccessDescription, "Completed"),
    HttpApiEndpoint.delete("deleteUpload", "/:id/uploads/:uploadId", {
      params: UploadParams,
      success: CustomCostDeleted,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete an upload and the rows it wrote")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/custom-cost-sources")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Custom Cost Sources") {}

export class CustomCostSourcesApi extends withApiDefaults(
  HttpApi.make("custom-cost-sources").add(CustomCostSourcesGroup),
) {}
