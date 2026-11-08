/**
 * Scheduled delivery of saved cost reports, the endpoint definitions: the
 * per-report schedules under `/api/org/:orgId/cost-reports/:id/notifications`
 * and the org-wide list at `/api/org/:orgId/cost-report-notifications`.
 *
 * Reads are `costs:read`, like every other cost surface. Writes, "Send now"
 * and the targets listing are `org:settings:write`: a schedule is standing
 * authorisation to ship the org's spend to destinations the creator picks,
 * the email list included, so the permission is pinned to the stricter case
 * rather than depending on the body.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../../schemas/common";
import {
  DeliveryCadence,
  DeliveryLastStatus,
  deliveryScheduleFields,
  deliverySendResultFields,
  ReportDeliveryTargets,
} from "../../schemas/report-delivery";

/** Documented; the store checks every field (see `deliveryScheduleFields`). */
const ReportNotificationInput = Schema.Struct(deliveryScheduleFields).annotate({
  identifier: "ReportNotificationInput",
  description:
    "A full replace, like a report's own PUT. At least one destination is required; a schedule " +
    "with nowhere to deliver would only ever record failures.",
});

export const ReportNotification = Schema.Struct({
  id: Uuid,
  costReportId: Uuid,
  cadence: DeliveryCadence,
  sendDay: Schema.Int,
  sendDayOfMonth: Schema.Int,
  hour: Schema.Int,
  timezone: Schema.String,
  slackChannelIds: Schema.Array(Schema.String),
  teamsWebhookIds: Schema.Array(Schema.String),
  emailRecipients: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  nextSendAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the next scheduled send is due; null while disabled.",
  }),
  lastSentAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When a delivery last actually reached at least one destination.",
  }),
  lastStatus: Schema.NullOr(DeliveryLastStatus).annotate({
    description:
      "What the last attempt did. `partial` means some destinations took it and some failed; " +
      "never retried automatically, because a retry would double-post where it landed.",
  }),
  lastError: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ReportNotification" });

export const ReportNotificationSendResult = Schema.Struct(deliverySendResultFields).annotate({
  identifier: "ReportNotificationSendResult",
});

const ReportParams = { orgId: OrgId, id: Uuid } as const;
const ScheduleParams = { orgId: OrgId, id: Uuid, notificationId: Uuid } as const;

export class CostReportNotificationsGroup extends HttpApiGroup.make("costReportNotifications")
  .add(
    HttpApiEndpoint.get("list", "/:id/notifications", {
      params: ReportParams,
      success: Schema.Array(ReportNotification),
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a report's delivery schedules")
      .annotate(SuccessDescription, "Schedules"),
    HttpApiEndpoint.get("targets", "/:id/notifications/targets", {
      params: ReportParams,
      success: ReportDeliveryTargets,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List the destinations a schedule can deliver to")
      .annotate(
        OpenApi.Description,
        "The org's live Slack channels and Teams webhooks, and whether this deployment can send " +
          "mail. Destinations are picked from here; a schedule can only point at surfaces the org " +
          "already connected.",
      )
      .annotate(SuccessDescription, "Targets"),
    HttpApiEndpoint.post("create", "/:id/notifications", {
      params: ReportParams,
      payload: ReportNotificationInput,
      success: ReportNotification,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create a delivery schedule")
      .annotate(
        OpenApi.Description,
        "On its cadence the server runs the report and sends a composed text summary; period " +
          "total (converted to the org's display currency where configured, with the conversion " +
          "caveat), change vs the previous period, top groups, and a deep link. No chart images. " +
          "An empty result still sends, saying so.",
      )
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.put("update", "/:id/notifications/:notificationId", {
      params: ScheduleParams,
      payload: ReportNotificationInput,
      success: ReportNotification,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update a delivery schedule")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("delete", "/:id/notifications/:notificationId", {
      params: ScheduleParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a delivery schedule")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("send", "/:id/notifications/:notificationId/send", {
      params: ScheduleParams,
      success: ReportNotificationSendResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Send a schedule's report now")
      .annotate(
        OpenApi.Description,
        "Runs the report and delivers it to this schedule's destinations immediately, ignoring " +
          "the schedule and its enabled flag. Fails with a 400 naming the reason when nothing could " +
          "be delivered. A successful manual send clears a parked failure; it is the documented " +
          "recovery for a partial delivery.",
      )
      .annotate(SuccessDescription, "Delivery outcome"),
  )
  .prefix("/api/org/:orgId/cost-reports")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost reports") {}

/**
 * The org-wide list, on its own prefix rather than under `/cost-reports` so
 * it cannot collide with the report's `/:id`.
 */
export class OrgReportNotificationsGroup extends HttpApiGroup.make("orgReportNotifications")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(ReportNotification),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List every delivery schedule in the organization")
      .annotate(
        OpenApi.Description,
        "All reports' schedules in one call; what the CLI's schedules column reads. Schedules " +
          "of deleted reports are excluded.",
      )
      .annotate(SuccessDescription, "Schedules"),
  )
  .prefix("/api/org/:orgId/cost-report-notifications")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost reports") {}

export class CostReportNotificationsApi extends withApiDefaults(
  HttpApi.make("cost-report-notifications")
    .add(CostReportNotificationsGroup)
    .add(OrgReportNotificationsGroup),
) {}
