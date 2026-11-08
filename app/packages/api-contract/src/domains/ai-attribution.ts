/**
 * AI spend attribution: `/api/org/:orgId/ai-attribution`, the endpoint
 * definitions.
 *
 * Request-log sources (who called the model), caller dimensions (which
 * request-metadata keys name the caller) and the split of AI spend over them.
 * Reading is `costs:read`; adding a source is `org:settings:write`, because a
 * source authorizes a daily read of the org's request logs (and, for the
 * CloudWatch kind, a query billed to the org's own AWS account); dimension
 * writes and re-splitting are `costs:write`.
 *
 * The bodies and the range parameters are documented here and read raw by
 * the handlers, which answer a malformed one with their own sentence.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength, pattern } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadGateway, BadRequest, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { documentedAs, requiredQuery } from "../http/schemas/documented";
import { OrgId, OrgParams } from "../http/schemas/common";

const Day = Schema.String.check(pattern(/^\d{4}-\d{2}-\d{2}$/));
const DimensionKey = Schema.String.check(pattern(/^[a-z][a-z0-9_-]{0,31}$/));
const SourceKind = Schema.Literals(["plugin", "litellm"]);
const StringMap = Schema.Record(Schema.String, Schema.String);

const IdParams = { orgId: OrgId, id: Schema.String } as const;

export const AiOk = Schema.Struct({ ok: Schema.Literal(true) });

const AiRequestSourceKindOption = Schema.Struct({
  kind: SourceKind,
  pluginId: Schema.NullOr(Schema.String),
  pluginName: Schema.NullOr(Schema.String),
  sourceKindId: Schema.String,
  label: Schema.String,
  description: Schema.String,
  locationLabel: Schema.String,
  maxHistoryDays: Schema.Int,
  queriesBillable: Schema.Boolean.annotate({
    description: "Reading this source is billed to the account's own provider (Logs Insights).",
  }),
  acceptsPrefix: Schema.Boolean,
  helpUrl: Schema.NullOr(Schema.String),
  accounts: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
}).annotate({ identifier: "AiRequestSourceKindOption" });

export const AiSourceKinds = Schema.Struct({
  sourceKinds: Schema.Array(AiRequestSourceKindOption),
});

const AiRequestLogLocation = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  location: StringMap,
  recommended: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "AiRequestLogLocation" });

export const AiLocations = Schema.Struct({ locations: Schema.Array(AiRequestLogLocation) });

export const AiRequestSource = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: SourceKind,
  pluginId: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  sourceKindId: Schema.String,
  location: StringMap,
  enabled: Schema.Boolean,
  lookbackDays: Schema.Int,
  baseUrl: Schema.NullOr(Schema.String),
  hasApiKey: Schema.Boolean,
  collectedThrough: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  lastErrorHelpUrl: Schema.NullOr(Schema.String),
  failureCount: Schema.Int,
  observedMetadataKeys: Schema.Record(Schema.String, Schema.Finite),
  lastQueryBytesScanned: Schema.NullOr(Schema.Finite),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotate({ identifier: "AiRequestSource" });

export const AiSources = Schema.Struct({ sources: Schema.Array(AiRequestSource) });

const AiRequestSourceInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(120)),
  kind: SourceKind,
  accountId: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({ description: "Required for `plugin` sources." }),
  ),
  sourceKindId: Schema.String,
  location: StringMap.annotate({
    description: "What the location picker returned, plus `prefix` where the kind accepts one.",
  }),
  enabled: Schema.Boolean,
  lookbackDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })),
  baseUrl: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({ description: "LiteLLM only: the proxy's https URL." }),
  ),
  apiKey: Schema.optionalKey(
    Schema.String.annotate({
      description: "LiteLLM only. Write-only; omit on update to keep the stored key.",
    }),
  ),
}).annotate({ identifier: "AiRequestSourceInput" });

export const AiAttributionDimension = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  label: Schema.String,
  metadataKeys: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotate({ identifier: "AiAttributionDimension" });

export const AiDimensions = Schema.Struct({ dimensions: Schema.Array(AiAttributionDimension) });

const AiAttributionDimensionInput = Schema.Struct({
  key: DimensionKey.annotate({
    description: "Becomes the tag key `caller:<key>` in cost reports.",
  }),
  label: Schema.String.check(minLength(1), maxLength(60)),
  metadataKeys: Schema.Array(Schema.String.check(minLength(1), maxLength(256)))
    .check(minLength(1), maxLength(8))
    .annotate({ description: "Request-metadata keys feeding the dimension, first present wins." }),
}).annotate({ identifier: "AiAttributionDimensionInput" });

const AiSourceMatchStats = Schema.Struct({
  sourceId: Schema.String,
  name: Schema.String,
  days: Schema.Int,
  requests: Schema.Finite,
  matchedRequests: Schema.Finite,
  ambiguousRequests: Schema.Finite,
  unmatchedRequests: Schema.Finite,
  skippedRecords: Schema.Finite,
  currency: Schema.NullOr(Schema.String),
  attributedAmount: Schema.Finite,
  billedAmount: Schema.Finite,
  coveragePercent: Schema.NullOr(Schema.Finite),
  degradedDays: Schema.Int,
  truncatedDays: Schema.Int,
}).annotate({ identifier: "AiSourceMatchStats" });

const AiProviderCoverage = Schema.Struct({
  provider: Schema.String,
  currency: Schema.String,
  billedAmount: Schema.Finite,
  attributedAmount: Schema.Finite,
  unattributedAmount: Schema.Finite,
}).annotate({ identifier: "AiProviderCoverage" });

export const AiAttributionStats = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  sources: Schema.Array(AiSourceMatchStats),
  providers: Schema.Array(AiProviderCoverage),
  attributedDays: Schema.Int,
}).annotate({ identifier: "AiAttributionStats" });

export const AiSpendBreakdown = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  dimension: Schema.String,
  tagKey: Schema.String,
  rows: Schema.Array(
    Schema.Struct({ value: Schema.String, currency: Schema.String, amount: Schema.Finite }),
  ),
}).annotate({ identifier: "AiSpendBreakdown" });

export const AiReattributed = Schema.Struct({ ok: Schema.Literal(true), days: Schema.Int });

/** Read as sent: the handler checks the range and answers with its own sentence. */
const rangeQuery = {
  from: Schema.optionalKey(
    documentedAs(Day.annotate({ description: "Inclusive start day. Defaults to 29 days ago." })),
  ),
  to: Schema.optionalKey(
    documentedAs(Day.annotate({ description: "Inclusive end day. Defaults to today." })),
  ),
};

export class AiAttributionGroup extends HttpApiGroup.make("aiAttribution")
  .add(
    HttpApiEndpoint.get("sourceKinds", "/source-kinds", {
      params: OrgParams,
      success: AiSourceKinds,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List the request-log source kinds the org can add")
      .annotate(SuccessDescription, "Source kinds"),
    // `org:settings:write`: it reads the account's inventory to configure a source.
    HttpApiEndpoint.get("locations", "/locations", {
      params: OrgParams,
      query: {
        accountId: Schema.optionalKey(documentedAs(Schema.String)),
        sourceKindId: Schema.optionalKey(documentedAs(Schema.String)),
      },
      success: AiLocations,
      error: [BadRequest, Forbidden, NotFound, BadGateway],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(
        OpenApi.Summary,
        "Discover locations (buckets, log groups, gateways) for a source kind",
      )
      .annotate(OpenApi.Transform, requiredQuery(["accountId", "sourceKindId"]))
      .annotate(SuccessDescription, "Picker options"),
    HttpApiEndpoint.get("sources", "/sources", {
      params: OrgParams,
      success: AiSources,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List request-log sources")
      .annotate(SuccessDescription, "Sources"),
    HttpApiEndpoint.get("source", "/sources/:id", {
      params: IdParams,
      success: AiRequestSource,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Read one request-log source")
      .annotate(SuccessDescription, "Source"),
    HttpApiEndpoint.post("createSource", "/sources", {
      params: OrgParams,
      payload: AiRequestSourceInput,
      success: AiRequestSource.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Add a request-log source")
      .annotate(
        OpenApi.Description,
        "Governed by `org:settings:write`: a source authorizes a daily read of the org's request " +
          "logs, and the Bedrock CloudWatch kind runs a Logs Insights query billed to the org's own " +
          "AWS account per GB scanned. Audit-logged.",
      )
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.put("updateSource", "/sources/:id", {
      params: IdParams,
      payload: AiRequestSourceInput,
      success: AiRequestSource,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update a request-log source")
      .annotate(
        OpenApi.Description,
        "Pointing a source at a different location restarts its collection history.",
      )
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("deleteSource", "/sources/:id", {
      params: IdParams,
      success: AiOk,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a request-log source")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("recollect", "/sources/:id/recollect", {
      params: IdParams,
      payload: Schema.Struct({ from: Day }),
      success: AiRequestSource,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Re-read a source's history from a day")
      .annotate(
        OpenApi.Description,
        "Aggregates keep only mapped metadata keys, so a newly mapped dimension reaches history " +
          "only by re-reading it. Clamped to the source kind's history limit.",
      )
      .annotate(SuccessDescription, "Rescheduled"),
    HttpApiEndpoint.get("dimensions", "/dimensions", {
      params: OrgParams,
      success: AiDimensions,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List caller dimensions")
      .annotate(SuccessDescription, "Dimensions"),
    // `costs:write`: a mapping changes how spend is labelled in reports, like a
    // cost centre or an allocation rule, and authorizes no new reads.
    HttpApiEndpoint.post("createDimension", "/dimensions", {
      params: OrgParams,
      payload: AiAttributionDimensionInput,
      success: AiAttributionDimension.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Map request-metadata keys to a caller dimension")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.put("updateDimension", "/dimensions/:id", {
      params: IdParams,
      payload: AiAttributionDimensionInput,
      success: AiAttributionDimension,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a caller dimension")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("deleteDimension", "/dimensions/:id", {
      params: IdParams,
      success: AiOk,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a caller dimension")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("stats", "/stats", {
      params: OrgParams,
      query: rangeQuery,
      success: AiAttributionStats,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Match-rate statistics per source and coverage per provider")
      .annotate(SuccessDescription, "Statistics"),
    HttpApiEndpoint.get("spend", "/spend", {
      params: OrgParams,
      query: { ...rangeQuery, dimension: Schema.optionalKey(documentedAs(DimensionKey)) },
      success: AiSpendBreakdown,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Attributed AI spend by one caller dimension")
      .annotate(
        OpenApi.Description,
        "Includes the `(unattributed)` remainder and `(not set)` for matched requests that lacked " +
          "every mapped key. For time series, group a cost report by the tag key `caller:<dimension>`.",
      )
      .annotate(OpenApi.Transform, requiredQuery(["dimension"]))
      .annotate(SuccessDescription, "Breakdown"),
    // Re-split a range now (after editing a mapping, say) instead of waiting
    // for the next collection. Bounded to 92 days.
    HttpApiEndpoint.post("reattribute", "/reattribute", {
      params: OrgParams,
      payload: Schema.Struct({ from: Day, to: Day }),
      success: AiReattributed,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Re-split a range of days now")
      .annotate(SuccessDescription, "Re-split"),
  )
  .prefix("/api/org/:orgId/ai-attribution")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "AI attribution") {}

export class AiAttributionApi extends withApiDefaults(
  HttpApi.make("aiAttribution").add(AiAttributionGroup),
) {}
