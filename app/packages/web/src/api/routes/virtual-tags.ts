import { Hono } from "hono";
import type { Context } from "hono";
import { virtualTagInputSchema } from "@infrawrench/ui/cost/config";
import {
  VirtualTagError,
  VirtualTagInUseError,
  VirtualTagKeyConflictError,
  createVirtualTag,
  deleteVirtualTag,
  getVirtualTag,
  listVirtualTags,
  reprocessVirtualTag,
  updateVirtualTag,
} from "@infrawrench/server-core/cost/virtual-tags";
import { previewVirtualTag } from "@infrawrench/server-core/cost/virtual-tag-pass";
import type { VirtualTag } from "@infrawrench/client-core";
import { requestIsCostScoped } from "../../auth/cost-visibility";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Virtual tags: the org's rule-based computed tags.
 *
 * Reads ride `costs:read`, like every cost surface: a virtual tag is part of
 * the explanation for every figure grouped or filtered by it. Writes ride
 * `costs:write`, the scope cost centres and allocation rules already use: a
 * virtual tag adds a way to slice spend and never changes how much there is
 * (splits are weighted so totals are conserved), which is the line between
 * `costs:write` and the `org:settings:write` that billing rules need.
 *
 * Every mutation is audit-logged with the rules it stored, so "why did this
 * team's number move on Tuesday" has an answer.
 */
const app = new Hono();

function writeError(c: Context, e: unknown) {
  if (e instanceof VirtualTagKeyConflictError) return c.json({ error: e.message }, 409);
  if (e instanceof VirtualTagInUseError) {
    return c.json({ error: e.message, references: e.references }, 409);
  }
  if (e instanceof VirtualTagError) return c.json({ error: e.message }, 400);
  throw e;
}

/**
 * The stored processing stats are whole-org money (totals, unmatched spend,
 * spend per rule, top values by spend) with no cost row left to test a
 * visibility scope against, so a cost-scoped caller gets the tag and its
 * status without them. The live preview needs no such step: it reads through
 * the scoped cost readers.
 */
function forCaller(c: Context, tag: VirtualTag): VirtualTag {
  const stats = tag.status.stats;
  if (!requestIsCostScoped(c) || !stats) return tag;
  return { ...tag, status: { ...tag.status, stats: { ...stats, currencies: [] } } };
}

/** GET /api/org/:orgId/virtual-tags: every virtual tag, by key, with its status. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  const tags = await listVirtualTags(c.get("organizationId"));
  return c.json(tags.map((t) => forCaller(c, t)));
});

/**
 * POST /api/org/:orgId/virtual-tags/preview: evaluate an unsaved definition
 * over the trailing 30 days (spend per rule, unmatched spend, top values), so
 * the editor can show what a rule would do before anything is stored.
 */
app.post("/preview", async (c) => {
  requirePermission(c, "costs:read");
  const parsed = virtualTagInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid virtual tag", issues: parsed.error.issues }, 400);
  }
  try {
    return c.json(await previewVirtualTag(c.get("organizationId"), parsed.data));
  } catch (e) {
    return writeError(c, e);
  }
});

/** GET /api/org/:orgId/virtual-tags/:id: one virtual tag. */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const tag = await getVirtualTag(c.get("organizationId"), c.req.param("id"));
  if (!tag) return c.json({ error: "Not found" }, 404);
  return c.json(forCaller(c, tag));
});

/** POST /api/org/:orgId/virtual-tags: create; processing is queued at once. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = virtualTagInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid virtual tag", issues: parsed.error.issues }, 400);
  }
  let tag;
  try {
    tag = await createVirtualTag(organizationId, parsed.data, session.userId);
  } catch (e) {
    return writeError(c, e);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "virtual_tag.create",
    entityType: "virtual_tag",
    entityId: tag.id,
    metadata: { key: tag.key, name: tag.name, rules: tag.rules, defaultValue: tag.defaultValue },
  });
  return c.json(tag);
});

/**
 * PUT /api/org/:orgId/virtual-tags/:id: full replace, rule order included.
 * The key cannot change (400 naming why); saving re-queues processing.
 */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = virtualTagInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid virtual tag", issues: parsed.error.issues }, 400);
  }
  let tag;
  try {
    tag = await updateVirtualTag(organizationId, c.req.param("id"), parsed.data);
  } catch (e) {
    return writeError(c, e);
  }
  if (!tag) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "virtual_tag.update",
    entityType: "virtual_tag",
    entityId: tag.id,
    metadata: { key: tag.key, name: tag.name, rules: tag.rules, defaultValue: tag.defaultValue },
  });
  return c.json(tag);
});

/** POST /api/org/:orgId/virtual-tags/:id/reprocess: re-run the backfill evaluation now. */
app.post("/:id/reprocess", async (c) => {
  requirePermission(c, "costs:write");
  const tag = await reprocessVirtualTag(c.get("organizationId"), c.req.param("id"));
  if (!tag) return c.json({ error: "Not found" }, 404);
  return c.json(tag);
});

/**
 * DELETE /api/org/:orgId/virtual-tags/:id. Refused with a 409 naming every
 * saved filter, budget, report, alert, allocation rule, export or metric that
 * still references the key: deleting it would make those fail.
 */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  let deleted;
  try {
    deleted = await deleteVirtualTag(organizationId, id);
  } catch (e) {
    return writeError(c, e);
  }
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "virtual_tag.delete",
    entityType: "virtual_tag",
    entityId: id,
  });
  return c.json({ ok: true });
});

export { app as virtualTagRoutes };
