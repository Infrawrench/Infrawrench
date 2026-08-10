/**
 * HTTP API for cost-report folders (org-scoped, mounted at
 * /api/org/:orgId/cost-report-folders).
 *
 * A folder organizes the Reports list and nothing else, so it follows the
 * cost-report permissions exactly: reads are `costs:read`, writes are
 * `costs:write`. Filing a *report* into a folder is not here — that is the
 * report's own PUT with a different `folderId`.
 *
 * The tree rules (nesting depth, no reparenting under a descendant) are
 * enforced in services/cost-report-folders.ts and surface as
 * {@link CostReportFolderError} → 400; this file is transport only, matching
 * api/routes/cost-reports.ts.
 */
import { Hono } from "hono";

import { costReportFolderInputSchema } from "@infrawrench/ui/cost/config";
import {
  CostReportFolderError,
  createCostReportFolder,
  deleteCostReportFolder,
  listCostReportFolders,
  updateCostReportFolder,
} from "../../services/cost-report-folders";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/org/:orgId/cost-report-folders — the org's folders, flat. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listCostReportFolders(c.get("organizationId")));
});

/** POST /api/org/:orgId/cost-report-folders — create a folder. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costReportFolderInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid folder", issues: parsed.error.issues }, 400);
  }

  try {
    const created = await createCostReportFolder(organizationId, parsed.data);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_report_folder.create",
      entityType: "cost_report_folder",
      entityId: created.id,
      metadata: { name: created.name },
    });
    return c.json(created);
  } catch (e) {
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * PUT /api/org/:orgId/cost-report-folders/:id — rename and/or reparent.
 *
 * The 400s here are the tree rules: a parent past the depth limit, or a parent
 * inside the folder's own subtree (the cycle case).
 */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costReportFolderInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid folder", issues: parsed.error.issues }, 400);
  }

  try {
    const updated = await updateCostReportFolder(organizationId, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_report_folder.update",
      entityType: "cost_report_folder",
      entityId: updated.id,
      metadata: { name: updated.name },
    });
    return c.json(updated);
  } catch (e) {
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * DELETE /api/org/:orgId/cost-report-folders/:id — delete the folder.
 *
 * Never blocked by contents and never destructive to them: the SET NULL
 * foreign keys drop the folder's reports and immediate subfolders to the top
 * level (see deleteCostReportFolder for why over refuse-until-empty).
 */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const folderId = c.req.param("id");

  const deleted = await deleteCostReportFolder(organizationId, folderId);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_report_folder.delete",
    entityType: "cost_report_folder",
    entityId: folderId,
    metadata: {},
  });
  return c.json({ ok: true });
});

export { app as costReportFolderRoutes };
