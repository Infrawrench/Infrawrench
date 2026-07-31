/**
 * Weekly digest — data gathering, scheduling, and delivery. The composition
 * itself is pure and lives in `./compose.ts`; this module is everything that
 * touches the database, ClickHouse, and the Slack/Teams transports.
 *
 * Scheduling piggybacks on the poller's tick loop (`poller/src/loop.ts` calls
 * `runWeeklyDigests()` every tick) rather than adding a scheduler process.
 * Restart- and replica-safety come from `claimDueDigestOrgs`: one conditional
 * UPDATE moves `last_sent_week_start` forward, and only rows the UPDATE
 * actually changed are returned — so of any number of concurrent pollers,
 * exactly one instance sends a given org's digest for a given week.
 *
 * Like every other notifier, nothing here throws into the poller: errors are
 * logged and the tick carries on.
 */
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "../db/client";
import { orgDigestSettings, organizations, pagingIncidents, resources } from "../db/schema";
import { queryCosts } from "../clickhouse/cost-readers";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import {
  composeWeeklyDigest,
  digestTitle,
  digestWindow,
  formatDigestSlackBody,
  formatDigestTeamsBody,
  isDigestDue,
  type DigestWindow,
  type WeeklyDigest,
} from "./compose";

/** Deep link to the org's cost dashboards, for the message button. */
function costsUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/costs`;
}

function dayRange(from: string, to: string): { fromDate: Date; toDatePlusOne: Date } {
  return {
    fromDate: new Date(`${from}T00:00:00.000Z`),
    // Exclusive upper bound: the first instant of the day after `to`.
    toDatePlusOne: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000),
  };
}

/**
 * Gather one org's digest inputs and compose the digest. Two ClickHouse
 * queries (provider and service grouping over the two-week span) and three
 * cheap Postgres counts.
 *
 * Sync incidents are counted from `paging_incidents` rather than
 * `account_sync_failures`: the failure rows are a rolling window the pager
 * prunes within minutes (and skips entirely while paging is off), so they
 * can't answer "how many incidents last week".
 */
export async function buildWeeklyDigest(
  organizationId: string,
  window: DigestWindow,
): Promise<WeeklyDigest> {
  const span = { from: window.prevWeekStart, to: window.weekEnd };
  const [byProvider, byService] = await Promise.all([
    queryCosts(organizationId, {
      ...span,
      binning: "daily",
      groupBy: "provider",
      filters: [],
    }),
    queryCosts(organizationId, {
      ...span,
      binning: "daily",
      groupBy: "service",
      filters: [],
    }),
  ]);

  const { fromDate, toDatePlusOne } = dayRange(window.weekStart, window.weekEnd);
  const count = sql<number>`count(*)::int`;
  const [[incidents], [added], [removed]] = await Promise.all([
    db
      .select({ count })
      .from(pagingIncidents)
      .where(
        and(
          eq(pagingIncidents.organizationId, organizationId),
          gte(pagingIncidents.openedAt, fromDate),
          lt(pagingIncidents.openedAt, toDatePlusOne),
        ),
      ),
    db
      .select({ count })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          gte(resources.createdAt, fromDate),
          lt(resources.createdAt, toDatePlusOne),
        ),
      ),
    db
      .select({ count })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          gte(resources.deletedAt, fromDate),
          lt(resources.deletedAt, toDatePlusOne),
        ),
      ),
  ]);

  return composeWeeklyDigest({
    window,
    byProvider,
    byService,
    syncIncidentsOpened: incidents?.count ?? 0,
    resourcesAdded: added?.count ?? 0,
    resourcesRemoved: removed?.count ?? 0,
  });
}

export interface DigestDeliveryResult {
  attempted: number;
  succeeded: number;
}

/**
 * Send a composed digest to every Slack channel and Teams webhook opted into
 * the `weeklyDigest` trigger. Never throws (both transports already swallow
 * and log).
 */
export async function deliverWeeklyDigest(
  organizationId: string,
  digest: WeeklyDigest,
): Promise<DigestDeliveryResult> {
  const [org] = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  const title = digestTitle(digest);
  const context = org ? `${org.displayName} · Infrawrench weekly digest` : undefined;
  const url = costsUrl(organizationId);

  const slack = await sendSlackToOrg(organizationId, "weeklyDigest", {
    title,
    body: formatDigestSlackBody(digest),
    ...(context ? { context } : {}),
    ...(url ? { url } : {}),
  });
  const teams = await sendMsTeamsToOrg(organizationId, "weeklyDigest", {
    title,
    body: formatDigestTeamsBody(digest),
    ...(context ? { context } : {}),
    ...(url ? { url } : {}),
  });
  return {
    attempted: slack.attempted + teams.attempted,
    succeeded: slack.succeeded + teams.succeeded,
  };
}

/**
 * Atomically claim every org whose digest for the week starting `weekStart`
 * has not been sent. The WHERE clause is the entire dedupe story: an org is
 * returned only when this UPDATE moved `last_sent_week_start` forward, so a
 * concurrent replica (or a restarted poller re-entering the same Monday)
 * matches zero rows and sends nothing.
 */
export async function claimDueDigestOrgs(weekStart: string, now: Date): Promise<string[]> {
  const rows = await db
    .update(orgDigestSettings)
    .set({ lastSentWeekStart: weekStart, lastSentAt: now, updatedAt: now })
    .where(
      and(
        eq(orgDigestSettings.enabled, true),
        or(
          isNull(orgDigestSettings.lastSentWeekStart),
          lt(orgDigestSettings.lastSentWeekStart, weekStart),
        ),
      ),
    )
    .returning({ organizationId: orgDigestSettings.organizationId });
  return rows.map((r) => r.organizationId);
}

/**
 * One scheduler pass: no-op until Monday 07:00 UTC, then claim and send every
 * due org's digest for the just-ended week. Called from the poller's tick loop;
 * safe to call as often as you like.
 *
 * A per-org build/send failure after a successful claim is logged and *not*
 * retried until the next week — the claim already burned this week's slot.
 * That trade keeps the claim a single UPDATE; see KNOWLEDGE.md.
 */
export async function runWeeklyDigests(now = new Date()): Promise<void> {
  const window = digestWindow(now);
  if (!isDigestDue(now, window)) return;

  let due: string[];
  try {
    due = await claimDueDigestOrgs(window.weekStart, now);
  } catch (err) {
    console.error("[digest] failed to claim due orgs:", err);
    return;
  }

  for (const organizationId of due) {
    try {
      const digest = await buildWeeklyDigest(organizationId, window);
      const result = await deliverWeeklyDigest(organizationId, digest);
      console.log(
        `[digest] org ${organizationId} week ${window.weekStart}: delivered ${result.succeeded}/${result.attempted}`,
      );
    } catch (err) {
      console.error(`[digest] org ${organizationId} digest failed:`, err);
    }
  }
}

export interface DigestSettingsRecord {
  enabled: boolean;
  lastSentWeekStart: string | null;
  lastSentAt: Date | null;
}

/** The org's digest settings; a missing row reads as disabled. */
export async function getOrgDigestSettings(organizationId: string): Promise<DigestSettingsRecord> {
  const [row] = await db
    .select()
    .from(orgDigestSettings)
    .where(eq(orgDigestSettings.organizationId, organizationId));
  if (!row) return { enabled: false, lastSentWeekStart: null, lastSentAt: null };
  return {
    enabled: row.enabled,
    lastSentWeekStart: row.lastSentWeekStart,
    lastSentAt: row.lastSentAt,
  };
}

/**
 * Enable or disable the digest. Enabling marks the current window as already
 * sent so the first scheduled digest goes out next Monday rather than the
 * moment the toggle flips — the settings UI offers "Send now" for immediate
 * feedback instead.
 */
export async function setOrgDigestEnabled(
  organizationId: string,
  enabled: boolean,
  now = new Date(),
): Promise<DigestSettingsRecord> {
  const window = digestWindow(now);
  const [row] = await db
    .insert(orgDigestSettings)
    .values({
      organizationId,
      enabled,
      lastSentWeekStart: enabled ? window.weekStart : null,
    })
    .onConflictDoUpdate({
      target: orgDigestSettings.organizationId,
      set: {
        enabled,
        updatedAt: now,
        // Re-enabling after a gap also skips the stale backlog week.
        ...(enabled
          ? {
              lastSentWeekStart: sql`GREATEST(coalesce(${orgDigestSettings.lastSentWeekStart}, ${window.weekStart}), ${window.weekStart})`,
            }
          : {}),
      },
    })
    .returning();
  if (!row) throw new Error("Failed to save digest settings");
  return {
    enabled: row.enabled,
    lastSentWeekStart: row.lastSentWeekStart,
    lastSentAt: row.lastSentAt,
  };
}

/**
 * Compose last week's digest and send it immediately, ignoring the schedule
 * and the enabled flag. Backs the settings UI's "Send now" button, so unlike
 * the scheduler this throws when nothing could be delivered — the user needs
 * to see why.
 */
export async function sendWeeklyDigestNow(
  organizationId: string,
  now = new Date(),
): Promise<DigestDeliveryResult> {
  const window = digestWindow(now);
  const digest = await buildWeeklyDigest(organizationId, window);
  const result = await deliverWeeklyDigest(organizationId, digest);
  if (result.attempted === 0) {
    throw new Error(
      "No channels are opted into the weekly digest. Enable it on a Slack channel or Teams webhook first.",
    );
  }
  return result;
}
