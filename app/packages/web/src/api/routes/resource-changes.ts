import { Hono } from "hono";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { resourceChanges, accounts } from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const CHANGE_KINDS = new Set(["created", "updated", "deleted"]);

/**
 * GET /api/org/:orgId/changes — org-wide change feed (paginated, filterable
 * by account, resource, change kind, and time range).
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");

  const page = Math.max(parseInt(c.req.query("page") ?? "1", 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(c.req.query("pageSize") ?? "50", 10) || 50, 1), 200);
  const accountId = c.req.query("accountId");
  const resourceId = c.req.query("resourceId");
  const kind = c.req.query("kind");
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (kind && !CHANGE_KINDS.has(kind)) {
    return c.json({ error: `Unknown change kind "${kind}"` }, 400);
  }

  const conditions = [eq(resourceChanges.organizationId, organizationId)];
  if (accountId) conditions.push(eq(resourceChanges.accountId, accountId));
  if (resourceId) conditions.push(eq(resourceChanges.resourceId, resourceId));
  if (kind) conditions.push(eq(resourceChanges.changeKind, kind as "created")); // narrowed above
  if (from) conditions.push(gte(resourceChanges.createdAt, new Date(from)));
  if (to) conditions.push(lte(resourceChanges.createdAt, new Date(to)));

  const where = and(...conditions);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(resourceChanges)
    .where(where);

  const entries = await db
    .select({
      id: resourceChanges.id,
      resourceId: resourceChanges.resourceId,
      accountId: resourceChanges.accountId,
      pluginId: resourceChanges.pluginId,
      resourceTypeId: resourceChanges.resourceTypeId,
      displayName: resourceChanges.displayName,
      changeKind: resourceChanges.changeKind,
      diff: resourceChanges.diff,
      createdAt: resourceChanges.createdAt,
      accountName: accounts.displayName,
    })
    .from(resourceChanges)
    .leftJoin(accounts, eq(resourceChanges.accountId, accounts.id))
    .where(where)
    .orderBy(desc(resourceChanges.createdAt), desc(resourceChanges.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return c.json({ entries, total: countResult?.count ?? 0 });
});

/**
 * GET /api/org/:orgId/changes/resource?resourceId=… — recent changes for one
 * resource. `resourceId` is a query param because composite resource ids
 * contain slashes and colons that don't survive as path segments.
 */
app.get("/resource", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");

  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "resourceId is required" }, 400);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);

  const entries = await db
    .select({
      id: resourceChanges.id,
      resourceId: resourceChanges.resourceId,
      accountId: resourceChanges.accountId,
      pluginId: resourceChanges.pluginId,
      resourceTypeId: resourceChanges.resourceTypeId,
      displayName: resourceChanges.displayName,
      changeKind: resourceChanges.changeKind,
      diff: resourceChanges.diff,
      createdAt: resourceChanges.createdAt,
    })
    .from(resourceChanges)
    .where(
      and(
        eq(resourceChanges.organizationId, organizationId),
        eq(resourceChanges.resourceId, resourceId),
      ),
    )
    .orderBy(desc(resourceChanges.createdAt), desc(resourceChanges.id))
    .limit(limit);

  return c.json({ entries });
});

export { app as resourceChangeRoutes };
