/**
 * Quota-radar notifications: a daily batched digest of every provider limit
 * the org is at or heading for, delivered through the existing alert routing
 * under the `quotaAlerts` trigger.
 *
 * Invoked from the poller loop (a bounded batch per tick), not from the
 * collection pass — a quota does not get closer to its ceiling because a
 * collector ran, so the cadence is the wall clock's. The claim/cooldown
 * protocol is the shared engine in `../alerts/daily-window.ts`; this module
 * supplies what is quota's alone: the settings table, the feed, and the
 * message. Never throws — every error is logged with the `[quotas]` prefix.
 */
import { alertableQuotas } from "@infrawrench/client-core";
import { orgQuotaSettings } from "../db/schema";
import { routeAlert } from "../alerts/route";
import {
  dailyWindowStore,
  runDailyAlertWindows,
  type DailyWindowOutcome,
  type DailyWindowResult,
  type WindowDelivery,
} from "../alerts/daily-window";
import { getQuotaFeed } from "./feed";
import { getQuotaSettings, type QuotaSettingsRecord } from "./settings";
import {
  formatQuotaPushBody,
  formatQuotaSlackBody,
  formatQuotaTeamsBody,
  quotaContext,
  quotaTitle,
  summarizeQuotas,
} from "./summary";

/** Least time between quota alert scans for one org. */
export const QUOTA_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The quota-specific halves of a scan's outcome. */
type QuotaScanOutcome =
  /** The scan completed and found nothing alertable; the window stays spent. */
  | { status: "quiet" }
  | { status: "sent"; quotas: number; push: number; slack: number; msTeams: number }
  | { status: "undelivered"; quotas: number };

/** What one org's scan did. Returned for tests/logs. */
export type QuotaOrgOutcome = DailyWindowOutcome<QuotaScanOutcome>;

export type QuotaAlertsResult = DailyWindowResult<QuotaScanOutcome>;

/** Deep link to the org's quota radar, for the Slack/Teams button. */
function quotasUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/quotas`;
}

const store = dailyWindowStore<QuotaSettingsRecord>({
  table: orgQuotaSettings,
  cooldownMs: QUOTA_NOTIFY_COOLDOWN_MS,
  claimValues: (organizationId, settings, now) => ({
    organizationId,
    enabled: settings.enabled,
    threshold: settings.threshold,
    lastNotifiedAt: now,
  }),
});

/** The scan-and-deliver body run under a won claim — see the engine's contract. */
async function deliverWindow(
  organizationId: string,
  _settings: QuotaSettingsRecord,
  now: Date,
  delivery: WindowDelivery,
) {
  const feed = await getQuotaFeed(organizationId, now);
  const due = alertableQuotas(feed.rows);
  if (due.length === 0) {
    // A completed scan consumes the cooldown even when it found nothing —
    // `last_notified_at` means "last alert scan", and a quiet org re-scanned
    // every tick would only reconfirm the same silence.
    //
    // Note this is deliberately silent about *collection* failures too: an
    // account whose quota read is failing produces no rows and therefore no
    // alert. That is the right call for this trigger — a broken collector is
    // an operational problem the Quotas page names per account, not a page at
    // 3am about a limit we cannot see.
    delivery.spent = true;
    return { status: "quiet" as const };
  }

  const summary = summarizeQuotas(due, feed.threshold);
  const routed = await routeAlert({
    organizationId,
    trigger: "quotaAlerts",
    title: quotaTitle(summary),
    body: formatQuotaSlackBody(summary),
    teamsBody: formatQuotaTeamsBody(summary),
    pushBody: formatQuotaPushBody(summary),
    context: quotaContext(summary),
    url: quotasUrl(organizationId),
    pushData: { type: "quota_alert", orgId: organizationId },
  });
  // A hold counts as spent: the digest *will* arrive, and rewinding the claim
  // would rebuild the same window and deliver it twice.
  delivery.succeeded += routed.succeeded + routed.held;

  if (delivery.succeeded === 0) {
    return { status: "undelivered" as const, quotas: due.length };
  }

  return {
    status: "sent" as const,
    quotas: due.length,
    push: routed.byTransport.push,
    slack: routed.byTransport.slack,
    msTeams: routed.byTransport.msTeams,
  };
}

/** The poller pass: claim up to `limit` due orgs and run each one's scan. */
export async function runQuotaAlerts(
  options: { limit?: number } = {},
  now = new Date(),
): Promise<QuotaAlertsResult> {
  return runDailyAlertWindows(
    { logPrefix: "quotas", store, getSettings: getQuotaSettings, deliver: deliverWindow },
    options,
    now,
  );
}
