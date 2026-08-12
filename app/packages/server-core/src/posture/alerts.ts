/**
 * Posture-check notifications: a daily batched digest of every critical/high
 * security finding on the org's synced resources, delivered through the
 * existing push / Slack / Teams transports under the `postureAlerts` trigger.
 *
 * The cross-cloud **access review** rides this same window: its critical/high
 * findings are computed under the same claim, appended to the same message,
 * and governed by the same `org_posture_settings.enabled` switch. Both are
 * recomputed-on-read security findings over synced state sharing one dismissal
 * store, so two claims and two triggers would mean two messages a day about
 * one review. See `access-review/summary.ts`.
 *
 * Invoked from the poller loop (a bounded batch per tick), not from sync — a
 * bucket does not get more public because a sync pass ran, so the cadence is
 * the wall clock's, not the poller's.
 *
 * The claim/cooldown protocol is the shared engine in
 * `../alerts/daily-window.ts`, with one posture-specific wrinkle on top: a
 * scan **whose access half threw while posture found nothing** is rolled back
 * (`scan-failed`) rather than spent — it established nothing, and spending the
 * window on it would make a broken feed indistinguishable from a quiet day for
 * 24 hours. Never throws — every error is logged with the `[posture]` prefix.
 */
import { alertableAccessFindings, alertablePostureFindings } from "@infrawrench/client-core";
import { orgPostureSettings } from "../db/schema";
import { routeAlert } from "../alerts/route";
import {
  dailyWindowStore,
  runDailyAlertWindows,
  type DailyWindowOutcome,
  type DailyWindowResult,
  type WindowDelivery,
} from "../alerts/daily-window";
import { listAccessReview } from "../access-review/feed";
import {
  ACCESS_REVIEW_UNAVAILABLE_NOTE,
  formatAccessReviewPushBody,
  formatAccessReviewSlackBody,
  formatAccessReviewTeamsBody,
  joinSecurityBody,
  securityAlertTitle,
  summarizeAccessReview,
} from "../access-review/summary";
import { listPosture } from "./feed";
import { getPostureSettings, type PostureSettingsRecord } from "./settings";
import {
  formatPosturePushBody,
  formatPostureSlackBody,
  formatPostureTeamsBody,
  postureContext,
  postureTitle,
  summarizePosture,
} from "./summary";

/** Least time between posture alert scans for one org. */
export const POSTURE_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The posture-specific halves of a scan's outcome. */
type PostureScanOutcome =
  /** The scan completed and found nothing alertable; the window stays spent. */
  | { status: "quiet" }
  | {
      status: "sent";
      /** Alertable posture findings named in the message. */
      findings: number;
      /** Alertable access-review findings named in the same message. */
      accessFindings: number;
      push: number;
      slack: number;
      msTeams: number;
    }
  | { status: "undelivered"; findings: number; accessFindings: number }
  /**
   * The access review threw and posture found nothing alertable, so this scan
   * established nothing. The claim is rolled back on the way out and the next
   * tick retries — a failed scan must never spend the window, or one broken
   * feed silences the org for a day.
   */
  | { status: "scan-failed"; error: string };

/** What one org's scan did. Returned for tests/logs. */
export type PostureOrgOutcome = DailyWindowOutcome<PostureScanOutcome>;

export type PostureAlertsResult = DailyWindowResult<PostureScanOutcome>;

/** Deep link to the org's posture screen, for the Slack/Teams button. */
function postureUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/posture`;
}

const store = dailyWindowStore<PostureSettingsRecord>({
  table: orgPostureSettings,
  cooldownMs: POSTURE_NOTIFY_COOLDOWN_MS,
  claimValues: (organizationId, settings, now) => ({
    organizationId,
    enabled: settings.enabled,
    lastNotifiedAt: now,
  }),
});

/** The scan-and-deliver body run under a won claim — see the engine's contract. */
async function deliverWindow(
  organizationId: string,
  _settings: PostureSettingsRecord,
  now: Date,
  delivery: WindowDelivery,
): Promise<PostureScanOutcome> {
  // One security window covering both recomputed-finding surfaces. The access
  // review answers to this same `postureAlerts` trigger and this same 24h
  // claim on purpose — see `access-review/summary.ts` for the argument.
  //
  // The access half is caught rather than thrown so a broken review cannot
  // stop a posture alert going out. What it must never do is *look like a
  // clean review* — see the `scan-failed` branch below.
  const [feed, review] = await Promise.all([
    listPosture(organizationId, { now: now.getTime() }),
    listAccessReview(organizationId, { now: now.getTime() }).then(
      (r) => ({ ok: true as const, review: r }),
      (err: unknown) => {
        console.error(`[posture] access review for org ${organizationId} failed:`, err);
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      },
    ),
  ]);
  const alertable = alertablePostureFindings(feed);
  const alertableAccess = review.ok ? alertableAccessFindings(review.review) : [];
  if (alertable.length === 0 && alertableAccess.length === 0) {
    if (!review.ok) {
      // A half that threw is not a quiet scan. Spending the window here would
      // suppress both the retry and every access finding for 24h, and would
      // make a broken feed indistinguishable from a clean org — the same
      // unknown-versus-clean distinction the findings themselves keep. Leaving
      // `spent` false means the engine's guard on the way out rolls the claim
      // back and the next tick tries again.
      return { status: "scan-failed", error: review.error };
    }
    // A completed scan consumes the cooldown even when it found nothing —
    // `last_notified_at` means "last alert scan", and a clean org re-scanned
    // every tick would only reconfirm the same silence until a sync changes
    // a field.
    delivery.spent = true;
    return { status: "quiet" };
  }

  const summary = summarizePosture(alertable);
  const accessSummary = summarizeAccessReview(alertableAccess);
  // `postureTitle` would say "0 high-severity findings" for a window whose
  // only findings were access findings, so the combined helper owns both
  // mixed cases and hands back null when there is nothing to add.
  const title = securityAlertTitle(summary, accessSummary) ?? postureTitle(summary);
  const context = postureContext();
  const url = postureUrl(organizationId);
  // The message goes out on the posture findings, but it must say that half of
  // the review is missing rather than reading as a complete picture.
  const accessUnavailable = review.ok ? "" : ACCESS_REVIEW_UNAVAILABLE_NOTE;

  const routed = await routeAlert({
    organizationId,
    trigger: "postureAlerts",
    title,
    body: joinSecurityBody([
      alertable.length > 0 ? formatPostureSlackBody(summary) : "",
      alertableAccess.length > 0 ? formatAccessReviewSlackBody(accessSummary) : "",
      accessUnavailable,
    ]),
    teamsBody: joinSecurityBody([
      alertable.length > 0 ? formatPostureTeamsBody(summary) : "",
      alertableAccess.length > 0 ? formatAccessReviewTeamsBody(accessSummary) : "",
      accessUnavailable,
    ]),
    pushBody:
      alertable.length > 0
        ? formatPosturePushBody(summary)
        : formatAccessReviewPushBody(accessSummary),
    context,
    url,
    pushData: { type: "posture_alert", orgId: organizationId },
  });
  // A hold counts as spent — see the same note in `drift/alerts.ts`.
  delivery.succeeded += routed.succeeded + routed.held;

  // Nobody is routed here, or every transport failed. Either way this window
  // was not spent — the engine rolls the claim back on the way out so the next
  // tick can retry instead of waiting out a cooldown nobody heard about.
  if (delivery.succeeded === 0) {
    return {
      status: "undelivered",
      findings: alertable.length,
      accessFindings: alertableAccess.length,
    };
  }

  return {
    status: "sent",
    findings: alertable.length,
    accessFindings: alertableAccess.length,
    push: routed.byTransport.push,
    slack: routed.byTransport.slack,
    msTeams: routed.byTransport.msTeams,
  };
}

/** The poller pass: claim up to `limit` due orgs and run each one's scan. */
export async function runPostureAlerts(
  options: { limit?: number } = {},
  now = new Date(),
): Promise<PostureAlertsResult> {
  return runDailyAlertWindows(
    { logPrefix: "posture", store, getSettings: getPostureSettings, deliver: deliverWindow },
    options,
    now,
  );
}
