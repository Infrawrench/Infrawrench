import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { v4 as uuid } from "uuid";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { apiKeys } from "../../db/schema";
import { logAudit } from "../../services/audit";
import { keyedHash } from "../../services/encryption";
import { requirePermission } from "../../auth/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import type { AuthSession } from "../auth-middleware";

/** Domain label for HMAC sub-key derivation when hashing API keys. */
export const API_KEY_HASH_DOMAIN = "api-key";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/api-keys — create a new API key */
app.post("/", async (c) => {
  requirePermission(c, "apikeys:write");
  const session = c.get("session");
  const { name, scopes, expiresAt } = await c.req.json<{
    name: string;
    scopes: string[];
    expiresAt?: string;
  }>();

  const raw = randomBytes(32);
  const key = `iwk_${raw.toString("base64url")}`;
  const hashedKey = await keyedHash(key, API_KEY_HASH_DOMAIN);
  const prefix = key.slice(0, 12);
  const id = uuid();

  await db.insert(apiKeys).values({
    id,
    organizationId: c.get("organizationId"),
    userId: session.userId,
    name,
    hashedKey,
    prefix,
    scopes,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  });

  void logAudit({
    organizationId: c.get("organizationId"),
    userId: session.userId,
    action: "api_key.create",
    entityType: "api_key",
    entityId: id,
    metadata: { name, scopes },
  });

  return c.json({ id, key });
});

/**
 * GET /api/api-keys — list API keys.
 *
 * Non-admins see only their own keys. Callers with `apikeys:write` (held by
 * admins and owners via the system role catalog) see every key in the org so
 * they can manage / revoke them — e.g. for offboarding.
 */
app.get("/", async (c) => {
  requirePermission(c, "apikeys:read");
  const session = c.get("session");
  const grantedPerms = c.get("permissions") ?? [];
  const canManageAll = hasPermission(grantedPerms, "apikeys:write");
  const whereClause = canManageAll
    ? eq(apiKeys.organizationId, c.get("organizationId"))
    : and(eq(apiKeys.organizationId, c.get("organizationId")), eq(apiKeys.userId, session.userId));
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(whereClause);
  return c.json(rows.map((r) => ({ ...r, scopes: (r.scopes as string[]) ?? [] })));
});

/** POST /api/api-keys/:id/revoke */
app.post("/:id/revoke", async (c) => {
  requirePermission(c, "apikeys:write");
  const session = c.get("session");
  const keyId = c.req.param("id");
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.organizationId, c.get("organizationId")),
        isNull(apiKeys.revokedAt),
      ),
    );

  void logAudit({
    organizationId: c.get("organizationId"),
    userId: session.userId,
    action: "api_key.revoke",
    entityType: "api_key",
    entityId: keyId,
  });
  return c.json({ ok: true });
});

/** POST /api/api-keys/:id/rotate */
app.post("/:id/rotate", async (c) => {
  requirePermission(c, "apikeys:write");
  const session = c.get("session");
  const keyId = c.req.param("id");

  const [old] = await db
    .select({ name: apiKeys.name, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, c.get("organizationId"))));
  if (!old) return c.json({ error: "API key not found" }, 404);

  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.organizationId, c.get("organizationId")),
        isNull(apiKeys.revokedAt),
      ),
    );

  const raw = randomBytes(32);
  const key = `iwk_${raw.toString("base64url")}`;
  const hashedKey = await keyedHash(key, API_KEY_HASH_DOMAIN);
  const prefix = key.slice(0, 12);
  const id = uuid();

  await db.insert(apiKeys).values({
    id,
    organizationId: c.get("organizationId"),
    userId: session.userId,
    name: old.name,
    hashedKey,
    prefix,
    scopes: (old.scopes as string[]) ?? [],
  });

  return c.json({ id, key });
});

export { app as apiKeyRoutes };
