import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import {
  Cadence,
  ReportDeliveryTargets,
  ScheduleFields,
  TransportOutcome,
} from "./cost-report-notifications";

const AttachPdf = z
  .boolean()
  .describe(
    "Attach the rendered PDF: as a file on every email, and uploaded into the Slack message's " +
      "thread (needs the Slack app's `files:write` scope; without it the message still posts). " +
      "Teams incoming webhooks cannot carry files, so Teams always gets the summary and a link.",
  );

const DashboardNotificationInput = strict({
  ...ScheduleFields,
  attachPdf: AttachPdf.optional().describe("Absent means `true`."),
})
  .describe(
    "A full replace. At least one destination is required. The same schedule shape as a cost " +
      "report's delivery schedule, plus `attachPdf`.",
  )
  .openapi("DashboardNotificationInput");

const DashboardNotification = strict({
  id: Uuid,
  dashboardId: Uuid,
  cadence: Cadence,
  sendDay: z.number().int(),
  sendDayOfMonth: z.number().int(),
  hour: z.number().int(),
  timezone: z.string(),
  slackChannelIds: z.array(z.string()),
  teamsWebhookIds: z.array(z.string()),
  emailRecipients: z.array(z.string()),
  enabled: z.boolean(),
  attachPdf: AttachPdf,
  nextSendAt: IsoDateTime.nullable().describe(
    "When the next scheduled send is due; null while disabled.",
  ),
  lastSentAt: IsoDateTime.nullable().describe(
    "When a delivery last actually reached at least one destination.",
  ),
  lastStatus: z
    .enum(["pending", "succeeded", "partial", "failed", "no_targets"])
    .nullable()
    .describe("What the last attempt did. `partial` is never retried automatically."),
  lastError: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("DashboardNotification");

const DashboardNotificationSendResult = strict({
  attempted: z.number().int(),
  succeeded: z.number().int(),
  slack: TransportOutcome,
  teams: TransportOutcome,
  email: TransportOutcome,
  pdfAttached: z.boolean().describe("Whether a PDF was rendered and sent."),
  slackFilesUploaded: z
    .number()
    .int()
    .describe(
      "Slack channels that also received the PDF. Lower than `slack.succeeded` when the Slack " +
        "install predates the `files:write` scope.",
    ),
}).openapi("DashboardNotificationSendResult");

const PdfBody = {
  "application/pdf": { schema: z.string().openapi({ format: "binary" }) },
};

const TzQuery = z.object({
  tz: z
    .string()
    .optional()
    .describe(
      "IANA zone the document's generated-at line is written in, e.g. `Europe/Berlin`. UTC " +
        "when absent or unknown.",
    ),
});

export function registerDashboardNotificationPaths(ctx: BuildContext) {
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
    path: "/api/org/{orgId}/dashboards/{id}/pdf",
    tags: ["Dashboards"],
    summary: "Export a dashboard as a PDF",
    description:
      "Renders every card server-side: cost graphs and saved reports (chart plus a totals " +
      "table, converted to the org's display currency where configured), budgets (spend " +
      "against the amount, forecast and thresholds), custom graphs (including their KPI and " +
      "table forms) and pinned resources and workflows. Cost cards need `costs:read` as well " +
      "and are replaced by a note without it. A card that fails renders its error in place.",
    request: { params: idParam(), query: TzQuery },
    responses: {
      200: { description: "The PDF, as an attachment", content: PdfBody },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-reports/{id}/pdf",
    tags: ["Cost reports"],
    summary: "Export a saved cost report as a PDF",
    description:
      "The report's chart and totals table for its saved window, rendered server-side and " +
      "converted to the org's display currency where configured.",
    request: { params: idParam(), query: TzQuery },
    responses: {
      200: { description: "The PDF, as an attachment", content: PdfBody },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboards/{id}/notifications",
    tags: ["Dashboards"],
    summary: "List a dashboard's delivery schedules",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Schedules",
        content: { "application/json": { schema: z.array(DashboardNotification) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboards/{id}/notifications/targets",
    tags: ["Dashboards"],
    summary: "List the destinations a dashboard schedule can deliver to",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Targets",
        content: { "application/json": { schema: ReportDeliveryTargets } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/{id}/notifications",
    tags: ["Dashboards"],
    summary: "Create a dashboard delivery schedule",
    description:
      "On its cadence the server renders the dashboard as a PDF and sends a short summary (one " +
      "line per card with a figure to quote) and a deep link to the schedule's destinations, " +
      "with the PDF attached to emails and uploaded to Slack when `attachPdf` is on.",
    request: {
      params: idParam(),
      body: {
        content: { "application/json": { schema: DashboardNotificationInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: DashboardNotification } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/dashboards/{id}/notifications/{notificationId}",
    tags: ["Dashboards"],
    summary: "Update a dashboard delivery schedule",
    request: {
      params: notifParam(),
      body: {
        content: { "application/json": { schema: DashboardNotificationInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: DashboardNotification } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/dashboards/{id}/notifications/{notificationId}",
    tags: ["Dashboards"],
    summary: "Delete a dashboard delivery schedule",
    request: { params: notifParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/{id}/notifications/{notificationId}/send",
    tags: ["Dashboards"],
    summary: "Send a dashboard schedule now",
    description:
      "Renders and delivers immediately, ignoring the schedule and its enabled flag. Fails with " +
      "a 400 naming the reason when nothing could be delivered.",
    request: { params: notifParam() },
    responses: {
      200: {
        description: "Delivery outcome",
        content: { "application/json": { schema: DashboardNotificationSendResult } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboard-notifications",
    tags: ["Dashboards"],
    summary: "List every dashboard delivery schedule in the organization",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Schedules",
        content: { "application/json": { schema: z.array(DashboardNotification) } },
      },
    },
  });
}
