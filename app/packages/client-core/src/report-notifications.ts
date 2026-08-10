/**
 * Scheduled delivery of a saved cost report — the wire contract shared by the
 * API, the report page's Delivery section, the mobile read-only view, and the
 * CLI.
 *
 * A report notification is a schedule attached to one cost report: on its
 * cadence the server runs the report, composes a text summary (period total in
 * the org's display currency where configured, change vs the previous period,
 * top groups, and a deep link — no chart images), and sends it to the Slack
 * channels, Teams webhooks and email addresses the schedule names.
 *
 * This follows the weekly digest's model, not alert routing: destinations are
 * picked per schedule, an empty result still sends (saying so), and the last
 * attempt's status/error rides on the schedule so a broken delivery is visible
 * on the report page instead of going quiet.
 */

/** How often a schedule fires. */
export const REPORT_NOTIFICATION_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ReportNotificationCadence = (typeof REPORT_NOTIFICATION_CADENCES)[number];

export const REPORT_NOTIFICATION_CADENCE_LABELS: Record<ReportNotificationCadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/** ISO weekday labels, 1 = Monday … 7 = Sunday — the digest's convention. */
export const REPORT_NOTIFICATION_WEEKDAY_LABELS: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

/** Bounds the API enforces. */
export const REPORT_NOTIFICATION_LIMITS = {
  maxEmailRecipients: 20,
  maxSlackChannels: 20,
  maxTeamsWebhooks: 20,
  /** Schedules per report — enough for "finance monthly + team weekly + me daily". */
  maxPerReport: 10,
} as const;

/** What the last attempt did. Same vocabulary as the digest's status. */
export type ReportNotificationStatus =
  "pending" | "succeeded" | "partial" | "failed" | "no_targets";

/**
 * Create/update payload. A full replace like `CostReportInput`: the editor
 * always holds the whole schedule, and merging two concurrent partial edits
 * would produce a schedule neither author wrote.
 */
export interface ReportNotificationInput {
  cadence: ReportNotificationCadence;
  /** ISO day of week (1–7); read only when `cadence` is `weekly`. */
  sendDay?: number | undefined;
  /**
   * Day of month (1–31); read only when `cadence` is `monthly`. A day the
   * month doesn't have clamps to its last day, so 31 means "month end".
   */
  sendDayOfMonth?: number | undefined;
  /** Local hour, 0–23. */
  hour: number;
  /** IANA zone, e.g. `Europe/Berlin`. Validated server-side. */
  timezone: string;
  /** `slack_channels` row ids to post to. */
  slackChannelIds: string[];
  /** `msteams_webhooks` row ids to post to. */
  teamsWebhookIds: string[];
  /** Email addresses; normalized (lowercased) server-side. */
  emailRecipients: string[];
  enabled: boolean;
}

/** A schedule as returned by the API. */
export interface ReportNotification {
  id: string;
  costReportId: string;
  cadence: ReportNotificationCadence;
  sendDay: number;
  sendDayOfMonth: number;
  hour: number;
  timezone: string;
  slackChannelIds: string[];
  teamsWebhookIds: string[];
  emailRecipients: string[];
  enabled: boolean;
  /** When the next scheduled send is due; null while disabled. */
  nextSendAt: string | null;
  /** When a delivery last actually reached someone. */
  lastSentAt: string | null;
  lastStatus: ReportNotificationStatus | null;
  /** Human-readable reason for the last non-success. */
  lastError: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One pickable Slack channel or Teams webhook, as the targets endpoint lists them. */
export interface ReportDeliveryTargetOption {
  /** The stored row id — what `ReportNotificationInput` carries. */
  id: string;
  /** Display label: `#alerts` for Slack, the user-supplied label for Teams. */
  label: string;
}

/**
 * What a schedule can currently be pointed at. `emailAvailable` is whether
 * this deployment can send mail at all — addresses can still be saved without
 * it, but the UI should say they will go nowhere until mail is configured.
 */
export interface ReportDeliveryTargets {
  slackChannels: ReportDeliveryTargetOption[];
  teamsWebhooks: ReportDeliveryTargetOption[];
  emailAvailable: boolean;
}

/** Per-transport outcome of a delivery — the answer to "Send now". */
export interface ReportNotificationSendResult {
  attempted: number;
  succeeded: number;
  slack: { attempted: number; succeeded: number };
  teams: { attempted: number; succeeded: number };
  email: { attempted: number; succeeded: number };
}

/** `"Weekly · Monday 08:00 Europe/Berlin"` — one schedule, said out loud. */
export function describeReportSchedule(n: {
  cadence: ReportNotificationCadence;
  sendDay: number;
  sendDayOfMonth: number;
  hour: number;
  timezone: string;
}): string {
  const hour = `${String(n.hour).padStart(2, "0")}:00`;
  const when =
    n.cadence === "weekly"
      ? `${REPORT_NOTIFICATION_WEEKDAY_LABELS[n.sendDay] ?? "Monday"} ${hour}`
      : n.cadence === "monthly"
        ? `day ${n.sendDayOfMonth} ${hour}`
        : hour;
  return `${REPORT_NOTIFICATION_CADENCE_LABELS[n.cadence]} · ${when} ${n.timezone}`;
}

/** `"2 Slack channels, 1 email"` — where a schedule delivers to. */
export function describeReportTargets(n: {
  slackChannelIds: string[];
  teamsWebhookIds: string[];
  emailRecipients: string[];
}): string {
  const parts: string[] = [];
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (n.slackChannelIds.length > 0) parts.push(plural(n.slackChannelIds.length, "Slack channel"));
  if (n.teamsWebhookIds.length > 0) parts.push(plural(n.teamsWebhookIds.length, "Teams webhook"));
  if (n.emailRecipients.length > 0) parts.push(plural(n.emailRecipients.length, "email"));
  return parts.length > 0 ? parts.join(", ") : "no destinations";
}
