/**
 * Connection features: SQL, KV, Docker, object storage, artifact registry and
 * SFTP operations against live resources, the endpoint definitions. They sit
 * directly under the org tree (`/api/org/:orgId/sql/query`, ...).
 *
 * Each one resolves the account's client and either calls the plugin or hands
 * the account's connection string to a socket driver (guarded by the egress
 * policy first). The KV browser endpoints were never in the published spec
 * and stay out of it.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, InternalServerError, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { JsonObject, Ok, OrgParams, ResourceId, Undocumented, Uuid } from "../http/schemas/common";

const sqlQueryFields = {
  accountId: Uuid,
  resourceId: Schema.optionalKey(ResourceId),
  resourceTypeId: Schema.optionalKey(Schema.String),
  sql: Schema.String,
};

const SqlQueryRequest = Schema.Struct(sqlQueryFields).annotate({
  identifier: "SqlQueryRequest",
});

const SqlQueryResponse = Schema.Struct({
  rows: Schema.Array(JsonObject),
  durationMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "SqlQueryResponse" });

export const SqlQueryResult = Schema.Union([SqlQueryResponse, JsonObject]).annotate({
  description:
    "REST executeQuery returns the plugin's native result shape; driver-based queries return `{ rows, durationMs }`.",
});

const SqlExecuteRequest = Schema.Struct({
  ...sqlQueryFields,
  params: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.Any)).check(
      // Bind values of any type, stated as such (`items: {}`).
      Schema.makeFilter(() => true, { toJsonSchema: () => ({ items: {} }) }),
    ),
  ),
}).annotate({ identifier: "SqlExecuteRequest" });

export const SqlExecuteResponse = Schema.Struct({
  affectedRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "SqlExecuteResponse" });

const SqlEstimateRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  sql: Schema.String,
}).annotate({ identifier: "SqlEstimateRequest" });

const KvCommandRequest = Schema.Struct({
  accountId: Uuid,
  command: Schema.String,
  args: Schema.mutable(Schema.Array(Schema.Union([Schema.String, Schema.Finite]))),
  pluginId: Schema.optionalKey(Schema.String),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "KvCommandRequest" });

export const KvCommandResponse = Schema.Struct({
  result: Schema.optionalKey(Schema.NullOr(Schema.Union([JsonObject, Schema.Unknown]))),
}).annotate({ identifier: "KvCommandResponse" });

const DockerCommandRequest = Schema.Struct({
  accountId: Uuid,
  op: Schema.String,
  params: Schema.optionalKey(JsonObject),
}).annotate({ identifier: "DockerCommandRequest" });

export const DockerCommandResponse = Schema.Struct({
  result: Schema.optionalKey(Schema.NullOr(Schema.Union([JsonObject, Schema.Unknown]))),
}).annotate({ identifier: "DockerCommandResponse" });

const StorageListRequest = Schema.Struct({
  accountId: Uuid,
  bucket: Schema.String,
  prefix: Schema.String,
}).annotate({ identifier: "StorageListRequest" });

const StorageObject = Schema.Struct({
  key: Schema.String.annotate({ description: "Full path within the bucket." }),
  name: Schema.String.annotate({ description: "Last path segment, what the browser renders." }),
  size: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  lastModified: Schema.String,
  isDirectory: Schema.Boolean,
  contentType: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "StorageObject" });

export const StorageObjects = Schema.Array(StorageObject);

const StoragePathRequest = Schema.Struct({
  accountId: Uuid,
  bucket: Schema.String,
  key: Schema.String,
}).annotate({ identifier: "StoragePathRequest" });

const ArtifactsListRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  resourceTypeId: Schema.String,
  pageToken: Schema.optionalKey(Schema.String),
  prefix: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "ArtifactsListRequest" });

const sftpFields = {
  accountId: Uuid,
  path: Schema.String,
  sshKeyId: Schema.optionalKey(Uuid),
  sshHost: Schema.optionalKey(Schema.String),
  sshUsername: Schema.optionalKey(Schema.String),
};

const SftpListRequest = Schema.Struct(sftpFields).annotate({ identifier: "SftpListRequest" });

/**
 * Directory listings come back in the same shape as object storage: the SFTP
 * host aliases its entry type to `StorageObject` so one browser component can
 * render both. Spelled out here so the generated SDKs keep a named type.
 */
const SftpEntry = Schema.Struct({
  key: Schema.String.annotate({ description: "Absolute remote path." }),
  name: Schema.String,
  size: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  lastModified: Schema.String,
  isDirectory: Schema.Boolean,
  contentType: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SftpEntry" });

export const SftpEntries = Schema.Array(SftpEntry);

const SftpPathRequest = Schema.Struct(sftpFields).annotate({ identifier: "SftpPathRequest" });

const SftpDeleteRequest = Schema.Struct({ ...sftpFields, isDir: Schema.Boolean }).annotate({
  identifier: "SftpDeleteRequest",
});

const kvBrowserTarget = {
  accountId: Schema.String,
  resourceTypeId: Schema.String,
  resourceId: Schema.String,
};

const KvBrowserListRequest = Schema.Struct({
  ...kvBrowserTarget,
  prefix: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  limit: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});

const KvBrowserKeyRequest = Schema.Struct({ ...kvBrowserTarget, key: Schema.String });

const KvBrowserPutRequest = Schema.Struct({
  ...kvBrowserTarget,
  key: Schema.String,
  value: Schema.String,
});

export class ConnectionsGroup extends HttpApiGroup.make("connections")
  .add(
    HttpApiEndpoint.post("sqlQuery", "/sql/query", {
      params: OrgParams,
      payload: SqlQueryRequest,
      success: SqlQueryResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Run a read-only SQL query")
      .annotate(
        OpenApi.Description,
        "Routes to the right driver: REST `executeQuery` (BigQuery, Databricks), per-resource SQL driver (Neon, Turso) or account-level SQL driver (Postgres, MySQL).",
      )
      .annotate(SuccessDescription, "Result"),
    HttpApiEndpoint.post("sqlExecute", "/sql/execute", {
      params: OrgParams,
      payload: SqlExecuteRequest,
      success: SqlExecuteResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Run an INSERT/UPDATE/DELETE/DDL statement")
      .annotate(SuccessDescription, "Result"),
    HttpApiEndpoint.post("sqlEstimate", "/sql/estimate", {
      params: OrgParams,
      payload: SqlEstimateRequest,
      success: JsonObject,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Dry-run cost estimate (e.g. BigQuery byte scan)")
      .annotate(SuccessDescription, "Estimate"),
    HttpApiEndpoint.post("kvCommand", "/kv/command", {
      params: OrgParams,
      payload: KvCommandRequest,
      success: KvCommandResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Run a Redis-style KV command")
      .annotate(SuccessDescription, "Result"),
    HttpApiEndpoint.post("dockerCommand", "/docker/command", {
      params: OrgParams,
      payload: DockerCommandRequest,
      success: DockerCommandResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Run a Docker daemon operation")
      .annotate(SuccessDescription, "Result"),
    HttpApiEndpoint.post("kvBrowserList", "/kv-browser/list", {
      params: OrgParams,
      payload: KvBrowserListRequest,
      success: Undocumented,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("kvBrowserGet", "/kv-browser/get", {
      params: OrgParams,
      payload: KvBrowserKeyRequest,
      success: Undocumented,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("kvBrowserPut", "/kv-browser/put", {
      params: OrgParams,
      payload: KvBrowserPutRequest,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("kvBrowserDelete", "/kv-browser/delete", {
      params: OrgParams,
      payload: KvBrowserKeyRequest,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("storageList", "/storage/list", {
      params: OrgParams,
      payload: StorageListRequest,
      success: StorageObjects,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "storage:read")
      .annotate(OpenApi.Summary, "List objects in a bucket / prefix")
      .annotate(SuccessDescription, "Objects"),
    HttpApiEndpoint.post("storageMkdir", "/storage/mkdir", {
      params: OrgParams,
      payload: StoragePathRequest,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "storage:write")
      .annotate(OpenApi.Summary, "Create a folder marker in a bucket")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.post("storageDelete", "/storage/delete", {
      params: OrgParams,
      payload: StoragePathRequest,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "storage:write")
      .annotate(OpenApi.Summary, "Delete a storage object")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("artifactsList", "/artifacts/list", {
      params: OrgParams,
      payload: ArtifactsListRequest,
      success: JsonObject,
      error: [BadRequest, NotFound, InternalServerError],
    })
      .annotate(RequiredPermission, "storage:read")
      .annotate(OpenApi.Summary, "List artifact-registry items for a resource")
      .annotate(SuccessDescription, "Artifacts"),
    HttpApiEndpoint.post("sftpList", "/sftp/list", {
      params: OrgParams,
      payload: SftpListRequest,
      success: SftpEntries,
      error: [NotFound, InternalServerError],
    })
      .annotate(RequiredPermission, "storage:read")
      .annotate(OpenApi.Summary, "List a directory over SFTP")
      .annotate(SuccessDescription, "Entries"),
    HttpApiEndpoint.post("sftpMkdir", "/sftp/mkdir", {
      params: OrgParams,
      payload: SftpPathRequest,
      success: Ok,
      error: [NotFound, InternalServerError],
    })
      .annotate(RequiredPermission, "storage:write")
      .annotate(OpenApi.Summary, "Create a directory over SFTP")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.post("sftpDelete", "/sftp/delete", {
      params: OrgParams,
      payload: SftpDeleteRequest,
      success: Ok,
      error: [NotFound, InternalServerError],
    })
      .annotate(RequiredPermission, "storage:write")
      .annotate(OpenApi.Summary, "Delete a file or directory over SFTP")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Connections") {}

export class ConnectionsApi extends withApiDefaults(
  HttpApi.make("connection-features").add(ConnectionsGroup),
) {}
