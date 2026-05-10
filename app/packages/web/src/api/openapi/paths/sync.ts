import { z } from "../zod";
import { strict, ErrorResponses, Uuid, IsoDateTime, JsonObject, Ok, ResourceId } from "../common";
import type { BuildContext } from "../index";

const PullRequest = strict({
  lastSyncVersion: z.number().int().nonnegative(),
}).openapi("SyncPullRequest");

const SyncedAccount = strict({
  id: Uuid,
  pluginId: z.string(),
  displayName: z.string(),
  encryptedCredentials: z.string(),
  credentialsIv: z.string(),
  syncVersion: z.number().int(),
  deletedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
}).openapi("SyncedAccount");

const SyncedResource = strict({
  id: ResourceId,
  pluginId: z.string(),
  resourceTypeId: z.string(),
  accountId: Uuid,
  displayName: z.string(),
  externalId: z.string().nullable(),
  fieldsJson: JsonObject,
  outputsJson: JsonObject,
  parentResourceId: ResourceId.nullable(),
  syncVersion: z.number().int(),
  deletedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
}).openapi("SyncedResource");

const SyncedDashboard = strict({
  id: Uuid,
  name: z.string(),
  isDefault: z.boolean(),
  syncVersion: z.number().int(),
  deletedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
}).openapi("SyncedDashboard");

const PullResponse = strict({
  accounts: z.array(SyncedAccount),
  resources: z.array(SyncedResource),
  dashboards: z.array(SyncedDashboard),
  dashboardPins: z.array(JsonObject),
  associations: z.array(JsonObject),
}).openapi("SyncPullResponse");

const PushAccount = strict({
  id: Uuid,
  pluginId: z.string(),
  displayName: z.string(),
  credentials: z.record(z.string()),
  updatedAt: IsoDateTime,
  deletedAt: IsoDateTime.nullable().optional(),
}).openapi("SyncPushAccount");

const PushResource = strict({
  id: ResourceId,
  pluginId: z.string(),
  resourceTypeId: z.string(),
  accountId: Uuid,
  displayName: z.string(),
  externalId: z.string().nullable().optional(),
  fieldsJson: JsonObject,
  outputsJson: JsonObject,
  parentResourceId: ResourceId.nullable().optional(),
  updatedAt: IsoDateTime,
  deletedAt: IsoDateTime.nullable().optional(),
}).openapi("SyncPushResource");

const PushDashboard = strict({
  id: Uuid,
  name: z.string(),
  isDefault: z.boolean(),
  updatedAt: IsoDateTime,
  deletedAt: IsoDateTime.nullable().optional(),
}).openapi("SyncPushDashboard");

const PushRequest = strict({
  accounts: z.array(PushAccount).optional(),
  resources: z.array(PushResource).optional(),
  dashboards: z.array(PushDashboard).optional(),
}).openapi("SyncPushRequest");

const StatusResponse = strict({
  maxSyncVersion: z.number().int().nonnegative(),
}).openapi("SyncStatus");

export function registerSyncPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/v1/sync/pull",
    tags: ["Sync"],
    summary: "Pull changes since `lastSyncVersion`",
    description: "Authenticated by API key (`sync:read` scope).",
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: PullRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Pull payload",
        content: { "application/json": { schema: PullResponse } },
      },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/sync/push",
    tags: ["Sync"],
    summary: "Push local changes to the server",
    description: "Authenticated by API key (`sync:write` scope). Last-write-wins.",
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: PushRequest } }, required: true },
    },
    responses: {
      200: { description: "Pushed", content: { "application/json": { schema: Ok } } },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/sync/status",
    tags: ["Sync"],
    summary: "Highest known sync version on the server",
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: "Status", content: { "application/json": { schema: StatusResponse } } },
      401: ErrorResponses[401],
    },
  });
}
