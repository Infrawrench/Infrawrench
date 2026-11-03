/**
 * Commitments (org-scoped, mounted at /api/org/:orgId/commitments).
 *
 * Reserved instances, savings plans and committed-use discounts: the
 * holdings themselves, coverage of usage spend (as a range; there is no
 * single honest denominator), derived utilization, and the savings planner's
 * recommendations. The holdings side is read-only, and deliberately so: this
 * API describes and recommends, it never purchases.
 *
 * Saved commitment reports live here too (`/reports`, `/report-query`,
 * `/report-options`): coverage, utilization, savings and commitment cost over
 * time. CRUD follows the cost reports' rules (folders, sharing, soft delete);
 * the logic is in `services/commitment-reports.ts`, the scan in server-core,
 * the metric definitions in client-core.
 *
 * Gated on `costs:read` / `costs:write`: a commitment is spend information,
 * and the permission that governs "what is this costing us" governs "what did
 * we commit to spending".
 */
import { Hono, type Context } from "hono";
import {
  normalizeCommitmentReportConfig,
  normalizeCommitmentReportInput,
} from "@infrawrench/client-core";

import { getCommitmentsFeed } from "@infrawrench/server-core/commitments/feed";
import {
  CommitmentReportError,
  getCommitmentReportOptions,
  runCommitmentReportConfig,
} from "@infrawrench/server-core/commitments/report";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import {
  createCommitmentReport,
  getCommitmentReport,
  listCommitmentReports,
  runCommitmentReport,
  softDeleteCommitmentReport,
  updateCommitmentReport,
} from "../../services/commitment-reports";
import { CostReportFolderError } from "../../services/cost-report-folders";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /: holdings, coverage range, utilization, and recommendations. */
app.get("/", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json(await getCommitmentsFeed(c.get("organizationId") as string));
});

async function readJson(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

/** GET /report-options: picker values for the report editor. */
app.get("/report-options", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await getCommitmentReportOptions(c.get("organizationId")));
});

/**
 * POST /report-query: run an unsaved config (the editor's preview, and the
 * CLI's ad-hoc flags). A read despite the method, like `/costs/query`.
 */
app.post("/report-query", async (c) => {
  requirePermission(c, "costs:read");
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = normalizeCommitmentReportConfig(json.body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    return c.json(await runCommitmentReportConfig(c.get("organizationId"), parsed.value));
  } catch (e) {
    if (e instanceof CommitmentReportError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** GET /reports: saved reports the caller may open. */
app.get("/reports", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listCommitmentReports(c.get("organizationId")));
});

/** POST /reports: create a saved report. */
app.post("/reports", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = normalizeCommitmentReportInput(json.body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const created = await createCommitmentReport(
      organizationId,
      parsed.value,
      session.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "commitment_report.create",
      entityType: "commitment_report",
      entityId: created.id,
      metadata: { name: created.name },
    });
    return c.json(created);
  } catch (e) {
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** GET /reports/:id */
app.get("/reports/:id", async (c) => {
  requirePermission(c, "costs:read");
  const report = await getCommitmentReport(c.get("organizationId"), c.req.param("id"));
  if (!report) return c.json({ error: "Not found" }, 404);
  return c.json(report);
});

/** PUT /reports/:id: replace name, description, config and folder. */
app.put("/reports/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = normalizeCommitmentReportInput(json.body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const updated = await updateCommitmentReport(organizationId, c.req.param("id"), parsed.value);
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "commitment_report.update",
      entityType: "commitment_report",
      entityId: updated.id,
      metadata: { name: updated.name },
    });
    return c.json(updated);
  } catch (e) {
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** DELETE /reports/:id: soft delete. */
app.delete("/reports/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const reportId = c.req.param("id");
  if (!(await softDeleteCommitmentReport(organizationId, reportId))) {
    return c.json({ error: "Not found" }, 404);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "commitment_report.delete",
    entityType: "commitment_report",
    entityId: reportId,
    metadata: {},
  });
  return c.json({ ok: true });
});

/** POST /reports/:id/run: execute a saved report. A read despite the method. */
app.post("/reports/:id/run", async (c) => {
  requirePermission(c, "costs:read");
  try {
    const result = await runCommitmentReport(c.get("organizationId"), c.req.param("id"));
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  } catch (e) {
    if (e instanceof CommitmentReportError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

export default app;
