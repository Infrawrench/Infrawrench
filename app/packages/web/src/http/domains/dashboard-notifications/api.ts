/**
 * PDF export of dashboards and cost reports, and scheduled dashboard
 * delivery, the endpoint definitions.
 *
 * - `GET /dashboards/:id/pdf` and `GET /cost-reports/:id/pdf` render the
 *   document server-side and send it back as an attachment, so the same
 *   document can go out on a schedule and every client gets one picture.
 * - `/dashboards/:id/notifications…` mirror the report schedules exactly
 *   (same permissions, same validation, same table), plus `attachPdf`.
 *
 * The dashboard PDF and the schedule lists are `dashboards:read`, like the
 * dashboard; cost cards in the PDF also need `costs:read` and are replaced by
 * a note without it. The report PDF is `costs:read`, like running the report.
 * Schedule writes, the targets listing and "Send now" are
 * `org:settings:write`: a schedule is standing authorisation to ship the
 * org's spend to arbitrary addresses.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../../schemas/common";
import {
  attachPdfDescription,
  DashboardNotificationInput,
  DashboardNotificationSendResult,
  DeliveryCadence,
  DeliveryLastStatus,
  PdfDocument as Pdf,
  ReportDeliveryTargets,
  TzQuery,
} from "../../schemas/report-delivery";

export { DashboardNotificationSendResult };

export const DashboardNotification = Schema.Struct({
  id: Uuid,
  dashboardId: Uuid,
  cadence: DeliveryCadence,
  sendDay: Schema.Int,
  sendDayOfMonth: Schema.Int,
  hour: Schema.Int,
  timezone: Schema.String,
  slackChannelIds: Schema.Array(Schema.String),
  teamsWebhookIds: Schema.Array(Schema.String),
  emailRecipients: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  attachPdf: Schema.Boolean.annotate({ description: attachPdfDescription }),
  nextSendAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the next scheduled send is due; null while disabled.",
  }),
  lastSentAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When a delivery last actually reached at least one destination.",
  }),
  lastStatus: Schema.NullOr(DeliveryLastStatus).annotate({
    description: "What the last attempt did. `partial` is never retried automatically.",
  }),
  lastError: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "DashboardNotification" });

const IdParams = { orgId: OrgId, id: Uuid } as const;
const ScheduleParams = { orgId: OrgId, id: Uuid, notificationId: Uuid } as const;

export class DashboardDeliveryGroup extends HttpApiGroup.make("dashboardDelivery")
  .add(
    HttpApiEndpoint.get("pdf", "/:id/pdf", {
      params: IdParams,
      query: TzQuery,
      success: Pdf,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Export a dashboard as a PDF")
      .annotate(
        OpenApi.Description,
        "Renders every card server-side: cost graphs and saved reports (chart plus a totals " +
          "table, converted to the org's display currency where configured), budgets (spend " +
          "against the amount, forecast and thresholds), custom graphs (including their KPI and " +
          "table forms) and pinned resources and workflows. Cost cards need `costs:read` as well " +
          "and are replaced by a note without it. A card that fails renders its error in place.",
      )
      .annotate(SuccessDescription, "The PDF, as an attachment"),
    HttpApiEndpoint.get("list", "/:id/notifications", {
      params: IdParams,
      success: Schema.Array(DashboardNotification),
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "List a dashboard's delivery schedules")
      .annotate(SuccessDescription, "Schedules"),
    HttpApiEndpoint.get("targets", "/:id/notifications/targets", {
      params: IdParams,
      success: ReportDeliveryTargets,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List the destinations a dashboard schedule can deliver to")
      .annotate(SuccessDescription, "Targets"),
    HttpApiEndpoint.post("create", "/:id/notifications", {
      params: IdParams,
      payload: DashboardNotificationInput,
      success: DashboardNotification,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create a dashboard delivery schedule")
      .annotate(
        OpenApi.Description,
        "On its cadence the server renders the dashboard as a PDF and sends a short summary (one " +
          "line per card with a figure to quote) and a deep link to the schedule's destinations, " +
          "with the PDF attached to emails and uploaded to Slack when `attachPdf` is on.",
      )
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.put("update", "/:id/notifications/:notificationId", {
      params: ScheduleParams,
      payload: DashboardNotificationInput,
      success: DashboardNotification,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update a dashboard delivery schedule")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("delete", "/:id/notifications/:notificationId", {
      params: ScheduleParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a dashboard delivery schedule")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("send", "/:id/notifications/:notificationId/send", {
      params: ScheduleParams,
      success: DashboardNotificationSendResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Send a dashboard schedule now")
      .annotate(
        OpenApi.Description,
        "Renders and delivers immediately, ignoring the schedule and its enabled flag. Fails with " +
          "a 400 naming the reason when nothing could be delivered.",
      )
      .annotate(SuccessDescription, "Delivery outcome"),
  )
  .prefix("/api/org/:orgId/dashboards")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Dashboards") {}

/** The org-wide schedules list, on its own prefix (the report precedent). */
export class OrgDashboardNotificationsGroup extends HttpApiGroup.make("orgDashboardNotifications")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(DashboardNotification),
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "List every dashboard delivery schedule in the organization")
      .annotate(SuccessDescription, "Schedules"),
  )
  .prefix("/api/org/:orgId/dashboard-notifications")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Dashboards") {}

export class CostReportPdfGroup extends HttpApiGroup.make("costReportPdf")
  .add(
    HttpApiEndpoint.get("pdf", "/:id/pdf", {
      params: IdParams,
      query: TzQuery,
      success: Pdf,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Export a saved cost report as a PDF")
      .annotate(
        OpenApi.Description,
        "The report's chart and totals table for its saved window, rendered server-side and " +
          "converted to the org's display currency where configured.",
      )
      .annotate(SuccessDescription, "The PDF, as an attachment"),
  )
  .prefix("/api/org/:orgId/cost-reports")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost reports") {}

export class DashboardNotificationsApi extends withApiDefaults(
  HttpApi.make("dashboard-notifications")
    .add(DashboardDeliveryGroup)
    .add(OrgDashboardNotificationsGroup)
    .add(CostReportPdfGroup),
) {}
