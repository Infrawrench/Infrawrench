/**
 * Pull requests: the `git_pull_requests` row beside a thread, its reviews and
 * its review comments. The thread itself (title, state, comments, timeline)
 * is `db/threads.ts`.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type GitDiffSide,
  type GitMergeMethod,
  type GitMergeableState,
  type GitReviewState,
  gitIssues,
  gitPullRequests,
  gitReviewComments,
  gitReviews,
} from "@infrawrench/server-core/db/schema";
import { db, isUniqueViolation, newId } from "./client";
import { type IssueRow, type NewThread, type Tx, insertThread, setThreadState } from "./threads";

export type PullRequestRow = typeof gitPullRequests.$inferSelect;
export type ReviewRow = typeof gitReviews.$inferSelect;
export type ReviewCommentRow = typeof gitReviewComments.$inferSelect;

export interface PullRequestWithThread {
  readonly thread: IssueRow;
  readonly pull: PullRequestRow;
}

export interface NewPullRequest extends Omit<NewThread, "isPullRequest"> {
  readonly baseRef: string;
  readonly headRepositoryId: string;
  readonly headRef: string;
  readonly headOid: string;
  readonly baseOid: string;
  readonly mergeBaseOid: string | null;
  readonly draft: boolean;
  readonly commitsCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

/** Open a pull request: the thread and its pull request row, with one number. */
export const createPullRequest = (input: NewPullRequest): Promise<PullRequestWithThread> =>
  db.transaction(async (tx) => {
    const thread = await insertThread(tx, { ...input, isPullRequest: true });
    const [pull] = await tx
      .insert(gitPullRequests)
      .values({
        issueId: thread.id,
        repositoryId: input.repositoryId,
        baseRef: input.baseRef,
        headRepositoryId: input.headRepositoryId,
        headRef: input.headRef,
        headOid: input.headOid,
        baseOid: input.baseOid,
        mergeBaseOid: input.mergeBaseOid,
        draft: input.draft,
        commitsCount: input.commitsCount,
        additions: input.additions,
        deletions: input.deletions,
        changedFiles: input.changedFiles,
      })
      .returning();
    return { thread, pull: pull! };
  });

/** `#number` as a pull request, or null when it is an issue or nothing. */
export const getPullRequest = async (
  repositoryId: string,
  number: number,
): Promise<PullRequestWithThread | null> => {
  const [row] = await db
    .select({ thread: gitIssues, pull: gitPullRequests })
    .from(gitIssues)
    .innerJoin(gitPullRequests, eq(gitPullRequests.issueId, gitIssues.id))
    .where(and(eq(gitIssues.repositoryId, repositoryId), eq(gitIssues.number, number)))
    .limit(1);
  return row ?? null;
};

/** The pull request rows of a page of threads, by thread id. */
export const pullRequestsFor = async (
  issueIds: readonly string[],
): Promise<Map<string, PullRequestRow>> => {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(gitPullRequests)
    .where(inArray(gitPullRequests.issueId, [...issueIds]));
  return new Map(rows.map((row) => [row.issueId, row]));
};

/**
 * The open pull requests a push to a branch touches: those whose head is the
 * branch, and those whose base is. What the queue consumer synchronises.
 */
export const openPullRequestsForBranch = (
  repositoryId: string,
  branch: string,
): Promise<PullRequestWithThread[]> =>
  db
    .select({ thread: gitIssues, pull: gitPullRequests })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      and(
        eq(gitIssues.state, "open"),
        or(
          and(
            eq(gitPullRequests.headRepositoryId, repositoryId),
            eq(gitPullRequests.headRef, branch),
          ),
          and(eq(gitPullRequests.repositoryId, repositoryId), eq(gitPullRequests.baseRef, branch)),
        ),
      ),
    );

/** The open pull request for exactly this base and head, when there is one. */
export const findOpenPullRequest = async (
  repositoryId: string,
  baseRef: string,
  headRepositoryId: string,
  headRef: string,
): Promise<PullRequestWithThread | null> => {
  const [row] = await db
    .select({ thread: gitIssues, pull: gitPullRequests })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      and(
        eq(gitPullRequests.repositoryId, repositoryId),
        eq(gitPullRequests.baseRef, baseRef),
        eq(gitPullRequests.headRepositoryId, headRepositoryId),
        eq(gitPullRequests.headRef, headRef),
        eq(gitIssues.state, "open"),
      ),
    )
    .limit(1);
  return row ?? null;
};

/** What a push to the head or the base changes. Mergeability goes back to `unknown` until rechecked. */
export const syncPullRequest = async (
  issueId: string,
  sync: {
    readonly headOid?: string;
    readonly baseOid?: string;
    readonly mergeBaseOid?: string | null;
    readonly headRefExists?: boolean;
    readonly commitsCount?: number;
    readonly additions?: number;
    readonly deletions?: number;
    readonly changedFiles?: number;
  },
): Promise<void> => {
  const now = new Date();
  await db
    .update(gitPullRequests)
    .set({
      ...sync,
      ...(sync.headOid !== undefined || sync.baseOid !== undefined
        ? { mergeableState: "unknown" as const, conflictFiles: [] }
        : {}),
      updatedAt: now,
    })
    .where(eq(gitPullRequests.issueId, issueId));
  await db.update(gitIssues).set({ updatedAt: now }).where(eq(gitIssues.id, issueId));
};

/**
 * Record a trial merge's answer, only if both sides are still where the
 * trial read them: a push that landed meanwhile keeps `unknown`.
 */
export const setMergeable = async (
  issueId: string,
  result: {
    readonly state: GitMergeableState;
    readonly headOid: string;
    readonly baseOid: string;
    readonly conflictFiles: readonly string[];
  },
): Promise<boolean> => {
  const updated = await db
    .update(gitPullRequests)
    .set({
      mergeableState: result.state,
      mergeableHeadOid: result.headOid,
      mergeableBaseOid: result.baseOid,
      conflictFiles: [...result.conflictFiles],
    })
    .where(
      and(
        eq(gitPullRequests.issueId, issueId),
        eq(gitPullRequests.headOid, result.headOid),
        eq(gitPullRequests.baseOid, result.baseOid),
      ),
    )
    .returning({ issueId: gitPullRequests.issueId });
  return updated.length > 0;
};

export const updatePullRequest = async (
  issueId: string,
  patch: { readonly draft?: boolean; readonly baseRef?: string; readonly baseOid?: string },
): Promise<void> => {
  await db
    .update(gitPullRequests)
    .set({
      ...patch,
      ...(patch.baseRef !== undefined ? { mergeableState: "unknown" as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(gitPullRequests.issueId, issueId));
};

/**
 * Mark a pull request merged and close its thread, in one transaction. False
 * when it was already merged or closed, so a merge raced by another answers
 * once. The refs have moved by the time this runs: the Durable Object is the
 * authority on the merge, and this records it.
 */
export const markMerged = async (
  issueId: string,
  merge: {
    readonly commitOid: string;
    readonly method: GitMergeMethod;
    readonly byUserId: string | null;
  },
): Promise<boolean> =>
  db.transaction(async (tx) => {
    const now = new Date();
    const merged = await tx
      .update(gitPullRequests)
      .set({
        mergedAt: now,
        mergedByUserId: merge.byUserId,
        mergeCommitOid: merge.commitOid,
        mergeMethod: merge.method,
        updatedAt: now,
      })
      .where(and(eq(gitPullRequests.issueId, issueId), isNull(gitPullRequests.mergedAt)))
      .returning({ issueId: gitPullRequests.issueId });
    if (merged.length === 0) return false;
    await setThreadState(tx, issueId, "closed", { userId: merge.byUserId });
    return true;
  });

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/** A person's pending review of a pull request, when they have one. */
export const getPendingReview = async (
  pullRequestId: string,
  authorUserId: string,
): Promise<ReviewRow | null> => {
  const [row] = await db
    .select()
    .from(gitReviews)
    .where(
      and(
        eq(gitReviews.pullRequestId, pullRequestId),
        eq(gitReviews.authorUserId, authorUserId),
        eq(gitReviews.state, "pending"),
      ),
    )
    .limit(1);
  return row ?? null;
};

/**
 * Start a review: `pending`, or submitted at once in another state. A second
 * pending review by the same person is refused by the partial unique index;
 * the existing one is returned instead.
 */
export const createReview = async (
  handle: Tx | typeof db,
  review: {
    readonly pullRequestId: string;
    readonly repositoryId: string;
    readonly authorUserId: string;
    readonly state: GitReviewState;
    readonly body: string;
    readonly commitOid: string;
  },
): Promise<ReviewRow> => {
  try {
    const [row] = await handle
      .insert(gitReviews)
      .values({
        id: newId(),
        ...review,
        submittedAt: review.state === "pending" ? null : new Date(),
      })
      .returning();
    return row!;
  } catch (error) {
    if (!isUniqueViolation(error) || review.state !== "pending") throw error;
    const existing = await getPendingReview(review.pullRequestId, review.authorUserId);
    if (!existing) throw error;
    return existing;
  }
};

export const getReview = async (
  pullRequestId: string,
  reviewId: string,
): Promise<ReviewRow | null> => {
  const [row] = await db
    .select()
    .from(gitReviews)
    .where(and(eq(gitReviews.id, reviewId), eq(gitReviews.pullRequestId, pullRequestId)))
    .limit(1);
  return row ?? null;
};

/** Submit a pending review. Null when it is not pending any more. */
export const submitReview = async (
  reviewId: string,
  submit: {
    readonly state: Exclude<GitReviewState, "pending" | "dismissed">;
    readonly body?: string;
    readonly commitOid: string;
  },
): Promise<ReviewRow | null> => {
  const now = new Date();
  const [row] = await db
    .update(gitReviews)
    .set({
      state: submit.state,
      ...(submit.body !== undefined ? { body: submit.body } : {}),
      commitOid: submit.commitOid,
      submittedAt: now,
      updatedAt: now,
    })
    .where(and(eq(gitReviews.id, reviewId), eq(gitReviews.state, "pending")))
    .returning();
  return row ?? null;
};

/** Dismiss an approval or a request for changes. Null when it was neither. */
export const dismissReview = async (
  reviewId: string,
  byUserId: string | null,
  reason: string | null,
): Promise<ReviewRow | null> => {
  const now = new Date();
  const [row] = await db
    .update(gitReviews)
    .set({
      state: "dismissed",
      dismissedState: sql`${gitReviews.state}`,
      dismissedByUserId: byUserId,
      dismissedAt: now,
      dismissalReason: reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(gitReviews.id, reviewId),
        inArray(gitReviews.state, ["approved", "changes_requested"]),
      ),
    )
    .returning();
  return row ?? null;
};

/** Discard a pending review and, by cascade, its comments. */
export const deletePendingReview = async (reviewId: string): Promise<boolean> => {
  const deleted = await db
    .delete(gitReviews)
    .where(and(eq(gitReviews.id, reviewId), eq(gitReviews.state, "pending")))
    .returning({ id: gitReviews.id });
  return deleted.length > 0;
};

/**
 * A pull request's reviews, oldest first: every submitted one, and `viewerId`'s
 * own pending one. Nobody else's pending review is ever read out.
 */
export const listReviews = (pullRequestId: string, viewerId: string | null): Promise<ReviewRow[]> =>
  db
    .select()
    .from(gitReviews)
    .where(
      and(
        eq(gitReviews.pullRequestId, pullRequestId),
        viewerId === null
          ? sql`${gitReviews.state} <> 'pending'`
          : or(sql`${gitReviews.state} <> 'pending'`, eq(gitReviews.authorUserId, viewerId)),
      ),
    )
    .orderBy(asc(gitReviews.createdAt));

/**
 * Each reviewer's standing verdict: their newest review that approves or
 * requests changes (a later comment does not withdraw an approval, a
 * dismissal does). What required approvals and the review decision count.
 */
export const standingReviews = async (
  pullRequestId: string,
): Promise<
  Array<{ authorUserId: string; state: "approved" | "changes_requested"; commitOid: string }>
> => {
  const rows = await db
    .select({
      authorUserId: gitReviews.authorUserId,
      state: gitReviews.state,
      commitOid: gitReviews.commitOid,
      submittedAt: gitReviews.submittedAt,
    })
    .from(gitReviews)
    .where(
      and(
        eq(gitReviews.pullRequestId, pullRequestId),
        inArray(gitReviews.state, ["approved", "changes_requested"]),
      ),
    )
    .orderBy(asc(gitReviews.submittedAt));
  const latest = new Map<
    string,
    { authorUserId: string; state: "approved" | "changes_requested"; commitOid: string }
  >();
  for (const row of rows) {
    if (row.authorUserId === null) continue;
    if (row.state !== "approved" && row.state !== "changes_requested") continue;
    latest.set(row.authorUserId, {
      authorUserId: row.authorUserId,
      state: row.state,
      commitOid: row.commitOid,
    });
  }
  return [...latest.values()];
};

/** Dismiss the approvals of an older head, for a rule with `dismissStaleApprovals`. */
export const dismissStaleApprovals = async (
  pullRequestId: string,
  headOid: string,
): Promise<number> => {
  const now = new Date();
  const dismissed = await db
    .update(gitReviews)
    .set({
      state: "dismissed",
      dismissedState: "approved",
      dismissedAt: now,
      dismissalReason: "A new commit was pushed",
      updatedAt: now,
    })
    .where(
      and(
        eq(gitReviews.pullRequestId, pullRequestId),
        eq(gitReviews.state, "approved"),
        sql`${gitReviews.commitOid} <> ${headOid}`,
      ),
    )
    .returning({ id: gitReviews.id });
  return dismissed.length;
};

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

export interface NewReviewComment {
  readonly pullRequestId: string;
  readonly reviewId: string;
  readonly repositoryId: string;
  readonly authorUserId: string;
  readonly body: string;
  /** The thread's first comment, for a reply. */
  readonly inReplyToId?: string | null;
  readonly path: string;
  readonly side: GitDiffSide;
  readonly line: number;
  readonly startLine?: number | null;
  readonly startSide?: GitDiffSide | null;
  readonly commitOid: string;
  readonly diffHunk?: string | null;
  /** The branch version it is written on, when versions are recorded for the pull request. */
  readonly versionNumber?: number | null;
}

export const addReviewComment = async (
  handle: Tx | typeof db,
  comment: NewReviewComment,
): Promise<ReviewCommentRow> => {
  const [row] = await handle
    .insert(gitReviewComments)
    .values({
      id: newId(),
      pullRequestId: comment.pullRequestId,
      reviewId: comment.reviewId,
      repositoryId: comment.repositoryId,
      authorUserId: comment.authorUserId,
      body: comment.body,
      inReplyToId: comment.inReplyToId ?? null,
      path: comment.path,
      side: comment.side,
      line: comment.line,
      startLine: comment.startLine ?? null,
      startSide: comment.startSide ?? null,
      commitOid: comment.commitOid,
      originalCommitOid: comment.commitOid,
      originalLine: comment.line,
      originalStartLine: comment.startLine ?? null,
      diffHunk: comment.diffHunk ?? null,
      versionNumber: comment.versionNumber ?? null,
    })
    .returning();
  return row!;
};

/** A review comment, only if it belongs to the repository in the path. */
export const getReviewComment = async (
  repositoryId: string,
  commentId: string,
): Promise<ReviewCommentRow | null> => {
  const [row] = await db
    .select()
    .from(gitReviewComments)
    .where(
      and(eq(gitReviewComments.id, commentId), eq(gitReviewComments.repositoryId, repositoryId)),
    )
    .limit(1);
  return row ?? null;
};

/**
 * Every review comment of a pull request the viewer may see, in file, line
 * and time order: those of submitted reviews, and those of the viewer's own
 * pending one. The handler groups them into threads by `inReplyToId`.
 */
export const listReviewComments = (
  pullRequestId: string,
  viewerId: string | null,
): Promise<Array<ReviewCommentRow & { pending: boolean }>> =>
  db
    .select({
      comment: gitReviewComments,
      pending: sql<boolean>`${gitReviews.state} = 'pending'`,
    })
    .from(gitReviewComments)
    .innerJoin(gitReviews, eq(gitReviews.id, gitReviewComments.reviewId))
    .where(
      and(
        eq(gitReviewComments.pullRequestId, pullRequestId),
        viewerId === null
          ? sql`${gitReviews.state} <> 'pending'`
          : or(sql`${gitReviews.state} <> 'pending'`, eq(gitReviews.authorUserId, viewerId)),
      ),
    )
    .orderBy(
      asc(gitReviewComments.path),
      sql`${gitReviewComments.originalLine} asc`,
      asc(gitReviewComments.createdAt),
    )
    .then((rows) => rows.map((row) => ({ ...row.comment, pending: row.pending })));

export const editReviewComment = async (
  commentId: string,
  body: string,
): Promise<ReviewCommentRow | null> => {
  const now = new Date();
  const [row] = await db
    .update(gitReviewComments)
    .set({ body, editedAt: now, updatedAt: now })
    .where(eq(gitReviewComments.id, commentId))
    .returning();
  return row ?? null;
};

/** Delete a review comment. Deleting a thread's first comment deletes its replies, by cascade. */
export const deleteReviewComment = async (commentId: string): Promise<boolean> => {
  const deleted = await db
    .delete(gitReviewComments)
    .where(eq(gitReviewComments.id, commentId))
    .returning({ id: gitReviewComments.id });
  return deleted.length > 0;
};

/** Resolve or reopen a thread, by its first comment. Null when that is not a thread's first comment. */
export const setThreadResolved = async (
  threadId: string,
  resolvedByUserId: string | null,
): Promise<ReviewCommentRow | null> => {
  const now = new Date();
  const [row] = await db
    .update(gitReviewComments)
    .set({
      resolvedAt: resolvedByUserId === null ? null : now,
      resolvedByUserId,
      updatedAt: now,
    })
    .where(and(eq(gitReviewComments.id, threadId), isNull(gitReviewComments.inReplyToId)))
    .returning();
  return row ?? null;
};

/**
 * Move a thread's anchor after a push: to its new line when the lines it was
 * written on survive, or `outdated` when they do not, with the version whose
 * push changed them. The mapping is computed by the caller from the two
 * heads' diff (`events/versions.ts` `carryThreads`).
 */
export const reanchorThread = async (
  threadId: string,
  anchor:
    | { readonly outdated: true; readonly version: number | null }
    | {
        readonly outdated: false;
        readonly commitOid: string;
        readonly line: number;
        readonly startLine: number | null;
      },
): Promise<void> => {
  await db
    .update(gitReviewComments)
    .set(
      anchor.outdated
        ? { outdated: true, line: null, startLine: null, answeredInVersion: anchor.version }
        : {
            outdated: false,
            commitOid: anchor.commitOid,
            line: anchor.line,
            startLine: anchor.startLine,
          },
    )
    .where(or(eq(gitReviewComments.id, threadId), eq(gitReviewComments.inReplyToId, threadId)));
};

// ---------------------------------------------------------------------------
// Lookups the content pages make
// ---------------------------------------------------------------------------

/** The newest pull request from each of these branches of a repository, by branch name. */
export const newestPullRequestsForBranches = async (
  headRepositoryId: string,
  branches: readonly string[],
): Promise<Map<string, PullRequestWithThread>> => {
  const newest = new Map<string, PullRequestWithThread>();
  if (branches.length === 0) return newest;
  const rows = await db
    .select({ thread: gitIssues, pull: gitPullRequests })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      and(
        eq(gitPullRequests.headRepositoryId, headRepositoryId),
        inArray(gitPullRequests.headRef, [...branches]),
      ),
    )
    .orderBy(asc(gitIssues.createdAt));
  // Oldest first, so the newest wins.
  for (const row of rows) newest.set(row.pull.headRef, row);
  return newest;
};

/** Pull requests a commit is the head or the merge of, in a repository. */
export const pullRequestsForCommit = (
  repositoryId: string,
  oid: string,
): Promise<Array<{ number: number; title: string }>> =>
  db
    .select({ number: gitIssues.number, title: gitIssues.title })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      and(
        eq(gitPullRequests.repositoryId, repositoryId),
        or(eq(gitPullRequests.mergeCommitOid, oid), eq(gitPullRequests.headOid, oid)),
      ),
    )
    .orderBy(asc(gitIssues.number))
    .limit(10);

/** Each reviewer's standing verdict, for a page of pull requests, by pull request id. */
export const standingReviewsFor = async (
  pullRequestIds: readonly string[],
): Promise<
  Map<string, Array<{ authorUserId: string; state: "approved" | "changes_requested" }>>
> => {
  const out = new Map<
    string,
    Array<{ authorUserId: string; state: "approved" | "changes_requested" }>
  >();
  if (pullRequestIds.length === 0) return out;
  const rows = await db
    .select({
      pullRequestId: gitReviews.pullRequestId,
      authorUserId: gitReviews.authorUserId,
      state: gitReviews.state,
    })
    .from(gitReviews)
    .where(
      and(
        inArray(gitReviews.pullRequestId, [...pullRequestIds]),
        inArray(gitReviews.state, ["approved", "changes_requested"]),
      ),
    )
    .orderBy(asc(gitReviews.submittedAt));
  const latest = new Map<string, Map<string, "approved" | "changes_requested">>();
  for (const row of rows) {
    if (row.authorUserId === null) continue;
    if (row.state !== "approved" && row.state !== "changes_requested") continue;
    const byAuthor = latest.get(row.pullRequestId) ?? new Map();
    byAuthor.set(row.authorUserId, row.state);
    latest.set(row.pullRequestId, byAuthor);
  }
  for (const [pullRequestId, byAuthor] of latest) {
    out.set(
      pullRequestId,
      [...byAuthor].map(([authorUserId, state]) => ({ authorUserId, state })),
    );
  }
  return out;
};

/** A review by its id alone, within a repository. */
export const getReviewInRepository = async (
  repositoryId: string,
  reviewId: string,
): Promise<ReviewRow | null> => {
  const [row] = await db
    .select()
    .from(gitReviews)
    .where(and(eq(gitReviews.id, reviewId), eq(gitReviews.repositoryId, repositoryId)))
    .limit(1);
  return row ?? null;
};

/** The pull request a thread id belongs to. */
export const getPullRequestByIssueId = async (
  issueId: string,
): Promise<PullRequestWithThread | null> => {
  const [row] = await db
    .select({ thread: gitIssues, pull: gitPullRequests })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(eq(gitPullRequests.issueId, issueId))
    .limit(1);
  return row ?? null;
};
