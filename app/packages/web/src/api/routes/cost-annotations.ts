/**
 * HTTP API for cost annotations (org-scoped, mounted at
 * /api/org/:orgId/cost-annotations).
 *
 * An annotation is a dated note drawn over a cost chart — "we migrated to
 * Graviton here". Reads are `costs:read` and writes are `costs:write`, the same
 * permissions cost reports use, because a note about spend is cost data with
 * words on it rather than dashboard furniture.
 *
 * The logic lives in services/cost-annotations.ts; this file is transport only.
 */
import { Hono } from "hono";

import { costAnnotationInputSchema } from "@infrawrench/ui/cost/config";
import {
  CostAnnotationError,
  createCostAnnotation,
  deleteCostAnnotation,
  listCostAnnotations,
  updateCostAnnotation,
} from "../../services/cost-annotations";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/cost-annotations[?reportId=…]
 *
 * With `reportId`, the set a chart for that report draws: the org-wide notes
 * plus that report's own. Without it, every annotation in the org.
 */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  const reportId = c.req.query("reportId");
  const annotations = await listCostAnnotations(c.get("organizationId"), {
    ...(reportId ? { reportId } : {}),
  });
  return c.json({ annotations });
});

/** POST /api/org/:orgId/cost-annotations — create a note. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costAnnotationInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid annotation", issues: parsed.error.issues }, 400);
  }

  try {
    const created = await createCostAnnotation(organizationId, parsed.data, session.userId ?? null);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_annotation.create",
      entityType: "cost_annotation",
      entityId: created.id,
      metadata: {
        startDate: created.startDate,
        endDate: created.endDate,
        costReportId: created.costReportId,
      },
    });
    return c.json(created);
  } catch (e) {
    // A backwards span, an over-long note, or a report id from another org.
    if (e instanceof CostAnnotationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** PUT /api/org/:orgId/cost-annotations/:id — replace date, span, text, scope. */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costAnnotationInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid annotation", issues: parsed.error.issues }, 400);
  }

  try {
    const updated = await updateCostAnnotation(organizationId, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_annotation.update",
      entityType: "cost_annotation",
      entityId: updated.id,
      metadata: {
        startDate: updated.startDate,
        endDate: updated.endDate,
        costReportId: updated.costReportId,
      },
    });
    return c.json(updated);
  } catch (e) {
    if (e instanceof CostAnnotationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** DELETE /api/org/:orgId/cost-annotations/:id — hard delete. */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const annotationId = c.req.param("id");

  const deleted = await deleteCostAnnotation(organizationId, annotationId);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_annotation.delete",
    entityType: "cost_annotation",
    entityId: annotationId,
    metadata: {},
  });
  return c.json({ ok: true });
});

export { app as costAnnotationRoutes };
