/**
 * Scheduled delivery of saved cost reports (org-scoped; the per-report routes
 * mount under `/api/org/:orgId/cost-reports`, the org-wide list under
 * `/api/org/:orgId/cost-report-notifications`).
 *
 * A schedule is a `report_notifications` row: cadence + local hour + IANA
 * zone, plus the destinations it delivers to. The logic lives in
 * `server-core/src/report-delivery/*` so the poller drives exactly the same
 * code; this file is transport only. It follows the **digest pattern, not
 * alert routing** — see `server-core/src/report-delivery/compose.ts`.
 *
 * ## Permissions
 *
 * Reads are `costs:read`, matching every other cost surface — that is what
 * lets the mobile app show a report's schedules read-only.
 *
 * Writes (and "Send now") are **`org:settings:write`, not `costs:write`**, the
 * same deliberate step up `cost-exports` took, and for the same reason: a
 * schedule is standing authorisation to ship the org's spend, recurringly, to
 * destinations the creator picks. Slack channels and Teams webhooks are
 * org-approved surfaces an admin already connected — on their own they could
 * arguably ride on `costs:write` — but the email list is arbitrary-address
 * egress, exactly like an export destination. Splitting the permission by
 * transport would make the required scope depend on the request body, and a
 * `costs:write` schedule that later *gained* an email address would be a
 * silent escalation; one route, one permission, pinned to the stricter case.
 * The targets listing is also `org:settings:write`: it enumerates the org's
 * connected channels and webhooks, which is editor furniture, not cost data.
 */
import { Hono } from "hono";

import type { ReportNotificationInput } from "@infrawrench/client-core";
import {
  ReportNotificationInputError,
  createReportNotification,
  deleteReportNotification,
  listOrgReportNotifications,
  listReportDeliveryTargets,
  listReportNotifications,
  updateReportNotification,
} from "@infrawrench/server-core/report-delivery/store";
import { sendReportNotificationNow } from "@infrawrench/server-core/report-delivery/deliver";
import { logAudit } from "../../services/audit";
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

const app = new Hono();

/** GET /cost-reports/:id/notifications — one report's delivery schedules. */
app.get("/:id/notifications", async (c) => {
  requirePermission(c, "costs:read");
  try {
    return c.json(await listReportNotifications(c.get("organizationId"), c.req.param("id")));
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

/**
 * GET /cost-reports/:id/notifications/targets — what a schedule can deliver
 * to: the org's live Slack channels, its Teams webhooks, and whether this
 * deployment can send mail. Backs the schedule editor's pickers.
 */
app.get("/:id/notifications/targets", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(await listReportDeliveryTargets(c.get("organizationId")));
});

/** POST /cost-reports/:id/notifications — create a schedule. */
app.post("/:id/notifications", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const reportId = c.req.param("id");

  try {
    const input = (await c.req.json()) as ReportNotificationInput;
    const created = await createReportNotification(
      organizationId,
      reportId,
      input,
      session.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "report_notification.create",
      entityType: "report_notification",
      entityId: created.id,
      metadata: {
        reportId,
        cadence: created.cadence,
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

/** PUT /cost-reports/:id/notifications/:notificationId — replace a schedule. */
app.put("/:id/notifications/:notificationId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const reportId = c.req.param("id");
  const notificationId = c.req.param("notificationId");

  try {
    const input = (await c.req.json()) as ReportNotificationInput;
    const updated = await updateReportNotification(organizationId, reportId, notificationId, input);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "report_notification.update",
      entityType: "report_notification",
      entityId: updated.id,
      metadata: {
        reportId,
        cadence: updated.cadence,
        enabled: updated.enabled,
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

/** DELETE /cost-reports/:id/notifications/:notificationId */
app.delete("/:id/notifications/:notificationId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const reportId = c.req.param("id");
  const notificationId = c.req.param("notificationId");

  try {
    await deleteReportNotification(organizationId, reportId, notificationId);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "report_notification.delete",
    entityType: "report_notification",
    entityId: notificationId,
    metadata: { reportId },
  });
  return c.json({ ok: true });
});

/**
 * POST /cost-reports/:id/notifications/:notificationId/send — run the report
 * and deliver it to this schedule's destinations right now, ignoring the
 * schedule. Errors are 400s with the reason — the caller is a person clicking
 * "Send now" who needs to see why nothing arrived.
 */
app.post("/:id/notifications/:notificationId/send", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const reportId = c.req.param("id");
  const notificationId = c.req.param("notificationId");

  try {
    const result = await sendReportNotificationNow(organizationId, reportId, notificationId);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "report_notification.send",
      entityType: "report_notification",
      entityId: notificationId,
      metadata: { reportId, attempted: result.attempted, succeeded: result.succeeded },
    });
    return c.json(result);
  } catch (e) {
    const err = asError(e);
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

export { app as costReportNotificationRoutes };

/**
 * The org-wide schedules list, mounted at `/cost-report-notifications` rather
 * than under `/cost-reports` so it cannot collide with the `/:id` route there.
 * One call for the CLI's schedules column instead of a request per report.
 */
const orgApp = new Hono();

orgApp.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listOrgReportNotifications(c.get("organizationId")));
});

export { orgApp as orgReportNotificationRoutes };
