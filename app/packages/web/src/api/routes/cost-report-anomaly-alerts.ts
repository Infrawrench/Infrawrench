/**
 * Anomaly alerts scoped to one cost report: `/cost-reports/:id/anomaly-alert`
 * (one per report) and the org-wide list at `/cost-report-anomaly-alerts`.
 *
 * ## Permissions
 *
 * Reads are `costs:read` plus viewer access to the report through object
 * sharing (an invisible report reads as not found), like the report itself.
 *
 * Writes are `org:settings:write`, the report-schedule stance and for the same
 * reason: an alert is standing authorisation to send this scope's spend to
 * destinations the writer picks, including arbitrary email addresses, so the
 * stricter case pins the permission rather than letting it depend on the body.
 * The destination catalog (`/targets`) is `org:settings:write` too: it lists
 * the org's channels, rotations and members, which is editor furniture.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  costReportAnomalyAlertProblem,
  type AlertDestination,
  type CostReportAnomalyAlertInput,
} from "@infrawrench/client-core";
import {
  ReportAnomalyAlertError,
  deleteReportAnomalyAlert,
  getReportAnomalyAlert,
  listReportAnomalyAlerts,
  upsertReportAnomalyAlert,
} from "@infrawrench/server-core/cost/report-anomaly-alerts";
import {
  canonicalDestination,
  destinationShapeError,
  foreignDestinationError,
  loadDestinationCatalog,
  loadOwnedDestinations,
} from "@infrawrench/server-core/alerts/destinations";
import { requirePermission } from "../../auth/permissions";
import { visibilityUserIdForRequest } from "../../auth/cost-visibility";
import { getCostReport } from "../../services/cost-reports";
import { filterVisibleObjects } from "../../services/object-sharing";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/** Shape only; `costReportAnomalyAlertProblem` and the destination checks judge it. */
const inputSchema = z.object({
  enabled: z.boolean(),
  sigmas: z.number(),
  minDeltaCents: z.number(),
  destinations: z.array(z.object({ kind: z.string() }).passthrough()).max(50),
});

/** 404 unless the caller can see the report (deleted and unshared read the same). */
async function requireReport(c: Context): Promise<{ id: string; name: string } | Response> {
  const report = await getCostReport(c.get("organizationId"), c.req.param("id") ?? "");
  if (!report) return c.json({ error: "Cost report not found" }, 404);
  return report;
}

/** Report-scoped routes, mounted under `/cost-reports`. */
const reportApp = new Hono();

/** GET /cost-reports/:id/anomaly-alert: the alert and its recent findings. */
reportApp.get("/:id/anomaly-alert", async (c) => {
  requirePermission(c, "costs:read");
  const report = await requireReport(c);
  if (report instanceof Response) return report;
  const alert = await getReportAnomalyAlert(c.get("organizationId"), report.id);
  if (!alert) return c.json({ error: "This report has no anomaly alert" }, 404);
  return c.json(alert);
});

/** GET /cost-reports/:id/anomaly-alert/targets: what the destination picker offers. */
reportApp.get("/:id/anomaly-alert/targets", async (c) => {
  requirePermission(c, "org:settings:write");
  const report = await requireReport(c);
  if (report instanceof Response) return report;
  return c.json(await loadDestinationCatalog(c.get("organizationId")));
});

/** PUT /cost-reports/:id/anomaly-alert: create or replace the report's alert. */
reportApp.put("/:id/anomaly-alert", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const report = await requireReport(c);
  if (report instanceof Response) return report;

  const parsed = inputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid anomaly alert", issues: parsed.error.issues }, 400);
  }
  const destinations = parsed.data.destinations as unknown as AlertDestination[];
  for (const d of destinations) {
    const shape = destinationShapeError(d, "destination");
    if (shape) return c.json({ error: shape }, 400);
  }
  const input: CostReportAnomalyAlertInput = {
    enabled: parsed.data.enabled,
    sigmas: parsed.data.sigmas,
    minDeltaCents: parsed.data.minDeltaCents,
    destinations: destinations.map(canonicalDestination),
  };
  const problem = costReportAnomalyAlertProblem(input);
  if (problem) return c.json({ error: problem }, 400);
  const foreign = foreignDestinationError(
    await loadOwnedDestinations(organizationId),
    input.destinations,
  );
  if (foreign) return c.json({ error: foreign }, 400);

  try {
    const saved = await upsertReportAnomalyAlert(organizationId, report.id, input, {
      userId: session.userId,
      visibilityUserId: visibilityUserIdForRequest(c),
    });
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_report_anomaly_alert.upsert",
      entityType: "cost_report",
      entityId: report.id,
      metadata: {
        reportName: report.name,
        enabled: saved.enabled,
        sigmas: saved.sigmas,
        minDeltaCents: saved.minDeltaCents,
        destinations: saved.destinations.map((d) => d.kind),
      },
    });
    return c.json(saved);
  } catch (e) {
    if (e instanceof ReportAnomalyAlertError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

/** DELETE /cost-reports/:id/anomaly-alert: remove the alert and its findings. */
reportApp.delete("/:id/anomaly-alert", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const report = await requireReport(c);
  if (report instanceof Response) return report;
  const deleted = await deleteReportAnomalyAlert(organizationId, report.id);
  if (!deleted) return c.json({ error: "This report has no anomaly alert" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "cost_report_anomaly_alert.delete",
    entityType: "cost_report",
    entityId: report.id,
    metadata: { reportName: report.name },
  });
  return c.json({ ok: true });
});

/** Org-wide list, mounted at `/cost-report-anomaly-alerts`. */
const orgApp = new Hono();

/**
 * GET /cost-report-anomaly-alerts: every report alert the caller can see (the
 * report's sharing decides), report name order. For the CLI and anyone
 * auditing which scopes page whom.
 */
orgApp.get("/", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const all = await listReportAnomalyAlerts(organizationId);
  const visible = await filterVisibleObjects(
    organizationId,
    "cost_report",
    all,
    (a) => a.reportId,
    (a) => ({ createdByUserId: a.reportCreatedByUserId, folderId: a.reportFolderId }),
  );
  return c.json({
    alerts: visible.map(({ reportCreatedByUserId: _c, reportFolderId: _f, ...alert }) => alert),
  });
});

export { reportApp as costReportAnomalyAlertRoutes, orgApp as orgReportAnomalyAlertRoutes };
