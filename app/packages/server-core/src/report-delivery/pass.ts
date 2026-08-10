/**
 * The poller pass that sends due scheduled report deliveries.
 *
 * Same protocol as every other claimed pass in this codebase (see
 * `poller/src/claim.ts` for the canonical write-up): one conditional
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, with the
 * row's own due-time column (`report_notifications.next_send_at`) doubling as
 * the lease. Concurrent poller replicas skip past each other's locked rows
 * instead of blocking, and a row is only ever handed to one claimer. An
 * instance that dies mid-send leaves the lease to expire, at which point the
 * schedule becomes due again — no orphan state, no reaper.
 *
 * This is the **digest pattern, not the alert pass**: what it sends is a
 * scheduled, composed summary addressed by its own row, and it must never be
 * threaded through `alerts/route.ts` (see `./compose.ts` for the full
 * rationale — do not "fix" that later).
 *
 * Nothing here throws into the tick: {@link runReportNotification} records its
 * own failures on the row, and the claim itself is wrapped by the caller.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { runReportNotification } from "./deliver";
import type { ReportNotificationRecord } from "./store";

/**
 * Must exceed the worst-case duration of one delivery: two ClickHouse reads
 * plus a fan-out to Slack, Teams and one request per email address, each with
 * its own timeout. Minutes of budget for tens of seconds of work — too short
 * and a second replica double-posts the same report into the same channel,
 * which no retry rule can undo.
 */
export const REPORT_DELIVERY_LEASE_MS = 10 * 60 * 1000;

/**
 * Schedules claimed per tick. Bounded for the reason the digest is: this
 * shares the poller's 15s tick with account polling and cost collection, and
 * every schedule on the same morning hour comes due within one tick. Claiming
 * moves `next_send_at` forward, so a deferred schedule simply lands in a later
 * tick's batch — a report that arrives a minute late is not late.
 */
export const REPORT_DELIVERIES_PER_TICK = 4;

/**
 * Claim up to `limit` due schedules, leasing each for
 * {@link REPORT_DELIVERY_LEASE_MS}.
 *
 * `next_send_at IS NOT NULL` excludes disabled rows without a second
 * predicate: disabling nulls the column, so "has a due time" and "should run"
 * are the same statement — the `cost_exports` convention.
 */
export async function claimDueReportNotifications(
  limit: number,
): Promise<ReportNotificationRecord[]> {
  const rows = await db.execute(sql`
    UPDATE report_notifications
    SET next_send_at = now() + ${REPORT_DELIVERY_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT id FROM report_notifications
      WHERE enabled = true
        AND next_send_at IS NOT NULL
        AND next_send_at <= now()
      ORDER BY next_send_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  const asStringArray = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];

  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    organizationId: String(r["organization_id"]),
    costReportId: String(r["cost_report_id"]),
    cadence: String(r["cadence"]),
    sendDay: Number(r["send_day"]),
    sendDayOfMonth: Number(r["send_day_of_month"]),
    hour: Number(r["hour"]),
    timezone: String(r["timezone"]),
    slackChannelIds: asStringArray(r["slack_channel_ids"]),
    teamsWebhookIds: asStringArray(r["teams_webhook_ids"]),
    emailRecipients: asStringArray(r["email_recipients"]),
    enabled: r["enabled"] === true,
    nextSendAt: r["next_send_at"] ? new Date(r["next_send_at"] as string) : null,
    lastSentAt: r["last_sent_at"] ? new Date(r["last_sent_at"] as string) : null,
    attemptCount: Number(r["attempt_count"] ?? 0),
    lastAttemptAt: r["last_attempt_at"] ? new Date(r["last_attempt_at"] as string) : null,
    lastStatus: (r["last_status"] as string | null) ?? null,
    lastError: (r["last_error"] as string | null) ?? null,
    createdByUserId: (r["created_by_user_id"] as string | null) ?? null,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
  }));
}

/**
 * One tick's worth of report deliveries. Claimed schedules run concurrently —
 * each is mostly waiting on sockets — and every one records its own outcome,
 * so a rejected settle here means the claim leased a row whose bookkeeping
 * write then failed, which the lease expiry retries.
 */
export async function runReportDeliveryPass(opts: { limit?: number } = {}): Promise<void> {
  const claimed = await claimDueReportNotifications(opts.limit ?? REPORT_DELIVERIES_PER_TICK);
  if (claimed.length === 0) return;
  console.log(`[report-delivery] sending ${claimed.length} due schedule(s)`);
  await Promise.allSettled(claimed.map((row) => runReportNotification(row)));
}
