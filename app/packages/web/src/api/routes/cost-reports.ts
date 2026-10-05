/**
 * HTTP API for cost reports (org-scoped, mounted at /api/org/:orgId/cost-reports).
 *
 * A report is a named, saved cost graph: the object dashboards reference by id
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

import {
  costReportBulkRequestSchema,
  costReportInputSchema,
  costReportRunOverridesSchema,
} from "@infrawrench/ui/cost/config";
import {
  createCostReport,
  getCostReport,
  listCostReports,
  runCostReport,
  softDeleteCostReport,
  updateCostReport,
} from "../../services/cost-reports";
import { CostQueryError } from "../../services/cost-query";
import { CostReportFolderError } from "../../services/cost-report-folders";
import { logAudit } from "../../services/audit";
import { applyCostReportBulk, CostReportBulkError } from "../../services/cost-reports-bulk";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/org/:orgId/cost-reports: list reports with dashboard placements. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listCostReports(c.get("organizationId")));
});

/** POST /api/org/:orgId/cost-reports: create a report. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costReportInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost report", issues: parsed.error.issues }, 400);
  }

  try {
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
  } catch (e) {
    // A folderId outside the org (or stale) is a bad request, not a server bug.
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * POST /api/org/:orgId/cost-reports/bulk: move or delete many reports and
 * folders at once, all or nothing.
 *
 * Every item is checked (exists, the caller's sharing allows it, the folder
 * tree that would result stays within the nesting limit) before anything is
 * written; any problem is a 400 whose `problems` names each blocking item, and
 * nothing changes. Audit rows are one per item, as the single-item routes
 * write them, with `bulk: true` in the metadata.
 */
app.post("/bulk", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costReportBulkRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid bulk request", issues: parsed.error.issues }, 400);
  }
  try {
    return c.json(await applyCostReportBulk(organizationId, parsed.data, session.userId ?? null));
  } catch (e) {
    if (e instanceof CostReportBulkError) {
      return c.json({ error: e.message, problems: e.problems }, 400);
    }
    throw e;
  }
});

/** GET /api/org/:orgId/cost-reports/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const report = await getCostReport(c.get("organizationId"), c.req.param("id"));
  if (!report) return c.json({ error: "Not found" }, 404);
  return c.json(report);
});

/** PUT /api/org/:orgId/cost-reports/:id: replace name, description, config. */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = costReportInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost report", issues: parsed.error.issues }, 400);
  }

  try {
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
  } catch (e) {
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * DELETE /api/org/:orgId/cost-reports/:id: soft delete.
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
 * POST /api/org/:orgId/cost-reports/:id/run: execute the report and return the
 * series, with the window its relative preset resolved to.
 *
 * A read despite the method: nothing is written; POST is only because this is
 * a query execution, like `POST /costs/query`. The body is optional and may
 * carry one-off display overrides (measure, unit, bin, cumulative) for this run.
 */
app.post("/:id/run", async (c) => {
  requirePermission(c, "costs:read");
  // An empty or absent body is the ordinary case: run the report as saved.
  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
  }
  const overrides = costReportRunOverridesSchema.safeParse(body);
  if (!overrides.success) {
    return c.json({ error: "Invalid overrides", issues: overrides.error.issues }, 400);
  }
  try {
    const result = await runCostReport(
      c.get("organizationId"),
      c.req.param("id"),
      new Date(),
      overrides.data,
    );
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  } catch (e) {
    if (e instanceof CostQueryError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

export { app as costReportRoutes };
