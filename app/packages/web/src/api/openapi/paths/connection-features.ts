import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam, JsonObject, ResourceId } from "../common";
import type { BuildContext } from "../index";

const SqlQueryRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId.optional(),
  resourceTypeId: z.string().optional(),
  sql: z.string(),
}).openapi("SqlQueryRequest");

const SqlQueryResponse = strict({
  rows: z.array(JsonObject),
  durationMs: z.number().int().nonnegative().optional(),
}).openapi("SqlQueryResponse");

const SqlExecuteRequest = SqlQueryRequest.extend({
  params: z.array(z.unknown()).optional(),
}).openapi("SqlExecuteRequest");

const SqlExecuteResponse = strict({
  affectedRows: z.number().int().nonnegative(),
}).openapi("SqlExecuteResponse");

const SqlEstimateRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  sql: z.string(),
}).openapi("SqlEstimateRequest");

const KvCommandRequest = strict({
  accountId: Uuid,
  command: z.string(),
  args: z.array(z.union([z.string(), z.number()])),
  pluginId: z.string().optional(),
  parentResourceId: ResourceId.optional(),
}).openapi("KvCommandRequest");

const KvCommandResponse = strict({ result: JsonObject.or(z.unknown()) }).openapi(
  "KvCommandResponse",
);

const DockerCommandRequest = strict({
  accountId: Uuid,
  op: z.string(),
  params: JsonObject.optional(),
}).openapi("DockerCommandRequest");

const DockerCommandResponse = strict({ result: JsonObject.or(z.unknown()) }).openapi(
  "DockerCommandResponse",
);

const StorageListRequest = strict({
  accountId: Uuid,
  bucket: z.string(),
  prefix: z.string(),
}).openapi("StorageListRequest");

const StorageObject = strict({
  key: z.string(),
  size: z.number().int().nonnegative().optional(),
  isFolder: z.boolean().optional(),
  lastModified: z.string().optional(),
}).openapi("StorageObject");

const StoragePathRequest = strict({
  accountId: Uuid,
  bucket: z.string(),
  key: z.string(),
}).openapi("StoragePathRequest");

const ArtifactsListRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  resourceTypeId: z.string(),
  pageToken: z.string().optional(),
  prefix: z.string().optional(),
}).openapi("ArtifactsListRequest");

const SftpListRequest = strict({
  accountId: Uuid,
  path: z.string(),
  sshKeyId: Uuid.optional(),
  sshHost: z.string().optional(),
  sshUsername: z.string().optional(),
}).openapi("SftpListRequest");

const SftpEntry = strict({
  name: z.string(),
  isDir: z.boolean(),
  size: z.number().int().optional(),
  modifiedAt: z.string().optional(),
}).openapi("SftpEntry");

const SftpPathRequest = SftpListRequest.openapi("SftpPathRequest");

const SftpDeleteRequest = SftpListRequest.extend({ isDir: z.boolean() }).openapi(
  "SftpDeleteRequest",
);

export function registerConnectionFeaturePaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/sql/query",
    tags: ["Connections"],
    summary: "Run a read-only SQL query",
    description:
      "Routes to the right driver: REST `executeQuery` (BigQuery, Databricks), per-resource SQL driver (Neon, Turso) or account-level SQL driver (Postgres, MySQL).",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SqlQueryRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Result",
        content: {
          "application/json": {
            schema: z.union([SqlQueryResponse, JsonObject]).openapi({
              description:
                "REST executeQuery returns the plugin's native result shape; driver-based queries return `{ rows, durationMs }`.",
            }),
          },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/sql/execute",
    tags: ["Connections"],
    summary: "Run an INSERT/UPDATE/DELETE/DDL statement",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SqlExecuteRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Result",
        content: { "application/json": { schema: SqlExecuteResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/sql/estimate",
    tags: ["Connections"],
    summary: "Dry-run cost estimate (e.g. BigQuery byte scan)",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SqlEstimateRequest } }, required: true },
    },
    responses: {
      200: { description: "Estimate", content: { "application/json": { schema: JsonObject } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/kv/command",
    tags: ["Connections"],
    summary: "Run a Redis-style KV command",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: KvCommandRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Result",
        content: { "application/json": { schema: KvCommandResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/docker/command",
    tags: ["Connections"],
    summary: "Run a Docker daemon operation",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DockerCommandRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Result",
        content: { "application/json": { schema: DockerCommandResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/storage/list",
    tags: ["Connections"],
    summary: "List objects in a bucket / prefix",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: StorageListRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Objects",
        content: { "application/json": { schema: z.array(StorageObject) } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/storage/mkdir",
    tags: ["Connections"],
    summary: "Create a folder marker in a bucket",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: StoragePathRequest } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/storage/delete",
    tags: ["Connections"],
    summary: "Delete a storage object",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: StoragePathRequest } }, required: true },
    },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/artifacts/list",
    tags: ["Connections"],
    summary: "List artifact-registry items for a resource",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ArtifactsListRequest } }, required: true },
    },
    responses: {
      200: { description: "Artifacts", content: { "application/json": { schema: JsonObject } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      500: ErrorResponses[500],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/sftp/list",
    tags: ["Connections"],
    summary: "List a directory over SFTP",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SftpListRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Entries",
        content: { "application/json": { schema: z.array(SftpEntry) } },
      },
      404: ErrorResponses[404],
      500: ErrorResponses[500],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/sftp/mkdir",
    tags: ["Connections"],
    summary: "Create a directory over SFTP",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SftpPathRequest } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
      500: ErrorResponses[500],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/sftp/delete",
    tags: ["Connections"],
    summary: "Delete a file or directory over SFTP",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SftpDeleteRequest } }, required: true },
    },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
      500: ErrorResponses[500],
    },
  });
}
