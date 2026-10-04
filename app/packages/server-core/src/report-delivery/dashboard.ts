/**
 * Scheduled dashboard delivery: the report-notification mechanism, pointed at
 * a whole dashboard and carrying a PDF.
 *
 * Same table (`report_notifications`, with `dashboard_id` set instead of
 * `cost_report_id`), same validation (`normalizeInput`), same schedule
 * arithmetic (`nextReportSendAt`), same retry rules
 * (`classifyReportDelivery`), same digest-pattern delivery straight to the
 * schedule's own destinations. Nothing here is routed through alert rules,
 * for the reason `compose.ts` gives.
 *
 * What differs is the payload, and where it is built. A dashboard holds cost
 * graphs, saved reports, budgets, custom graphs (sandboxed scripts) and pinned
 * resources; rendering all of that needs the web app's query services, which
 * the poller does not bundle. So rendering is **injected**: the web process
 * passes a {@link DashboardRenderer} to {@link runDashboardDeliveryPass} from
 * its own delivery loop, and to {@link sendDashboardNotificationNow} from the
 * "Send now" route. The claim and bookkeeping stay here, beside the report
 * ones, so the two cannot drift.
 *
 * Transports: email gets the PDF attached; Slack gets the summary message and
 * the PDF uploaded as a reply in its thread (soft-failing for installs
 * without `files:write`); Teams incoming webhooks cannot carry a file, so
 * Teams gets the summary and the link.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  DASHBOARD_NOTIFICATION_LIMITS,
  pdfFileName,
  type DashboardNotification,
  type DashboardNotificationInput,
  type DashboardNotificationSendResult,
  type ReportNotificationCadence,
  type ReportNotificationStatus,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { dashboards, organizations, reportNotifications } from "../db/schema";
import { isEmailConfigured, sendEmails, type EmailMessage } from "../email";
import { sendSlackToChannelsWithFile } from "../slack";
import { sendMsTeamsToWebhooks } from "../msteams";
import { formatSegmentsEmailHtml, type DigestLine } from "../digest/compose";
import {
  classifyReportDelivery,
  nextReportDeliveryAttemptAt,
  nextReportSendAt,
  MAX_REPORT_DELIVERY_ATTEMPTS,
  type ReportDeliveryStatus,
} from "./compose";
import {
  ReportNotificationInputError,
  normalizeInput,
  scheduleOf,
  type ReportNotificationRecord,
} from "./store";

/* ------------------------------------------------------------------ *
 * The injected renderer
 * ------------------------------------------------------------------ */

/** What the web app's renderer hands back for one dashboard. */
export interface RenderedDashboard {
  /** The dashboard's name at render time. */
  name: string;
  /** The PDF, or null when the schedule does not attach one. */
  pdf: Uint8Array | null;
  /**
   * One line per card worth quoting in the message body: "Spend by
   * provider: $4,305 (last 30 days)". Already formatted; bounded here.
   */
  highlights: string[];
  /** Deep link to the dashboard; null when APP_URL is unset. */
  url: string | null;
}

export interface DashboardRenderRequest {
  organizationId: string;
  dashboardId: string;
  /** Whether to produce the PDF (`attach_pdf`); highlights are always built. */
  includePdf: boolean;
  /** The schedule's zone, for the "generated at" line. */
  timezone: string;
  /**
   * Who the schedule was created by. Cards are rendered with the org's data
   * either way; this is recorded for the audit trail of what ran.
   */
  createdByUserId: string | null;
  now: Date;
}

/**
 * Renders a dashboard for delivery. Returns null when the dashboard no longer
 * exists. May throw: a render failure is recorded on the schedule as a
 * retryable failure, exactly like a report that could not run.
 */
export type DashboardRenderer = (req: DashboardRenderRequest) => Promise<RenderedDashboard | null>;

/* ------------------------------------------------------------------ *
 * Views and store
 * ------------------------------------------------------------------ */

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

export function toDashboardNotificationView(row: ReportNotificationRecord): DashboardNotification {
  return {
    id: row.id,
    dashboardId: row.dashboardId ?? "",
    cadence: row.cadence as ReportNotificationCadence,
    sendDay: row.sendDay,
    sendDayOfMonth: row.sendDayOfMonth,
    hour: row.hour,
    timezone: row.timezone,
    slackChannelIds: asStringArray(row.slackChannelIds),
    teamsWebhookIds: asStringArray(row.teamsWebhookIds),
    emailRecipients: asStringArray(row.emailRecipients),
    enabled: row.enabled,
    attachPdf: row.attachPdf,
    nextSendAt: row.nextSendAt?.toISOString() ?? null,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    lastStatus: (row.lastStatus as ReportNotificationStatus | null) ?? null,
    lastError: row.lastError,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The live (non-deleted) dashboard row, or a 404-shaped error. */
export async function requireLiveDashboard(
  organizationId: string,
  dashboardId: string,
): Promise<{ id: string; name: string }> {
  const [row] = await db
    .select({ id: dashboards.id, name: dashboards.name })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new ReportNotificationInputError("Dashboard not found", 404);
  return row;
}

/** One dashboard's schedules, oldest first. */
export async function listDashboardNotifications(
  organizationId: string,
  dashboardId: string,
): Promise<DashboardNotification[]> {
  await requireLiveDashboard(organizationId, dashboardId);
  const rows = await db
    .select()
    .from(reportNotifications)
    .where(
      and(
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.dashboardId, dashboardId),
      ),
    )
    .orderBy(asc(reportNotifications.createdAt), asc(reportNotifications.id));
  return rows.map(toDashboardNotificationView);
}

/** Every dashboard schedule in the org, joined to live dashboards only. */
export async function listOrgDashboardNotifications(
  organizationId: string,
): Promise<DashboardNotification[]> {
  const rows = await db
    .select({ notification: reportNotifications })
    .from(reportNotifications)
    .innerJoin(dashboards, eq(dashboards.id, reportNotifications.dashboardId))
    .where(
      and(eq(reportNotifications.organizationId, organizationId), isNull(dashboards.deletedAt)),
    )
    .orderBy(asc(reportNotifications.createdAt), asc(reportNotifications.id));
  return rows.map((r) => toDashboardNotificationView(r.notification));
}

export async function getDashboardNotificationRow(
  organizationId: string,
  dashboardId: string,
  notificationId: string,
): Promise<ReportNotificationRecord> {
  const [row] = await db
    .select()
    .from(reportNotifications)
    .where(
      and(
        eq(reportNotifications.id, notificationId),
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.dashboardId, dashboardId),
      ),
    )
    .limit(1);
  if (!row) throw new ReportNotificationInputError("Schedule not found", 404);
  return row;
}

export async function createDashboardNotification(
  organizationId: string,
  dashboardId: string,
  input: DashboardNotificationInput,
  createdByUserId: string | null,
  now = new Date(),
): Promise<DashboardNotification> {
  await requireLiveDashboard(organizationId, dashboardId);
  const normalized = await normalizeInput(organizationId, input);

  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reportNotifications)
    .where(eq(reportNotifications.dashboardId, dashboardId))) as [{ count: number }];
  if (count >= DASHBOARD_NOTIFICATION_LIMITS.maxPerDashboard) {
    throw new ReportNotificationInputError(
      `A dashboard can have at most ${DASHBOARD_NOTIFICATION_LIMITS.maxPerDashboard} delivery schedules`,
    );
  }

  const [created] = await db
    .insert(reportNotifications)
    .values({
      id: randomUUID(),
      organizationId,
      costReportId: null,
      dashboardId,
      ...normalized,
      attachPdf: input.attachPdf !== false,
      // Armed at the true next fire, never "right now": the report rule.
      nextSendAt: normalized.enabled ? nextReportSendAt(scheduleOf(normalized), now) : null,
      createdByUserId,
    })
    .returning();
  return toDashboardNotificationView(created!);
}

/** Full replace; clears parked failure state like the report update does. */
export async function updateDashboardNotification(
  organizationId: string,
  dashboardId: string,
  notificationId: string,
  input: DashboardNotificationInput,
  now = new Date(),
): Promise<DashboardNotification> {
  await getDashboardNotificationRow(organizationId, dashboardId, notificationId);
  await requireLiveDashboard(organizationId, dashboardId);
  const normalized = await normalizeInput(organizationId, input);

  const [updated] = await db
    .update(reportNotifications)
    .set({
      ...normalized,
      attachPdf: input.attachPdf !== false,
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
  return toDashboardNotificationView(updated);
}

export async function deleteDashboardNotification(
  organizationId: string,
  dashboardId: string,
  notificationId: string,
): Promise<void> {
  const [deleted] = await db
    .delete(reportNotifications)
    .where(
      and(
        eq(reportNotifications.id, notificationId),
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.dashboardId, dashboardId),
      ),
    )
    .returning({ id: reportNotifications.id });
  if (!deleted) throw new ReportNotificationInputError("Schedule not found", 404);
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/** Lines quoted in a message. Bounded: the PDF is where the rest lives. */
export const MAX_DASHBOARD_HIGHLIGHTS = 8;

/** `Platform costs · Oct 4` in the schedule's zone. */
export function dashboardDeliveryTitle(name: string, now: Date, timezone: string): string {
  let day: string;
  try {
    day = now.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timezone });
  } catch {
    day = now.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return `${name} · ${day}`;
}

/**
 * The message body as structured lines, shared by every transport. `fileNote`
 * says where the PDF went, per transport: attached (email), in the thread
 * (Slack), or nowhere (Teams, or a schedule that does not attach one).
 */
export function dashboardDeliverySegments(
  rendered: Pick<RenderedDashboard, "highlights">,
  fileNote: string | null,
): DigestLine[] {
  const lines: DigestLine[] = [];
  const highlights = rendered.highlights.slice(0, MAX_DASHBOARD_HIGHLIGHTS);
  if (highlights.length === 0) {
    lines.push([
      {
        text: "This dashboard has no cards with a figure to quote. Open it for the full picture.",
        bold: false,
      },
    ]);
  } else {
    for (const h of highlights) lines.push([{ text: `• ${h}`, bold: false }]);
    if (rendered.highlights.length > highlights.length) {
      lines.push([
        {
          text: `…and ${rendered.highlights.length - highlights.length} more card(s).`,
          bold: false,
        },
      ]);
    }
  }
  if (fileNote) {
    lines.push([]);
    lines.push([{ text: fileNote, bold: false }]);
  }
  return lines;
}

function flatten(lines: DigestLine[], bold: (s: string) => string, join: string): string {
  return lines.map((line) => line.map((s) => (s.bold ? bold(s.text) : s.text)).join("")).join(join);
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

/** Send one rendered dashboard to a schedule's destinations. Never throws. */
export async function deliverDashboardNotification(
  organizationId: string,
  row: Pick<
    ReportNotificationRecord,
    "id" | "slackChannelIds" | "teamsWebhookIds" | "emailRecipients" | "attachPdf" | "timezone"
  >,
  rendered: RenderedDashboard,
  now: Date,
  origin = "scheduled",
): Promise<DashboardNotificationSendResult> {
  const slackIds = asStringArray(row.slackChannelIds);
  const teamsIds = asStringArray(row.teamsWebhookIds);
  const recipients = asStringArray(row.emailRecipients);
  const pdf = row.attachPdf ? rendered.pdf : null;
  const filename = pdfFileName(rendered.name, "dashboard");

  const [org] = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const title = dashboardDeliveryTitle(rendered.name, now, row.timezone);
  const context = org ? `${org.displayName} · Infrawrench dashboard` : undefined;

  const emailLines = dashboardDeliverySegments(
    rendered,
    pdf ? `The full dashboard is attached as ${filename}.` : null,
  );
  const text =
    recipients.length > 0
      ? [
          title,
          "",
          flatten(emailLines, (s) => s, "\n"),
          ...(rendered.url ? ["", `View in Infrawrench: ${rendered.url}`] : []),
        ].join("\n")
      : "";
  const html =
    recipients.length > 0 ? formatSegmentsEmailHtml(title, emailLines, rendered.url) : "";
  const emails: EmailMessage[] = recipients.map((to) => ({
    to,
    subject: title,
    text,
    html,
    ...(pdf ? { attachments: [{ filename, content: pdf, contentType: "application/pdf" }] } : {}),
    traceKey: `dashboard-notification:${row.id}:${now.toISOString().slice(0, 10)}:${origin}:${to}`,
  }));

  const [slack, teams, email] = await Promise.all([
    sendSlackToChannelsWithFile(
      organizationId,
      slackIds,
      {
        title,
        body: flatten(
          dashboardDeliverySegments(
            rendered,
            pdf ? "The full dashboard PDF is in the thread." : null,
          ),
          (s) => `*${s}*`,
          "\n",
        ),
        ...(rendered.url ? { url: rendered.url } : {}),
        ...(context ? { context } : {}),
      },
      pdf ? { filename, title: `${rendered.name} (PDF)`, content: pdf } : null,
    ),
    sendMsTeamsToWebhooks(organizationId, teamsIds, {
      title,
      body: flatten(
        dashboardDeliverySegments(
          rendered,
          rendered.url
            ? "Open the dashboard for the full picture or to download it as a PDF."
            : null,
        ),
        (s) => s,
        "\n\n",
      ),
      ...(rendered.url ? { url: rendered.url } : {}),
      ...(context ? { context } : {}),
    }),
    sendEmails(emails, `dashboard notification ${row.id}`),
  ]);

  // Unsendable addresses count as attempted-and-failed: the report rule.
  const emailAttempted = recipients.length;
  return {
    attempted: slack.attempted + teams.attempted + emailAttempted,
    succeeded: slack.succeeded + teams.succeeded + email.succeeded,
    slack: { attempted: slack.attempted, succeeded: slack.succeeded },
    teams: { attempted: teams.attempted, succeeded: teams.succeeded },
    email: { attempted: emailAttempted, succeeded: email.succeeded },
    pdfAttached: pdf !== null,
    slackFilesUploaded: slack.filesUploaded,
  };
}

async function recordAttempt(
  row: ReportNotificationRecord,
  now: Date,
  outcome: { status: ReportDeliveryStatus; error: string | null; retryable: boolean },
): Promise<void> {
  const attemptCount = row.attemptCount + 1;
  const spent = attemptCount >= MAX_REPORT_DELIVERY_ATTEMPTS;
  const retryAt = outcome.retryable ? nextReportDeliveryAttemptAt(now, attemptCount) : null;
  const nextSendAt = row.enabled ? (retryAt ?? nextReportSendAt(scheduleOf(row), now)) : null;
  try {
    await db
      .update(reportNotifications)
      .set({
        lastStatus: outcome.status,
        lastError: outcome.error,
        lastAttemptAt: now,
        ...(outcome.status === "succeeded" || outcome.status === "partial"
          ? { lastSentAt: now }
          : {}),
        attemptCount: outcome.retryable && !spent ? attemptCount : 0,
        nextSendAt,
        updatedAt: now,
      })
      .where(eq(reportNotifications.id, row.id));
  } catch (err) {
    console.error(`[dashboard-delivery] ${row.id}: failed to record attempt outcome:`, err);
  }
}

/** Render, deliver and record one claimed schedule. Never throws. */
export async function runDashboardNotification(
  row: ReportNotificationRecord,
  render: DashboardRenderer,
  now = new Date(),
): Promise<void> {
  try {
    const rendered = row.dashboardId
      ? await render({
          organizationId: row.organizationId,
          dashboardId: row.dashboardId,
          includePdf: row.attachPdf,
          timezone: row.timezone,
          createdByUserId: row.createdByUserId,
          now,
        })
      : null;
    if (!rendered) {
      // Soft-deleted under the schedule (a hard delete cascades). Park it.
      await db
        .update(reportNotifications)
        .set({
          enabled: false,
          nextSendAt: null,
          lastStatus: "failed",
          lastError: "The dashboard this schedule delivers was deleted.",
          updatedAt: now,
        })
        .where(eq(reportNotifications.id, row.id))
        .catch((err: unknown) =>
          console.error(`[dashboard-delivery] ${row.id}: failed to park orphaned schedule:`, err),
        );
      return;
    }
    const result = await deliverDashboardNotification(row.organizationId, row, rendered, now);
    const outcome = classifyReportDelivery(result);
    await recordAttempt(row, now, outcome);
    const line = `[dashboard-delivery] ${row.id} (dashboard "${rendered.name}") attempt ${row.attemptCount + 1}/${MAX_REPORT_DELIVERY_ATTEMPTS}: ${outcome.status}; slack ${result.slack.succeeded}/${result.slack.attempted} (files ${result.slackFilesUploaded}), teams ${result.teams.succeeded}/${result.teams.attempted}, email ${result.email.succeeded}/${result.email.attempted}`;
    if (outcome.status === "succeeded") console.log(line);
    else console.warn(`${line}${outcome.error ? `: ${outcome.error}` : ""}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAttempt(row, now, {
      status: "failed",
      error: `Could not render the dashboard: ${message}`,
      retryable: true,
    });
    console.error(`[dashboard-delivery] ${row.id} (dashboard ${row.dashboardId}) failed:`, err);
  }
}

/**
 * "Send now": render and deliver immediately, ignoring the schedule. Throws
 * when nothing could be delivered, because the caller is a person.
 */
export async function sendDashboardNotificationNow(
  organizationId: string,
  dashboardId: string,
  notificationId: string,
  render: DashboardRenderer,
  now = new Date(),
): Promise<DashboardNotificationSendResult> {
  const row = await getDashboardNotificationRow(organizationId, dashboardId, notificationId);
  const rendered = await render({
    organizationId,
    dashboardId,
    includePdf: row.attachPdf,
    timezone: row.timezone,
    createdByUserId: row.createdByUserId,
    now,
  });
  if (!rendered) throw new ReportNotificationInputError("Dashboard not found", 404);

  const result = await deliverDashboardNotification(
    organizationId,
    row,
    rendered,
    now,
    `manual-${now.toISOString()}`,
  );
  if (result.attempted === 0) {
    throw new ReportNotificationInputError(
      "This schedule has no live destinations. Pick a Slack channel or Teams webhook, or add an email recipient.",
    );
  }
  const outcome = classifyReportDelivery(result);
  try {
    await db
      .update(reportNotifications)
      .set({
        lastStatus: outcome.status,
        lastError: outcome.error,
        lastAttemptAt: now,
        attemptCount: 0,
        ...(outcome.status === "succeeded" || outcome.status === "partial"
          ? { lastSentAt: now }
          : {}),
        updatedAt: now,
      })
      .where(eq(reportNotifications.id, row.id));
  } catch (err) {
    console.error(`[dashboard-delivery] ${row.id}: failed to record manual send:`, err);
  }
  if (result.succeeded === 0) {
    const emailOnly =
      result.slack.attempted === 0 && result.teams.attempted === 0 && result.email.attempted > 0;
    throw new ReportNotificationInputError(
      emailOnly && !isEmailConfigured()
        ? "This schedule only has email recipients and this deployment has no mail provider configured (MAILGUN_API_KEY, MAILGUN_DOMAIN, EMAIL_FROM)."
        : `The dashboard could not be delivered to any of its ${result.attempted} destination(s). Check the Slack, Teams and email settings.`,
    );
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Claim and pass
 * ------------------------------------------------------------------ */

/**
 * Lease for one dashboard delivery: a render (several cost queries and any
 * custom-graph scripts) plus the fan-out. Same budget as the report lease,
 * for the same reason: too short and a second replica double-posts.
 */
export const DASHBOARD_DELIVERY_LEASE_MS = 10 * 60 * 1000;

/** Claimed per tick: renders are heavier than report runs, so fewer. */
export const DASHBOARD_DELIVERIES_PER_TICK = 2;

/**
 * Claim due dashboard schedules: the report claim's statement, filtered on
 * `dashboard_id`. `FOR UPDATE SKIP LOCKED` makes it safe for every web
 * replica to run the loop; a row is only ever handed to one of them.
 */
export async function claimDueDashboardNotifications(
  limit: number,
): Promise<ReportNotificationRecord[]> {
  const claimed = await db.execute(sql`
    UPDATE report_notifications
    SET next_send_at = now() + ${DASHBOARD_DELIVERY_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT id FROM report_notifications
      WHERE enabled = true
        AND dashboard_id IS NOT NULL
        AND next_send_at IS NOT NULL
        AND next_send_at <= now()
      ORDER BY next_send_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  const ids = Array.from(claimed as Iterable<Record<string, unknown>>, (r) => String(r["id"]));
  if (ids.length === 0) return [];
  // Re-read through drizzle for typed rows rather than hand-mapping columns.
  const rows = await Promise.all(
    ids.map((id) =>
      db
        .select()
        .from(reportNotifications)
        .where(eq(reportNotifications.id, id))
        .limit(1)
        .then((r) => r[0]),
    ),
  );
  return rows.filter((r): r is ReportNotificationRecord => r !== undefined);
}

/** One tick's worth of dashboard deliveries. */
export async function runDashboardDeliveryPass(
  render: DashboardRenderer,
  opts: { limit?: number } = {},
): Promise<void> {
  const claimed = await claimDueDashboardNotifications(opts.limit ?? DASHBOARD_DELIVERIES_PER_TICK);
  if (claimed.length === 0) return;
  console.log(`[dashboard-delivery] sending ${claimed.length} due schedule(s)`);
  await Promise.allSettled(claimed.map((row) => runDashboardNotification(row, render)));
}
