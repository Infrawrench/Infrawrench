/**
 * Desktop cloud sync: `/api/v1/sync`, the endpoint definitions.
 *
 * Bi-directional resource sync used by the desktop app, so internal: the
 * whole `/api/v1/sync/` tree is stripped from the published spec
 * (`api/openapi/public-spec.ts`). Bearer only, and each endpoint
 * authenticates itself (`http/bearer-caller.ts`) and then checks the key's
 * scope, before reading anything else.
 *
 * The push body decodes exactly what the route's validator accepted: ids are
 * any non-empty string and timestamps any string, documented as the UUIDs,
 * composite resource ids and ISO timestamps clients send. The pull body is
 * checked by hand, in its own sentence, and only documented here.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { minLength } from "@infrawrench/ui/schemas";
import { Internal, InvalidRequestMessage, Security, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Unauthorized } from "../../errors";
import { IsoDateTime, JsonObject, Ok, ResourceId, Uuid } from "../../schemas/common";
import { documentedAs } from "../../schemas/documented";

/** A string the validator only required to be non-empty, documented as `doc`. */
const nonEmptyDocumentedAs = <S extends Schema.Top>(doc: S) =>
  Schema.String.pipe(
    Schema.refine((value: string): value is string => value.length > 0, {
      representation: { id: "infrawrench/nonEmptyDocumentedAs", payload: null, schemas: [doc.ast] },
      toJsonSchema: ({ schemas }) => schemas[0] ?? {},
    }),
  );

const NonEmptyId = Uuid.check(minLength(1));

export const SyncPullRequest = Schema.Struct({
  lastSyncVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "SyncPullRequest" });

export const SyncedAccount = Schema.Struct({
  id: Uuid,
  pluginId: Schema.String,
  displayName: Schema.String,
  hasCredentials: Schema.Boolean.annotate({
    description:
      "Whether the account has stored credentials. The credentials themselves are never returned here; this endpoint only requires `resources:read`. Fetch one with `GET /api/org/{orgId}/accounts/{id}/credentials`, which requires `secrets:read` and is audit-logged.",
  }),
  syncVersion: Schema.Int,
  deletedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
}).annotate({ identifier: "SyncedAccount" });

/**
 * A pulled resource row. Named apart from the accounts domain's
 * `SyncedResource` (the `sync-type` result, which has no `accountId` or sync
 * columns): the Zod registry had both under that one name and kept the
 * accounts shape, so the pull response documented the wrong row.
 */
export const SyncPulledResource = Schema.Struct({
  id: ResourceId,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  fieldsJson: JsonObject,
  outputsJson: JsonObject,
  parentResourceId: Schema.NullOr(ResourceId),
  syncVersion: Schema.Int,
  deletedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
}).annotate({ identifier: "SyncPulledResource" });

export const SyncedDashboard = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  isDefault: Schema.Boolean,
  syncVersion: Schema.Int,
  deletedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
}).annotate({ identifier: "SyncedDashboard" });

export const SyncPullResponse = Schema.Struct({
  accounts: Schema.Array(SyncedAccount),
  resources: Schema.Array(SyncPulledResource),
  dashboards: Schema.Array(SyncedDashboard),
  dashboardPins: Schema.Array(JsonObject),
  associations: Schema.Array(JsonObject),
}).annotate({ identifier: "SyncPullResponse" });

export const SyncPushAccount = Schema.Struct({
  id: NonEmptyId,
  pluginId: Schema.String.check(minLength(1)),
  displayName: Schema.String,
  credentials: Schema.Record(Schema.String, Schema.String),
  updatedAt: documentedAs(IsoDateTime),
  deletedAt: Schema.optionalKey(Schema.NullOr(documentedAs(IsoDateTime))),
}).annotate({ identifier: "SyncPushAccount" });

export const SyncPushResource = Schema.Struct({
  id: nonEmptyDocumentedAs(ResourceId),
  pluginId: Schema.String.check(minLength(1)),
  resourceTypeId: Schema.String.check(minLength(1)),
  accountId: NonEmptyId,
  displayName: Schema.String,
  externalId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fieldsJson: JsonObject,
  outputsJson: JsonObject,
  parentResourceId: Schema.optionalKey(Schema.NullOr(documentedAs(ResourceId))),
  updatedAt: documentedAs(IsoDateTime),
  deletedAt: Schema.optionalKey(Schema.NullOr(documentedAs(IsoDateTime))),
}).annotate({ identifier: "SyncPushResource" });

export const SyncPushDashboard = Schema.Struct({
  id: NonEmptyId,
  name: Schema.String,
  isDefault: Schema.Boolean,
  updatedAt: documentedAs(IsoDateTime),
  deletedAt: Schema.optionalKey(Schema.NullOr(documentedAs(IsoDateTime))),
}).annotate({ identifier: "SyncPushDashboard" });

export const SyncPushRequest = Schema.Struct({
  accounts: Schema.optionalKey(Schema.Array(SyncPushAccount)),
  resources: Schema.optionalKey(Schema.Array(SyncPushResource)),
  dashboards: Schema.optionalKey(Schema.Array(SyncPushDashboard)),
}).annotate({ identifier: "SyncPushRequest" });

export const SyncStatus = Schema.Struct({
  maxSyncVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "SyncStatus" });

export class SyncGroup extends HttpApiGroup.make("sync")
  .add(
    HttpApiEndpoint.post("pull", "/pull", {
      payload: SyncPullRequest,
      success: SyncPullResponse,
      error: [BadRequest, Unauthorized],
    })
      .annotate(OpenApi.Summary, "Pull changes since `lastSyncVersion`")
      .annotate(OpenApi.Description, "Authenticated by API key (`sync:read` scope).")
      .annotate(SuccessDescription, "Pull payload"),
  )
  .add(
    HttpApiEndpoint.post("push", "/push", {
      payload: SyncPushRequest,
      success: Ok,
      error: [BadRequest, Unauthorized],
    })
      .annotate(OpenApi.Summary, "Push local changes to the server")
      .annotate(
        OpenApi.Description,
        "Authenticated by API key (`sync:write` scope). Last-write-wins.",
      )
      .annotate(SuccessDescription, "Pushed")
      .annotate(InvalidRequestMessage, "Invalid request body"),
  )
  .add(
    HttpApiEndpoint.get("status", "/status", { success: SyncStatus, error: [Unauthorized] })
      .annotate(OpenApi.Summary, "Highest known sync version on the server")
      .annotate(SuccessDescription, "Status"),
  )
  .prefix("/api/v1/sync")
  .annotate(Security, [{ bearerAuth: [] }])
  .annotate(Internal, true)
  .annotate(OpenApi.Title, "Sync") {}

export class SyncApi extends withApiDefaults(HttpApi.make("sync").add(SyncGroup)) {}
