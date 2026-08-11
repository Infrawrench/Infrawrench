import { Hono } from "hono";
import type { Context } from "hono";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import {
  getDriftAlertSettings,
  updateDriftAlertSettings,
  type DriftAlertSettings,
  type DriftAlertSettingsPatch,
} from "@infrawrench/server-core/drift/settings";
import { buildRevertPatch, REVERT_CONFLICT_CODE } from "@infrawrench/client-core";
import { db } from "../../db/client";
import { resourceChanges, accounts } from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import { checkChangeFreeze } from "../../services/change-freezes";
import { logAudit } from "../../services/audit";
import {
  buildRevertPlan,
  claimRevert,
  completeRevert,
  loadChange,
  releaseRevert,
} from "../../services/change-revert";
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
        revertedAt: resourceChanges.revertedAt,
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
      revertedAt: resourceChanges.revertedAt,
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

/* ----------------------------- revert -------------------------------- *
 *
 * GET  /changes/:changeId/revert — the dry run
 * POST /changes/:changeId/revert — apply it
 *
 * Same path, and the verb carries the whole difference: the plan is computed
 * identically either way, the POST just rebuilds it against a fresher read and
 * then writes. That re-read is a last-moment check rather than an atomic
 * compare-and-swap — `buildRevertPlan` in `services/change-revert.ts` documents
 * the window it leaves and why the plugin contract can't close it.
 */

function revertFailureResponse(c: Context, failure: { kind: string; message?: string }) {
  if (failure.kind === "account-not-found") {
    return c.json({ error: "The account this change belongs to no longer exists" }, 404);
  }
  return c.json(
    {
      error: `Couldn't read the resource's current state, so a revert can't be planned safely — ${failure.message ?? "unknown error"}`,
    },
    502,
  );
}

/**
 * What a revert of this event would do, field by field, against the resource as
 * it is right now. Read-only: it touches the provider (to read) and nothing
 * else.
 *
 * `resources:write` rather than `resources:read` — the plan names the write it
 * is offering to make, and it costs a live provider call, so it is gated with
 * the action it previews rather than with the feed it reads from.
 */
app.get("/:changeId/revert", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const changeId = c.req.param("changeId");

  const change = await loadChange(organizationId, changeId);
  if (!change) return c.json({ error: "Change not found" }, 404);

  const result = await buildRevertPlan(organizationId, change);
  if (!result.ok) return revertFailureResponse(c, result.failure);

  return c.json({
    changeId: change.id,
    resourceId: change.resourceId,
    displayName: change.displayName,
    pluginId: change.pluginId,
    resourceTypeId: change.resourceTypeId,
    accountId: change.accountId,
    plan: result.result.plan,
    revertedAt: change.revertedAt ? change.revertedAt.toISOString() : null,
  });
});

/**
 * Put the resource back, through the plugin's ordinary update path.
 *
 * Order matters and is the point of the handler:
 *
 * 1. permission, then the change freeze — a revert is a provider mutation like
 *    any other, so it goes through the same gate a delete or a resize does;
 * 2. claim the event under a lease, which settles a race between two reverts of
 *    the same event before either can reach the provider;
 * 3. rebuild the plan against a *fresh* live read — anything that moved since
 *    the preview is now a conflict and drops out of the patch;
 * 4. write **through the client that read**, so nothing (least of all a
 *    credential decrypt and a client rebuild) sits between the read and the
 *    write. The remaining gap is one provider round-trip and is documented on
 *    `buildRevertPlan`; it is a narrow window, not an absence of one.
 * 5. record completion, releasing the claim on any failure so the attempt is
 *    retryable at once rather than at lease expiry.
 *
 * The stored `resources` snapshot is deliberately left alone (unlike
 * `POST /api/resources/update`), so the next poll sees the difference and
 * records the revert as an ordinary change event.
 */
app.post("/:changeId/revert", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const userId = (c.get("session") as { userId?: string } | undefined)?.userId;
  const changeId = c.req.param("changeId");

  const change = await loadChange(organizationId, changeId);
  if (!change) return c.json({ error: "Change not found" }, 404);
  if (change.revertedAt) {
    return c.json(
      { error: "This change has already been reverted.", code: REVERT_CONFLICT_CODE },
      409,
    );
  }

  const frozen = await checkChangeFreeze(c, {
    action: "resource.change_revert",
    entityType: "resource",
    entityId: change.resourceId,
    metadata: {
      pluginId: change.pluginId,
      resourceTypeId: change.resourceTypeId,
      changeId: change.id,
    },
  });
  if (frozen) return frozen;

  const claimedAt = new Date();
  const claimed = await claimRevert(organizationId, change.id, userId, claimedAt);
  if (!claimed) {
    return c.json(
      {
        error: "Another revert of this change is already in flight or has completed.",
        code: REVERT_CONFLICT_CODE,
      },
      409,
    );
  }

  const result = await buildRevertPlan(organizationId, change);
  if (!result.ok) {
    await releaseRevert(organizationId, change.id);
    return revertFailureResponse(c, result.failure);
  }
  const { plan, client } = result.result;
  const patch = buildRevertPatch(plan);
  if (Object.keys(patch).length === 0) {
    await releaseRevert(organizationId, change.id);
    return c.json(
      {
        error: plan.blockedReason ?? "Nothing about this change can be reverted.",
        plan,
      },
      409,
    );
  }

  // The client that performed the live read, reused rather than rebuilt: a
  // second `getClientForAccount` here would decrypt credentials and run
  // credential rewriters *between* the read and the write, widening the window
  // for exactly the lost update the re-read is trying to catch.
  if (!client?.updateResource) {
    await releaseRevert(organizationId, change.id);
    return c.json({ error: "The account this change belongs to no longer exists" }, 404);
  }

  try {
    await client.updateResource(change.resourceTypeId, change.resourceId, change.accountId, patch);
  } catch (err) {
    await releaseRevert(organizationId, change.id);
    const message = err instanceof Error ? err.message : "The revert failed";
    return c.json({ error: message }, 400);
  }

  // Only now is the event reverted. Until this commits the row carries a lease,
  // not a verdict — so a crash anywhere above leaves something retryable.
  const revertedAt = new Date();
  await completeRevert(organizationId, change.id, revertedAt);

  void logAudit({
    organizationId,
    userId,
    action: "resource.change_revert",
    entityType: "resource",
    entityId: change.resourceId,
    metadata: {
      changeId: change.id,
      pluginId: change.pluginId,
      resourceTypeId: change.resourceTypeId,
      // Keys only, like `resource.update` — a reverted value can be anything
      // the plugin declared, and the audit table is not the place for it.
      fieldKeys: plan.revertibleFields,
      changeRecordedAt: change.createdAt.toISOString(),
    },
  });

  return c.json({
    changeId: change.id,
    resourceId: change.resourceId,
    appliedFields: plan.revertibleFields,
    plan,
    revertedAt: revertedAt.toISOString(),
  });
});

export { app as resourceChangeRoutes };
