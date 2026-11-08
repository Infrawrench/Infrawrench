/**
 * Scheduled delivery of saved cost reports, the handlers. Transport only: the
 * store and the delivery run live in `server-core/src/report-delivery/*`, so
 * the poller drives exactly the same code. Bodies go to the store as sent;
 * its `normalizeInput` checks every field and answers with its own sentences.
 */
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  createReportNotification,
  deleteReportNotification,
  listOrgReportNotifications,
  listReportDeliveryTargets,
  listReportNotifications,
  updateReportNotification,
} from "@infrawrench/server-core/report-delivery/store";
import { sendReportNotificationNow } from "@infrawrench/server-core/report-delivery/deliver";
import type { ReportNotificationInput } from "@infrawrench/client-core";
import {
  CostReportNotificationsApi,
  ok,
  ReportDeliveryTargets,
  ReportNotification,
  ReportNotificationSendResult,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { deliveryCall, readScheduleBody } from "./delivery";

const CostReportNotificationsHandlers = HttpApiBuilder.group(
  CostReportNotificationsApi,
  "costReportNotifications",
  (handlers) =>
    handlers
      .handle("list", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const schedules = yield* deliveryCall(() =>
            listReportNotifications(organizationId, params.id),
          );
          return yield* respond(Schema.Array(ReportNotification))(schedules);
        }),
      )
      // What a schedule can deliver to: the org's live Slack channels, its
      // Teams webhooks, and whether this deployment can send mail.
      .handle("targets", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const targets = yield* legacy(() => listReportDeliveryTargets(organizationId));
          return yield* respond(ReportDeliveryTargets)(targets);
        }),
      )
      .handleRaw("create", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const input = yield* readScheduleBody<ReportNotificationInput>(request);
          const created = yield* deliveryCall(() =>
            createReportNotification(organizationId, params.id, input, session.userId ?? null),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "report_notification.create",
              entityType: "report_notification",
              entityId: created.id,
              metadata: {
                reportId: params.id,
                cadence: created.cadence,
                slackChannels: created.slackChannelIds.length,
                teamsWebhooks: created.teamsWebhookIds.length,
                emailRecipients: created.emailRecipients.length,
              },
            }),
          );
          return yield* respond(ReportNotification)(created);
        }),
      )
      .handleRaw("update", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const input = yield* readScheduleBody<ReportNotificationInput>(request);
          const updated = yield* deliveryCall(() =>
            updateReportNotification(organizationId, params.id, params.notificationId, input),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "report_notification.update",
              entityType: "report_notification",
              entityId: updated.id,
              metadata: {
                reportId: params.id,
                cadence: updated.cadence,
                enabled: updated.enabled,
                slackChannels: updated.slackChannelIds.length,
                teamsWebhooks: updated.teamsWebhookIds.length,
                emailRecipients: updated.emailRecipients.length,
              },
            }),
          );
          return yield* respond(ReportNotification)(updated);
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          yield* deliveryCall(() =>
            deleteReportNotification(organizationId, params.id, params.notificationId),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "report_notification.delete",
              entityType: "report_notification",
              entityId: params.notificationId,
              metadata: { reportId: params.id },
            }),
          );
          return ok;
        }),
      )
      // Run the report and deliver it now, ignoring the schedule. Errors are
      // 400s with the reason: the caller is a person clicking "Send now" who
      // needs to see why nothing arrived.
      .handle("send", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const result = yield* deliveryCall(() =>
            sendReportNotificationNow(organizationId, params.id, params.notificationId),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "report_notification.send",
              entityType: "report_notification",
              entityId: params.notificationId,
              metadata: {
                reportId: params.id,
                attempted: result.attempted,
                succeeded: result.succeeded,
              },
            }),
          );
          return yield* respond(ReportNotificationSendResult)(result);
        }),
      ),
);

const OrgReportNotificationsHandlers = HttpApiBuilder.group(
  CostReportNotificationsApi,
  "orgReportNotifications",
  (handlers) =>
    handlers.handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const schedules = yield* legacy(() => listOrgReportNotifications(organizationId));
        return yield* respond(Schema.Array(ReportNotification))(schedules);
      }),
    ),
);

export const costReportNotificationsDomain = makeDomain(
  "cost-report-notifications",
  CostReportNotificationsApi,
  Layer.mergeAll(CostReportNotificationsHandlers, OrgReportNotificationsHandlers),
);
