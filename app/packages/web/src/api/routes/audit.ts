import { Hono } from "hono";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { apiKeys, auditLogs, users } from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/audit-logs */
app.get("/", async (c) => {
  requirePermission(c, "audit:read");
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = parseInt(c.req.query("pageSize") ?? "25", 10);
  const action = c.req.query("action");
  const entityType = c.req.query("entityType");
  const userId = c.req.query("userId");
  // "Which key did this?" — the question an operator asks after a credential
  // leaks. Filtering by owner is not a substitute: a person and every key they
  // minted share a `userId`.
  const apiKeyId = c.req.query("apiKeyId");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const conditions = [eq(auditLogs.organizationId, c.get("organizationId"))];
  if (action) conditions.push(eq(auditLogs.action, action));
  if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
  if (userId) conditions.push(eq(auditLogs.userId, userId));
  if (apiKeyId) conditions.push(eq(auditLogs.apiKeyId, apiKeyId));
  if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
  if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));

  const where = and(...conditions);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditLogs)
    .where(where);

  const entries = await db
    .select({
      id: auditLogs.id,
      userId: auditLogs.userId,
      apiKeyId: auditLogs.apiKeyId,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
      userName: users.displayName,
      userEmail: users.email,
      // A key id alone answers "which key" only if you can still look it up;
      // a revoked key is gone from the UI long before the audit row ages out.
      // Carry the name and prefix so the entry stays readable on its own.
      apiKeyName: apiKeys.name,
      apiKeyPrefix: apiKeys.prefix,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(apiKeys, eq(auditLogs.apiKeyId, apiKeys.id))
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return c.json({ entries, total: countResult?.count ?? 0 });
});

export { app as auditRoutes };
