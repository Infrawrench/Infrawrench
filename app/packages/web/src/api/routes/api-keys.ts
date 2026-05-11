import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { v4 as uuid } from "uuid";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { apiKeys } from "../../db/schema";
import { logAudit } from "../../services/audit";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

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
  const hashedKey = createHash("sha256").update(key).digest("hex");
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

/** GET /api/api-keys — list API keys */
app.get("/", async (c) => {
  requirePermission(c, "apikeys:read");
  const session = c.get("session");
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
    .where(eq(apiKeys.organizationId, c.get("organizationId")));
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
  const hashedKey = createHash("sha256").update(key).digest("hex");
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
