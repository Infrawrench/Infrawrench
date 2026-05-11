import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime, Ok, Permission } from "../common";
import type { BuildContext } from "../index";

/**
 * API key scopes mirror the same permission strings used for role-based UI
 * authorization. Granted scopes may include exact permissions from the
 * `Permission` enum or wildcards (e.g. `resources:*:read`, `*`).
 */
const Scope = Permission;

const ApiKey = strict({
  id: Uuid,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(Scope),
  lastUsedAt: IsoDateTime.nullable(),
  expiresAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
}).openapi("ApiKey");

const CreateRequest = strict({
  name: z.string().min(1),
  scopes: z.array(Scope),
  expiresAt: IsoDateTime.optional(),
}).openapi("CreateApiKeyRequest");

const CreatedKey = strict({
  id: Uuid,
  key: z
    .string()
    .openapi({ description: "Plaintext key. Returned once. Format: `iwk_<base64url>`." }),
}).openapi("CreatedApiKey");

export function registerApiKeyPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParams = OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/api-keys",
    tags: ["API keys"],
    summary: "List API keys (no plaintext)",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Keys", content: { "application/json": { schema: z.array(ApiKey) } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/api-keys",
    tags: ["API keys"],
    summary: "Create an API key (plaintext returned once)",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateRequest } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: CreatedKey } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/api-keys/{id}/revoke",
    tags: ["API keys"],
    summary: "Revoke an API key",
    request: { params: idParams },
    responses: { 200: { description: "Revoked", content: { "application/json": { schema: Ok } } } },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/api-keys/{id}/rotate",
    tags: ["API keys"],
    summary: "Rotate an API key (revokes old, returns new)",
    request: { params: idParams },
    responses: {
      200: { description: "Rotated", content: { "application/json": { schema: CreatedKey } } },
      404: ErrorResponses[404],
    },
  });
}
