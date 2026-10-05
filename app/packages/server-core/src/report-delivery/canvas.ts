/**
 * Scheduled cost-canvas delivery: the dashboard schedule mechanism pointed at
 * a canvas (`report_notifications` with `cost_canvas_id` set).
 *
 * Everything but the target is shared with `dashboard.ts`: validation
 * (`normalizeInput`), schedule arithmetic, the retry rules, the transports
 * (`deliverDashboardNotification` with the `canvas` noun) and the attempt
 * bookkeeping (`recordAttempt`). Rendering is injected for the same reason
 * it is for dashboards: running a canvas needs the web app's query services,
 * so the rows are claimed by the web process's delivery loop.
 *
 * Unlike a dashboard schedule, a canvas schedule records the creator's cost
 * visibility (`visibility_user_id`, set when the creator was scoped) and the
 * renderer runs inside that scope, the rule every other unattended cost
 * object follows. A canvas's numbers are always re-queried; nothing about a
 * delivery reads a stored figure.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  COST_CANVAS_LIMITS,
  type CostCanvasNotification,
  type CostCanvasNotificationInput,
  type CostCanvasNotificationSendResult,
  type ReportNotificationCadence,
  type ReportNotificationStatus,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costCanvases, reportNotifications } from "../db/schema";
import { isEmailConfigured } from "../email";
import { scopedViewerUserId } from "../cost/visibility-context";
import { classifyReportDelivery, nextReportSendAt, MAX_REPORT_DELIVERY_ATTEMPTS } from "./compose";
import {
  ReportNotificationInputError,
  normalizeInput,
  scheduleOf,
  type ReportNotificationRecord,
} from "./store";
import { deliverDashboardNotification, recordAttempt, type RenderedDashboard } from "./dashboard";

export interface CanvasRenderRequest {
  organizationId: string;
  costCanvasId: string;
  includePdf: boolean;
  timezone: string;
  /** The scoped creator whose cost visibility the render runs under; null = org-wide. */
  visibilityUserId: string | null;
  createdByUserId: string | null;
  now: Date;
}

/** Renders a canvas for delivery; null when the canvas no longer exists. May throw. */
export type CanvasRenderer = (req: CanvasRenderRequest) => Promise<RenderedDashboard | null>;

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

export function toCostCanvasNotificationView(
  row: ReportNotificationRecord,
): CostCanvasNotification {
  return {
    id: row.id,
    costCanvasId: row.costCanvasId ?? "",
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

/** The live canvas row, or a 404-shaped error. */
export async function requireLiveCanvas(
  organizationId: string,
  canvasId: string,
): Promise<{ id: string; name: string }> {
  const [row] = await db
    .select({ id: costCanvases.id, name: costCanvases.name })
    .from(costCanvases)
    .where(
      and(
        eq(costCanvases.id, canvasId),
        eq(costCanvases.organizationId, organizationId),
        isNull(costCanvases.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new ReportNotificationInputError("Canvas not found", 404);
  return row;
}

/** A scoped caller sees and manages only the schedules that deliver within their own scope. */
function visibleToCaller(organizationId: string, row: ReportNotificationRecord): boolean {
  const viewer = scopedViewerUserId(organizationId);
  return viewer === undefined || row.visibilityUserId === viewer;
}

export async function listCanvasNotifications(
  organizationId: string,
  canvasId: string,
): Promise<CostCanvasNotification[]> {
  await requireLiveCanvas(organizationId, canvasId);
  const rows = await db
    .select()
    .from(reportNotifications)
    .where(
      and(
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.costCanvasId, canvasId),
      ),
    )
    .orderBy(asc(reportNotifications.createdAt), asc(reportNotifications.id));
  return rows.filter((r) => visibleToCaller(organizationId, r)).map(toCostCanvasNotificationView);
}

export async function getCanvasNotificationRow(
  organizationId: string,
  canvasId: string,
  notificationId: string,
): Promise<ReportNotificationRecord> {
  const [row] = await db
    .select()
    .from(reportNotifications)
    .where(
      and(
        eq(reportNotifications.id, notificationId),
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.costCanvasId, canvasId),
      ),
    )
    .limit(1);
  if (!row || !visibleToCaller(organizationId, row)) {
    throw new ReportNotificationInputError("Schedule not found", 404);
  }
  return row;
}

export async function createCanvasNotification(
  organizationId: string,
  canvasId: string,
  input: CostCanvasNotificationInput,
  createdByUserId: string | null,
  now = new Date(),
): Promise<CostCanvasNotification> {
  await requireLiveCanvas(organizationId, canvasId);
  const normalized = await normalizeInput(organizationId, input);

  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reportNotifications)
    .where(eq(reportNotifications.costCanvasId, canvasId))) as [{ count: number }];
  if (count >= COST_CANVAS_LIMITS.maxNotificationsPerCanvas) {
    throw new ReportNotificationInputError(
      `A canvas can have at most ${COST_CANVAS_LIMITS.maxNotificationsPerCanvas} delivery schedules`,
    );
  }

  const [created] = await db
    .insert(reportNotifications)
    .values({
      id: randomUUID(),
      organizationId,
      costReportId: null,
      dashboardId: null,
      costCanvasId: canvasId,
      ...normalized,
      attachPdf: input.attachPdf !== false,
      nextSendAt: normalized.enabled ? nextReportSendAt(scheduleOf(normalized), now) : null,
      visibilityUserId: scopedViewerUserId(organizationId) ?? null,
      createdByUserId,
    })
    .returning();
  return toCostCanvasNotificationView(created!);
}

export async function updateCanvasNotification(
  organizationId: string,
  canvasId: string,
  notificationId: string,
  input: CostCanvasNotificationInput,
  now = new Date(),
): Promise<CostCanvasNotification> {
  await getCanvasNotificationRow(organizationId, canvasId, notificationId);
  await requireLiveCanvas(organizationId, canvasId);
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
  return toCostCanvasNotificationView(updated);
}

export async function deleteCanvasNotification(
  organizationId: string,
  canvasId: string,
  notificationId: string,
): Promise<void> {
  await getCanvasNotificationRow(organizationId, canvasId, notificationId);
  await db
    .delete(reportNotifications)
    .where(
      and(
        eq(reportNotifications.id, notificationId),
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.costCanvasId, canvasId),
      ),
    );
}

/** Soft-deleting a canvas parks its schedules (the FK cascade covers a hard delete). */
export async function disableCanvasNotifications(
  organizationId: string,
  canvasId: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(reportNotifications)
    .set({ enabled: false, nextSendAt: null, updatedAt: now })
    .where(
      and(
        eq(reportNotifications.organizationId, organizationId),
        eq(reportNotifications.costCanvasId, canvasId),
      ),
    );
}

function renderRequestFor(row: ReportNotificationRecord, now: Date): CanvasRenderRequest {
  return {
    organizationId: row.organizationId,
    costCanvasId: row.costCanvasId ?? "",
    includePdf: row.attachPdf,
    timezone: row.timezone,
    visibilityUserId: row.visibilityUserId,
    createdByUserId: row.createdByUserId,
    now,
  };
}

/** Render, deliver and record one claimed canvas schedule. Never throws. */
export async function runCanvasNotification(
  row: ReportNotificationRecord,
  render: CanvasRenderer,
  now = new Date(),
): Promise<void> {
  try {
    const rendered = row.costCanvasId ? await render(renderRequestFor(row, now)) : null;
    if (!rendered) {
      await db
        .update(reportNotifications)
        .set({
          enabled: false,
          nextSendAt: null,
          lastStatus: "failed",
          lastError: "The canvas this schedule delivers was deleted.",
          updatedAt: now,
        })
        .where(eq(reportNotifications.id, row.id))
        .catch((err: unknown) =>
          console.error(`[canvas-delivery] ${row.id}: failed to park orphaned schedule:`, err),
        );
      return;
    }
    const result = await deliverDashboardNotification(
      row.organizationId,
      row,
      rendered,
      now,
      "scheduled",
      "canvas",
    );
    const outcome = classifyReportDelivery(result);
    await recordAttempt(row, now, outcome);
    const line = `[canvas-delivery] ${row.id} (canvas "${rendered.name}") attempt ${row.attemptCount + 1}/${MAX_REPORT_DELIVERY_ATTEMPTS}: ${outcome.status}`;
    if (outcome.status === "succeeded") console.log(line);
    else console.warn(`${line}${outcome.error ? `: ${outcome.error}` : ""}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAttempt(row, now, {
      status: "failed",
      error: `Could not render the canvas: ${message}`,
      retryable: true,
    });
    console.error(`[canvas-delivery] ${row.id} (canvas ${row.costCanvasId}) failed:`, err);
  }
}

/** "Send now". Throws when nothing could be delivered, because the caller is a person. */
export async function sendCanvasNotificationNow(
  organizationId: string,
  canvasId: string,
  notificationId: string,
  render: CanvasRenderer,
  now = new Date(),
): Promise<CostCanvasNotificationSendResult> {
  const row = await getCanvasNotificationRow(organizationId, canvasId, notificationId);
  const rendered = await render(renderRequestFor(row, now));
  if (!rendered) throw new ReportNotificationInputError("Canvas not found", 404);
  const result = await deliverDashboardNotification(
    organizationId,
    row,
    rendered,
    now,
    `manual-${now.toISOString()}`,
    "canvas",
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
    console.error(`[canvas-delivery] ${row.id}: failed to record manual send:`, err);
  }
  if (result.succeeded === 0) {
    const emailOnly =
      result.slack.attempted === 0 && result.teams.attempted === 0 && result.email.attempted > 0;
    throw new ReportNotificationInputError(
      emailOnly && !isEmailConfigured()
        ? "This schedule only has email recipients and this deployment has no mail provider configured (MAILGUN_API_KEY, MAILGUN_DOMAIN, EMAIL_FROM)."
        : `The canvas could not be delivered to any of its ${result.attempted} destination(s). Check the Slack, Teams and email settings.`,
    );
  }
  return result;
}

/** Same lease as a dashboard render: a canvas runs a comparable set of queries. */
export const CANVAS_DELIVERY_LEASE_MS = 10 * 60 * 1000;
export const CANVAS_DELIVERIES_PER_TICK = 2;

/** Claim due canvas schedules; `FOR UPDATE SKIP LOCKED`, safe on every replica. */
export async function claimDueCanvasNotifications(
  limit: number,
): Promise<ReportNotificationRecord[]> {
  const claimed = await db.execute(sql`
    UPDATE report_notifications
    SET next_send_at = now() + ${CANVAS_DELIVERY_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT id FROM report_notifications
      WHERE enabled = true
        AND cost_canvas_id IS NOT NULL
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

/** One tick's worth of canvas deliveries. */
export async function runCanvasDeliveryPass(
  render: CanvasRenderer,
  opts: { limit?: number } = {},
): Promise<void> {
  const claimed = await claimDueCanvasNotifications(opts.limit ?? CANVAS_DELIVERIES_PER_TICK);
  if (claimed.length === 0) return;
  console.log(`[canvas-delivery] sending ${claimed.length} due schedule(s)`);
  await Promise.allSettled(claimed.map((row) => runCanvasNotification(row, render)));
}
