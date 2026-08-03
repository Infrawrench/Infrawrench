import { Hono } from "hono";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import {
  getDriftAlertSettings,
  updateDriftAlertSettings,
  type DriftAlertSettings,
  type DriftAlertSettingsPatch,
} from "@infrawrench/server-core/drift/settings";
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

  // Independent read-only queries — race them so the page costs max(count, rows)
  // instead of the sum.
  const [countRows, entries] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(resourceChanges)
      .where(where),
    db
      .select({
        id: resourceChanges.id,
        resourceId: resourceChanges.resourceId,
        accountId: resourceChanges.accountId,
        pluginId: resourceChanges.pluginId,
        resourceTypeId: resourceChanges.resourceTypeId,
        displayName: resourceChanges.displayName,
        changeKind: resourceChanges.changeKind,
        diff: resourceChanges.diff,
        origin: resourceChanges.origin,
        createdAt: resourceChanges.createdAt,
        accountName: accounts.displayName,
      })
      .from(resourceChanges)
      .leftJoin(accounts, eq(resourceChanges.accountId, accounts.id))
      .where(where)
      .orderBy(desc(resourceChanges.createdAt), desc(resourceChanges.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);
  const countResult = countRows[0];

  return c.json({ entries, total: countResult?.count ?? 0 });
});

/* ------------------------ drift alert settings ------------------------ *
 *
 * Registered before `/resource` only for readability; Hono matches on the
 * literal path either way. `org:settings:write` rather than `resources:read`:
 * these decide who the org's channels and phones hear from, which is the same
 * trust level as the Slack/Teams/digest settings next to them.
 */

function toWire(s: DriftAlertSettings) {
  return {
    notifyCreated: s.notifyCreated,
    notifyUpdated: s.notifyUpdated,
    notifyDeleted: s.notifyDeleted,
    cooldownMinutes: s.cooldownMinutes,
    minChanges: s.minChanges,
    accountIds: s.accountIds,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

/** The org's drift alert filter; an org that never saved reads the defaults. */
app.get("/alert-settings", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(toWire(await getDriftAlertSettings(c.get("organizationId"))));
});

/**
 * Update the drift alert filter. Every field is optional so a single toggle can
 * be saved on its own. Bounds live in server-core so the API and the poller
 * cannot disagree about what a valid cooldown is.
 */
app.put("/alert-settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const body = await c.req.json<Record<string, unknown>>();
  const patch: DriftAlertSettingsPatch = {};

  for (const key of ["notifyCreated", "notifyUpdated", "notifyDeleted"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return c.json({ error: `${key} must be a boolean` }, 400);
    patch[key] = value;
  }
  for (const key of ["cooldownMinutes", "minChanges"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number") return c.json({ error: `${key} must be a number` }, 400);
    patch[key] = value;
  }
  if (body["accountIds"] !== undefined) {
    const value = body["accountIds"];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return c.json({ error: "accountIds must be an array of account ids" }, 400);
    }
    patch.accountIds = value as string[];
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No settings supplied" }, 400);
  }

  try {
    return c.json(toWire(await updateDriftAlertSettings(c.get("organizationId"), patch)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save drift alert settings";
    return c.json({ error: message }, 400);
  }
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
      origin: resourceChanges.origin,
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
