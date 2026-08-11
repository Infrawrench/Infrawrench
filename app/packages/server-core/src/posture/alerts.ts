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
 * Volume is bounded exactly the way the expiry radar's is:
 *
 * 1. **One message per org per 24h** (`POSTURE_NOTIFY_COOLDOWN_MS`), claimed
 *    with a single conditional upsert on `org_posture_settings.last_notified_at`
 *    — the exact protocol `expiry/alerts.ts` uses. Whoever wins the statement
 *    scans, everyone else is suppressed, so N poller replicas racing the same
 *    window still produce one message.
 * 2. **`last_notified_at` means "last alert scan", not "last message".** A
 *    completed scan that found nothing alertable keeps the window spent —
 *    posture only changes when a sync lands a changed field, so re-scanning a
 *    clean org every tick would only reconfirm the same silence. Only a scan
 *    whose message reached *nobody* (or that threw) is rolled back, so a
 *    failed delivery retries next tick rather than starting a quiet day.
 * 3. **A bounded body** — see `./summary.ts`.
 *
 * Never throws. The pass runs inside the poller loop and must not be able to
 * fail a tick; every error is logged with the `[posture]` prefix.
 */
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { alertableAccessFindings, alertablePostureFindings } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, orgPostureSettings } from "../db/schema";
import { routeAlert } from "../alerts/route";
import { listAccessReview } from "../access-review/feed";
import {
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

/** What one org's scan did. Returned for tests/logs. */
export type PostureOrgOutcome =
  | { status: "disabled" }
  | { status: "cooling-down" }
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
   * `claimed` is true only after the cooldown claim landed — pre-claim
   * failures (settings read, claim SQL) leave it false so `scanned` stays
   * honest. `released` is whether the claim was rolled back.
   */
  | { status: "failed"; error: string; claimed: boolean; released: boolean };

export interface PostureAlertsResult {
  /** Orgs this pass claimed and scanned. */
  scanned: number;
  /** Orgs whose message reached at least one destination. */
  sent: number;
  /** Per-org outcomes, keyed by organization id. */
  outcomes: Record<string, PostureOrgOutcome>;
}

/** Deep link to the org's posture screen, for the Slack/Teams button. */
function postureUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/posture`;
}

/**
 * Orgs due for a scan: at least one non-deleted account, and either no
 * settings row (shipped defaults: enabled) or enabled with the cooldown
 * elapsed. Bounded and deterministically ordered; an org this pass claims
 * fails the predicate next tick, so a backlog drains across ticks without
 * starving anyone.
 */
async function findDueOrgs(now: Date, limit: number): Promise<string[]> {
  const cutoff = new Date(now.getTime() - POSTURE_NOTIFY_COOLDOWN_MS);
  const rows = await db
    .selectDistinct({ organizationId: accounts.organizationId })
    .from(accounts)
    .leftJoin(orgPostureSettings, eq(orgPostureSettings.organizationId, accounts.organizationId))
    .where(
      and(
        isNull(accounts.deletedAt),
        or(
          isNull(orgPostureSettings.organizationId),
          and(
            eq(orgPostureSettings.enabled, true),
            or(
              isNull(orgPostureSettings.lastNotifiedAt),
              lte(orgPostureSettings.lastNotifiedAt, cutoff),
            ),
          ),
        ),
      ),
    )
    .orderBy(accounts.organizationId)
    .limit(limit);
  return rows.map((r) => r.organizationId);
}

/**
 * Take the org's scan slot for this window. One statement, exactly like the
 * expiry radar's `claimWindow`: the insert covers an org with no settings row
 * (it lands the shipped defaults the reader already reported), the
 * conditional update covers every subsequent window, and reading the existing
 * row inside the same statement is what makes the claim atomic across
 * replicas.
 */
async function claimWindow(
  organizationId: string,
  settings: PostureSettingsRecord,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - POSTURE_NOTIFY_COOLDOWN_MS);
  const rows = await db
    .insert(orgPostureSettings)
    .values({ organizationId, enabled: settings.enabled, lastNotifiedAt: now })
    .onConflictDoUpdate({
      target: orgPostureSettings.organizationId,
      set: { lastNotifiedAt: now, updatedAt: now },
      // or()/lte(), not a raw sql`` fragment: raw interpolation sends the
      // Date object straight to postgres.js, which rejects it as a bind
      // parameter — comparators map it through the column's serializer.
      // (The ! is exactOptionalPropertyTypes noise; or() with arguments
      // never returns undefined.)
      setWhere: or(
        isNull(orgPostureSettings.lastNotifiedAt),
        lte(orgPostureSettings.lastNotifiedAt, cutoff),
      )!,
    })
    .returning({ organizationId: orgPostureSettings.organizationId });
  return rows.length > 0;
}

/**
 * Undo a claim whose message reached nobody, restoring the previous value.
 * Conditional on still owning the claim: `claimWindow` stamped
 * `lastNotifiedAt` with its own `now`, so that value is the ownership token —
 * a replica that wedged past the cooldown must not rewind a later replica's
 * claim. Losing the race means someone else owns the window, not an error.
 */
async function releaseWindow(
  organizationId: string,
  claimed: Date,
  prior: Date | null,
): Promise<void> {
  await db
    .update(orgPostureSettings)
    .set({ lastNotifiedAt: prior })
    .where(
      and(
        eq(orgPostureSettings.organizationId, organizationId),
        eq(orgPostureSettings.lastNotifiedAt, claimed),
      ),
    );
}

/**
 * What the claimed body reported into the release guard. `spent` is whether a
 * completed scan legitimately consumed the window (nothing alertable, or a
 * message that landed), so the guard can tell a quiet day apart from
 * "message reached nobody".
 */
interface WindowDelivery {
  succeeded: number;
  /** True when the scan completed and legitimately consumed the window. */
  spent: boolean;
  /** `null` until the release guard has run; then whether it succeeded. */
  release: null | boolean;
}

/**
 * The release invariant: **the window stays spent exactly when the scan
 * completed quietly or at least one transport delivered.** Never throws (a
 * failing rollback must not mask the error that triggered it) and runs at
 * most once, so `catch` and `finally` can both call it. Returns whether the
 * claim ended up released.
 */
async function releaseUnlessDelivered(
  organizationId: string,
  claimed: Date,
  prior: Date | null,
  delivery: WindowDelivery,
): Promise<boolean> {
  if (delivery.succeeded > 0 || delivery.spent) return false;
  if (delivery.release !== null) return delivery.release;
  try {
    await releaseWindow(organizationId, claimed, prior);
    delivery.release = true;
  } catch (err) {
    console.error(
      `[posture] rolling back the claimed window for org ${organizationId} failed:`,
      err,
    );
    delivery.release = false;
  }
  return delivery.release;
}

/**
 * Everything that happens under a won claim: compute the findings, decide
 * whether there is anything to say, and fan it out. Reports transport
 * successes into `delivery` as they land, so a throw part-way through the
 * fan-out is distinguishable from a throw before any of it ran.
 */
async function deliverWindow(
  organizationId: string,
  now: Date,
  delivery: WindowDelivery,
): Promise<PostureOrgOutcome> {
  // One security window covering both recomputed-finding surfaces. The access
  // review answers to this same `postureAlerts` trigger and this same 24h
  // claim on purpose — see `access-review/summary.ts` for the argument. A
  // broken access review costs the message one section, never the whole alert.
  const [feed, review] = await Promise.all([
    listPosture(organizationId, { now: now.getTime() }),
    listAccessReview(organizationId, { now: now.getTime() }).catch((err) => {
      console.error(`[posture] access review for org ${organizationId} failed:`, err);
      return undefined;
    }),
  ]);
  const alertable = alertablePostureFindings(feed);
  const alertableAccess = review ? alertableAccessFindings(review) : [];
  if (alertable.length === 0 && alertableAccess.length === 0) {
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

  const routed = await routeAlert({
    organizationId,
    trigger: "postureAlerts",
    title,
    body: joinSecurityBody([
      alertable.length > 0 ? formatPostureSlackBody(summary) : "",
      alertableAccess.length > 0 ? formatAccessReviewSlackBody(accessSummary) : "",
    ]),
    teamsBody: joinSecurityBody([
      alertable.length > 0 ? formatPostureTeamsBody(summary) : "",
      alertableAccess.length > 0 ? formatAccessReviewTeamsBody(accessSummary) : "",
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
  // was not spent — the guard rolls the claim back on the way out so the next
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

/** One org's full claim-scan-deliver-release cycle. Never throws. */
async function runOne(organizationId: string, now: Date): Promise<PostureOrgOutcome> {
  try {
    const settings = await getPostureSettings(organizationId);
    // The due query already filtered on `enabled`, but the row can change
    // between the read and the claim; re-checking is one comparison.
    if (!settings.enabled) return { status: "disabled" };

    const prior = settings.lastNotifiedAt;
    if (!(await claimWindow(organizationId, settings, now))) return { status: "cooling-down" };

    const delivery: WindowDelivery = { succeeded: 0, spent: false, release: null };
    try {
      return await deliverWindow(organizationId, now, delivery);
    } catch (err) {
      console.error(`[posture] alert scan for org ${organizationId} failed:`, err);
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        claimed: true,
        released: await releaseUnlessDelivered(organizationId, now, prior, delivery),
      };
    } finally {
      await releaseUnlessDelivered(organizationId, now, prior, delivery);
    }
  } catch (err) {
    // Nothing was claimed on this path — settings or the claim statement
    // itself failed — so there is nothing to roll back.
    console.error(`[posture] alert scan for org ${organizationId} failed:`, err);
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      claimed: false,
      released: false,
    };
  }
}

/**
 * The poller pass: claim up to `limit` due orgs and run each one's scan.
 * Sequential on purpose — the batch is small and each scan is a handful of
 * indexed reads; parallel fan-outs would just interleave transport calls.
 */
export async function runPostureAlerts(
  { limit = 4 }: { limit?: number } = {},
  now = new Date(),
): Promise<PostureAlertsResult> {
  const result: PostureAlertsResult = { scanned: 0, sent: 0, outcomes: {} };
  let due: string[];
  try {
    due = await findDueOrgs(now, limit);
  } catch (err) {
    console.error("[posture] finding due orgs failed:", err);
    return result;
  }

  for (const organizationId of due) {
    const outcome = await runOne(organizationId, now);
    result.outcomes[organizationId] = outcome;
    // Only count orgs that actually claimed a window. Pre-claim outcomes
    // (`disabled`, `cooling-down`, unclaimed `failed`) leave the cooldown
    // untouched and must not inflate `scanned`.
    const claimed =
      outcome.status === "quiet" ||
      outcome.status === "sent" ||
      outcome.status === "undelivered" ||
      (outcome.status === "failed" && outcome.claimed);
    if (claimed) result.scanned += 1;
    if (outcome.status === "sent") result.sent += 1;
  }
  return result;
}
