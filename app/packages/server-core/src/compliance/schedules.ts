/**
 * Scheduled evidence-pack delivery: the dashboard schedule mechanism pointed
 * at a compliance framework (`report_notifications` with
 * `compliance_framework_id` set).
 *
 * Shared with dashboards and canvases: validation (`normalizeInput`), the
 * schedule arithmetic (`nextReportSendAt`, which knows `quarterly` for these
 * rows only), the retry rules (`classifyReportDelivery`), the attempt
 * bookkeeping (`recordAttempt`) and the claim protocol. Rows are claimed by
 * the web process's delivery loop beside dashboards, because a pack is built
 * from the same web-side feeds.
 *
 * Each delivery covers the previous calendar month or quarter in the
 * schedule's zone (`compliancePackPeriodFor`), and renders with full access:
 * creating a schedule needs `org:settings:write`, the dashboard-schedule rule.
 *
 * Transports: email attaches the ZIP; Slack posts the summary and uploads the
 * ZIP in the thread (soft-failing without `files:write`); Teams gets the
 * summary and a link, since its webhooks cannot carry a file.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  COMPLIANCE_PACK_CADENCES,
  COMPLIANCE_PACK_SCHEDULE_LIMITS,
  COMPLIANCE_CONTROL_STATUS_LABELS,
  compliancePackPeriodFor,
  type CompliancePackCadence,
  type CompliancePackSchedule,
  type CompliancePackScheduleInput,
  type DashboardNotificationSendResult,
  type ReportNotificationStatus,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { organizations, reportNotifications } from "../db/schema";
import { isEmailConfigured, sendEmails, type EmailMessage } from "../email";
import { sendSlackToChannelsWithFile } from "../slack";
import { sendMsTeamsToWebhooks } from "../msteams";
import { civilMoment, formatSegmentsEmailHtml, type DigestLine } from "../digest/compose";
import { orgAppUrl } from "../app-url";
import { classifyReportDelivery, nextReportSendAt, MAX_REPORT_DELIVERY_ATTEMPTS } from "../report-delivery/compose";
import {
  ReportNotificationInputError,
  normalizeInput,
  scheduleOf,
  type ReportNotificationRecord,
} from "../report-delivery/store";
import { recordAttempt } from "../report-delivery/dashboard";
import { buildEvidencePack, type EvidencePack } from "./pack";
import { requireFramework } from "./status";

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

export function toCompliancePackScheduleView(row: ReportNotificationRecord): CompliancePackSchedule {
  return {
    id: row.id,
    frameworkId: row.complianceFrameworkId ?? "",
    cadence: row.cadence as CompliancePackCadence,
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

/** Validate a pack schedule: the shared report rules plus the pack's own cadence. */
async function normalizePackInput(organizationId: string, input: CompliancePackScheduleInput) {
  requireFramework(input.frameworkId);
  if (!COMPLIANCE_PACK_CADENCES.includes(input.cadence)) {
    throw new ReportNotificationInputError(
      `cadence must be one of: ${COMPLIANCE_PACK_CADENCES.join(", ")}`,
    );
  }
  // `normalizeInput` validates everything but the cadence vocabulary, which
  // only pack schedules extend; pass it a cadence it knows, then restore ours.
  const normalized = await normalizeInput(organizationId, {
    cadence: "monthly",
    sendDayOfMonth: input.sendDayOfMonth,
    hour: input.hour,
    timezone: input.timezone,
    slackChannelIds: input.slackChannelIds ?? [],
    teamsWebhookIds: input.teamsWebhookIds ?? [],
    emailRecipients: input.emailRecipients,
    enabled: input.enabled,
  });
  return { ...normalized, cadence: input.cadence as string, sendDay: 1 };
}

export async function listCompliancePackSchedules(
  organizationId: string,
  frameworkId?: string,
): Promise<CompliancePackSchedule[]> {
  const rows = await db
    .select()
    .from(reportNotifications)
    .where(
      and(
        eq(reportNotifications.organizationId, organizationId),
        frameworkId
          ? eq(reportNotifications.complianceFrameworkId, frameworkId)
          : isNotNull(reportNotifications.complianceFrameworkId),
      ),
    )
    .orderBy(asc(reportNotifications.createdAt), asc(reportNotifications.id));
  return rows.map(toCompliancePackScheduleView);
}

export async function getCompliancePackScheduleRow(
  organizationId: string,
  scheduleId: string,
): Promise<ReportNotificationRecord> {
  const [row] = await db
    .select()
    .from(reportNotifications)
    .where(
      and(
        eq(reportNotifications.id, scheduleId),
        eq(reportNotifications.organizationId, organizationId),
        isNotNull(reportNotifications.complianceFrameworkId),
      ),
    )
    .limit(1);
  if (!row) throw new ReportNotificationInputError("Schedule not found", 404);
  return row;
}

export async function createCompliancePackSchedule(
  organizationId: string,
  input: CompliancePackScheduleInput,
  createdByUserId: string | null,
  now = new Date(),
): Promise<CompliancePackSchedule> {
  const normalized = await normalizePackInput(organizationId, input);
  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reportNotifications)
    .where(
      and(
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.complianceFrameworkId, input.frameworkId),
      ),
    )) as [{ count: number }];
  if (count >= COMPLIANCE_PACK_SCHEDULE_LIMITS.maxPerFramework) {
    throw new ReportNotificationInputError(
      `A framework can have at most ${COMPLIANCE_PACK_SCHEDULE_LIMITS.maxPerFramework} pack schedules`,
    );
  }
  const [created] = await db
    .insert(reportNotifications)
    .values({
      id: randomUUID(),
      organizationId,
      costReportId: null,
      complianceFrameworkId: input.frameworkId,
      ...normalized,
      attachPdf: true,
      nextSendAt: normalized.enabled ? nextReportSendAt(scheduleOf(normalized), now) : null,
      createdByUserId,
    })
    .returning();
  return toCompliancePackScheduleView(created!);
}

/** Full replace. The framework may change; parked failure state is cleared. */
export async function updateCompliancePackSchedule(
  organizationId: string,
  scheduleId: string,
  input: CompliancePackScheduleInput,
  now = new Date(),
): Promise<CompliancePackSchedule> {
  await getCompliancePackScheduleRow(organizationId, scheduleId);
  const normalized = await normalizePackInput(organizationId, input);
  const [updated] = await db
    .update(reportNotifications)
    .set({
      ...normalized,
      complianceFrameworkId: input.frameworkId,
      nextSendAt: normalized.enabled ? nextReportSendAt(scheduleOf(normalized), now) : null,
      attemptCount: 0,
      lastStatus: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(eq(reportNotifications.id, scheduleId), eq(reportNotifications.organizationId, organizationId)),
    )
    .returning();
  if (!updated) throw new ReportNotificationInputError("Schedule not found", 404);
  return toCompliancePackScheduleView(updated);
}

export async function deleteCompliancePackSchedule(
  organizationId: string,
  scheduleId: string,
): Promise<void> {
  const [deleted] = await db
    .delete(reportNotifications)
    .where(
      and(
        eq(reportNotifications.id, scheduleId),
        eq(reportNotifications.organizationId, organizationId),
        isNotNull(reportNotifications.complianceFrameworkId),
      ),
    )
    .returning({ id: reportNotifications.id });
  if (!deleted) throw new ReportNotificationInputError("Schedule not found", 404);
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

/** The pack a schedule delivers when it fires at `now`. */
export async function buildScheduledPack(row: ReportNotificationRecord, now: Date): Promise<EvidencePack> {
  const today = civilMoment(now, row.timezone).date;
  const period = compliancePackPeriodFor(row.cadence as CompliancePackCadence, today);
  return buildEvidencePack(row.organizationId, row.complianceFrameworkId ?? "", {
    period,
    now,
    canRead: null,
    generatedBy: "Scheduled delivery",
    timezone: row.timezone,
  });
}

function packLines(pack: EvidencePack, fileNote: string | null): DigestLine[] {
  const { status } = pack;
  const lines: DigestLine[] = [
    [{ text: `Period ${status.period.from} to ${status.period.to}`, bold: false }],
    [
      { text: `${status.counts.evidence}`, bold: true },
      { text: ` controls with evidence, `, bold: false },
      { text: `${status.counts.gaps}`, bold: true },
      { text: ` with gaps, ${status.counts.notApplicable} not applicable.`, bold: false },
    ],
  ];
  const gaps = status.controls.filter((c) => c.status === "gaps").slice(0, 8);
  for (const c of gaps) {
    lines.push([{ text: `• ${c.id} ${c.title}: ${COMPLIANCE_CONTROL_STATUS_LABELS[c.status]}`, bold: false }]);
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

/** Send one built pack to a schedule's destinations. Never throws. */
export async function deliverCompliancePack(
  row: ReportNotificationRecord,
  pack: EvidencePack,
  now: Date,
  origin = "scheduled",
): Promise<DashboardNotificationSendResult> {
  const slackIds = asStringArray(row.slackChannelIds);
  const teamsIds = asStringArray(row.teamsWebhookIds);
  const recipients = asStringArray(row.emailRecipients);
  const [org] = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, row.organizationId));
  const title = `${pack.status.framework.name} evidence pack · ${pack.status.period.from} to ${pack.status.period.to}`;
  const context = org ? `${org.displayName} · Infrawrench compliance` : undefined;
  const url = orgAppUrl(row.organizationId, "compliance");

  const emailLines = packLines(pack, `The evidence pack is attached as ${pack.filename}.`);
  const text = [title, "", flatten(emailLines, (s) => s, "\n"), ...(url ? ["", `View in Infrawrench: ${url}`] : [])].join("\n");
  const html = recipients.length > 0 ? formatSegmentsEmailHtml(title, emailLines, url) : "";
  const emails: EmailMessage[] = recipients.map((to) => ({
    to,
    subject: title,
    text,
    html,
    attachments: [{ filename: pack.filename, content: pack.bytes, contentType: "application/zip" }],
    traceKey: `compliance-pack:${row.id}:${now.toISOString().slice(0, 10)}:${origin}:${to}`,
  }));

  const [slack, teams, email] = await Promise.all([
    sendSlackToChannelsWithFile(
      row.organizationId,
      slackIds,
      {
        title,
        body: flatten(packLines(pack, "The evidence pack is in the thread."), (s) => `*${s}*`, "\n"),
        ...(url ? { url } : {}),
        ...(context ? { context } : {}),
      },
      { filename: pack.filename, title: `${pack.status.framework.name} evidence pack`, content: pack.bytes },
    ),
    sendMsTeamsToWebhooks(row.organizationId, teamsIds, {
      title,
      body: flatten(packLines(pack, url ? "Open Compliance in Infrawrench to download the pack." : null), (s) => s, "\n\n"),
      ...(url ? { url } : {}),
      ...(context ? { context } : {}),
    }),
    sendEmails(emails, `compliance pack ${row.id}`),
  ]);
  return {
    attempted: slack.attempted + teams.attempted + recipients.length,
    succeeded: slack.succeeded + teams.succeeded + email.succeeded,
    slack: { attempted: slack.attempted, succeeded: slack.succeeded },
    teams: { attempted: teams.attempted, succeeded: teams.succeeded },
    email: { attempted: recipients.length, succeeded: email.succeeded },
    pdfAttached: true,
    slackFilesUploaded: slack.filesUploaded,
  };
}

/** Build, deliver and record one claimed schedule. Never throws. */
export async function runCompliancePackSchedule(row: ReportNotificationRecord, now = new Date()): Promise<void> {
  try {
    const pack = await buildScheduledPack(row, now);
    const result = await deliverCompliancePack(row, pack, now);
    const outcome = classifyReportDelivery(result);
    await recordAttempt(row, now, outcome);
    const line = `[compliance-pack] ${row.id} (${row.complianceFrameworkId}) attempt ${row.attemptCount + 1}/${MAX_REPORT_DELIVERY_ATTEMPTS}: ${outcome.status}; slack ${result.slack.succeeded}/${result.slack.attempted}, teams ${result.teams.succeeded}/${result.teams.attempted}, email ${result.email.succeeded}/${result.email.attempted}`;
    if (outcome.status === "succeeded") console.log(line);
    else console.warn(`${line}${outcome.error ? `: ${outcome.error}` : ""}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAttempt(row, now, {
      status: "failed",
      error: `Could not build the evidence pack: ${message}`,
      retryable: true,
    });
    console.error(`[compliance-pack] ${row.id} failed:`, err);
  }
}

/** "Send now": build the pack for the period the next delivery would cover, and send it. */
export async function sendCompliancePackScheduleNow(
  organizationId: string,
  scheduleId: string,
  now = new Date(),
): Promise<DashboardNotificationSendResult> {
  const row = await getCompliancePackScheduleRow(organizationId, scheduleId);
  const pack = await buildScheduledPack(row, now);
  const result = await deliverCompliancePack(row, pack, now, `manual-${now.toISOString()}`);
  if (result.attempted === 0) {
    throw new ReportNotificationInputError(
      "This schedule has no live destinations. Add an email recipient or pick a Slack channel.",
    );
  }
  const outcome = classifyReportDelivery(result);
  await db
    .update(reportNotifications)
    .set({
      lastStatus: outcome.status,
      lastError: outcome.error,
      lastAttemptAt: now,
      attemptCount: 0,
      ...(outcome.status === "succeeded" || outcome.status === "partial" ? { lastSentAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(reportNotifications.id, row.id))
    .catch((err: unknown) => console.error(`[compliance-pack] ${row.id}: failed to record manual send:`, err));
  if (result.succeeded === 0) {
    const emailOnly = result.slack.attempted === 0 && result.teams.attempted === 0;
    throw new ReportNotificationInputError(
      emailOnly && !isEmailConfigured()
        ? "This schedule only has email recipients and this deployment has no mail provider configured (MAILGUN_API_KEY, MAILGUN_DOMAIN, EMAIL_FROM)."
        : `The evidence pack could not be delivered to any of its ${result.attempted} destination(s).`,
    );
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Claim and pass
 * ------------------------------------------------------------------ */

/** A pack reads every evidence feed; same lease as a dashboard render. */
export const COMPLIANCE_PACK_LEASE_MS = 10 * 60 * 1000;
export const COMPLIANCE_PACKS_PER_TICK = 1;

export async function claimDueCompliancePackSchedules(limit: number): Promise<ReportNotificationRecord[]> {
  const claimed = await db.execute(sql`
    UPDATE report_notifications
    SET next_send_at = now() + ${COMPLIANCE_PACK_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT id FROM report_notifications
      WHERE enabled = true
        AND compliance_framework_id IS NOT NULL
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

/** One tick's worth of pack deliveries; the web delivery loop calls it. */
export async function runCompliancePackDeliveryPass(opts: { limit?: number } = {}): Promise<void> {
  const claimed = await claimDueCompliancePackSchedules(opts.limit ?? COMPLIANCE_PACKS_PER_TICK);
  if (claimed.length === 0) return;
  console.log(`[compliance-pack] sending ${claimed.length} due schedule(s)`);
  await Promise.allSettled(claimed.map((row) => runCompliancePackSchedule(row)));
}
