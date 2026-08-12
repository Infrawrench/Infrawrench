/**
 * Expiry-radar notifications: a daily batched digest of every deadline inside
 * the org's lead time, delivered through the existing push / Slack / Teams
 * transports under the `expiryAlerts` trigger.
 *
 * Invoked from the poller loop (a bounded batch per tick), not from sync — a
 * certificate does not get closer to expiring because a sync pass ran, so the
 * cadence is the wall clock's, not the poller's.
 *
 * The claim/cooldown protocol (one message per org per 24h, "last alert scan"
 * semantics, rollback when a message reached nobody) is the shared engine in
 * `../alerts/daily-window.ts`; this module supplies what is expiry's alone:
 * the settings table, the feed, and the message. Never throws — every error is
 * logged with the `[expiry]` prefix.
 */
import { itemsWithinLead } from "@infrawrench/client-core";
import { orgExpirySettings } from "../db/schema";
import { routeAlert } from "../alerts/route";
import {
  dailyWindowStore,
  runDailyAlertWindows,
  type DailyWindowOutcome,
  type DailyWindowResult,
  type WindowDelivery,
} from "../alerts/daily-window";
import { listExpiring } from "./feed";
import { getExpirySettings, type ExpirySettingsRecord } from "./settings";
import {
  expiryContext,
  expiryTitle,
  formatExpiryPushBody,
  formatExpirySlackBody,
  formatExpiryTeamsBody,
  summarizeExpiry,
} from "./summary";

/** Least time between expiry alert scans for one org. */
export const EXPIRY_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The expiry-specific halves of a scan's outcome. */
type ExpiryScanOutcome =
  /** The scan completed and found nothing due; the window stays spent. */
  | { status: "quiet" }
  | { status: "sent"; deadlines: number; push: number; slack: number; msTeams: number }
  | { status: "undelivered"; deadlines: number };

/** What one org's scan did. Returned for tests/logs. */
export type ExpiryOrgOutcome = DailyWindowOutcome<ExpiryScanOutcome>;

export type ExpiryAlertsResult = DailyWindowResult<ExpiryScanOutcome>;

/** Deep link to the org's expiry radar, for the Slack/Teams button. */
function expiringUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/expiring`;
}

const store = dailyWindowStore<ExpirySettingsRecord>({
  table: orgExpirySettings,
  cooldownMs: EXPIRY_NOTIFY_COOLDOWN_MS,
  claimValues: (organizationId, settings, now) => ({
    organizationId,
    enabled: settings.enabled,
    leadDays: settings.leadDays,
    lastNotifiedAt: now,
  }),
});

/** The scan-and-deliver body run under a won claim — see the engine's contract. */
async function deliverWindow(
  organizationId: string,
  settings: ExpirySettingsRecord,
  now: Date,
  delivery: WindowDelivery,
) {
  const feed = await listExpiring(organizationId, {
    now: now.getTime(),
    leadDays: settings.leadDays,
  });
  const due = itemsWithinLead(feed);
  if (due.length === 0) {
    // A completed scan consumes the cooldown even when it found nothing —
    // `last_notified_at` means "last alert scan", and a quiet org re-scanned
    // every tick would only reconfirm the same silence until a day boundary.
    delivery.spent = true;
    return { status: "quiet" as const };
  }

  const summary = summarizeExpiry(due, feed.leadDays);
  const title = expiryTitle(summary);
  const context = expiryContext(summary);
  const url = expiringUrl(organizationId);

  const routed = await routeAlert({
    organizationId,
    trigger: "expiryAlerts",
    title,
    body: formatExpirySlackBody(summary),
    teamsBody: formatExpiryTeamsBody(summary),
    pushBody: formatExpiryPushBody(summary),
    context,
    url,
    pushData: { type: "expiry_alert", orgId: organizationId },
  });
  // A hold counts as spent: the digest *will* arrive, and rewinding the claim
  // would rebuild the same window and deliver it twice.
  delivery.succeeded += routed.succeeded + routed.held;

  // Nobody is routed here, or every transport failed. Either way this window
  // was not spent — the engine rolls the claim back on the way out so the next
  // tick can retry instead of waiting out a cooldown nobody heard about.
  if (delivery.succeeded === 0) {
    return { status: "undelivered" as const, deadlines: due.length };
  }

  return {
    status: "sent" as const,
    deadlines: due.length,
    push: routed.byTransport.push,
    slack: routed.byTransport.slack,
    msTeams: routed.byTransport.msTeams,
  };
}

/** The poller pass: claim up to `limit` due orgs and run each one's scan. */
export async function runExpiryAlerts(
  options: { limit?: number } = {},
  now = new Date(),
): Promise<ExpiryAlertsResult> {
  return runDailyAlertWindows(
    { logPrefix: "expiry", store, getSettings: getExpirySettings, deliver: deliverWindow },
    options,
    now,
  );
}
