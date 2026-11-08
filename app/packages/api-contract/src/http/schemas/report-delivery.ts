/**
 * Scheduled delivery of a saved cost report or a dashboard: the schedule
 * fields both take, the destinations a schedule can pick from and the
 * per-transport outcome of a send. Shared because the report, dashboard and
 * cost canvas delivery domains document the same components.
 */
import { Schema } from "effect";
import { HttpApiSchema } from "effect/http-api";
import { REPORT_NOTIFICATION_CADENCES } from "@infrawrench/client-core";

export const DeliveryCadence = Schema.Literals(REPORT_NOTIFICATION_CADENCES).annotate({
  description: "How often the schedule fires. The report itself decides what window it charts.",
});

/**
 * The schedule fields of a report's (and a dashboard's) delivery input, as
 * documented. The store (`normalizeInput` in server-core) checks every one of
 * them and answers with its own sentences, so they are documentation here.
 */
export const deliveryScheduleFields = {
  cadence: DeliveryCadence,
  sendDay: Schema.optionalKey(
    Schema.Int.annotate({
      description: "ISO day of week (1 = Monday … 7 = Sunday); read only when cadence is weekly.",
    }).check(Schema.isBetween({ minimum: 1, maximum: 7 })),
  ),
  sendDayOfMonth: Schema.optionalKey(
    Schema.Int.annotate({
      description:
        "Day of month; read only when cadence is monthly. A day the month doesn't have clamps to " +
        "its last day, so 31 means month end everywhere.",
    }).check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  ),
  hour: Schema.Int.annotate({
    description: "Local hour in `timezone` the delivery fires at.",
  }).check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  timezone: Schema.String.annotate({
    description: "IANA zone, e.g. `Europe/Berlin`. Validated server-side.",
  }),
  slackChannelIds: Schema.Array(Schema.String).annotate({
    description: "Stored Slack channel row ids (from the targets endpoint) to post to.",
  }),
  teamsWebhookIds: Schema.Array(Schema.String).annotate({
    description: "Stored Teams webhook row ids (from the targets endpoint) to post to.",
  }),
  emailRecipients: Schema.Array(Schema.String).annotate({
    description: "Email addresses; normalized (lowercased) server-side. At most 20.",
  }),
  enabled: Schema.Boolean,
};

/** What a delivery attempt last did, on a stored schedule. */
export const DeliveryLastStatus = Schema.Literals([
  "pending",
  "succeeded",
  "partial",
  "failed",
  "no_targets",
]);

const ReportDeliveryTargetOption = Schema.Struct({
  id: Schema.String.annotate({
    description: "The stored row id; what the schedule input carries.",
  }),
  label: Schema.String.annotate({
    description: "Display label: `#channel` for Slack, the saved label for Teams.",
  }),
}).annotate({ identifier: "ReportDeliveryTargetOption" });

/** `listReportDeliveryTargets`: what a report or dashboard schedule can deliver to. */
export const ReportDeliveryTargets = Schema.Struct({
  slackChannels: Schema.Array(ReportDeliveryTargetOption),
  teamsWebhooks: Schema.Array(ReportDeliveryTargetOption),
  emailAvailable: Schema.Boolean.annotate({
    description:
      "Whether this deployment can send mail at all. Addresses can be saved regardless, but " +
      "they deliver nowhere until a mail provider is configured.",
  }),
}).annotate({ identifier: "ReportDeliveryTargets" });

/** One transport's share of a send. */
export const TransportOutcome = Schema.Struct({ attempted: Schema.Int, succeeded: Schema.Int });

/** The per-transport outcome every send-now answers with. */
export const deliverySendResultFields = {
  attempted: Schema.Int,
  succeeded: Schema.Int,
  slack: TransportOutcome,
  teams: TransportOutcome,
  email: TransportOutcome,
};

export const attachPdfDescription =
  "Attach the rendered PDF: as a file on every email, and uploaded into the Slack message's " +
  "thread (needs the Slack app's `files:write` scope; without it the message still posts). " +
  "Teams incoming webhooks cannot carry files, so Teams always gets the summary and a link.";

/**
 * A dashboard's (and a cost canvas's) delivery input. Documented; the store
 * checks every field, as for a report's schedule.
 */
export const DashboardNotificationInput = Schema.Struct({
  ...deliveryScheduleFields,
  attachPdf: Schema.optionalKey(Schema.Boolean.annotate({ description: "Absent means `true`." })),
}).annotate({
  identifier: "DashboardNotificationInput",
  description:
    "A full replace. At least one destination is required. The same schedule shape as a cost " +
    "report's delivery schedule, plus `attachPdf`.",
});

/** What "Send now" on a dashboard (or a cost canvas) schedule answers. */
export const DashboardNotificationSendResult = Schema.Struct({
  ...deliverySendResultFields,
  pdfAttached: Schema.Boolean.annotate({ description: "Whether a PDF was rendered and sent." }),
  slackFilesUploaded: Schema.Int.annotate({
    description:
      "Slack channels that also received the PDF. Lower than `slack.succeeded` when the Slack " +
      "install predates the `files:write` scope.",
  }),
}).annotate({ identifier: "DashboardNotificationSendResult" });

/** A rendered PDF; the handler sends it as an attachment. */
export const PdfDocument = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: "application/pdf" }),
);

/** `?tz=`, read as-is: the handler keeps a zone `Intl` knows and drops any other. */
export const TzQuery = {
  tz: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "IANA zone the document's generated-at line is written in, e.g. `Europe/Berlin`. UTC " +
        "when absent or unknown.",
    }),
  ),
};
