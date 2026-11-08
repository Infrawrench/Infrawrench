/**
 * API keys: `/api/org/:orgId/api-keys`, the handlers.
 *
 * The plaintext key is returned once, at creation or rotation; only its keyed
 * hash is stored, under the `api-key` HMAC domain.
 */
import { randomBytes } from "node:crypto";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { v4 as uuid } from "uuid";
import { eq, and, isNull } from "drizzle-orm";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { db } from "../../../db/client";
import { apiKeys } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { keyedHash } from "../../../services/encryption";
import { makeDomain } from "../../domain";
import { BadRequest, notFound } from "../../errors";
import { readJson } from "../../json-body";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { ApiKey, ApiKeysApi, CreatedApiKey } from "./api";

/** Domain label for HMAC sub-key derivation when hashing API keys. */
const API_KEY_HASH_DOMAIN = "api-key";

/**
 * What the create handler can use. The route never validated its body beyond
 * this: a blank name and an empty scope list are allowed, `expiresAt` may be
 * null, and a scope may be any permission string, wildcards included.
 */
const CreateBody = Schema.Struct({
  name: Schema.String,
  scopes: Schema.Array(Schema.String),
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

async function mintKey() {
  const raw = randomBytes(32);
  const key = `iwk_${raw.toString("base64url")}`;
  const hashedKey = await keyedHash(key, API_KEY_HASH_DOMAIN);
  return { key, hashedKey, prefix: key.slice(0, 12) };
}

async function createApiKey(organizationId: string, userId: string, input: typeof CreateBody.Type) {
  const { key, hashedKey, prefix } = await mintKey();
  const id = uuid();
  await db.insert(apiKeys).values({
    id,
    organizationId,
    userId,
    name: input.name,
    hashedKey,
    prefix,
    scopes: [...input.scopes],
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  });
  return { id, key };
}

/**
 * Non-admins see only their own keys. Callers with `apikeys:write` (held by
 * admins and owners via the system role catalog) see every key in the org so
 * they can manage and revoke them, e.g. for offboarding.
 */
async function listApiKeys(organizationId: string, userId: string, permissions: readonly string[]) {
  const canManageAll = hasPermission(permissions, "apikeys:write");
  const whereClause = canManageAll
    ? eq(apiKeys.organizationId, organizationId)
    : and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.userId, userId));
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      legacyHashSunsetAt: apiKeys.legacyHashSunsetAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(whereClause);
  return rows.map((r) => ({
    ...r,
    scopes: r.scopes ?? [],
    // Whether this row is still on the legacy SHA-256 hash. The sunset column
    // is only ever non-null while a row carries the legacy hash: on rehash
    // it's cleared. UIs warn admins to rotate before the cutover.
    needsRotation: r.legacyHashSunsetAt !== null,
  }));
}

async function revokeApiKey(organizationId: string, keyId: string) {
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.organizationId, organizationId),
        isNull(apiKeys.revokedAt),
      ),
    );
}

/** Revoke the key and mint its replacement under the same name and scopes; null when absent. */
async function rotateApiKey(organizationId: string, userId: string, keyId: string) {
  const [old] = await db
    .select({ name: apiKeys.name, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, organizationId)));
  if (!old) return null;
  await revokeApiKey(organizationId, keyId);
  const { key, hashedKey, prefix } = await mintKey();
  const id = uuid();
  await db.insert(apiKeys).values({
    id,
    organizationId,
    userId,
    name: old.name,
    hashedKey,
    prefix,
    scopes: old.scopes ?? [],
  });
  return { id, key };
}

const ApiKeysHandlers = HttpApiBuilder.group(ApiKeysApi, "apiKeys", (handlers) =>
  handlers
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* Schema.decodeUnknownEffect(CreateBody)(yield* readJson(request)).pipe(
          Effect.mapError(() => new BadRequest({ error: "Invalid API key" })),
        );
        const created = yield* legacy(() => createApiKey(organizationId, session.userId, input));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "api_key.create",
            entityType: "api_key",
            entityId: created.id,
            metadata: { name: input.name, scopes: input.scopes },
          }),
        );
        return yield* respond(CreatedApiKey)(created);
      }),
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId, session, permissions } = yield* OrgPrincipal;
        const keys = yield* legacy(() => listApiKeys(organizationId, session.userId, permissions));
        return yield* respond(Schema.Array(ApiKey))(keys);
      }),
    )
    .handle("revoke", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        yield* legacy(() => revokeApiKey(organizationId, params.id));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "api_key.revoke",
            entityType: "api_key",
            entityId: params.id,
          }),
        );
        return ok;
      }),
    )
    .handle("rotate", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const rotated = yield* legacy(() =>
          rotateApiKey(organizationId, session.userId, params.id),
        );
        if (!rotated) return yield* notFound("API key not found");
        return yield* respond(CreatedApiKey)(rotated);
      }),
    ),
);

export const apiKeysDomain = makeDomain("apiKeys", ApiKeysApi, ApiKeysHandlers);
