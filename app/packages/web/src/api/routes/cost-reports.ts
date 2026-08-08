/**
 * HTTP API for cost reports (org-scoped, mounted at /api/org/:orgId/cost-reports).
 *
 * A report is a named, saved cost graph — the object dashboards reference by id
 * through the `cost_report` widget kind. CRUD plus `POST /:id/run`, which
 * executes the report server-side so a caller never has to reassemble its
 * config to get the numbers.
 *
 * Reads are `costs:read` and writes are `costs:write`: a report is cost data
 * under a name, not dashboard furniture, so it follows the cost permissions
 * rather than the dashboard ones. The logic lives in services/cost-reports.ts
 * so the MCP/chat tools drive exactly the same code path; this file is
 * transport only.
 */
import { Hono } from "hono";

import { costReportInputSchema } from "@infrawrench/ui/cost/config";
import {
  createCostReport,
  getCostReport,
  listCostReports,
  runCostReport,
  softDeleteCostReport,
  updateCostReport,
} from "../../services/cost-reports";
import { CostQueryError } from "../../services/cost-query";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/org/:orgId/cost-reports — list reports with dashboard placements. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listCostReports(c.get("organizationId")));
});

/** POST /api/org/:orgId/cost-reports — create a report. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costReportInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost report", issues: parsed.error.issues }, 400);
  }

  const created = await createCostReport(organizationId, parsed.data, session.userId ?? null);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_report.create",
    entityType: "cost_report",
    entityId: created.id,
    metadata: { name: created.name },
  });
  return c.json(created);
});

/** GET /api/org/:orgId/cost-reports/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const report = await getCostReport(c.get("organizationId"), c.req.param("id"));
  if (!report) return c.json({ error: "Not found" }, 404);
  return c.json(report);
});

/** PUT /api/org/:orgId/cost-reports/:id — replace name, description, config. */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costReportInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost report", issues: parsed.error.issues }, 400);
  }

  const updated = await updateCostReport(organizationId, c.req.param("id"), parsed.data);
  if (!updated) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_report.update",
    entityType: "cost_report",
    entityId: updated.id,
    metadata: { name: updated.name },
  });
  return c.json(updated);
});

/**
 * DELETE /api/org/:orgId/cost-reports/:id — soft delete.
 *
 * Every dashboard card pointing at the report goes with it; see
 * `softDeleteCostReport` for why a card cannot be left behind.
 */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const reportId = c.req.param("id");

  const deleted = await softDeleteCostReport(organizationId, reportId);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_report.delete",
    entityType: "cost_report",
    entityId: reportId,
    metadata: {},
  });
  return c.json({ ok: true });
});

/**
 * POST /api/org/:orgId/cost-reports/:id/run — execute the report and return the
 * series, with the window its relative preset resolved to.
 *
 * A read despite the method: there is no body and nothing is written; POST is
 * only because this is a query execution, like `POST /costs/query`.
 */
app.post("/:id/run", async (c) => {
  requirePermission(c, "costs:read");
  try {
    const result = await runCostReport(c.get("organizationId"), c.req.param("id"));
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  } catch (e) {
    if (e instanceof CostQueryError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

export { app as costReportRoutes };
