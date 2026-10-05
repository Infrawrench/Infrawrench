/**
 * Extended-support notifications: a weekly batched message naming every
 * resource paying an extended-support surcharge (or past the end of support),
 * delivered through alert routing under the `extendedSupportAlerts` trigger.
 *
 * Weekly rather than daily because the condition changes on the provider's
 * calendar, not by the hour: a surcharge that started on Monday is the same
 * surcharge on Tuesday, and a daily repeat of it is how a channel gets muted.
 * Upcoming surcharges are not here; they are deadlines and appear on the
 * expiry radar, whose own alert already covers them.
 *
 * The claim/cooldown protocol is the shared engine in
 * `../alerts/daily-window.ts` with a seven-day window. Amounts are list price
 * here (the poller holds no billing credentials); the message says so.
 * Never throws: errors are logged with the `[extended-support]` prefix.
 */
import { alertableExtendedSupport } from "@infrawrench/client-core";
import { orgExtendedSupportSettings } from "../db/schema";
import { routeAlert } from "../alerts/route";
import {
  dailyWindowStore,
  runDailyAlertWindows,
  type DailyWindowOutcome,
  type DailyWindowResult,
  type WindowDelivery,
} from "../alerts/daily-window";
import { orgAppUrl } from "../app-url";
import { listExtendedSupport } from "./feed";
import { getExtendedSupportSettings, type ExtendedSupportSettingsRecord } from "./settings";
import {
  extendedSupportContext,
  extendedSupportTitle,
  formatExtendedSupportPushBody,
  formatExtendedSupportSlackBody,
  formatExtendedSupportTeamsBody,
  summarizeExtendedSupport,
} from "./summary";

/** Least time between extended-support alert scans for one org. */
export const EXTENDED_SUPPORT_NOTIFY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

type ExtendedSupportScanOutcome =
  | { status: "quiet" }
  | { status: "sent"; findings: number; push: number; slack: number; msTeams: number }
  | { status: "undelivered"; findings: number };

export type ExtendedSupportOrgOutcome = DailyWindowOutcome<ExtendedSupportScanOutcome>;
export type ExtendedSupportAlertsResult = DailyWindowResult<ExtendedSupportScanOutcome>;

const store = dailyWindowStore<ExtendedSupportSettingsRecord>({
  table: orgExtendedSupportSettings,
  cooldownMs: EXTENDED_SUPPORT_NOTIFY_COOLDOWN_MS,
  claimValues: (organizationId, settings, now) => ({
    organizationId,
    enabled: settings.enabled,
    leadDays: settings.leadDays,
    lastNotifiedAt: now,
  }),
});

async function deliverWindow(
  organizationId: string,
  settings: ExtendedSupportSettingsRecord,
  now: Date,
  delivery: WindowDelivery,
): Promise<ExtendedSupportScanOutcome> {
  const feed = await listExtendedSupport(organizationId, {
    now: now.getTime(),
    leadDays: settings.leadDays,
  });
  const alertable = alertableExtendedSupport(feed);
  if (alertable.length === 0) {
    // A completed scan keeps the window: "last scan", not "last message".
    delivery.spent = true;
    return { status: "quiet" };
  }

  const summary = summarizeExtendedSupport(alertable);
  const routed = await routeAlert({
    organizationId,
    trigger: "extendedSupportAlerts",
    title: extendedSupportTitle(summary),
    body: formatExtendedSupportSlackBody(summary),
    teamsBody: formatExtendedSupportTeamsBody(summary),
    pushBody: formatExtendedSupportPushBody(summary),
    context: extendedSupportContext(),
    url: orgAppUrl(organizationId, "costs"),
    pushData: { type: "extended_support_alert", orgId: organizationId },
  });
  // A hold counts as delivered: rewinding would deliver the window twice.
  delivery.succeeded += routed.succeeded + routed.held;
  if (delivery.succeeded === 0) return { status: "undelivered", findings: alertable.length };
  return {
    status: "sent",
    findings: alertable.length,
    push: routed.byTransport.push,
    slack: routed.byTransport.slack,
    msTeams: routed.byTransport.msTeams,
  };
}

/** The poller pass: claim up to `limit` due orgs and run each one's scan. */
export async function runExtendedSupportAlerts(
  options: { limit?: number } = {},
  now = new Date(),
): Promise<ExtendedSupportAlertsResult> {
  return runDailyAlertWindows(
    {
      logPrefix: "extended-support",
      store,
      getSettings: getExtendedSupportSettings,
      deliver: deliverWindow,
    },
    options,
    now,
  );
}
