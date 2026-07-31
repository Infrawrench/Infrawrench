/**
 * Resource-drift notifications: a batched digest of the change timeline,
 * delivered through the existing push / Slack / Teams transports under the
 * `resourceDrift` trigger.
 *
 * Invoked from `sync-resources.ts` right after a pass writes its
 * `resource_changes` rows, but only for poller-driven syncs — a manual refresh
 * from the UI never notifies, the same rule the sync-failure pager follows.
 *
 * Volume is the whole design (see `./summary.ts` for the caps). Three things
 * keep a pathological sync from emitting an unbounded number of messages:
 *
 * 1. **One message per org per cooldown window.** Not per change, not per
 *    account, not per sync pass. The window is claimed with a single
 *    conditional UPDATE on `org_drift_alert_settings.last_notified_at`, which
 *    is the same protocol `paging/deliver.ts` uses behind `PageCooldownStore`
 *    and the weekly digest uses on `last_sent_week_start`: whoever wins the
 *    statement sends, everyone else is suppressed, so N poller replicas racing
 *    the same window still produce one message. As there, the claim is rolled
 *    back when every transport reached nobody, so a message nobody received
 *    does not start a quiet period.
 * 2. **A bounded read.** The digest covers everything since the previous
 *    notification rather than just the pass that triggered it — so a suppressed
 *    window is folded into the next message instead of lost — but the query
 *    stops at `MAX_SCANNED_CHANGES + 1` rows and reports the overflow as "500+".
 * 3. **A bounded body.** At most `MAX_LISTED_CHANGES` named changes; the rest
 *    collapse into a link to the change timeline.
 *
 * Cheap guards run before any of that: a pass with no events, or whose events
 * the org's filter rejects outright, costs one indexed settings read and
 * nothing else.
 *
 * Never throws. Drift alerting sits on the poller's hot path and must not be
 * able to fail a sync.
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { accounts, orgDriftAlertSettings, resourceChanges } from "../db/schema";
import { sendPushToOrg } from "../push/dispatch";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import type { ResourceChangeEvent } from "../resource-changes";
import { getDriftAlertSettings, type DriftAlertSettings } from "./settings";
import {
  MAX_SCANNED_CHANGES,
  accountEnabled,
  driftContext,
  driftTitle,
  enabledKinds,
  formatDriftPushBody,
  formatDriftSlackBody,
  formatDriftTeamsBody,
  kindEnabled,
  summarizeDrift,
  type DriftChangeRow,
} from "./summary";

/** Why a pass did or did not produce a notification. Returned for tests/logs. */
export type DriftNotifyOutcome =
  | { status: "no-changes" }
  | { status: "filtered" }
  | { status: "cooling-down" }
  | { status: "below-minimum"; matched: number }
  | { status: "sent"; changes: number; push: number; slack: number; msTeams: number }
  | { status: "undelivered"; changes: number };

/** Deep link to the org's change timeline, for the Slack/Teams button. */
function changesUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/changes`;
}

/**
 * Take the org's notification slot for this window.
 *
 * One statement, deliberately: a read-then-write would lose the race it exists
 * to win. The insert covers an org with no settings row (it lands the shipped
 * defaults, which is what `getDriftAlertSettings` already reported); the
 * conditional update covers every subsequent window.
 */
async function claimWindow(
  organizationId: string,
  settings: DriftAlertSettings,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - settings.cooldownMinutes * 60_000);
  const rows = await db
    .insert(orgDriftAlertSettings)
    .values({
      organizationId,
      notifyCreated: settings.notifyCreated,
      notifyUpdated: settings.notifyUpdated,
      notifyDeleted: settings.notifyDeleted,
      cooldownMinutes: settings.cooldownMinutes,
      minChanges: settings.minChanges,
      accountIds: settings.accountIds,
      lastNotifiedAt: now,
    })
    .onConflictDoUpdate({
      target: orgDriftAlertSettings.organizationId,
      set: { lastNotifiedAt: now, updatedAt: now },
      // Reading the *existing* row inside the same statement is what makes the
      // claim atomic: two replicas racing this insert produce one winner.
      setWhere: sql`${orgDriftAlertSettings.lastNotifiedAt} IS NULL OR ${orgDriftAlertSettings.lastNotifiedAt} <= ${cutoff}`,
    })
    .returning({ organizationId: orgDriftAlertSettings.organizationId });
  return rows.length > 0;
}

/** Undo a claim whose digest reached nobody, restoring the previous value. */
async function releaseWindow(organizationId: string, prior: Date | null): Promise<void> {
  await db
    .update(orgDriftAlertSettings)
    .set({ lastNotifiedAt: prior })
    .where(eq(orgDriftAlertSettings.organizationId, organizationId));
}

/**
 * Read the window's changes, newest first, one row past the cap so the caller
 * can tell "exactly 500" from "at least 500". Rides
 * `resource_changes_org_created_idx` (organization_id, created_at).
 */
async function readWindow(
  organizationId: string,
  settings: DriftAlertSettings,
  since: Date,
): Promise<DriftChangeRow[]> {
  const kinds = enabledKinds(settings);
  const conditions = [
    eq(resourceChanges.organizationId, organizationId),
    gt(resourceChanges.createdAt, since),
    inArray(resourceChanges.changeKind, kinds),
  ];
  if (settings.accountIds.length > 0) {
    conditions.push(inArray(resourceChanges.accountId, settings.accountIds));
  }
  const rows = await db
    .select({
      accountId: resourceChanges.accountId,
      accountName: accounts.displayName,
      resourceTypeId: resourceChanges.resourceTypeId,
      displayName: resourceChanges.displayName,
      changeKind: resourceChanges.changeKind,
      diff: resourceChanges.diff,
    })
    .from(resourceChanges)
    .leftJoin(accounts, eq(resourceChanges.accountId, accounts.id))
    .where(and(...conditions))
    .orderBy(desc(resourceChanges.createdAt), desc(resourceChanges.id))
    .limit(MAX_SCANNED_CHANGES + 1);

  return rows.map((r) => ({
    accountId: r.accountId,
    accountName: r.accountName,
    resourceTypeId: r.resourceTypeId,
    displayName: r.displayName,
    changeKind: r.changeKind,
    fields: (r.diff ?? []).map((d) => d.field),
  }));
}

/**
 * Consider notifying about the drift a sync pass just recorded.
 *
 * `events` is only used as a cheap guard — the notification itself covers every
 * change since the last one, across every account, so a quiet account's pass
 * can still carry a busy account's news.
 */
export async function notifyResourceDrift(
  organizationId: string,
  accountId: string,
  events: ResourceChangeEvent[],
  now = new Date(),
): Promise<DriftNotifyOutcome> {
  try {
    if (events.length === 0) return { status: "no-changes" };

    const settings = await getDriftAlertSettings(organizationId);
    if (!accountEnabled(settings, accountId)) return { status: "filtered" };
    if (!events.some((e) => kindEnabled(settings, e.changeKind))) return { status: "filtered" };

    const prior = settings.lastNotifiedAt;
    if (!(await claimWindow(organizationId, settings, now))) return { status: "cooling-down" };

    // No prior notification means no window boundary to measure from; the
    // cooldown is the natural one — anything older would have been reported by
    // the notification that never happened.
    const since = prior ?? new Date(now.getTime() - settings.cooldownMinutes * 60_000);
    const rows = await readWindow(organizationId, settings, since);
    if (rows.length < settings.minChanges) {
      await releaseWindow(organizationId, prior);
      return { status: "below-minimum", matched: rows.length };
    }

    const summary = summarizeDrift(rows, since);
    const title = driftTitle(summary);
    const context = driftContext(summary);
    const url = changesUrl(organizationId);

    const push = await sendPushToOrg(organizationId, "resourceDrift", {
      title,
      body: formatDriftPushBody(summary),
      data: {
        type: "resource_drift",
        orgId: organizationId,
        changeCount: summary.total,
        since: since.toISOString(),
        ...(summary.accountIds.length === 1 && summary.accountIds[0]
          ? { accountId: summary.accountIds[0] }
          : {}),
      },
    });
    const slack = await sendSlackToOrg(organizationId, "resourceDrift", {
      title,
      body: formatDriftSlackBody(summary),
      context,
      ...(url ? { url } : {}),
    });
    const msTeams = await sendMsTeamsToOrg(organizationId, "resourceDrift", {
      title,
      body: formatDriftTeamsBody(summary),
      context,
      ...(url ? { url } : {}),
    });

    if (push.succeeded + slack.succeeded + msTeams.succeeded === 0) {
      // Nobody is opted in (the common case for a default-off trigger), or every
      // transport failed. Either way this window was not spent.
      await releaseWindow(organizationId, prior);
      return { status: "undelivered", changes: summary.total };
    }

    return {
      status: "sent",
      changes: summary.total,
      push: push.succeeded,
      slack: slack.succeeded,
      msTeams: msTeams.succeeded,
    };
  } catch (err) {
    console.error(`[drift] notification for org ${organizationId} failed:`, err);
    return { status: "no-changes" };
  }
}
