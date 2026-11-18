/**
 * Quota-radar notifications: a daily batched digest of every provider limit
 * the org is at or heading for, delivered through the existing alert routing
 * under the `quotaAlerts` trigger.
 *
 * The capacity runway rides the same digest: resources at or running out of
 * their own limits (a disk, a plan's storage cap, a monthly allowance). One
 * message a day about "what will run out" rather than two, under the trigger
 * people already route, with one on/off switch and one claim.
 *
 * Invoked from the poller loop (a bounded batch per tick), not from the
 * collection pass: a quota does not get closer to its ceiling because a
 * collector ran, so the cadence is the wall clock's. The claim/cooldown
 * protocol is the shared engine in `../alerts/daily-window.ts`; this module
 * supplies what is quota's alone: the settings table, the feed, and the
 * message. Never throws: every error is logged with the `[quotas]` prefix.
 */
import { alertableQuotas, alertableRunway } from "@infrawrench/client-core";
import { orgQuotaSettings } from "../db/schema";
import { routeAlert } from "../alerts/route";
import {
  dailyWindowStore,
  runDailyAlertWindows,
  type DailyWindowOutcome,
  type DailyWindowResult,
  type WindowDelivery,
} from "../alerts/daily-window";
import { getRunwayFeed } from "../capacity/feed";
import { runwayLines, runwayRowLine, runwayTitle, summarizeRunway } from "../capacity/summary";
import { getQuotaFeed } from "./feed";
import { getQuotaSettings, type QuotaSettingsRecord } from "./settings";
import {
  formatQuotaPushBody,
  quotaContext,
  quotaLines,
  quotaTitle,
  summarizeQuotas,
} from "./summary";
import { orgAppUrl } from "../app-url";

/** Least time between quota alert scans for one org. */
export const QUOTA_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The quota-specific halves of a scan's outcome. */
type QuotaScanOutcome =
  /** The scan completed and found nothing alertable; the window stays spent. */
  | { status: "quiet" }
  | {
      status: "sent";
      quotas: number;
      runway: number;
      push: number;
      slack: number;
      msTeams: number;
    }
  | { status: "undelivered"; quotas: number; runway: number };

/** What one org's scan did. Returned for tests/logs. */
export type QuotaOrgOutcome = DailyWindowOutcome<QuotaScanOutcome>;

export type QuotaAlertsResult = DailyWindowResult<QuotaScanOutcome>;

const store = dailyWindowStore<QuotaSettingsRecord>({
  table: orgQuotaSettings,
  cooldownMs: QUOTA_NOTIFY_COOLDOWN_MS,
  claimValues: (organizationId, settings, now) => ({
    organizationId,
    enabled: settings.enabled,
    threshold: settings.threshold,
    runwayDays: settings.runwayDays,
    allowanceThreshold: settings.allowanceThreshold,
    lastNotifiedAt: now,
  }),
});

/** The scan-and-deliver body run under a won claim: see the engine's contract. */
async function deliverWindow(
  organizationId: string,
  settings: QuotaSettingsRecord,
  now: Date,
  delivery: WindowDelivery,
) {
  const [feed, runway] = await Promise.all([
    getQuotaFeed(organizationId, now),
    // A runway read that fails must not take the quota digest down with it:
    // the quota half is the older, trusted signal.
    getRunwayFeed(organizationId, now).catch((err: unknown) => {
      console.error(`[quotas] capacity runway feed for org ${organizationId} failed:`, err);
      return null;
    }),
  ]);
  const due = alertableQuotas(feed.rows);
  const dueRunway = runway ? alertableRunway(runway.rows) : [];
  if (due.length === 0 && dueRunway.length === 0) {
    // A completed scan consumes the cooldown even when it found nothing:
    // `last_notified_at` means "last alert scan", and a quiet org re-scanned
    // every tick would only reconfirm the same silence.
    //
    // Note this is deliberately silent about *collection* failures too: an
    // account whose quota read is failing produces no rows and therefore no
    // alert. That is the right call for this trigger: a broken collector is
    // an operational problem the Quotas page names per account, not a page at
    // 3am about a limit we cannot see.
    delivery.spent = true;
    return { status: "quiet" as const };
  }

  const summary = due.length > 0 ? summarizeQuotas(due, feed.threshold) : null;
  const runwaySummary =
    dueRunway.length > 0
      ? summarizeRunway(dueRunway, {
          runwayDays: settings.runwayDays,
          allowanceThreshold: settings.allowanceThreshold,
        })
      : null;

  const linesFor = (bold: (s: string) => string): string[] => {
    const lines: string[] = [];
    if (summary) lines.push(...quotaLines(summary, bold));
    if (runwaySummary) {
      if (lines.length > 0) lines.push("");
      lines.push(...runwayLines(runwaySummary, bold));
    }
    return lines;
  };

  let title: string;
  if (summary && runwaySummary) {
    title = `${quotaTitle(summary)}; ${runwaySummary.total} resource limit${
      runwaySummary.total === 1 ? "" : "s"
    } running out`;
  } else if (summary) {
    title = quotaTitle(summary);
  } else {
    title = runwayTitle(runwaySummary!);
  }

  const firstRunway = runwaySummary?.rows[0];
  const pushBody = summary
    ? formatQuotaPushBody(summary)
    : firstRunway
      ? runwayRowLine(firstRunway)
      : title;

  const contextParts: string[] = [];
  if (summary) contextParts.push(quotaContext(summary));
  if (runwaySummary) {
    contextParts.push(
      `runway alerts within ${runwaySummary.runwayDays} days or past ${Math.round(
        runwaySummary.allowanceThreshold * 100,
      )}% of a monthly allowance`,
    );
  }

  const routed = await routeAlert({
    organizationId,
    trigger: "quotaAlerts",
    title,
    body: linesFor((s) => `*${s}*`).join("\n"),
    teamsBody: linesFor((s) => s).join("\n\n"),
    pushBody,
    context: contextParts.join(" · "),
    url: orgAppUrl(organizationId, "quotas"),
    pushData: { type: "quota_alert", orgId: organizationId },
  });
  // A hold counts as spent: the digest *will* arrive, and rewinding the claim
  // would rebuild the same window and deliver it twice.
  delivery.succeeded += routed.succeeded + routed.held;

  if (delivery.succeeded === 0) {
    return { status: "undelivered" as const, quotas: due.length, runway: dueRunway.length };
  }

  return {
    status: "sent" as const,
    quotas: due.length,
    runway: dueRunway.length,
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
