/**
 * Report notification rows — CRUD, validation, and the delivery-target
 * catalogue, shared by the web API and the poller pass.
 *
 * Scheduled report delivery follows the **digest pattern, not alert routing**
 * (see `compose.ts`): destinations live on the schedule row itself, not in
 * `alert_rules`. What this store validates on the way in is therefore the
 * whole trust story — a Slack channel or Teams webhook id must be a row the
 * org already connected, and email addresses are normalized and bounded.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  REPORT_NOTIFICATION_CADENCES,
  REPORT_NOTIFICATION_LIMITS,
  type ReportDeliveryTargets,
  type ReportNotification,
  type ReportNotificationCadence,
  type ReportNotificationInput,
  type ReportNotificationStatus,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costReports, reportNotifications, slackChannels, slackInstallations } from "../db/schema";
import { isValidTimeZone } from "../digest/compose";
import { isEmailConfigured, normalizeEmailAddress } from "../email";
import { resolveSlackChannels, isSlackConfigured } from "../slack";
import { listMsTeamsWebhooks } from "../msteams";
import { nextReportSendAt, type ReportSchedule } from "./compose";

export type ReportNotificationRecord = typeof reportNotifications.$inferSelect;

/** Thrown for caller mistakes the API maps onto 400/404. */
export class ReportNotificationInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "ReportNotificationInputError";
  }
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

export function toReportNotificationView(row: ReportNotificationRecord): ReportNotification {
  return {
    id: row.id,
    costReportId: row.costReportId,
    cadence: row.cadence as ReportNotificationCadence,
    sendDay: row.sendDay,
    sendDayOfMonth: row.sendDayOfMonth,
    hour: row.hour,
    timezone: row.timezone,
    slackChannelIds: asStringArray(row.slackChannelIds),
    teamsWebhookIds: asStringArray(row.teamsWebhookIds),
    emailRecipients: asStringArray(row.emailRecipients),
    enabled: row.enabled,
    nextSendAt: row.nextSendAt?.toISOString() ?? null,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    lastStatus: (row.lastStatus as ReportNotificationStatus | null) ?? null,
    lastError: row.lastError,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The schedule half of a row, for `nextReportSendAt`. */
export function scheduleOf(row: {
  cadence: string;
  sendDay: number;
  sendDayOfMonth: number;
  hour: number;
  timezone: string;
}): ReportSchedule {
  return {
    cadence: row.cadence as ReportNotificationCadence,
    sendDay: row.sendDay,
    sendDayOfMonth: row.sendDayOfMonth,
    hour: row.hour,
    timezone: row.timezone,
  };
}

/* ------------------------------------------------------------------ *
 * Report resolution
 * ------------------------------------------------------------------ */

/** The live (non-deleted) report row, or a 404-shaped error. */
export async function requireLiveReport(
  organizationId: string,
  reportId: string,
): Promise<{ id: string; name: string }> {
  const [row] = await db
    .select({ id: costReports.id, name: costReports.name })
    .from(costReports)
    .where(
      and(
        eq(costReports.id, reportId),
        eq(costReports.organizationId, organizationId),
        isNull(costReports.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new ReportNotificationInputError("Report not found", 404);
  return row;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

interface NormalizedInput {
  cadence: ReportNotificationCadence;
  sendDay: number;
  sendDayOfMonth: number;
  hour: number;
  timezone: string;
  slackChannelIds: string[];
  teamsWebhookIds: string[];
  emailRecipients: string[];
  enabled: boolean;
}

async function normalizeInput(
  organizationId: string,
  input: ReportNotificationInput,
): Promise<NormalizedInput> {
  if (!REPORT_NOTIFICATION_CADENCES.includes(input.cadence)) {
    throw new ReportNotificationInputError(
      `cadence must be one of: ${REPORT_NOTIFICATION_CADENCES.join(", ")}`,
    );
  }
  const sendDay = input.sendDay ?? 1;
  if (!Number.isInteger(sendDay) || sendDay < 1 || sendDay > 7) {
    throw new ReportNotificationInputError("sendDay must be 1 (Monday) through 7 (Sunday)");
  }
  const sendDayOfMonth = input.sendDayOfMonth ?? 1;
  if (!Number.isInteger(sendDayOfMonth) || sendDayOfMonth < 1 || sendDayOfMonth > 31) {
    throw new ReportNotificationInputError(
      "sendDayOfMonth must be 1 through 31 (31 clamps to the month's last day)",
    );
  }
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) {
    throw new ReportNotificationInputError("hour must be an integer from 0 to 23");
  }
  if (!isValidTimeZone(input.timezone)) {
    throw new ReportNotificationInputError(`Unknown time zone: ${input.timezone}`);
  }

  // Emails: normalized (lowercased, validated) and deduped, digest-style.
  const emails: string[] = [];
  for (const raw of input.emailRecipients ?? []) {
    let email: string;
    try {
      email = normalizeEmailAddress(String(raw));
    } catch (e) {
      throw new ReportNotificationInputError(e instanceof Error ? e.message : String(e));
    }
    if (!emails.includes(email)) emails.push(email);
  }
  if (emails.length > REPORT_NOTIFICATION_LIMITS.maxEmailRecipients) {
    throw new ReportNotificationInputError(
      `At most ${REPORT_NOTIFICATION_LIMITS.maxEmailRecipients} email recipients per schedule`,
    );
  }

  // Slack / Teams ids must be rows the org already connected — a schedule can
  // only point at destinations an admin approved, never at a raw channel id.
  const slackIds = [...new Set((input.slackChannelIds ?? []).map(String))];
  if (slackIds.length > REPORT_NOTIFICATION_LIMITS.maxSlackChannels) {
    throw new ReportNotificationInputError(
      `At most ${REPORT_NOTIFICATION_LIMITS.maxSlackChannels} Slack channels per schedule`,
    );
  }
  if (slackIds.length > 0) {
    const resolved = await resolveSlackChannels(organizationId, slackIds);
    if (resolved.length !== slackIds.length) {
      throw new ReportNotificationInputError(
        "One or more Slack channels are unknown or their workspace was disconnected",
      );
    }
  }

  const teamsIds = [...new Set((input.teamsWebhookIds ?? []).map(String))];
  if (teamsIds.length > REPORT_NOTIFICATION_LIMITS.maxTeamsWebhooks) {
    throw new ReportNotificationInputError(
      `At most ${REPORT_NOTIFICATION_LIMITS.maxTeamsWebhooks} Teams webhooks per schedule`,
    );
  }
  if (teamsIds.length > 0) {
    const known = new Set((await listMsTeamsWebhooks(organizationId)).map((w) => w.id));
    if (!teamsIds.every((id) => known.has(id))) {
      throw new ReportNotificationInputError("One or more Teams webhooks are unknown");
    }
  }

  if (slackIds.length === 0 && teamsIds.length === 0 && emails.length === 0) {
    throw new ReportNotificationInputError(
      "A schedule needs at least one destination — a Slack channel, a Teams webhook, or an email address",
    );
  }

  return {
    cadence: input.cadence,
    sendDay,
    sendDayOfMonth,
    hour: input.hour,
    timezone: input.timezone,
    slackChannelIds: slackIds,
    teamsWebhookIds: teamsIds,
    emailRecipients: emails,
    enabled: input.enabled !== false,
  };
}

/* ------------------------------------------------------------------ *
 * CRUD
 * ------------------------------------------------------------------ */

/** One report's schedules, oldest first (stable for the report page's list). */
export async function listReportNotifications(
  organizationId: string,
  reportId: string,
): Promise<ReportNotification[]> {
  await requireLiveReport(organizationId, reportId);
  const rows = await db
    .select()
    .from(reportNotifications)
    .where(
      and(
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.costReportId, reportId),
      ),
    )
    .orderBy(asc(reportNotifications.createdAt), asc(reportNotifications.id));
  return rows.map(toReportNotificationView);
}

/**
 * Every schedule in the org, one call — what the CLI's schedules column reads
 * instead of a request per report. Joined to live reports only: a soft-deleted
 * report's schedules are disabled state, not something to keep listing.
 */
export async function listOrgReportNotifications(
  organizationId: string,
): Promise<ReportNotification[]> {
  const rows = await db
    .select({ notification: reportNotifications })
    .from(reportNotifications)
    .innerJoin(costReports, eq(costReports.id, reportNotifications.costReportId))
    .where(
      and(eq(reportNotifications.organizationId, organizationId), isNull(costReports.deletedAt)),
    )
    .orderBy(asc(reportNotifications.createdAt), asc(reportNotifications.id));
  return rows.map((r) => toReportNotificationView(r.notification));
}

export async function getReportNotificationRow(
  organizationId: string,
  reportId: string,
  notificationId: string,
): Promise<ReportNotificationRecord> {
  const [row] = await db
    .select()
    .from(reportNotifications)
    .where(
      and(
        eq(reportNotifications.id, notificationId),
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.costReportId, reportId),
      ),
    )
    .limit(1);
  if (!row) throw new ReportNotificationInputError("Schedule not found", 404);
  return row;
}

export async function createReportNotification(
  organizationId: string,
  reportId: string,
  input: ReportNotificationInput,
  createdByUserId: string | null,
  now = new Date(),
): Promise<ReportNotification> {
  await requireLiveReport(organizationId, reportId);
  const normalized = await normalizeInput(organizationId, input);

  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reportNotifications)
    .where(eq(reportNotifications.costReportId, reportId))) as [{ count: number }];
  if (count >= REPORT_NOTIFICATION_LIMITS.maxPerReport) {
    throw new ReportNotificationInputError(
      `A report can have at most ${REPORT_NOTIFICATION_LIMITS.maxPerReport} delivery schedules`,
    );
  }

  const [created] = await db
    .insert(reportNotifications)
    .values({
      id: randomUUID(),
      organizationId,
      costReportId: reportId,
      ...normalized,
      // Armed at the schedule's true next fire — never "right now", so
      // creating a schedule at 07:59 for 08:00 sends at 08:00, and creating
      // one at 08:01 sends tomorrow. "Send now" exists for immediacy.
      nextSendAt: normalized.enabled ? nextReportSendAt(scheduleOf(normalized), now) : null,
      createdByUserId,
    })
    .returning();
  return toReportNotificationView(created!);
}

/**
 * Full replace, like a report's own PUT. Recomputes `next_send_at` from the
 * new schedule and clears any parked failure state — the user changed what
 * they asked for, so a stale error about the old schedule would only confuse.
 */
export async function updateReportNotification(
  organizationId: string,
  reportId: string,
  notificationId: string,
  input: ReportNotificationInput,
  now = new Date(),
): Promise<ReportNotification> {
  await getReportNotificationRow(organizationId, reportId, notificationId);
  await requireLiveReport(organizationId, reportId);
  const normalized = await normalizeInput(organizationId, input);

  const [updated] = await db
    .update(reportNotifications)
    .set({
      ...normalized,
      nextSendAt: normalized.enabled ? nextReportSendAt(scheduleOf(normalized), now) : null,
      attemptCount: 0,
      lastStatus: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(reportNotifications.id, notificationId),
        eq(reportNotifications.organizationId, organizationId),
      ),
    )
    .returning();
  if (!updated) throw new ReportNotificationInputError("Schedule not found", 404);
  return toReportNotificationView(updated);
}

export async function deleteReportNotification(
  organizationId: string,
  reportId: string,
  notificationId: string,
): Promise<void> {
  const [deleted] = await db
    .delete(reportNotifications)
    .where(
      and(
        eq(reportNotifications.id, notificationId),
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.costReportId, reportId),
      ),
    )
    .returning({ id: reportNotifications.id });
  if (!deleted) throw new ReportNotificationInputError("Schedule not found", 404);
}

/**
 * Park every schedule of a soft-deleted report. The FK cascade only covers a
 * *hard* delete; this is the soft-delete half of "a deleted report takes its
 * schedules with it". Disabled rather than deleted so `report_notification.*`
 * audit entries still resolve to something.
 */
export async function disableReportNotificationsForReport(
  organizationId: string,
  reportId: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(reportNotifications)
    .set({ enabled: false, nextSendAt: null, updatedAt: now })
    .where(
      and(
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.costReportId, reportId),
      ),
    );
}

/* ------------------------------------------------------------------ *
 * Targets
 * ------------------------------------------------------------------ */

/**
 * What a schedule can be pointed at right now: the org's live Slack channels
 * and Teams webhooks, plus whether this deployment can send mail. Backs the
 * schedule editor's pickers — the user picks a channel, never types an id.
 */
export async function listReportDeliveryTargets(
  organizationId: string,
): Promise<ReportDeliveryTargets> {
  const [slack, teams] = await Promise.all([
    isSlackConfigured()
      ? db
          .select({ id: slackChannels.id, channelName: slackChannels.channelName })
          .from(slackChannels)
          .innerJoin(slackInstallations, eq(slackInstallations.id, slackChannels.installationId))
          .where(
            and(
              eq(slackChannels.organizationId, organizationId),
              isNull(slackInstallations.deletedAt),
            ),
          )
          .orderBy(asc(slackChannels.channelName))
      : Promise.resolve([]),
    listMsTeamsWebhooks(organizationId),
  ]);
  return {
    slackChannels: slack.map((ch) => ({ id: ch.id, label: `#${ch.channelName}` })),
    // The label is `msteams_webhooks.label`, never the URL — the URL is a
    // credential and no route surfaces it.
    teamsWebhooks: teams.map((w) => ({ id: w.id, label: w.label })),
    emailAvailable: isEmailConfigured(),
  };
}

export type { ReportSchedule };
