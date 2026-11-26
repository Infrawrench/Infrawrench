/**
 * A person's work across repositories, as Postgres holds it: the branches
 * (pull requests) of the repositories they have a tie to, the ones suggested
 * for their review, what happened lately, and where they were mentioned.
 *
 * Every query is behind `tiedTo`, which is narrower than `visibleTo`: a
 * public repository the viewer has nothing to do with is not their work, and
 * a private one they cannot read is in none of it. What a row says about a
 * branch (its state, its newest version, its open must-fix findings) is read
 * in the same statement, never a query a row.
 */
import { type SQL, and, asc, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import {
  type GitAgentKind,
  gitAgentLinks,
  gitBranchVersions,
  gitComments,
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
  gitReviews,
  gitTraceEntries,
  gitVersionReviews,
} from "@infrawrench/server-core/db/schema";
import { db } from "./client";
import { type TimeCursor, afterCursor, cursorTime, toPage } from "./cursor";
import { type ListViewer, tiedTo } from "./repositories";

export type WorkspaceViewer = ListViewer & { readonly userId: string };

export interface WorkspaceScope {
  readonly viewer: WorkspaceViewer;
  /** Only this namespace's repositories, by lowercased slug. */
  readonly namespace?: string | undefined;
}

const pull = gitPullRequests;
const issue = gitIssues;
const repo = gitRepositories;
const owner = gitNamespaces;
const link = gitAgentLinks;
const version = gitBranchVersions;
const mark = gitVersionReviews;

/** The repositories a workspace is made of. Archived ones are nobody's work in progress. */
const inScope = ({ viewer, namespace }: WorkspaceScope, withArchived = false): SQL =>
  and(
    tiedTo(viewer) ?? sql`false`,
    withArchived ? undefined : eq(repo.archived, false),
    namespace === undefined ? undefined : eq(owner.slugLower, namespace.toLowerCase()),
  )!;

/** The viewer wrote it, or connected the agent that does. */
const mineOf = (me: string): SQL<boolean> =>
  sql<boolean>`(coalesce(${issue.authorUserId} = ${me}, false) or coalesce(${link.connectedByUserId} = ${me}, false))`;

/** An instruction is with the agent, or it has recorded work it has not pushed (`views/review.ts`). */
const working = sql<boolean>`(exists (select 1 from ${gitInstructions} where ${gitInstructions.pullRequestId} = ${pull.issueId} and (${gitInstructions.status} in ('queued', 'delivered') or (${gitInstructions.status} = 'answered' and ${gitInstructions.answeredInVersionNumber} is null))) or exists (select 1 from ${gitTraceEntries} where ${gitTraceEntries.repositoryId} = ${pull.headRepositoryId} and ${gitTraceEntries.branch} = ${pull.headRef} and ${gitTraceEntries.versionId} is null))`;

const changeColumns = {
  pullRequestId: pull.issueId,
  repositoryId: repo.id,
  owner: owner.slug,
  repositoryName: repo.name,
  visibility: repo.visibility,
  number: issue.number,
  title: issue.title,
  // The first line is all a list shows of it.
  body: sql<string>`left(${issue.body}, 600)`,
  branch: pull.headRef,
  headOid: pull.headOid,
  draft: pull.draft,
  threadState: issue.state,
  mergedAt: pull.mergedAt,
  authorUserId: issue.authorUserId,
  agentKind: link.kind,
  agentName: link.displayName,
  additions: pull.additions,
  deletions: pull.deletions,
  changedFiles: pull.changedFiles,
  updatedAt: issue.updatedAt,
  working,
  latestVersion: sql<
    number | null
  >`(select ${version.number} from ${version} where ${version.pullRequestId} = ${pull.issueId} order by ${version.lineage} desc, ${version.number} desc limit 1)`,
  /** The newest review that says yes or no. A dismissed one says neither. */
  verdict: sql<
    "approved" | "changes_requested" | null
  >`(select ${gitReviews.state} from ${gitReviews} where ${gitReviews.pullRequestId} = ${pull.issueId} and ${gitReviews.state} in ('approved', 'changes_requested') order by ${gitReviews.submittedAt} desc nulls last limit 1)`,
  /** Open must-fix findings no override covers. */
  mustFixOpen: sql<number>`(select count(*)::int from ${gitReviewFindings} where ${gitReviewFindings.pullRequestId} = ${pull.issueId} and ${gitReviewFindings.status} = 'open' and ${gitReviewFindings.severity} = 'must_fix' and not exists (select 1 from ${gitMergeOverrides} where ${gitMergeOverrides.pullRequestId} = ${pull.issueId} and ${gitMergeOverrides.findingIds} @> to_jsonb(${gitReviewFindings.id})))`,
} as const;

export interface ChangeRow {
  readonly pullRequestId: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly repositoryName: string;
  readonly visibility: "public" | "private";
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly branch: string;
  readonly headOid: string;
  readonly draft: boolean;
  readonly threadState: "open" | "closed";
  readonly mergedAt: Date | null;
  readonly authorUserId: string | null;
  readonly agentKind: GitAgentKind | null;
  readonly agentName: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly updatedAt: Date;
  readonly working: boolean;
  readonly latestVersion: number | null;
  readonly verdict: "approved" | "changes_requested" | null;
  readonly mustFixOpen: number;
}

export interface ListChangesOptions extends WorkspaceScope {
  readonly state: "open" | "merged" | "all";
  readonly author: "mine" | "team" | "all";
  readonly cursor: TimeCursor | null;
  readonly limit: number;
}

/** Branches, the most recently active first. */
export const listChanges = async (
  options: ListChangesOptions,
): Promise<{ readonly items: ChangeRow[]; readonly nextCursor: string | null }> => {
  const mine = mineOf(options.viewer.userId);
  const rows = await db
    .select(changeColumns)
    .from(pull)
    .innerJoin(issue, eq(issue.id, pull.issueId))
    .innerJoin(repo, eq(repo.id, pull.repositoryId))
    .innerJoin(owner, eq(owner.id, repo.namespaceId))
    .leftJoin(link, eq(link.pullRequestId, pull.issueId))
    .where(
      and(
        inScope(options),
        options.state === "open"
          ? eq(issue.state, "open")
          : options.state === "merged"
            ? isNotNull(pull.mergedAt)
            : undefined,
        options.author === "mine" ? mine : options.author === "team" ? sql`not ${mine}` : undefined,
        afterCursor(issue.updatedAt, issue.id, options.cursor, "desc"),
      ),
    )
    .orderBy(desc(cursorTime(issue.updatedAt)), desc(issue.id))
    .limit(options.limit + 1);
  return toPage(rows, options.limit, (row) => ({
    at: row.updatedAt.getTime(),
    id: row.pullRequestId,
  }));
};

export interface OpenCounts {
  readonly mine: number;
  readonly team: number;
  readonly working: number;
}

/** How many branches are open: the viewer's, everyone else's, and those an agent is on. */
export const countOpenChanges = async (scope: WorkspaceScope): Promise<OpenCounts> => {
  const mine = mineOf(scope.viewer.userId);
  const [row] = await db
    .select({
      mine: sql<number>`(count(*) filter (where ${mine}))::int`,
      team: sql<number>`(count(*) filter (where not ${mine}))::int`,
      working: sql<number>`(count(*) filter (where ${working}))::int`,
    })
    .from(pull)
    .innerJoin(issue, eq(issue.id, pull.issueId))
    .innerJoin(repo, eq(repo.id, pull.repositoryId))
    .innerJoin(owner, eq(owner.id, repo.namespaceId))
    .leftJoin(link, eq(link.pullRequestId, pull.issueId))
    .where(and(inScope(scope), eq(issue.state, "open")));
  return { mine: row?.mine ?? 0, team: row?.team ?? 0, working: row?.working ?? 0 };
};

export interface SuggestedRow extends ChangeRow {
  readonly assigned: boolean;
  readonly reviewedVersion: number | null;
  readonly commented: boolean;
  readonly commentedVersion: number | null;
  readonly pushes: boolean;
  readonly total: number;
}

/**
 * Other people's open branches, out of draft and not with their agent, that
 * have a version the viewer has not reviewed and that they have not approved
 * as it stands. The ones they have the most to do with first, then the most
 * recently active.
 */
export const suggestedReviews = async (
  scope: WorkspaceScope,
  limit: number,
): Promise<{ readonly items: SuggestedRow[]; readonly count: number }> => {
  const me = scope.viewer.userId;
  const assigned = sql<boolean>`exists (select 1 from ${gitIssueAssignees} where ${gitIssueAssignees.issueId} = ${issue.id} and ${gitIssueAssignees.userId} = ${me})`;
  const commented = sql<boolean>`exists (select 1 from ${gitReviews} where ${gitReviews.pullRequestId} = ${pull.issueId} and ${gitReviews.authorUserId} = ${me} and ${gitReviews.state} <> 'pending')`;
  const pushes = sql<boolean>`exists (select 1 from ${version} where ${version.repositoryId} = ${repo.id} and ${version.pusherUserId} = ${me})`;
  // A version newer than the viewer's mark: every one when they have none.
  const unseen = sql`exists (select 1 from ${version} where ${version.pullRequestId} = ${pull.issueId} and (${mark.userId} is null or (${version.lineage}, ${version.number}) > (${mark.lineage}, ${mark.versionNumber})))`;
  const rank = sql`(case when ${assigned} then 3 when ${mark.userId} is not null or ${commented} then 2 when ${pushes} then 1 else 0 end)`;
  const rows = await db
    .select({
      ...changeColumns,
      assigned,
      reviewedVersion: mark.versionNumber,
      commented,
      commentedVersion: sql<
        number | null
      >`(select max(${gitReviewComments.versionNumber}) from ${gitReviewComments} where ${gitReviewComments.pullRequestId} = ${pull.issueId} and ${gitReviewComments.authorUserId} = ${me})`,
      pushes,
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(pull)
    .innerJoin(issue, eq(issue.id, pull.issueId))
    .innerJoin(repo, eq(repo.id, pull.repositoryId))
    .innerJoin(owner, eq(owner.id, repo.namespaceId))
    .leftJoin(link, eq(link.pullRequestId, pull.issueId))
    .leftJoin(mark, and(eq(mark.pullRequestId, pull.issueId), eq(mark.userId, me)))
    .where(
      and(
        inScope(scope),
        eq(issue.state, "open"),
        eq(pull.draft, false),
        sql`not ${mineOf(me)}`,
        sql`not ${working}`,
        unseen,
        // Approved by them as it stands: there is nothing more to ask of them.
        sql`not exists (select 1 from ${gitReviews} where ${gitReviews.pullRequestId} = ${pull.issueId} and ${gitReviews.authorUserId} = ${me} and ${gitReviews.state} = 'approved' and ${gitReviews.commitOid} = ${pull.headOid})`,
      ),
    )
    .orderBy(sql`${rank} desc`, desc(issue.updatedAt), desc(issue.id))
    .limit(limit);
  return { items: rows, count: rows[0]?.total ?? 0 };
};

export interface PushedRepository {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly versions: number;
}

/** The repositories pushed to since a time, the most pushes first. */
export const pushedSince = async (
  scope: WorkspaceScope,
  since: Date,
): Promise<PushedRepository[]> =>
  db
    .select({
      id: repo.id,
      owner: owner.slug,
      name: repo.name,
      visibility: repo.visibility,
      versions: sql<number>`count(*)::int`,
    })
    .from(version)
    .innerJoin(repo, eq(repo.id, version.repositoryId))
    .innerJoin(owner, eq(owner.id, repo.namespaceId))
    .where(and(inScope(scope), gt(version.createdAt, since)))
    .groupBy(repo.id, owner.slug)
    .orderBy(sql`count(*) desc`, asc(repo.id))
    .limit(100);

export interface ActivityRow {
  readonly id: string;
  readonly type: "pushed" | "approved" | "changes_requested" | "commented" | "findings" | "merged";
  readonly at: Date;
  readonly actorUserId: string | null;
  readonly agent: string | null;
  readonly repositoryId: string;
  readonly owner: string;
  readonly repositoryName: string;
  readonly visibility: "public" | "private";
  /** The branch page's thread id, for its key. */
  readonly pageId: string;
  readonly number: number;
  readonly title: string;
  readonly version: number | null;
  readonly found: number | null;
  readonly mustFix: number | null;
}

const threadColumns = {
  repositoryId: repo.id,
  owner: owner.slug,
  repositoryName: repo.name,
  visibility: repo.visibility,
  number: issue.number,
  title: issue.title,
} as const;

/** An activity row's thread: the branch page it happened on. */
const activityColumns = { ...threadColumns, pageId: issue.id } as const;

/**
 * What happened to branches since a time, newest first: versions pushed,
 * reviews submitted, review runs that found something, and merges. Each kind
 * is read newest first up to `limit`, so the newest `limit` of all of them
 * are among what was read.
 */
export const activitySince = async (
  scope: WorkspaceScope,
  since: Date,
  limit: number,
): Promise<ActivityRow[]> => {
  const where = inScope(scope);
  const found = sql<number>`(select count(*)::int from ${gitReviewFindings} where ${gitReviewFindings.runId} = ${gitReviewRuns.id})`;
  const [pushes, reviews, runs, merges] = await Promise.all([
    db
      .select({
        ...activityColumns,
        id: version.id,
        at: version.createdAt,
        actorUserId: version.pusherUserId,
        agent: version.agent,
        version: version.number,
      })
      .from(version)
      .innerJoin(issue, eq(issue.id, version.pullRequestId))
      .innerJoin(repo, eq(repo.id, issue.repositoryId))
      .innerJoin(owner, eq(owner.id, repo.namespaceId))
      .where(and(where, gt(version.createdAt, since)))
      .orderBy(desc(version.createdAt))
      .limit(limit),
    db
      .select({
        ...activityColumns,
        id: gitReviews.id,
        at: gitReviews.submittedAt,
        actorUserId: gitReviews.authorUserId,
        state: gitReviews.state,
      })
      .from(gitReviews)
      .innerJoin(issue, eq(issue.id, gitReviews.pullRequestId))
      .innerJoin(repo, eq(repo.id, issue.repositoryId))
      .innerJoin(owner, eq(owner.id, repo.namespaceId))
      .where(
        and(
          where,
          gt(gitReviews.submittedAt, since),
          sql`${gitReviews.state} in ('approved', 'changes_requested', 'commented')`,
        ),
      )
      .orderBy(desc(gitReviews.submittedAt))
      .limit(limit),
    db
      .select({
        ...activityColumns,
        id: gitReviewRuns.id,
        at: gitReviewRuns.finishedAt,
        version: gitReviewRuns.versionNumber,
        found,
        mustFix: sql<number>`(select count(*)::int from ${gitReviewFindings} where ${gitReviewFindings.runId} = ${gitReviewRuns.id} and ${gitReviewFindings.severity} = 'must_fix')`,
      })
      .from(gitReviewRuns)
      .innerJoin(issue, eq(issue.id, gitReviewRuns.pullRequestId))
      .innerJoin(repo, eq(repo.id, issue.repositoryId))
      .innerJoin(owner, eq(owner.id, repo.namespaceId))
      .where(
        and(
          where,
          eq(gitReviewRuns.status, "done"),
          gt(gitReviewRuns.finishedAt, since),
          sql`${found} > 0`,
        ),
      )
      .orderBy(desc(gitReviewRuns.finishedAt))
      .limit(limit),
    db
      .select({
        ...activityColumns,
        id: pull.issueId,
        at: pull.mergedAt,
        actorUserId: pull.mergedByUserId,
      })
      .from(pull)
      .innerJoin(issue, eq(issue.id, pull.issueId))
      .innerJoin(repo, eq(repo.id, pull.repositoryId))
      .innerJoin(owner, eq(owner.id, repo.namespaceId))
      .where(and(where, gt(pull.mergedAt, since)))
      .orderBy(desc(pull.mergedAt))
      .limit(limit),
  ]);
  const blank = { agent: null, version: null, found: null, mustFix: null, actorUserId: null };
  const all: ActivityRow[] = [
    ...pushes.map((row) => ({
      ...blank,
      ...row,
      id: `push:${row.id}`,
      type: "pushed" as const,
      agent: row.agent?.name ?? null,
    })),
    ...reviews.map(({ state, ...row }) => ({
      ...blank,
      ...row,
      id: `review:${row.id}`,
      at: row.at!,
      type: state as "approved" | "changes_requested" | "commented",
    })),
    ...runs.map((row) => ({
      ...blank,
      ...row,
      id: `run:${row.id}`,
      at: row.at!,
      type: "findings" as const,
    })),
    ...merges.map((row) => ({
      ...blank,
      ...row,
      id: `merge:${row.id}`,
      at: row.at!,
      type: "merged" as const,
    })),
  ];
  return all.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
};

/** `@name` as a Postgres (and JavaScript) pattern: not part of a longer name or an address. */
export const mentionPattern = (username: string): string =>
  `(^|[^a-z0-9_.-])@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_.-]|\\.($|[^a-z0-9]))`;

export interface MentionRow {
  readonly id: string;
  readonly kind: "comment" | "review_comment";
  readonly repositoryId: string;
  readonly owner: string;
  readonly repositoryName: string;
  readonly visibility: "public" | "private";
  /** The thread the comment is on. */
  readonly threadId: string;
  readonly number: number;
  readonly title: string;
  readonly isPullRequest: boolean;
  readonly authorUserId: string | null;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * Comments by other people that name the viewer, newest first. There is no
 * index of mentions, so this matches the text of the comments in the
 * viewer's repositories.
 */
export const listMentions = async (
  viewer: WorkspaceViewer,
  username: string,
  page: { readonly cursor: TimeCursor | null; readonly limit: number },
): Promise<{ readonly items: MentionRow[]; readonly nextCursor: string | null }> => {
  const where = inScope({ viewer }, true);
  const pattern = mentionPattern(username);
  const columns = { ...threadColumns, threadId: issue.id, isPullRequest: issue.isPullRequest };
  const [comments, reviewComments] = await Promise.all([
    db
      .select({
        ...columns,
        id: gitComments.id,
        authorUserId: gitComments.authorUserId,
        body: gitComments.body,
        createdAt: gitComments.createdAt,
      })
      .from(gitComments)
      .innerJoin(issue, eq(issue.id, gitComments.issueId))
      .innerJoin(repo, eq(repo.id, issue.repositoryId))
      .innerJoin(owner, eq(owner.id, repo.namespaceId))
      .where(
        and(
          where,
          sql`${gitComments.authorUserId} is distinct from ${viewer.userId}`,
          sql`${gitComments.body} ~* ${pattern}`,
          afterCursor(gitComments.createdAt, gitComments.id, page.cursor, "desc"),
        ),
      )
      .orderBy(desc(cursorTime(gitComments.createdAt)), desc(gitComments.id))
      .limit(page.limit + 1),
    db
      .select({
        ...columns,
        id: gitReviewComments.id,
        authorUserId: gitReviewComments.authorUserId,
        body: gitReviewComments.body,
        createdAt: gitReviewComments.createdAt,
      })
      .from(gitReviewComments)
      .innerJoin(gitReviews, eq(gitReviews.id, gitReviewComments.reviewId))
      .innerJoin(issue, eq(issue.id, gitReviewComments.pullRequestId))
      .innerJoin(repo, eq(repo.id, issue.repositoryId))
      .innerJoin(owner, eq(owner.id, repo.namespaceId))
      .where(
        and(
          where,
          sql`${gitReviews.state} <> 'pending'`,
          sql`${gitReviewComments.authorUserId} is distinct from ${viewer.userId}`,
          sql`${gitReviewComments.body} ~* ${pattern}`,
          afterCursor(gitReviewComments.createdAt, gitReviewComments.id, page.cursor, "desc"),
        ),
      )
      .orderBy(desc(cursorTime(gitReviewComments.createdAt)), desc(gitReviewComments.id))
      .limit(page.limit + 1),
  ]);
  const millis = (row: { createdAt: Date }) => row.createdAt.getTime();
  const merged: MentionRow[] = [
    ...comments.map((row) => ({ ...row, kind: "comment" as const })),
    ...reviewComments.map((row) => ({ ...row, kind: "review_comment" as const })),
  ].sort((a, b) => millis(b) - millis(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return toPage(merged, page.limit, (row) => ({ at: millis(row), id: row.id }));
};
