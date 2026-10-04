/**
 * PDF export of dashboards and cost reports, and scheduled dashboard delivery.
 *
 * - `GET /dashboards/:id/pdf` and `GET /cost-reports/:id/pdf` render the
 *   document server-side (`services/dashboard-pdf.ts`) and stream it back as
 *   an attachment. Rendering here rather than in each client is what lets the
 *   same document go out on a schedule, and gives web, desktop, mobile and the
 *   CLI one picture.
 * - `/dashboards/:id/notifications…` mirror the report-notification routes
 *   exactly (same permissions, same validation, same table); the logic lives
 *   in `server-core/src/report-delivery/dashboard.ts`.
 *
 * ## Permissions
 *
 * The dashboard PDF and the schedule list are `dashboards:read`, matching the
 * dashboard itself; cost cards in the PDF additionally need `costs:read`, and
 * are replaced by a note without it, as they fail to load on screen. The
 * report PDF is `costs:read`, like running the report. Schedule writes, the
 * targets listing and "Send now" are `org:settings:write`, for the reason
 * `cost-report-notifications.ts` gives: a schedule is standing authorisation
 * to ship the org's spend to arbitrary addresses.
 */
import { Hono, type Context } from "hono";

import { pdfFileName, type DashboardNotificationInput } from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  ReportNotificationInputError,
  listReportDeliveryTargets,
} from "@infrawrench/server-core/report-delivery/store";
import {
  createDashboardNotification,
  deleteDashboardNotification,
  listDashboardNotifications,
  listOrgDashboardNotifications,
  requireLiveDashboard,
  sendDashboardNotificationNow,
  updateDashboardNotification,
} from "@infrawrench/server-core/report-delivery/dashboard";
import { attachmentDisposition } from "../../lib/content-disposition";
import { logAudit } from "../../services/audit";
import {
  renderCostReportPdf,
  renderDashboardForDelivery,
  renderDashboardPdf,
} from "../../services/dashboard-pdf";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

function asError(e: unknown): { message: string; status: 400 | 404 } | null {
  if (e instanceof ReportNotificationInputError) {
    return { message: e.message, status: e.status };
  }
  return null;
}

/** A validated IANA zone from `?tz=`, for the "generated at" line. */
function requestTimezone(c: Context): string | undefined {
  const tz = c.req.query("tz");
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function pdfResponse(c: Context, name: string, pdf: Uint8Array, fallback: string): Response {
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": attachmentDisposition(pdfFileName(name, fallback)),
      "Content-Length": String(pdf.byteLength),
      // Spend figures: never let a shared cache keep a copy.
      "Cache-Control": "private, no-store",
    },
  });
}

const app = new Hono();

/** GET /dashboards/:id/pdf: the dashboard, every card, as a PDF. */
app.get("/:id/pdf", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");
  const granted = (c.get("permissions") as string[] | undefined) ?? [];
  const rendered = await renderDashboardPdf(organizationId, c.req.param("id"), {
    canReadCosts: hasPermission(granted, "costs:read"),
    timezone: requestTimezone(c),
  });
  if (!rendered) return c.json({ error: "Dashboard not found" }, 404);
  return pdfResponse(c, rendered.name, rendered.pdf, "dashboard");
});

/** GET /dashboards/:id/notifications: one dashboard's delivery schedules. */
app.get("/:id/notifications", async (c) => {
  requirePermission(c, "dashboards:read");
  try {
    return c.json(await listDashboardNotifications(c.get("organizationId"), c.req.param("id")));
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/** GET /dashboards/:id/notifications/targets: the schedule editor's pickers. */
app.get("/:id/notifications/targets", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    await requireLiveDashboard(organizationId, c.req.param("id"));
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
  return c.json(await listReportDeliveryTargets(organizationId));
});

/** POST /dashboards/:id/notifications: create a schedule. */
app.post("/:id/notifications", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const dashboardId = c.req.param("id");
  try {
    const input = (await c.req.json()) as DashboardNotificationInput;
    const created = await createDashboardNotification(
      organizationId,
      dashboardId,
      input,
      session.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "dashboard_notification.create",
      entityType: "dashboard_notification",
      entityId: created.id,
      metadata: {
        dashboardId,
        cadence: created.cadence,
        attachPdf: created.attachPdf,
        slackChannels: created.slackChannelIds.length,
        teamsWebhooks: created.teamsWebhookIds.length,
        emailRecipients: created.emailRecipients.length,
      },
    });
    return c.json(created);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/** PUT /dashboards/:id/notifications/:notificationId: replace a schedule. */
app.put("/:id/notifications/:notificationId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const dashboardId = c.req.param("id");
  const notificationId = c.req.param("notificationId");
  try {
    const input = (await c.req.json()) as DashboardNotificationInput;
    const updated = await updateDashboardNotification(
      organizationId,
      dashboardId,
      notificationId,
      input,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "dashboard_notification.update",
      entityType: "dashboard_notification",
      entityId: updated.id,
      metadata: {
        dashboardId,
        cadence: updated.cadence,
        enabled: updated.enabled,
        attachPdf: updated.attachPdf,
        slackChannels: updated.slackChannelIds.length,
        teamsWebhooks: updated.teamsWebhookIds.length,
        emailRecipients: updated.emailRecipients.length,
      },
    });
    return c.json(updated);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/** DELETE /dashboards/:id/notifications/:notificationId */
app.delete("/:id/notifications/:notificationId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const dashboardId = c.req.param("id");
  const notificationId = c.req.param("notificationId");
  try {
    await deleteDashboardNotification(organizationId, dashboardId, notificationId);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "dashboard_notification.delete",
    entityType: "dashboard_notification",
    entityId: notificationId,
    metadata: { dashboardId },
  });
  return c.json({ ok: true });
});

/** POST /dashboards/:id/notifications/:notificationId/send: deliver it now. */
app.post("/:id/notifications/:notificationId/send", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const dashboardId = c.req.param("id");
  const notificationId = c.req.param("notificationId");
  try {
    const result = await sendDashboardNotificationNow(
      organizationId,
      dashboardId,
      notificationId,
      renderDashboardForDelivery,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "dashboard_notification.send",
      entityType: "dashboard_notification",
      entityId: notificationId,
      metadata: {
        dashboardId,
        attempted: result.attempted,
        succeeded: result.succeeded,
        pdfAttached: result.pdfAttached,
      },
    });
    return c.json(result);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

export { app as dashboardNotificationRoutes };

/** The org-wide schedules list, on its own prefix (the report precedent). */
const orgApp = new Hono();

orgApp.get("/", async (c) => {
  requirePermission(c, "dashboards:read");
  return c.json(await listOrgDashboardNotifications(c.get("organizationId")));
});

export { orgApp as orgDashboardNotificationRoutes };

/** GET /cost-reports/:id/pdf: one saved report as a PDF. */
const reportPdfApp = new Hono();

reportPdfApp.get("/:id/pdf", async (c) => {
  requirePermission(c, "costs:read");
  const rendered = await renderCostReportPdf(c.get("organizationId"), c.req.param("id"), {
    timezone: requestTimezone(c),
  });
  if (!rendered) return c.json({ error: "Report not found" }, 404);
  return pdfResponse(c, rendered.name, rendered.pdf, "cost-report");
});

export { reportPdfApp as costReportPdfRoutes };
