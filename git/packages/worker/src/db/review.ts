/**
 * Reviewing work a branch at a time, as Postgres holds it
 * (`git-review-schema.ts`): the versions of a branch, who has reviewed up to
 * which, a repository's review settings, the agent behind a branch page, and
 * the counts the branch page and the inbox show. (`auto_open_branch_pages`
 * and `git_users.review_mode` are in the schema still, and read by nothing:
 * every branch has a page, and there is one way to read it.)
 *
 * Versions are numbered by the repository's Durable Object; rows here are
 * copies made by the queue consumer (`events/versions.ts`), unique on
 * repository, branch, lineage and number, so copying one twice writes one.
 */
import { type SQL, and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  type GitAgentIdentity,
  type GitAgentKind,
  gitAgentLinks,
  gitBranchVersions,
  gitInstructions,
  gitIssueAssignees,
  gitIssues,
  gitMergeOverrides,
  gitNamespaces,
  gitPullRequests,
  gitRepositories,
  gitReviewComments,
  gitReviewFindings,
  gitReviewRuns,
  gitReviewSettings,
  gitReviews,
  gitTraceEntries,
  gitUsers,
  gitVersionReviews,
} from "@infrawrench/server-core/db/schema";
import { db, newId } from "./client";
import { type TimeCursor, toPage } from "./cursor";
import type { PullRequestRow } from "./pulls";
import { type ListViewer, visibleTo } from "./repositories";

export type VersionRow = typeof gitBranchVersions.$inferSelect;
export type AgentLinkRow = typeof gitAgentLinks.$inferSelect;
export type ReviewSettingsRow = typeof gitReviewSettings.$inferSelect;

/** How long a version's commit outlives its branch being merged or deleted. The row stays. */
export const VERSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** The newest version copied here for a branch: where the next copy starts. */
export const latestVersionOf = async (
  repositoryId: string,
  branch: string,
): Promise<VersionRow | null> => {
  const [row] = await db
    .select()
    .from(gitBranchVersions)
    .where(
      and(eq(gitBranchVersions.repositoryId, repositoryId), eq(gitBranchVersions.branch, branch)),
    )
    .orderBy(desc(gitBranchVersions.lineage), desc(gitBranchVersions.number))
    .limit(1);
  return row ?? null;
};

export interface NewVersion {
  readonly repositoryId: string;
  readonly branch: string;
  readonly lineage: number;
  readonly number: number;
  readonly tipOid: string;
  readonly baseOid: string | null;
  readonly targetRef: string | null;
  readonly previousOid: string | null;
  readonly forced: boolean;
  readonly pusherUserId: string | null;
  readonly pusherKind: string | null;
  readonly agent: GitAgentIdentity | null;
  readonly pullRequestId: string | null;
  readonly commitsCount: number | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly changedFiles: number | null;
  readonly createdAt: Date;
}

/** Copy a version. Null when it was here already: the first copy stands. */
export const insertVersion = async (version: NewVersion): Promise<VersionRow | null> => {
  const [row] = await db
    .insert(gitBranchVersions)
    .values({ id: newId(), ...version })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
};

/**
 * A lineage that has a new version is a branch that is alive: its versions
 * are kept, and those of the lineages before it (the branch was deleted and
 * made again) are due thirty days after the new one started.
 */
export const keepLineage = async (
  repositoryId: string,
  branch: string,
  lineage: number,
  at: Date,
): Promise<void> => {
  const branchIs = and(
    eq(gitBranchVersions.repositoryId, repositoryId),
    eq(gitBranchVersions.branch, branch),
  );
  await db
    .update(gitBranchVersions)
    .set({ pruneAfter: null })
    .where(
      and(
        branchIs,
        eq(gitBranchVersions.lineage, lineage),
        sql`${gitBranchVersions.pruneAfter} is not null`,
      ),
    );
  await db
    .update(gitBranchVersions)
    .set({ pruneAfter: new Date(at.getTime() + VERSION_RETENTION_MS) })
    .where(
      and(
        branchIs,
        sql`${gitBranchVersions.lineage} < ${lineage}`,
        isNull(gitBranchVersions.pruneAfter),
      ),
    );
};

/** The branch was merged or deleted: its versions' refs go thirty days from `at`, unless already due. */
export const markBranchForPruning = async (
  repositoryId: string,
  branch: string,
  at: Date,
): Promise<void> => {
  await db
    .update(gitBranchVersions)
    .set({ pruneAfter: new Date(at.getTime() + VERSION_RETENTION_MS) })
    .where(
      and(
        eq(gitBranchVersions.repositoryId, repositoryId),
        eq(gitBranchVersions.branch, branch),
        isNull(gitBranchVersions.pruneAfter),
        isNull(gitBranchVersions.prunedAt),
      ),
    );
};

/** Versions whose time has come and whose refs are still there, oldest first. */
export const dueVersions = (now: Date, limit: number): Promise<VersionRow[]> =>
  db
    .select()
    .from(gitBranchVersions)
    .where(and(lte(gitBranchVersions.pruneAfter, now), isNull(gitBranchVersions.prunedAt)))
    .orderBy(asc(gitBranchVersions.pruneAfter))
    .limit(limit);

/**
 * Their refs are gone. The rows stay as the record: the numbers, the trace
 * entries, the findings and the review comments all still name them.
 */
export const markVersionsPruned = async (ids: readonly string[], at: Date): Promise<void> => {
  if (ids.length === 0) return;
  await db
    .update(gitBranchVersions)
    .set({ prunedAt: at })
    .where(and(inArray(gitBranchVersions.id, [...ids]), isNull(gitBranchVersions.prunedAt)));
};

/**
 * Give a pull request the versions its head branch already has: those of
 * the branch's newest lineage that belong to no pull request yet.
 */
export const linkVersionsToPull = async (
  repositoryId: string,
  branch: string,
  pullRequestId: string,
): Promise<void> => {
  const latest = await latestVersionOf(repositoryId, branch);
  if (!latest) return;
  await db
    .update(gitBranchVersions)
    .set({ pullRequestId })
    .where(
      and(
        eq(gitBranchVersions.repositoryId, repositoryId),
        eq(gitBranchVersions.branch, branch),
        eq(gitBranchVersions.lineage, latest.lineage),
        isNull(gitBranchVersions.pullRequestId),
      ),
    );
};

/**
 * A pull request's versions, oldest first: those recorded for it, of the
 * newest lineage among them. A pull request that shares its head branch with
 * an older one has none of its own and reads the branch's.
 */
export const versionsForPull = async (pull: PullRequestRow): Promise<VersionRow[]> => {
  const order = [asc(gitBranchVersions.lineage), asc(gitBranchVersions.number)] as const;
  let rows = await db
    .select()
    .from(gitBranchVersions)
    .where(eq(gitBranchVersions.pullRequestId, pull.issueId))
    .orderBy(...order);
  if (rows.length === 0 && pull.headRepositoryId !== null) {
    rows = await db
      .select()
      .from(gitBranchVersions)
      .where(
        and(
          eq(gitBranchVersions.repositoryId, pull.headRepositoryId),
          eq(gitBranchVersions.branch, pull.headRef),
        ),
      )
      .orderBy(...order);
  }
  const lineage = rows.at(-1)?.lineage;
  return rows.filter((row) => row.lineage === lineage);
};

/** The newest version number of each of these pull requests, by pull request id. */
export const latestVersionNumbers = async (
  pullRequestIds: readonly string[],
): Promise<Map<string, number>> => {
  const latest = new Map<string, number>();
  if (pullRequestIds.length === 0) return latest;
  const rows = await db
    .select({
      pullRequestId: gitBranchVersions.pullRequestId,
      lineage: gitBranchVersions.lineage,
      number: gitBranchVersions.number,
    })
    .from(gitBranchVersions)
    .where(inArray(gitBranchVersions.pullRequestId, [...pullRequestIds]))
    .orderBy(asc(gitBranchVersions.lineage), asc(gitBranchVersions.number));
  // Ordered, so the newest of the newest lineage is the last one seen.
  for (const row of rows) if (row.pullRequestId) latest.set(row.pullRequestId, row.number);
  return latest;
};

export interface VersionCounts {
  readonly comments: number;
  readonly findings: number;
  readonly traceEntries: number;
  readonly answeredInstructions: number;
  readonly reviewStatus: "queued" | "running" | "done" | "failed" | null;
}

/** What each version of a pull request carries, by version number. */
export const versionCounts = async (
  pullRequestId: string,
  versions: readonly VersionRow[],
): Promise<Map<number, VersionCounts>> => {
  const ids = versions.map((version) => version.id);
  const count = sql<number>`count(*)::int`;
  const [comments, findings, traces, answered, runs] = await Promise.all([
    db
      .select({ number: gitReviewComments.versionNumber, count })
      .from(gitReviewComments)
      .innerJoin(gitReviews, eq(gitReviews.id, gitReviewComments.reviewId))
      .where(
        and(
          eq(gitReviewComments.pullRequestId, pullRequestId),
          sql`${gitReviews.state} <> 'pending'`,
        ),
      )
      .groupBy(gitReviewComments.versionNumber),
    db
      .select({ number: gitReviewFindings.versionNumber, count })
      .from(gitReviewFindings)
      .where(eq(gitReviewFindings.pullRequestId, pullRequestId))
      .groupBy(gitReviewFindings.versionNumber),
    ids.length === 0
      ? []
      : db
          .select({ versionId: gitTraceEntries.versionId, count })
          .from(gitTraceEntries)
          .where(inArray(gitTraceEntries.versionId, ids))
          .groupBy(gitTraceEntries.versionId),
    db
      .select({ number: gitInstructions.answeredInVersionNumber, count })
      .from(gitInstructions)
      .where(
        and(
          eq(gitInstructions.pullRequestId, pullRequestId),
          eq(gitInstructions.status, "answered"),
        ),
      )
      .groupBy(gitInstructions.answeredInVersionNumber),
    db
      .select({ number: gitReviewRuns.versionNumber, status: gitReviewRuns.status })
      .from(gitReviewRuns)
      .where(eq(gitReviewRuns.pullRequestId, pullRequestId))
      .orderBy(asc(gitReviewRuns.createdAt)),
  ]);
  const by = <T extends { count: number }>(rows: readonly T[], key: (row: T) => unknown) =>
    new Map(rows.map((row) => [key(row), row.count]));
  const commentsBy = by(comments, (row) => row.number);
  const findingsBy = by(findings, (row) => row.number);
  const tracesBy = by(traces, (row) => row.versionId);
  const answeredBy = by(answered, (row) => row.number);
  // Oldest first, so the newest run's status is the one left.
  const statusBy = new Map(runs.map((run) => [run.number, run.status]));
  return new Map(
    versions.map((version) => [
      version.number,
      {
        comments: commentsBy.get(version.number) ?? 0,
        findings: findingsBy.get(version.number) ?? 0,
        traceEntries: tracesBy.get(version.id) ?? 0,
        answeredInstructions: answeredBy.get(version.number) ?? 0,
        reviewStatus: statusBy.get(version.number) ?? null,
      },
    ]),
  );
};

// ---------------------------------------------------------------------------
// "Since you last looked"
// ---------------------------------------------------------------------------

export type ReviewedMarkRow = typeof gitVersionReviews.$inferSelect;

export const getReviewedMark = async (
  pullRequestId: string,
  userId: string,
): Promise<ReviewedMarkRow | null> => {
  const [row] = await db
    .select()
    .from(gitVersionReviews)
    .where(
      and(eq(gitVersionReviews.pullRequestId, pullRequestId), eq(gitVersionReviews.userId, userId)),
    )
    .limit(1);
  return row ?? null;
};

/** Mark a pull request reviewed up to a version. A mark never moves back within a lineage. */
export const setReviewedMark = async (
  pullRequestId: string,
  userId: string,
  version: VersionRow,
): Promise<ReviewedMarkRow> => {
  const mark = {
    versionId: version.id,
    lineage: version.lineage,
    versionNumber: version.number,
    tipOid: version.tipOid,
    reviewedAt: new Date(),
  };
  const [row] = await db
    .insert(gitVersionReviews)
    .values({ pullRequestId, userId, ...mark })
    .onConflictDoUpdate({
      target: [gitVersionReviews.pullRequestId, gitVersionReviews.userId],
      set: mark,
      setWhere: sql`(${gitVersionReviews.lineage}, ${gitVersionReviews.versionNumber}) < (${version.lineage}, ${version.number})`,
    })
    .returning();
  return row ?? (await getReviewedMark(pullRequestId, userId))!;
};

// ---------------------------------------------------------------------------
// Traces: what a push claims
// ---------------------------------------------------------------------------

/**
 * Give a new version the trace entries that were waiting on its branch when
 * it was pushed. Entries recorded after the push wait for the next one.
 */
export const claimTraceEntries = async (version: VersionRow): Promise<void> => {
  await db
    .update(gitTraceEntries)
    .set({ versionId: version.id })
    .where(
      and(
        eq(gitTraceEntries.repositoryId, version.repositoryId),
        eq(gitTraceEntries.branch, version.branch),
        isNull(gitTraceEntries.versionId),
        lte(gitTraceEntries.createdAt, version.createdAt),
      ),
    );
};

export const pendingTraceCount = async (repositoryId: string, branch: string): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gitTraceEntries)
    .where(
      and(
        eq(gitTraceEntries.repositoryId, repositoryId),
        eq(gitTraceEntries.branch, branch),
        isNull(gitTraceEntries.versionId),
      ),
    );
  return row?.count ?? 0;
};

// ---------------------------------------------------------------------------
// Settings and preferences
// ---------------------------------------------------------------------------

export interface ReviewSettingsValue {
  readonly reviewAgentsEnabled: boolean;
  readonly reviewerKinds: readonly string[];
  readonly mustFixBlocksMerge: boolean;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettingsValue = {
  reviewAgentsEnabled: false,
  reviewerKinds: ["general"],
  mustFixBlocksMerge: true,
};

/** A repository's review settings: its row, or the defaults when it has none. */
export const getReviewSettings = async (repositoryId: string): Promise<ReviewSettingsValue> => {
  const [row] = await db
    .select()
    .from(gitReviewSettings)
    .where(eq(gitReviewSettings.repositoryId, repositoryId))
    .limit(1);
  return row
    ? {
        reviewAgentsEnabled: row.reviewAgentsEnabled,
        reviewerKinds: row.reviewerKinds,
        mustFixBlocksMerge: row.mustFixBlocksMerge,
      }
    : DEFAULT_REVIEW_SETTINGS;
};

export const updateReviewSettings = async (
  repositoryId: string,
  patch: Partial<ReviewSettingsValue>,
  userId: string | null,
): Promise<ReviewSettingsValue> => {
  const next = { ...(await getReviewSettings(repositoryId)), ...patch };
  const values = {
    reviewAgentsEnabled: next.reviewAgentsEnabled,
    reviewerKinds: [...next.reviewerKinds],
    mustFixBlocksMerge: next.mustFixBlocksMerge,
    updatedByUserId: userId,
    updatedAt: new Date(),
  };
  await db
    .insert(gitReviewSettings)
    .values({ repositoryId, ...values })
    .onConflictDoUpdate({ target: gitReviewSettings.repositoryId, set: values });
  return next;
};

// ---------------------------------------------------------------------------
// The agent behind a pull request
// ---------------------------------------------------------------------------

export const getAgentLink = async (pullRequestId: string): Promise<AgentLinkRow | null> => {
  const [row] = await db
    .select()
    .from(gitAgentLinks)
    .where(eq(gitAgentLinks.pullRequestId, pullRequestId))
    .limit(1);
  return row ?? null;
};

export const setAgentLink = async (link: {
  readonly pullRequestId: string;
  readonly repositoryId: string;
  readonly kind: GitAgentKind;
  readonly displayName: string;
  readonly externalRefs: Record<string, string>;
  readonly t3EnvironmentId: string | null;
  readonly connectedByUserId: string | null;
}): Promise<AgentLinkRow> => {
  const now = new Date();
  const [row] = await db
    .insert(gitAgentLinks)
    .values(link)
    .onConflictDoUpdate({
      target: gitAgentLinks.pullRequestId,
      set: {
        kind: link.kind,
        displayName: link.displayName,
        externalRefs: link.externalRefs,
        t3EnvironmentId: link.t3EnvironmentId,
        connectedByUserId: link.connectedByUserId,
        updatedAt: now,
      },
    })
    .returning();
  return row!;
};

/**
 * Write one of a link's refs, or take it away with null, leaving the rest
 * as they are: one statement, so it cannot undo a ref somebody else wrote.
 */
export const noteAgentLinkRef = async (
  pullRequestId: string,
  key: string,
  value: string | null,
): Promise<void> => {
  await db
    .update(gitAgentLinks)
    .set({
      externalRefs:
        value === null
          ? sql`${gitAgentLinks.externalRefs} - ${key}::text`
          : sql`${gitAgentLinks.externalRefs} || jsonb_build_object(${key}::text, ${value}::text)`,
    })
    .where(eq(gitAgentLinks.pullRequestId, pullRequestId));
};

export const removeAgentLink = async (pullRequestId: string): Promise<void> => {
  await db.delete(gitAgentLinks).where(eq(gitAgentLinks.pullRequestId, pullRequestId));
};

// ---------------------------------------------------------------------------
// Findings and instructions, as counts
// ---------------------------------------------------------------------------

export interface FindingsCount {
  readonly found: number;
  readonly open: number;
  readonly fixed: number;
  readonly dismissed: number;
  /** Open must-fix findings no override covers. */
  readonly mustFixOpen: number;
  /** Open findings nobody has sent to the agent. */
  readonly needsPerson: number;
}

/** The ids of findings an administrator's override covers, for a pull request. */
export const overriddenFindingIds = async (pullRequestId: string): Promise<Set<string>> => {
  const rows = await db
    .select({ findingIds: gitMergeOverrides.findingIds })
    .from(gitMergeOverrides)
    .where(eq(gitMergeOverrides.pullRequestId, pullRequestId));
  return new Set(rows.flatMap((row) => row.findingIds));
};

export const findingsCount = async (pullRequestId: string): Promise<FindingsCount> => {
  const [rows, overridden, sent] = await Promise.all([
    db
      .select({
        id: gitReviewFindings.id,
        status: gitReviewFindings.status,
        severity: gitReviewFindings.severity,
      })
      .from(gitReviewFindings)
      .where(eq(gitReviewFindings.pullRequestId, pullRequestId)),
    overriddenFindingIds(pullRequestId),
    db
      .select({ findingId: gitInstructions.findingId })
      .from(gitInstructions)
      .where(
        and(
          eq(gitInstructions.pullRequestId, pullRequestId),
          sql`${gitInstructions.findingId} is not null`,
          sql`${gitInstructions.status} <> 'dismissed'`,
        ),
      ),
  ]);
  const withAgent = new Set(sent.map((row) => row.findingId));
  const open = rows.filter((row) => row.status === "open");
  return {
    found: rows.length,
    open: open.length,
    fixed: rows.filter((row) => row.status === "fixed").length,
    dismissed: rows.filter((row) => row.status === "dismissed").length,
    mustFixOpen: open.filter((row) => row.severity === "must_fix" && !overridden.has(row.id))
      .length,
    needsPerson: open.filter((row) => !withAgent.has(row.id)).length,
  };
};

/**
 * Instructions that are with the agent or on their way: queued, delivered,
 * or answered by a version it has not pushed yet (`db/instructions.ts`).
 */
export const openInstructionCount = async (pullRequestId: string): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gitInstructions)
    .where(
      and(
        eq(gitInstructions.pullRequestId, pullRequestId),
        or(
          inArray(gitInstructions.status, ["queued", "delivered"]),
          and(
            eq(gitInstructions.status, "answered"),
            isNull(gitInstructions.answeredInVersionNumber),
          ),
        ),
      ),
    );
  return row?.count ?? 0;
};

/** The newest review run's status on a version of a pull request. */
export const latestRunStatus = async (
  pullRequestId: string,
  versionNumber: number,
): Promise<"queued" | "running" | "done" | "failed" | null> => {
  const [row] = await db
    .select({ status: gitReviewRuns.status })
    .from(gitReviewRuns)
    .where(
      and(
        eq(gitReviewRuns.pullRequestId, pullRequestId),
        eq(gitReviewRuns.versionNumber, versionNumber),
      ),
    )
    .orderBy(desc(gitReviewRuns.createdAt))
    .limit(1);
  return row?.status ?? null;
};

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

export interface InboxRow {
  readonly pullRequestId: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly repositoryName: string;
  readonly visibility: "public" | "private";
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  readonly draft: boolean;
  readonly authorUserId: string | null;
  readonly agentKind: GitAgentKind | null;
  readonly agentName: string | null;
  readonly latestVersion: number;
  readonly reviewedVersion: number | null;
  readonly reviewedAt: Date | null;
  readonly waitingSince: Date;
  readonly versions: number;
}

/**
 * Open pull requests the viewer has a part in (they wrote it, are assigned,
 * have reviewed it or marked a version of it, or connected its agent) that
 * have a version newer than the one they last reviewed, in repositories they
 * can still read. The longest wait first.
 */
export const reviewInbox = async (
  viewer: ListViewer & { readonly userId: string },
  page: { readonly cursor: TimeCursor | null; readonly limit: number },
): Promise<{ readonly items: InboxRow[]; readonly nextCursor: string | null }> => {
  const me = viewer.userId;
  const mark = gitVersionReviews;
  const version = gitBranchVersions;
  // Versions newer than the viewer's mark: every one when they have none.
  const unseen = sql`(${mark.userId} is null or (${version.lineage}, ${version.number}) > (${mark.lineage}, ${mark.versionNumber}))`;
  const waitingSince = sql<Date>`min(${version.createdAt}) filter (where ${unseen})`;
  const waitingMillis = sql<Date>`date_trunc('milliseconds', ${waitingSince})`;
  const involved: SQL = or(
    eq(gitIssues.authorUserId, me),
    sql`${mark.userId} is not null`,
    sql`exists (select 1 from ${gitIssueAssignees} where ${gitIssueAssignees.issueId} = ${gitIssues.id} and ${gitIssueAssignees.userId} = ${me})`,
    sql`exists (select 1 from ${gitReviews} where ${gitReviews.pullRequestId} = ${gitIssues.id} and ${gitReviews.authorUserId} = ${me})`,
    eq(gitAgentLinks.connectedByUserId, me),
  )!;
  const after = page.cursor
    ? sql`(${waitingMillis}, ${gitIssues.id}) > (${new Date(page.cursor.at).toISOString()}::timestamptz at time zone 'UTC', ${page.cursor.id})`
    : undefined;
  const rows = await db
    .select({
      pullRequestId: gitIssues.id,
      repositoryId: gitRepositories.id,
      owner: gitNamespaces.slug,
      repositoryName: gitRepositories.name,
      visibility: gitRepositories.visibility,
      number: gitIssues.number,
      title: gitIssues.title,
      branch: gitPullRequests.headRef,
      draft: gitPullRequests.draft,
      authorUserId: gitIssues.authorUserId,
      agentKind: gitAgentLinks.kind,
      agentName: gitAgentLinks.displayName,
      latestVersion: sql<number>`(array_agg(${version.number} order by ${version.lineage} desc, ${version.number} desc))[1]`,
      reviewedVersion: mark.versionNumber,
      reviewedAt: mark.reviewedAt,
      waitingSince,
      versions: sql<number>`(count(*) filter (where ${unseen}))::int`,
    })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .innerJoin(gitRepositories, eq(gitRepositories.id, gitPullRequests.repositoryId))
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .innerJoin(version, eq(version.pullRequestId, gitPullRequests.issueId))
    .leftJoin(mark, and(eq(mark.pullRequestId, gitPullRequests.issueId), eq(mark.userId, me)))
    .leftJoin(gitAgentLinks, eq(gitAgentLinks.pullRequestId, gitPullRequests.issueId))
    .where(
      and(
        eq(gitIssues.state, "open"),
        eq(gitRepositories.archived, false),
        visibleTo(viewer),
        involved,
      ),
    )
    .groupBy(
      gitIssues.id,
      gitRepositories.id,
      gitNamespaces.slug,
      gitPullRequests.issueId,
      mark.pullRequestId,
      mark.userId,
      gitAgentLinks.pullRequestId,
    )
    .having(after ? and(sql`${waitingSince} is not null`, after) : sql`${waitingSince} is not null`)
    .orderBy(sql`${waitingMillis} asc`, asc(gitIssues.id))
    .limit(page.limit + 1);
  return toPage(rows, page.limit, (row) => ({
    at: new Date(row.waitingSince).getTime(),
    id: row.pullRequestId,
  }));
};

/** What happened on these pull requests since a time each: comments and findings, by pull request id. */
export const changesSince = async (
  since: ReadonlyArray<{ readonly pullRequestId: string; readonly at: Date | null }>,
): Promise<Map<string, { comments: number; findings: number; mustFixOpen: number }>> => {
  const out = new Map<string, { comments: number; findings: number; mustFixOpen: number }>();
  for (const { pullRequestId, at } of since) {
    const from = at ?? new Date(0);
    const [[comments], [findings], tally] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(gitReviewComments)
        .innerJoin(gitReviews, eq(gitReviews.id, gitReviewComments.reviewId))
        .where(
          and(
            eq(gitReviewComments.pullRequestId, pullRequestId),
            sql`${gitReviews.state} <> 'pending'`,
            gt(gitReviewComments.createdAt, from),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(gitReviewFindings)
        .where(
          and(
            eq(gitReviewFindings.pullRequestId, pullRequestId),
            gt(gitReviewFindings.createdAt, from),
          ),
        ),
      findingsCount(pullRequestId),
    ]);
    out.set(pullRequestId, {
      comments: comments?.count ?? 0,
      findings: findings?.count ?? 0,
      mustFixOpen: tally.mustFixOpen,
    });
  }
  return out;
};
