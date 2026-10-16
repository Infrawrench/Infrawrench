/**
 * Keeping filed issues' status current.
 *
 * Every link row (Jira, Linear, GitHub) carries the issue's status, category,
 * assignee and last-changed time. Two things feed them, through the same
 * functions here:
 *
 *   - **Webhooks**, where the org set them up (`routes/issue-webhooks.ts`):
 *     a delivery is verified, parsed (`readings.ts`) and applied at once.
 *   - **The poll** (`pass.ts`), for everything else and as the safety net for
 *     a webhook that was deleted or a delivery that never came: links are
 *     claimed oldest-checked first and read from the tracker in batches.
 *
 * Applying a reading:
 *
 *   1. **Older never overwrites newer.** A reading whose `issueUpdatedAt` is
 *      before the stored one (a retried delivery, a poll racing a webhook) only
 *      stamps `status_synced_at`.
 *   2. **The first reading is a baseline.** A change event is published, and
 *      a finding resolved, only when a known status moved to another one.
 *   3. **Done may resolve the finding**, when the tracker's
 *      `acknowledge_on_done` is on and the finding is a cost anomaly: the only
 *      kind with a resolved state (its acknowledgement). Everything else is
 *      displayed only.
 *
 * Nothing here throws into a webhook receiver or the poll for one bad link:
 * each link is applied on its own, failures are logged and counted.
 */
import { and, eq, inArray, isNull, ne, or, sql, lt, asc, gte } from "drizzle-orm";
import {
  ISSUE_STATUS_CHANGED,
  issueHandle,
  type IssueStatusRefreshResult,
  type IssueStatusSnapshot,
  type IssueTracker,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { githubIssueLinks, jiraIssueLinks, linearIssueLinks } from "../db/schema";
import { publishEvent } from "../events/publish";
import { GithubApiError, getIssueRaw } from "../github/issues-api";
import { getGithubIssueSettings } from "../github-issues/settings";
import { fetchJiraIssueReadings, jiraAcknowledgesOnDone } from "../jira";
import {
  fetchLinearIssueReading,
  fetchLinearIssueReadings,
  linearAcknowledgesOnDone,
} from "../linear";
import { acknowledgeAnomalyFromIssue, issueDoneExplanation } from "./acknowledge";
import { planIssueStatusUpdate, type IssueStatusPlan } from "./plan";
import {
  deletedReading,
  githubReadingFromIssue,
  type GithubWebhookChange,
  type JiraWebhookChange,
  type LinearWebhookChange,
} from "./readings";

function readingColumns(reading: IssueStatusSnapshot, now: Date) {
  return {
    status: reading.status,
    statusCategory: reading.statusCategory,
    assignee: reading.assignee,
    issueUpdatedAt: reading.issueUpdatedAt ? new Date(reading.issueUpdatedAt) : null,
    statusSyncedAt: now,
  };
}

const TRACKER_LABEL: Record<IssueTracker, string> = {
  jira: "Jira",
  linear: "Linear",
  github: "GitHub",
};

interface AppliedLink {
  tracker: IssueTracker;
  organizationId: string;
  linkId: string;
  sourceKind: string;
  sourceId: string;
  handle: string;
  url: string;
}

/** Everything that follows a stored change: the event and the optional resolution. */
async function afterChange(
  link: AppliedLink,
  plan: IssueStatusPlan,
  reading: IssueStatusSnapshot,
  acknowledgeOnDone: () => Promise<boolean>,
): Promise<void> {
  if (plan.changed) {
    await publishEvent(
      ISSUE_STATUS_CHANGED,
      link.organizationId,
      {
        tracker: link.tracker,
        issue: link.handle,
        issueUrl: link.url,
        sourceKind: link.sourceKind,
        sourceId: link.sourceId,
        status: reading.status,
        statusCategory: reading.statusCategory,
        previousStatus: plan.previous.status,
        previousStatusCategory: plan.previous.statusCategory,
        assignee: reading.assignee,
      },
      {
        title: `${link.handle} moved to ${reading.status ?? "an unknown status"} in ${TRACKER_LABEL[link.tracker]}`,
        url: link.url,
        // One event per link per transition, however many deliveries say so.
        idempotencyKey: `issue-status:${link.linkId}:${reading.issueUpdatedAt ?? ""}:${reading.status ?? ""}`,
      },
    );
  }
  if (plan.becameDone && link.sourceKind === "cost_anomaly" && (await acknowledgeOnDone())) {
    await acknowledgeAnomalyFromIssue(
      link.organizationId,
      link.sourceId,
      issueDoneExplanation(TRACKER_LABEL[link.tracker], link.handle, reading.status),
    );
  }
}

/** Memoize a per-org setting read across the links of one batch. */
function once(read: () => Promise<boolean>): () => Promise<boolean> {
  let value: Promise<boolean> | null = null;
  return () => (value ??= read().catch(() => false));
}

// --- Jira ---

type JiraLinkRow = typeof jiraIssueLinks.$inferSelect;

async function applyJiraReading(
  row: JiraLinkRow,
  reading: IssueStatusSnapshot & { issueId?: string | null },
  acknowledgeOnDone: () => Promise<boolean>,
  now: Date,
): Promise<boolean> {
  const plan = planIssueStatusUpdate(row, reading);
  await db
    .update(jiraIssueLinks)
    .set(
      plan.fresh
        ? {
            ...readingColumns(reading, now),
            ...(reading.issueId && !row.issueId ? { issueId: reading.issueId } : {}),
          }
        : { statusSyncedAt: now },
    )
    .where(eq(jiraIssueLinks.id, row.id));
  await afterChange(
    {
      tracker: "jira",
      organizationId: row.organizationId,
      linkId: row.id,
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      handle: issueHandle({ tracker: "jira", issueKey: row.issueKey }),
      url: row.issueUrl,
    },
    plan,
    reading,
    acknowledgeOnDone,
  );
  return plan.changed || (plan.fresh && plan.differs);
}

/** Read and store the status of a set of one org's Jira links. Throws on a tracker failure. */
export async function syncJiraLinks(
  organizationId: string,
  rows: readonly JiraLinkRow[],
): Promise<IssueStatusRefreshResult> {
  if (rows.length === 0) return { checked: 0, changed: 0 };
  const refs = [...new Set(rows.map((r) => r.issueId ?? r.issueKey))];
  const readings = await fetchJiraIssueReadings(organizationId, refs);
  const byId = new Map(readings.flatMap((r) => (r.issueId ? [[r.issueId, r] as const] : [])));
  const byKey = new Map(readings.map((r) => [r.issueKey.toUpperCase(), r] as const));
  const ack = once(() => jiraAcknowledgesOnDone(organizationId));
  const now = new Date();
  let changed = 0;
  for (const row of rows) {
    const reading =
      (row.issueId ? byId.get(row.issueId) : undefined) ?? byKey.get(row.issueKey.toUpperCase());
    try {
      if (!reading) {
        // Not found or not visible to the account: nothing to say, but the
        // link was looked at, so it goes to the back of the poll queue.
        await db
          .update(jiraIssueLinks)
          .set({ statusSyncedAt: now })
          .where(eq(jiraIssueLinks.id, row.id));
        continue;
      }
      if (await applyJiraReading(row, reading, ack, now)) changed += 1;
    } catch (err) {
      console.error(`[issue-status] applying Jira ${row.issueKey} failed:`, err);
    }
  }
  return { checked: rows.length, changed };
}

/** Apply one verified Jira webhook delivery. Returns how many links it touched. */
export async function applyJiraWebhook(
  organizationId: string,
  change: JiraWebhookChange,
): Promise<number> {
  if (change.kind === "ignored") return 0;
  const key = change.kind === "updated" ? change.reading.issueKey : change.issueKey;
  const id = change.kind === "updated" ? change.reading.issueId : change.issueId;
  const rows = await db
    .select()
    .from(jiraIssueLinks)
    .where(
      and(
        eq(jiraIssueLinks.organizationId, organizationId),
        id
          ? or(eq(jiraIssueLinks.issueKey, key), eq(jiraIssueLinks.issueId, id))
          : eq(jiraIssueLinks.issueKey, key),
      ),
    );
  if (rows.length === 0) return 0;
  const reading = change.kind === "updated" ? change.reading : deletedReading();
  const ack = once(() => jiraAcknowledgesOnDone(organizationId));
  const now = new Date();
  for (const row of rows) {
    try {
      await applyJiraReading(row, reading, ack, now);
    } catch (err) {
      console.error(`[issue-status] applying Jira webhook for ${key} failed:`, err);
    }
  }
  return rows.length;
}

// --- Linear ---

type LinearLinkRow = typeof linearIssueLinks.$inferSelect;

async function applyLinearReading(
  row: LinearLinkRow,
  reading: IssueStatusSnapshot & { issueId?: string | null },
  acknowledgeOnDone: () => Promise<boolean>,
  now: Date,
): Promise<boolean> {
  const plan = planIssueStatusUpdate(row, reading);
  await db
    .update(linearIssueLinks)
    .set(
      plan.fresh
        ? {
            ...readingColumns(reading, now),
            ...(reading.issueId && !row.issueId ? { issueId: reading.issueId } : {}),
          }
        : { statusSyncedAt: now },
    )
    .where(eq(linearIssueLinks.id, row.id));
  await afterChange(
    {
      tracker: "linear",
      organizationId: row.organizationId,
      linkId: row.id,
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      handle: issueHandle({ tracker: "linear", issueIdentifier: row.issueIdentifier }),
      url: row.issueUrl,
    },
    plan,
    reading,
    acknowledgeOnDone,
  );
  return plan.changed || (plan.fresh && plan.differs);
}

/** Read and store the status of a set of one org's Linear links. Throws on a tracker failure. */
export async function syncLinearLinks(
  organizationId: string,
  rows: readonly LinearLinkRow[],
): Promise<IssueStatusRefreshResult> {
  if (rows.length === 0) return { checked: 0, changed: 0 };
  const readings = await fetchLinearIssueReadings(
    organizationId,
    rows.map((r) => ({ issueId: r.issueId, identifier: r.issueIdentifier })),
  );
  const byId = new Map(readings.flatMap((r) => (r.issueId ? [[r.issueId, r] as const] : [])));
  const byIdentifier = new Map(readings.map((r) => [r.identifier.toUpperCase(), r] as const));
  const ack = once(() => linearAcknowledgesOnDone(organizationId));
  const now = new Date();
  let changed = 0;
  for (const row of rows) {
    const reading =
      (row.issueId ? byId.get(row.issueId) : undefined) ??
      byIdentifier.get(row.issueIdentifier.toUpperCase());
    try {
      if (!reading) {
        await db
          .update(linearIssueLinks)
          .set({ statusSyncedAt: now })
          .where(eq(linearIssueLinks.id, row.id));
        continue;
      }
      if (await applyLinearReading(row, reading, ack, now)) changed += 1;
    } catch (err) {
      console.error(`[issue-status] applying Linear ${row.issueIdentifier} failed:`, err);
    }
  }
  return { checked: rows.length, changed };
}

/** Apply one verified Linear webhook delivery. Returns how many links it touched. */
export async function applyLinearWebhook(
  organizationId: string,
  change: LinearWebhookChange,
): Promise<number> {
  if (change.kind === "ignored") return 0;
  const identifier = change.kind === "updated" ? change.reading.identifier : change.identifier;
  const id = change.kind === "updated" ? change.reading.issueId : change.issueId;
  const rows = await db
    .select()
    .from(linearIssueLinks)
    .where(
      and(
        eq(linearIssueLinks.organizationId, organizationId),
        id
          ? or(eq(linearIssueLinks.issueIdentifier, identifier), eq(linearIssueLinks.issueId, id))
          : eq(linearIssueLinks.issueIdentifier, identifier),
      ),
    );
  if (rows.length === 0) return 0;
  let reading: IssueStatusSnapshot & { issueId?: string | null };
  if (change.kind === "deleted") {
    reading = deletedReading();
  } else if (change.complete) {
    reading = change.reading;
  } else {
    // The delivery named the issue but not its state: ask Linear rather than
    // store a reading with the status missing.
    const fetched = await fetchLinearIssueReading(organizationId, id ?? identifier);
    if (!fetched) return 0;
    reading = fetched;
  }
  const ack = once(() => linearAcknowledgesOnDone(organizationId));
  const now = new Date();
  for (const row of rows) {
    try {
      await applyLinearReading(row, reading, ack, now);
    } catch (err) {
      console.error(`[issue-status] applying Linear webhook for ${identifier} failed:`, err);
    }
  }
  return rows.length;
}

// --- GitHub ---

type GithubLinkRow = typeof githubIssueLinks.$inferSelect;

/**
 * Store a GitHub reading. Unlike the other two, a GitHub link's `state` is
 * also the filing lifecycle (one *open* link per finding is what a refile
 * comments on), so it follows the issue: closed on GitHub closes the link,
 * reopened reopens it unless the finding has been filed again since, in which
 * case the newer link stays the open one and this one only records status.
 */
async function applyGithubReading(
  row: GithubLinkRow,
  reading: IssueStatusSnapshot & { state?: "open" | "closed" },
  acknowledgeOnDone: () => Promise<boolean>,
  now: Date,
): Promise<boolean> {
  const plan = planIssueStatusUpdate(row, reading);
  if (!plan.fresh) {
    await db
      .update(githubIssueLinks)
      .set({ statusSyncedAt: now })
      .where(eq(githubIssueLinks.id, row.id));
    return false;
  }
  const columns = readingColumns(reading, now);
  const nextState = reading.state ?? (reading.statusCategory === "todo" ? "open" : "closed");
  if (nextState === "open" && row.state === "closed") {
    const reopened = await db
      .update(githubIssueLinks)
      .set({ ...columns, state: "open", updatedAt: now })
      .where(
        and(
          eq(githubIssueLinks.id, row.id),
          sql`NOT EXISTS (SELECT 1 FROM ${githubIssueLinks} other WHERE other.organization_id = ${row.organizationId} AND other.fingerprint = ${row.fingerprint} AND other.state = 'open' AND other.id <> ${row.id})`,
        ),
      )
      .returning({ id: githubIssueLinks.id });
    if (reopened.length === 0) {
      await db.update(githubIssueLinks).set(columns).where(eq(githubIssueLinks.id, row.id));
    }
  } else {
    await db
      .update(githubIssueLinks)
      .set({ ...columns, ...(nextState !== row.state ? { state: nextState, updatedAt: now } : {}) })
      .where(eq(githubIssueLinks.id, row.id));
  }
  await afterChange(
    {
      tracker: "github",
      organizationId: row.organizationId,
      linkId: row.id,
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      handle: issueHandle({ tracker: "github", repo: row.repo, issueNumber: row.issueNumber }),
      url: row.issueUrl,
    },
    plan,
    reading,
    acknowledgeOnDone,
  );
  return plan.changed || plan.differs;
}

function githubAcknowledges(organizationId: string): () => Promise<boolean> {
  return once(
    async () => (await getGithubIssueSettings(organizationId)).acknowledgeOnDone ?? false,
  );
}

/**
 * Read and store the status of a set of one org's GitHub links, one request
 * each (GitHub's REST API has no batch issue read). A permission or transport
 * failure stops the batch and is thrown; a missing issue is recorded as
 * deleted.
 */
export async function syncGithubLinks(
  organizationId: string,
  rows: readonly GithubLinkRow[],
): Promise<IssueStatusRefreshResult> {
  const ack = githubAcknowledges(organizationId);
  let changed = 0;
  for (const row of rows) {
    const now = new Date();
    let raw: Record<string, unknown> | null;
    try {
      raw = await getIssueRaw(row.installationId, row.repo, row.issueNumber);
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 410) {
        raw = null;
      } else {
        throw err;
      }
    }
    try {
      const reading = raw ? githubReadingFromIssue(raw) : null;
      if (await applyGithubReading(row, reading ?? deletedReading(now), ack, now)) changed += 1;
    } catch (err) {
      console.error(`[issue-status] applying GitHub ${row.repo}#${row.issueNumber} failed:`, err);
    }
  }
  return { checked: rows.length, changed };
}

/**
 * Apply one verified GitHub App `issues` delivery. The App is shared by every
 * org on the server, so the links are found by installation, repository and
 * number, across orgs: one issue is only ever one org's, because the
 * fingerprint marker is org-scoped, but nothing breaks if two orgs share it.
 */
export async function applyGithubWebhook(change: GithubWebhookChange): Promise<number> {
  if (change.kind === "ignored") return 0;
  const number = change.kind === "updated" ? change.reading.number : change.number;
  const rows = await db
    .select()
    .from(githubIssueLinks)
    .where(
      and(
        eq(githubIssueLinks.installationId, change.installationId),
        eq(githubIssueLinks.repo, change.repo),
        eq(githubIssueLinks.issueNumber, number),
      ),
    );
  const now = new Date();
  for (const row of rows) {
    try {
      if (change.kind === "transferred") {
        // The issue lives on under a new address; the link follows it, and
        // the next poll or delivery for the new repository reads its status.
        await db
          .update(githubIssueLinks)
          .set({
            repo: change.newRepo,
            issueNumber: change.newNumber,
            issueUrl: change.newUrl,
            statusSyncedAt: null,
            updatedAt: now,
          })
          .where(eq(githubIssueLinks.id, row.id));
        continue;
      }
      const reading = change.kind === "updated" ? change.reading : deletedReading(now);
      await applyGithubReading(row, reading, githubAcknowledges(row.organizationId), now);
    } catch (err) {
      console.error(
        `[issue-status] applying GitHub webhook for ${change.repo}#${number} failed:`,
        err,
      );
    }
  }
  return rows.length;
}

// --- Claiming work ---

/** How long a link with an unfinished issue goes between polls. */
export const OPEN_POLL_INTERVAL_MS = 30 * 60_000;
/** A finished issue is still checked daily: issues get reopened. */
export const CLOSED_POLL_INTERVAL_MS = 24 * 60 * 60_000;
/** Links older than this are no longer polled (webhooks still update them). */
export const POLL_HORIZON_MS = 365 * 24 * 60 * 60_000;

/**
 * The due-ness condition, shared by the three tables: never checked, or an
 * unfinished issue not checked for half an hour, or a finished one not
 * checked for a day; only for links filed within the last year.
 */
function dueCondition(
  table: typeof jiraIssueLinks | typeof linearIssueLinks | typeof githubIssueLinks,
  now: Date,
) {
  const openCutoff = new Date(now.getTime() - OPEN_POLL_INTERVAL_MS);
  const closedCutoff = new Date(now.getTime() - CLOSED_POLL_INTERVAL_MS);
  return and(
    gte(table.createdAt, new Date(now.getTime() - POLL_HORIZON_MS)),
    or(
      isNull(table.statusSyncedAt),
      and(
        or(
          isNull(table.statusCategory),
          and(ne(table.statusCategory, "done"), ne(table.statusCategory, "canceled")),
        ),
        lt(table.statusSyncedAt, openCutoff),
      ),
      lt(table.statusSyncedAt, closedCutoff),
    ),
  );
}

/**
 * Claim up to `limit` due links of one tracker across all orgs, oldest-checked
 * first, by stamping `status_synced_at` in the same statement (`FOR UPDATE
 * SKIP LOCKED`), so two poller replicas never read the same issue twice and a
 * crashed pass simply leaves its links for the next interval.
 */
export async function claimDueJiraLinks(limit: number, now = new Date()): Promise<JiraLinkRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: jiraIssueLinks.id })
      .from(jiraIssueLinks)
      .where(dueCondition(jiraIssueLinks, now))
      .orderBy(sql`${jiraIssueLinks.statusSyncedAt} ASC NULLS FIRST`)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const ids = due.map((d) => d.id);
    const rows = await tx.select().from(jiraIssueLinks).where(inArray(jiraIssueLinks.id, ids));
    await tx
      .update(jiraIssueLinks)
      .set({ statusSyncedAt: now })
      .where(inArray(jiraIssueLinks.id, ids));
    return rows;
  });
}

export async function claimDueLinearLinks(
  limit: number,
  now = new Date(),
): Promise<LinearLinkRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: linearIssueLinks.id })
      .from(linearIssueLinks)
      .where(dueCondition(linearIssueLinks, now))
      .orderBy(sql`${linearIssueLinks.statusSyncedAt} ASC NULLS FIRST`)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const ids = due.map((d) => d.id);
    const rows = await tx.select().from(linearIssueLinks).where(inArray(linearIssueLinks.id, ids));
    await tx
      .update(linearIssueLinks)
      .set({ statusSyncedAt: now })
      .where(inArray(linearIssueLinks.id, ids));
    return rows;
  });
}

export async function claimDueGithubLinks(
  limit: number,
  now = new Date(),
): Promise<GithubLinkRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: githubIssueLinks.id })
      .from(githubIssueLinks)
      .where(dueCondition(githubIssueLinks, now))
      .orderBy(sql`${githubIssueLinks.statusSyncedAt} ASC NULLS FIRST`)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const ids = due.map((d) => d.id);
    const rows = await tx.select().from(githubIssueLinks).where(inArray(githubIssueLinks.id, ids));
    await tx
      .update(githubIssueLinks)
      .set({ statusSyncedAt: now })
      .where(inArray(githubIssueLinks.id, ids));
    return rows;
  });
}

// --- "Refresh statuses" ---

/** At most this many links per tracker are read by one click. */
export const REFRESH_LIMIT = 200;

/**
 * Re-read one org's links for one tracker now, most recently filed first.
 * User-initiated: throws the tracker's own error (the route turns it into a
 * message), so "the token was revoked" is not reported as "0 changed".
 */
export async function refreshOrgIssueStatuses(
  organizationId: string,
  tracker: IssueTracker,
): Promise<IssueStatusRefreshResult> {
  switch (tracker) {
    case "jira": {
      const rows = await db
        .select()
        .from(jiraIssueLinks)
        .where(eq(jiraIssueLinks.organizationId, organizationId))
        .orderBy(asc(sql`${jiraIssueLinks.statusSyncedAt} NULLS FIRST`))
        .limit(REFRESH_LIMIT);
      return syncJiraLinks(organizationId, rows);
    }
    case "linear": {
      const rows = await db
        .select()
        .from(linearIssueLinks)
        .where(eq(linearIssueLinks.organizationId, organizationId))
        .orderBy(asc(sql`${linearIssueLinks.statusSyncedAt} NULLS FIRST`))
        .limit(REFRESH_LIMIT);
      return syncLinearLinks(organizationId, rows);
    }
    case "github": {
      const rows = await db
        .select()
        .from(githubIssueLinks)
        .where(eq(githubIssueLinks.organizationId, organizationId))
        .orderBy(asc(sql`${githubIssueLinks.statusSyncedAt} NULLS FIRST`))
        .limit(REFRESH_LIMIT);
      return syncGithubLinks(organizationId, rows);
    }
  }
}
