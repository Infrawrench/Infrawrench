/**
 * PDF export of dashboards and cost reports, and scheduled dashboard
 * delivery, the handlers. Rendering lives in `services/dashboard-pdf.ts`; the
 * schedules in `server-core/src/report-delivery/dashboard.ts`, which "Send
 * now" hands this process's renderer.
 */
import { Effect, Layer, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { pdfFileName, type DashboardNotificationInput } from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { listReportDeliveryTargets } from "@infrawrench/server-core/report-delivery/store";
import {
  createDashboardNotification,
  deleteDashboardNotification,
  listDashboardNotifications,
  listOrgDashboardNotifications,
  requireLiveDashboard,
  sendDashboardNotificationNow,
  updateDashboardNotification,
} from "@infrawrench/server-core/report-delivery/dashboard";
import {
  DashboardNotification,
  DashboardNotificationsApi,
  DashboardNotificationSendResult,
  notFound,
  ok,
  ReportDeliveryTargets,
} from "@infrawrench/api-contract";
import { attachmentDisposition } from "../../../lib/content-disposition";
import { logAudit } from "../../../services/audit";
import {
  renderCostReportPdf,
  renderDashboardForDelivery,
  renderDashboardPdf,
} from "../../../services/dashboard-pdf";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { deliveryCall, readScheduleBody } from "../cost-report-notifications/delivery";

/** A validated IANA zone from `?tz=`, for the "generated at" line. */
function requestTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function pdfResponse(name: string, pdf: Uint8Array, fallback: string) {
  const bytes = new Uint8Array(pdf);
  return HttpServerResponse.uint8Array(bytes, {
    contentType: "application/pdf",
    headers: {
      "content-disposition": attachmentDisposition(pdfFileName(name, fallback)),
      "content-length": String(bytes.byteLength),
      // Spend figures: never let a shared cache keep a copy.
      "cache-control": "private, no-store",
    },
  });
}

const DashboardDeliveryHandlers = HttpApiBuilder.group(
  DashboardNotificationsApi,
  "dashboardDelivery",
  (handlers) =>
    handlers
      // The dashboard, every card, as a PDF.
      .handle("pdf", ({ params, query }) =>
        Effect.gen(function* () {
          const { organizationId, permissions } = yield* OrgPrincipal;
          const rendered = yield* legacy(() =>
            renderDashboardPdf(organizationId, params.id, {
              canReadCosts: hasPermission(permissions, "costs:read"),
              timezone: requestTimezone(query.tz),
            }),
          );
          if (!rendered) return yield* notFound("Dashboard not found");
          return pdfResponse(rendered.name, rendered.pdf, "dashboard");
        }),
      )
      .handle("list", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const schedules = yield* deliveryCall(() =>
            listDashboardNotifications(organizationId, params.id),
          );
          return yield* respond(Schema.Array(DashboardNotification))(schedules);
        }),
      )
      // The schedule editor's pickers, once the dashboard is known to exist.
      .handle("targets", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          yield* deliveryCall(() => requireLiveDashboard(organizationId, params.id));
          const targets = yield* legacy(() => listReportDeliveryTargets(organizationId));
          return yield* respond(ReportDeliveryTargets)(targets);
        }),
      )
      .handleRaw("create", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const input = yield* readScheduleBody<DashboardNotificationInput>(request);
          const created = yield* deliveryCall(() =>
            createDashboardNotification(organizationId, params.id, input, session.userId ?? null),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "dashboard_notification.create",
              entityType: "dashboard_notification",
              entityId: created.id,
              metadata: {
                dashboardId: params.id,
                cadence: created.cadence,
                attachPdf: created.attachPdf,
                slackChannels: created.slackChannelIds.length,
                teamsWebhooks: created.teamsWebhookIds.length,
                emailRecipients: created.emailRecipients.length,
              },
            }),
          );
          return yield* respond(DashboardNotification)(created);
        }),
      )
      .handleRaw("update", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const input = yield* readScheduleBody<DashboardNotificationInput>(request);
          const updated = yield* deliveryCall(() =>
            updateDashboardNotification(organizationId, params.id, params.notificationId, input),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "dashboard_notification.update",
              entityType: "dashboard_notification",
              entityId: updated.id,
              metadata: {
                dashboardId: params.id,
                cadence: updated.cadence,
                enabled: updated.enabled,
                attachPdf: updated.attachPdf,
                slackChannels: updated.slackChannelIds.length,
                teamsWebhooks: updated.teamsWebhookIds.length,
                emailRecipients: updated.emailRecipients.length,
              },
            }),
          );
          return yield* respond(DashboardNotification)(updated);
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          yield* deliveryCall(() =>
            deleteDashboardNotification(organizationId, params.id, params.notificationId),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "dashboard_notification.delete",
              entityType: "dashboard_notification",
              entityId: params.notificationId,
              metadata: { dashboardId: params.id },
            }),
          );
          return ok;
        }),
      )
      // Deliver it now, with this process's renderer.
      .handle("send", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const result = yield* deliveryCall(() =>
            sendDashboardNotificationNow(
              organizationId,
              params.id,
              params.notificationId,
              renderDashboardForDelivery,
            ),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "dashboard_notification.send",
              entityType: "dashboard_notification",
              entityId: params.notificationId,
              metadata: {
                dashboardId: params.id,
                attempted: result.attempted,
                succeeded: result.succeeded,
                pdfAttached: result.pdfAttached,
              },
            }),
          );
          return yield* respond(DashboardNotificationSendResult)(result);
        }),
      ),
);

const OrgDashboardNotificationsHandlers = HttpApiBuilder.group(
  DashboardNotificationsApi,
  "orgDashboardNotifications",
  (handlers) =>
    handlers.handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const schedules = yield* legacy(() => listOrgDashboardNotifications(organizationId));
        return yield* respond(Schema.Array(DashboardNotification))(schedules);
      }),
    ),
);

const CostReportPdfHandlers = HttpApiBuilder.group(
  DashboardNotificationsApi,
  "costReportPdf",
  (handlers) =>
    // One saved report as a PDF.
    handlers.handle("pdf", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rendered = yield* legacy(() =>
          renderCostReportPdf(organizationId, params.id, { timezone: requestTimezone(query.tz) }),
        );
        if (!rendered) return yield* notFound("Report not found");
        return pdfResponse(rendered.name, rendered.pdf, "cost-report");
      }),
    ),
);

export const dashboardNotificationsDomain = makeDomain(
  "dashboard-notifications",
  DashboardNotificationsApi,
  Layer.mergeAll(
    DashboardDeliveryHandlers,
    OrgDashboardNotificationsHandlers,
    CostReportPdfHandlers,
  ),
);
