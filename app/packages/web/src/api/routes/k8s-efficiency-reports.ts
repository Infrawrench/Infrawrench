/**
 * HTTP API for Kubernetes efficiency reports (org-scoped, mounted at
 * /api/org/:orgId/k8s-efficiency-reports).
 *
 * CRUD, `POST /query` (an unsaved config, for the editor's preview),
 * `POST /:id/run`, `GET /:id/export` (CSV or NDJSON, optionally per period)
 * and the pickers' options. Reads are `costs:read` and writes `costs:write`,
 * like cost reports: a report is cost data under a name. Every read runs under
 * the caller's cost visibility scope, which the org middleware establishes.
 * The logic lives in services/k8s-efficiency-reports.ts; this file is
 * transport only.
 */
import {
  kubernetesEfficiencyCsv,
  kubernetesEfficiencyExportRecords,
} from "@infrawrench/client-core";
import {
  kubernetesEfficiencyQuerySchema,
  kubernetesEfficiencyReportInputSchema,
} from "@infrawrench/ui/cost/config";
import { Hono } from "hono";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { CostReportFolderError } from "../../services/cost-report-folders";
import {
  createKubernetesEfficiencyReport,
  getKubernetesEfficiencyOptions,
  getKubernetesEfficiencyReport,
  getKubernetesEfficiencyTagValues,
  listKubernetesEfficiencyReports,
  queryKubernetesEfficiency,
  runKubernetesEfficiencyReport,
  softDeleteKubernetesEfficiencyReport,
  updateKubernetesEfficiencyReport,
} from "../../services/k8s-efficiency-reports";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /k8s-efficiency-reports: the reports the caller may open. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listKubernetesEfficiencyReports(c.get("organizationId")));
});

/** POST /k8s-efficiency-reports: create one. */
app.post("/", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = kubernetesEfficiencyReportInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid efficiency report", issues: parsed.error.issues }, 400);
  }
  try {
    const created = await createKubernetesEfficiencyReport(
      organizationId,
      parsed.data,
      session.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "kubernetes_efficiency_report.create",
      entityType: "kubernetes_efficiency_report",
      entityId: created.id,
      metadata: { name: created.name },
    });
    return c.json(created);
  } catch (e) {
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** GET /k8s-efficiency-reports/options: clusters, regions, namespaces, pools, label keys. */
app.get("/options", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await getKubernetesEfficiencyOptions(c.get("organizationId")));
});

/** GET /k8s-efficiency-reports/values?tagKey=…: values of one label on Kubernetes rows. */
app.get("/values", async (c) => {
  requirePermission(c, "costs:read");
  const tagKey = c.req.query("tagKey")?.trim();
  if (!tagKey) return c.json({ error: "tagKey is required" }, 400);
  return c.json({
    values: await getKubernetesEfficiencyTagValues(c.get("organizationId"), tagKey),
  });
});

/** POST /k8s-efficiency-reports/query: run an unsaved config (the editor preview). */
app.post("/query", async (c) => {
  requirePermission(c, "costs:read");
  const parsed = kubernetesEfficiencyQuerySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid efficiency query", issues: parsed.error.issues }, 400);
  }
  return c.json(await queryKubernetesEfficiency(c.get("organizationId"), parsed.data.config));
});

/** GET /k8s-efficiency-reports/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const report = await getKubernetesEfficiencyReport(c.get("organizationId"), c.req.param("id"));
  if (!report) return c.json({ error: "Not found" }, 404);
  return c.json(report);
});

/** PUT /k8s-efficiency-reports/:id: replace name, description, config and folder. */
app.put("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = kubernetesEfficiencyReportInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid efficiency report", issues: parsed.error.issues }, 400);
  }
  try {
    const updated = await updateKubernetesEfficiencyReport(
      organizationId,
      c.req.param("id"),
      parsed.data,
    );
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "kubernetes_efficiency_report.update",
      entityType: "kubernetes_efficiency_report",
      entityId: updated.id,
      metadata: { name: updated.name },
    });
    return c.json(updated);
  } catch (e) {
    if (e instanceof CostReportFolderError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** DELETE /k8s-efficiency-reports/:id: soft delete, with its sharing. */
app.delete("/:id", async (c) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const reportId = c.req.param("id");
  if (!(await softDeleteKubernetesEfficiencyReport(organizationId, reportId))) {
    return c.json({ error: "Not found" }, 404);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "kubernetes_efficiency_report.delete",
    entityType: "kubernetes_efficiency_report",
    entityId: reportId,
    metadata: {},
  });
  return c.json({ ok: true });
});

/** POST /k8s-efficiency-reports/:id/run: execute a saved report. */
app.post("/:id/run", async (c) => {
  requirePermission(c, "costs:read");
  const result = await runKubernetesEfficiencyReport(c.get("organizationId"), c.req.param("id"));
  if (!result) return c.json({ error: "Not found" }, 404);
  return c.json(result);
});

/**
 * GET /k8s-efficiency-reports/:id/export?format=csv|ndjson&perPeriod=true
 *
 * The report as a file: one record per row and cost category plus the totals,
 * and with `perPeriod` each row's figures per bucket as well. NDJSON is one
 * record per line, for loading into a warehouse or a notebook.
 */
app.get("/:id/export", async (c) => {
  requirePermission(c, "costs:read");
  const format = c.req.query("format") ?? "csv";
  if (format !== "csv" && format !== "ndjson") {
    return c.json({ error: "format must be csv or ndjson" }, 400);
  }
  const perPeriod = c.req.query("perPeriod") === "true" || c.req.query("perPeriod") === "1";
  const run = await runKubernetesEfficiencyReport(c.get("organizationId"), c.req.param("id"));
  if (!run) return c.json({ error: "Not found" }, 404);
  const slug =
    run.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "efficiency";
  const filename = `${slug}-${run.result.from}-${run.result.to}.${format === "csv" ? "csv" : "ndjson"}`;
  const body =
    format === "csv"
      ? kubernetesEfficiencyCsv(run.result, { perPeriod })
      : kubernetesEfficiencyExportRecords(run.result, { perPeriod })
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n";
  return c.body(body, 200, {
    "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
});

export { app as kubernetesEfficiencyReportRoutes };
