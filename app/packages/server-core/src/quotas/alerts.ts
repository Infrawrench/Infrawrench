/**
 * Quota-radar notifications: a daily batched digest of every provider limit
 * the org is at or heading for, delivered through the existing alert routing
 * under the `quotaAlerts` trigger.
 *
 * Invoked from the poller loop (a bounded batch per tick), not from the
 * collection pass — a quota does not get closer to its ceiling because a
 * collector ran, so the cadence is the wall clock's. The claim protocol is
 * `expiry/alerts.ts` verbatim, and the three rules it exists to enforce are
 * the same:
 *
 * 1. **One message per org per 24h** (`QUOTA_NOTIFY_COOLDOWN_MS`), claimed
 *    with a single conditional upsert on `org_quota_settings.last_notified_at`.
 *    Whoever wins the statement scans, everyone else is suppressed, so N
 *    poller replicas racing the same window still produce one message.
 * 2. **`last_notified_at` means "last alert scan", not "last message".** A
 *    completed scan that found nothing keeps the window spent: quota
 *    utilisation moves with provisioning decisions, and re-scanning a quiet
 *    org every tick would only reconfirm the same silence. Only a scan whose
 *    message reached *nobody* (or that threw) is rolled back.
 * 3. **A bounded body** — see `./summary.ts`.
 *
 * Never throws. The pass runs inside the poller loop and must not be able to
 * fail a tick; every error is logged with the `[quotas]` prefix.
 */
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { alertableQuotas } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, orgQuotaSettings } from "../db/schema";
import { routeAlert } from "../alerts/route";
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

/** What one org's scan did. Returned for tests/logs. */
export type QuotaOrgOutcome =
  | { status: "disabled" }
  | { status: "cooling-down" }
  /** The scan completed and found nothing alertable; the window stays spent. */
  | { status: "quiet" }
  | { status: "sent"; quotas: number; push: number; slack: number; msTeams: number }
  | { status: "undelivered"; quotas: number }
  /**
   * `claimed` is true only after the cooldown claim landed — pre-claim
   * failures (settings read, claim SQL) leave it false so `scanned` stays
   * honest. `released` is whether the claim was rolled back.
   */
  | { status: "failed"; error: string; claimed: boolean; released: boolean };

export interface QuotaAlertsResult {
  /** Orgs this pass claimed and scanned. */
  scanned: number;
  /** Orgs whose message reached at least one destination. */
  sent: number;
  /** Per-org outcomes, keyed by organization id. */
  outcomes: Record<string, QuotaOrgOutcome>;
}

/** Deep link to the org's quota radar, for the Slack/Teams button. */
function quotasUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/quotas`;
}

/**
 * Orgs due for a scan: at least one non-deleted account, and either no
 * settings row (shipped defaults: enabled) or enabled with the cooldown
 * elapsed. Bounded and deterministically ordered; an org this pass claims
 * fails the predicate next tick, so a backlog drains across ticks without
 * starving anyone.
 */
async function findDueOrgs(now: Date, limit: number): Promise<string[]> {
  const cutoff = new Date(now.getTime() - QUOTA_NOTIFY_COOLDOWN_MS);
  const rows = await db
    .selectDistinct({ organizationId: accounts.organizationId })
    .from(accounts)
    .leftJoin(orgQuotaSettings, eq(orgQuotaSettings.organizationId, accounts.organizationId))
    .where(
      and(
        isNull(accounts.deletedAt),
        or(
          isNull(orgQuotaSettings.organizationId),
          and(
            eq(orgQuotaSettings.enabled, true),
            or(
              isNull(orgQuotaSettings.lastNotifiedAt),
              lte(orgQuotaSettings.lastNotifiedAt, cutoff),
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
 * Take the org's scan slot for this window. One statement, exactly like
 * expiry's `claimWindow`: the insert covers an org with no settings row (it
 * lands the shipped defaults the reader already reported), the conditional
 * update covers every subsequent window, and reading the existing row inside
 * the same statement is what makes the claim atomic across replicas.
 */
async function claimWindow(
  organizationId: string,
  settings: QuotaSettingsRecord,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - QUOTA_NOTIFY_COOLDOWN_MS);
  const rows = await db
    .insert(orgQuotaSettings)
    .values({
      organizationId,
      enabled: settings.enabled,
      threshold: settings.threshold,
      lastNotifiedAt: now,
    })
    .onConflictDoUpdate({
      target: orgQuotaSettings.organizationId,
      set: { lastNotifiedAt: now, updatedAt: now },
      // or()/lte(), not a raw sql`` fragment: raw interpolation sends the Date
      // object straight to postgres.js, which rejects it as a bind parameter —
      // comparators map it through the column's serializer.
      setWhere: or(
        isNull(orgQuotaSettings.lastNotifiedAt),
        lte(orgQuotaSettings.lastNotifiedAt, cutoff),
      )!,
    })
    .returning({ organizationId: orgQuotaSettings.organizationId });
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
    .update(orgQuotaSettings)
    .set({ lastNotifiedAt: prior })
    .where(
      and(
        eq(orgQuotaSettings.organizationId, organizationId),
        eq(orgQuotaSettings.lastNotifiedAt, claimed),
      ),
    );
}

/**
 * What the claimed body reported into the release guard. `spent` is the one
 * difference from drift's protocol: a completed scan with nothing alertable
 * keeps the window (see the module doc), so the guard must be able to tell
 * "quiet day" apart from "message reached nobody".
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
 * failing rollback must not mask the error that triggered it) and runs at most
 * once, so `catch` and `finally` can both call it.
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
      `[quotas] rolling back the claimed window for org ${organizationId} failed:`,
      err,
    );
    delivery.release = false;
  }
  return delivery.release;
}

/**
 * Everything that happens under a won claim: compute the feed, decide whether
 * there is anything to say, and fan it out. Reports transport successes into
 * `delivery` as they land, so a throw part-way through the fan-out is
 * distinguishable from a throw before any of it ran.
 */
async function deliverWindow(
  organizationId: string,
  now: Date,
  delivery: WindowDelivery,
): Promise<QuotaOrgOutcome> {
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
    return { status: "quiet" };
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

  if (delivery.succeeded === 0) return { status: "undelivered", quotas: due.length };

  return {
    status: "sent",
    quotas: due.length,
    push: routed.byTransport.push,
    slack: routed.byTransport.slack,
    msTeams: routed.byTransport.msTeams,
  };
}

/** One org's full claim-scan-deliver-release cycle. Never throws. */
async function runOne(organizationId: string, now: Date): Promise<QuotaOrgOutcome> {
  try {
    const settings = await getQuotaSettings(organizationId);
    // The due query already filtered on `enabled`, but the row can change
    // between the read and the claim; re-checking is one comparison.
    if (!settings.enabled) return { status: "disabled" };

    const prior = settings.lastNotifiedAt;
    if (!(await claimWindow(organizationId, settings, now))) return { status: "cooling-down" };

    const delivery: WindowDelivery = { succeeded: 0, spent: false, release: null };
    try {
      return await deliverWindow(organizationId, now, delivery);
    } catch (err) {
      console.error(`[quotas] alert scan for org ${organizationId} failed:`, err);
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
    console.error(`[quotas] alert scan for org ${organizationId} failed:`, err);
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
export async function runQuotaAlerts(
  { limit = 4 }: { limit?: number } = {},
  now = new Date(),
): Promise<QuotaAlertsResult> {
  const result: QuotaAlertsResult = { scanned: 0, sent: 0, outcomes: {} };
  let due: string[];
  try {
    due = await findDueOrgs(now, limit);
  } catch (err) {
    console.error("[quotas] finding due orgs failed:", err);
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
