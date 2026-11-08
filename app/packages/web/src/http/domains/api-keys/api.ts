/**
 * API keys: `/api/org/:orgId/api-keys`, the endpoint definitions.
 *
 * Keys may never manage keys: `API_KEY_DENY_RULES` closes this prefix to an
 * `iwk_` caller in the auth chain, before any endpoint here runs.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { Permission } from "../../schemas/permissions";

/**
 * API key scopes are the permission strings role-based authorization uses:
 * exact entries of the `Permission` enum, or wildcards (`resources:*:read`, `*`).
 */
const Scope = Permission;

export const ApiKey = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  prefix: Schema.String,
  scopes: Schema.Array(Scope),
  lastUsedAt: Schema.NullOr(IsoDateTime),
  expiresAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  legacyHashSunsetAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "Cutover date past which a key still on the legacy SHA-256 hash will be refused. Null once rehashed to HMAC.",
  }),
  needsRotation: Schema.Boolean.annotate({
    description:
      "True when this key is still hashed with the legacy SHA-256 scheme and should be rotated before `legacyHashSunsetAt`.",
  }),
  createdAt: IsoDateTime,
}).annotate({ identifier: "ApiKey" });

/** Documented; the handler reads the body raw, as it always has. */
const CreateApiKeyRequest = Schema.Struct({
  name: Schema.String.check(minLength(1)),
  scopes: Schema.Array(Scope),
  expiresAt: Schema.optionalKey(IsoDateTime),
}).annotate({ identifier: "CreateApiKeyRequest" });

export const CreatedApiKey = Schema.Struct({
  id: Uuid,
  key: Schema.String.annotate({
    description: "Plaintext key. Returned once. Format: `iwk_<base64url>`.",
  }),
}).annotate({ identifier: "CreatedApiKey" });

export class ApiKeysGroup extends HttpApiGroup.make("apiKeys")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(ApiKey),
    })
      .annotate(RequiredPermission, "apikeys:read")
      .annotate(OpenApi.Summary, "List API keys (no plaintext)")
      .annotate(SuccessDescription, "Keys"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CreateApiKeyRequest,
      success: CreatedApiKey,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "apikeys:write")
      .annotate(OpenApi.Summary, "Create an API key (plaintext returned once)")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.post("revoke", "/:id/revoke", {
      params: OrgIdParams,
      success: Ok,
    })
      .annotate(RequiredPermission, "apikeys:write")
      .annotate(OpenApi.Summary, "Revoke an API key")
      .annotate(SuccessDescription, "Revoked"),
    HttpApiEndpoint.post("rotate", "/:id/rotate", {
      params: OrgIdParams,
      success: CreatedApiKey,
      error: NotFound,
    })
      .annotate(RequiredPermission, "apikeys:write")
      .annotate(OpenApi.Summary, "Rotate an API key (revokes old, returns new)")
      .annotate(SuccessDescription, "Rotated"),
  )
  .prefix("/api/org/:orgId/api-keys")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "API keys") {}

export class ApiKeysApi extends withApiDefaults(HttpApi.make("apiKeys").add(ApiKeysGroup)) {}
