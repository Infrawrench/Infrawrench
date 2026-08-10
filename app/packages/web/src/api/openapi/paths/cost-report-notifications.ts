import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const Cadence = z
  .enum(["daily", "weekly", "monthly"])
  .describe("How often the schedule fires. The report itself decides what window it charts.");

const ScheduleFields = {
  cadence: Cadence,
  sendDay: z
    .number()
    .int()
    .min(1)
    .max(7)
    .optional()
    .describe("ISO day of week (1 = Monday … 7 = Sunday); read only when cadence is weekly."),
  sendDayOfMonth: z
    .number()
    .int()
    .min(1)
    .max(31)
    .optional()
    .describe(
      "Day of month; read only when cadence is monthly. A day the month doesn't have clamps to " +
        "its last day, so 31 means month end everywhere.",
    ),
  hour: z.number().int().min(0).max(23).describe("Local hour in `timezone` the delivery fires at."),
  timezone: z.string().describe("IANA zone, e.g. `Europe/Berlin`. Validated server-side."),
  slackChannelIds: z
    .array(z.string())
    .describe("Stored Slack channel row ids (from the targets endpoint) to post to."),
  teamsWebhookIds: z
    .array(z.string())
    .describe("Stored Teams webhook row ids (from the targets endpoint) to post to."),
  emailRecipients: z
    .array(z.string())
    .describe("Email addresses; normalized (lowercased) server-side. At most 20."),
  enabled: z.boolean(),
};

const ReportNotificationInput = strict({ ...ScheduleFields })
  .describe(
    "A full replace, like a report's own PUT. At least one destination is required — a schedule " +
      "with nowhere to deliver would only ever record failures.",
  )
  .openapi("ReportNotificationInput");

const ReportNotification = strict({
  id: Uuid,
  costReportId: Uuid,
  cadence: Cadence,
  sendDay: z.number().int(),
  sendDayOfMonth: z.number().int(),
  hour: z.number().int(),
  timezone: z.string(),
  slackChannelIds: z.array(z.string()),
  teamsWebhookIds: z.array(z.string()),
  emailRecipients: z.array(z.string()),
  enabled: z.boolean(),
  nextSendAt: IsoDateTime.nullable().describe(
    "When the next scheduled send is due; null while disabled.",
  ),
  lastSentAt: IsoDateTime.nullable().describe(
    "When a delivery last actually reached at least one destination.",
  ),
  lastStatus: z
    .enum(["pending", "succeeded", "partial", "failed", "no_targets"])
    .nullable()
    .describe(
      "What the last attempt did. `partial` means some destinations took it and some failed — " +
        "never retried automatically, because a retry would double-post where it landed.",
    ),
  lastError: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("ReportNotification");

const ReportDeliveryTargetOption = strict({
  id: z.string().describe("The stored row id — what the schedule input carries."),
  label: z.string().describe("Display label: `#channel` for Slack, the saved label for Teams."),
}).openapi("ReportDeliveryTargetOption");

const ReportDeliveryTargets = strict({
  slackChannels: z.array(ReportDeliveryTargetOption),
  teamsWebhooks: z.array(ReportDeliveryTargetOption),
  emailAvailable: z
    .boolean()
    .describe(
      "Whether this deployment can send mail at all. Addresses can be saved regardless, but " +
        "they deliver nowhere until a mail provider is configured.",
    ),
}).openapi("ReportDeliveryTargets");

const TransportOutcome = strict({
  attempted: z.number().int(),
  succeeded: z.number().int(),
});

const ReportNotificationSendResult = strict({
  attempted: z.number().int(),
  succeeded: z.number().int(),
  slack: TransportOutcome,
  teams: TransportOutcome,
  email: TransportOutcome,
}).openapi("ReportNotificationSendResult");

export function registerCostReportNotificationPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () => params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });
  const notifParam = () =>
    params({
      id: Uuid.openapi({ param: { name: "id", in: "path" } }),
      notificationId: Uuid.openapi({ param: { name: "notificationId", in: "path" } }),
    });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-reports/{id}/notifications",
    tags: ["Cost reports"],
    summary: "List a report's delivery schedules",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Schedules",
        content: { "application/json": { schema: z.array(ReportNotification) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-reports/{id}/notifications/targets",
    tags: ["Cost reports"],
    summary: "List the destinations a schedule can deliver to",
    description:
      "The org's live Slack channels and Teams webhooks, and whether this deployment can send " +
      "mail. Destinations are picked from here — a schedule can only point at surfaces the org " +
      "already connected.",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Targets",
        content: { "application/json": { schema: ReportDeliveryTargets } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-reports/{id}/notifications",
    tags: ["Cost reports"],
    summary: "Create a delivery schedule",
    description:
      "On its cadence the server runs the report and sends a composed text summary — period " +
      "total (converted to the org's display currency where configured, with the conversion " +
      "caveat), change vs the previous period, top groups, and a deep link. No chart images. " +
      "An empty result still sends, saying so.",
    request: {
      params: idParam(),
      body: {
        content: { "application/json": { schema: ReportNotificationInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: ReportNotification } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-reports/{id}/notifications/{notificationId}",
    tags: ["Cost reports"],
    summary: "Update a delivery schedule",
    request: {
      params: notifParam(),
      body: {
        content: { "application/json": { schema: ReportNotificationInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: ReportNotification } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-reports/{id}/notifications/{notificationId}",
    tags: ["Cost reports"],
    summary: "Delete a delivery schedule",
    request: { params: notifParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-reports/{id}/notifications/{notificationId}/send",
    tags: ["Cost reports"],
    summary: "Send a schedule's report now",
    description:
      "Runs the report and delivers it to this schedule's destinations immediately, ignoring " +
      "the schedule and its enabled flag. Fails with a 400 naming the reason when nothing could " +
      "be delivered. A successful manual send clears a parked failure — it is the documented " +
      "recovery for a partial delivery.",
    request: { params: notifParam() },
    responses: {
      200: {
        description: "Delivery outcome",
        content: { "application/json": { schema: ReportNotificationSendResult } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-report-notifications",
    tags: ["Cost reports"],
    summary: "List every delivery schedule in the organization",
    description:
      "All reports' schedules in one call — what the CLI's schedules column reads. Schedules " +
      "of deleted reports are excluded.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Schedules",
        content: { "application/json": { schema: z.array(ReportNotification) } },
      },
    },
  });
}
