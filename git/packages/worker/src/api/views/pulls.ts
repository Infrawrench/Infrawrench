/**
 * Pull request rows as the contract's shapes: summaries for a page, the
 * detail with its mergeability, reviews and review threads.
 *
 * {@link mergeabilityOf} is the one place "can this merge, and why not" is
 * decided. `pulls.get`, `pulls.mergeability` and `pulls.merge` all read it, so
 * the merge box and the merge cannot disagree.
 */
import {
  type CommitStatus,
  type DiffHunk,
  type MergeMethod,
  type Mergeability,
  type PullRequest,
  type PullRequestSummary,
  type Review,
  type ReviewComment,
  type ReviewDecision,
  type ReviewThread,
  type UserRef,
  MERGE_METHODS,
  accessAtLeast,
} from "@infrawrench/git-contract";
import {
  type BranchProtection,
  type CommitStatusRow,
  combinedState,
  combinedStatesFor,
  listProtectedBranches,
  protectionFor,
  statusesForCommit,
} from "../../db/policy";
import {
  type PullRequestWithThread,
  type ReviewCommentRow,
  type ReviewRow,
  getPendingReview,
  listReviewComments,
  setMergeable,
  standingReviews,
  standingReviewsFor,
} from "../../db/pulls";
import { visibleRepositoriesById } from "../../db/repository-lists";
import { RepoReaderError } from "../../repo/reader";
import type { RepoCx } from "../context";
import { bypasses, mayPush } from "../protection";
import { headRepositoryOf } from "../repos";
import { iso, isoOrNull, peopleById, toRepositoryRef } from "./repositories";
import { mayChangeOwn, threadBody, threadFieldsFor, threadViewer } from "./threads";

export const statusViews = async (rows: readonly CommitStatusRow[]): Promise<CommitStatus[]> => {
  const person = await peopleById(rows.map((row) => row.creatorUserId));
  return rows.map((row) => ({
    id: row.id,
    context: row.context,
    state: row.state,
    description: row.description,
    targetUrl: row.targetUrl,
    creator: person(row.creatorUserId),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
};

const decisionOf = (
  standing: ReadonlyArray<{ readonly state: "approved" | "changes_requested" }>,
  requiredApprovals: number,
): ReviewDecision | null => {
  const approvals = standing.filter((review) => review.state === "approved").length;
  if (standing.some((review) => review.state === "changes_requested")) return "changes_requested";
  if (requiredApprovals > 0) return approvals >= requiredApprovals ? "approved" : "review_required";
  return approvals > 0 ? "approved" : null;
};

export const pullSummaries = async (
  cx: RepoCx,
  rows: readonly PullRequestWithThread[],
): Promise<PullRequestSummary[]> => {
  const { repository } = cx.repo;
  const viewer = await cx.viewer();
  const [{ fields }, states, standing, rules, heads] = await Promise.all([
    threadFieldsFor(rows.map((row) => row.thread)),
    combinedStatesFor(repository.id, [...new Set(rows.map((row) => row.pull.headOid))]),
    standingReviewsFor(rows.map((row) => row.pull.issueId)),
    listProtectedBranches(repository.id),
    visibleRepositoriesById(
      rows.flatMap((row) =>
        row.pull.headRepositoryId && row.pull.headRepositoryId !== repository.id
          ? [row.pull.headRepositoryId]
          : [],
      ),
      viewer,
    ),
  ]);
  return rows.map(({ thread, pull }) => {
    const head =
      pull.headRepositoryId === repository.id
        ? cx.repo
        : pull.headRepositoryId
          ? heads.get(pull.headRepositoryId)
          : undefined;
    return {
      ...fields(thread),
      state: pull.mergedAt ? "merged" : thread.state,
      draft: pull.draft,
      baseRef: pull.baseRef,
      headRef: pull.headRef,
      headRepository: head ? toRepositoryRef(head) : null,
      crossRepository: pull.headRepositoryId !== repository.id,
      headOid: pull.headOid,
      status: states.get(pull.headOid) ?? null,
      reviewDecision: decisionOf(
        standing.get(pull.issueId) ?? [],
        protectionFor(rules, pull.baseRef)?.requiredApprovals ?? 0,
      ),
      mergedAt: isoOrNull(pull.mergedAt),
    };
  });
};

type Blocker = Mergeability["blockers"][number];

/** Blockers an administrator may override where the rule does not bind administrators. */
export const BYPASSABLE: ReadonlySet<Blocker["code"]> = new Set([
  "checks_pending",
  "checks_failed",
  "approvals_required",
  "changes_requested",
]);

const BLOCKER_MESSAGES: Record<Blocker["code"], string> = {
  merged: "This pull request has been merged",
  closed: "This pull request is closed",
  draft: "This pull request is a draft",
  conflicts: "The branch has conflicts with the base branch",
  checking: "Checking whether the branch can merge",
  head_missing: "The head branch has been deleted",
  checks_pending: "Required checks have not finished",
  checks_failed: "Required checks have failed",
  approvals_required: "Approving reviews are required",
  changes_requested: "A reviewer has requested changes",
  push_restricted: "Only listed people may merge into this branch",
  archived: "This repository is archived",
  no_permission: "Merging needs write access",
};

export const allowedMethodsOf = (repository: RepoCx["repo"]["repository"]): MergeMethod[] =>
  MERGE_METHODS.filter(
    (method) =>
      ({
        merge: repository.allowMergeCommit,
        squash: repository.allowSquash,
        rebase: repository.allowRebase,
      })[method],
  );

export interface MergeabilityDetail {
  readonly mergeability: Mergeability;
  readonly protection: BranchProtection | null;
}

/**
 * Whether a pull request can merge and everything that says why not. An open
 * pull request's trial merge is asked of the `RepoReader` (which caches it by
 * the two heads) and the answer kept on the row; while the storage does not
 * answer, the state is `unknown` and merging waits.
 */
export const mergeabilityDetail = async (
  cx: RepoCx,
  { thread, pull }: PullRequestWithThread,
): Promise<MergeabilityDetail> => {
  const { repository } = cx.repo;
  const [rules, statusRows, standing, head] = await Promise.all([
    listProtectedBranches(repository.id),
    statusesForCommit(repository.id, pull.headOid),
    standingReviews(pull.issueId),
    headRepositoryOf(cx, pull.headRepositoryId),
  ]);
  const protection = protectionFor(rules, pull.baseRef);
  const open = thread.state === "open";
  const headExists = pull.headRepositoryId !== null && pull.headRefExists;

  let state = pull.mergeableState;
  let conflictFiles: readonly string[] = pull.conflictFiles;
  let behindBy = 0;
  if (open && pull.headRepositoryId !== null) {
    try {
      const trial = await cx.git.mergeability({
        baseRef: pull.baseRef,
        headRepositoryId: pull.headRepositoryId,
        headOid: pull.headOid,
      });
      state = trial.state;
      conflictFiles = trial.conflictFiles;
      behindBy = trial.behindBy;
      if (
        pull.mergeableState !== trial.state ||
        pull.mergeableHeadOid !== trial.headOid ||
        pull.mergeableBaseOid !== trial.baseOid
      ) {
        await setMergeable(pull.issueId, trial);
      }
    } catch (error) {
      if (!(error instanceof RepoReaderError)) throw error;
      // Not known right now is not the stored answer for an older pair of heads.
      state = "unknown";
      conflictFiles = [];
    }
  }

  const statuses = await statusViews(statusRows);
  const required = (protection?.requiredStatusContexts ?? []).map((context) => ({
    context,
    state: statusRows.find((row) => row.context === context)?.state ?? null,
  }));
  const requiredApprovals = protection?.requiredApprovals ?? 0;
  const approvals = standing.filter((review) => review.state === "approved").length;
  const changesRequested = standing.filter((review) => review.state === "changes_requested").length;

  const codes: Blocker["code"][] = [];
  if (pull.mergedAt) codes.push("merged");
  else if (!open) codes.push("closed");
  else {
    if (repository.archived) codes.push("archived");
    if (!accessAtLeast(cx.access, "write")) codes.push("no_permission");
    if (pull.draft) codes.push("draft");
    if (!headExists) codes.push("head_missing");
    if (state === "conflicting") codes.push("conflicts");
    if (state === "checking" || state === "unknown") codes.push("checking");
    if (required.some((check) => check.state === "failure" || check.state === "error")) {
      codes.push("checks_failed");
    } else if (required.some((check) => check.state !== "success")) codes.push("checks_pending");
    if (approvals < requiredApprovals) codes.push("approvals_required");
    if (requiredApprovals > 0 && changesRequested > 0) codes.push("changes_requested");
    if (!mayPush(protection, cx.access, cx.userId)) codes.push("push_restricted");
  }

  const allowedMethods = allowedMethodsOf(repository);
  return {
    protection,
    mergeability: {
      state,
      conflictFiles: [...conflictFiles],
      behindBy,
      checks: {
        state: combinedState(statusRows.map((row) => row.state)),
        statuses,
        required,
      },
      reviews: {
        decision: decisionOf(standing, requiredApprovals),
        requiredApprovals,
        approvals,
        changesRequested,
      },
      protection: protection
        ? { pattern: protection.patterns[0] ?? "", enforceAdmins: protection.enforceAdmins }
        : null,
      blockers: codes.map((code) => ({ code, message: BLOCKER_MESSAGES[code] })),
      canMerge: codes.length === 0,
      canBypass: open && protection !== null && bypasses(protection, cx.access),
      allowedMethods,
      defaultMethod: allowedMethods.includes(repository.defaultMergeMethod)
        ? repository.defaultMergeMethod
        : (allowedMethods[0] ?? "merge"),
      canUpdateBranch:
        open &&
        headExists &&
        behindBy > 0 &&
        state !== "conflicting" &&
        head !== null &&
        accessAtLeast(head.access, "write"),
    },
  };
};

export const pullDetail = async (
  cx: RepoCx,
  found: PullRequestWithThread,
): Promise<PullRequest> => {
  const { thread, pull } = found;
  const [[summary], { person }, { mergeability }, head, pending, extra] = await Promise.all([
    pullSummaries(cx, [found]),
    threadFieldsFor([thread]),
    mergeabilityDetail(cx, found),
    headRepositoryOf(cx, pull.headRepositoryId),
    cx.userId ? getPendingReview(pull.issueId, cx.userId) : Promise.resolve(null),
    peopleById([pull.mergedByUserId]),
  ]);
  const viewer = threadViewer(cx, thread);
  const canReview = viewer.canComment || (cx.userId !== null && cx.username !== null);
  return {
    ...summary!,
    ...threadBody(thread, person),
    baseOid: pull.baseOid,
    mergeBaseOid: pull.mergeBaseOid,
    headRefExists: pull.headRefExists,
    commitCount: pull.commitsCount,
    stats: {
      filesChanged: pull.changedFiles,
      additions: pull.additions,
      deletions: pull.deletions,
    },
    mergedBy: extra(pull.mergedByUserId),
    mergeCommitOid: pull.mergeCommitOid,
    mergeMethod: pull.mergeMethod,
    mergeability,
    viewer: {
      ...viewer,
      canReview,
      canApprove: canReview && thread.authorUserId !== cx.userId && thread.state === "open",
      pendingReviewId: pending?.id ?? null,
      canDeleteHeadBranch:
        thread.state === "closed" &&
        pull.headRefExists &&
        head !== null &&
        accessAtLeast(head.access, "write") &&
        pull.headRef !== head.repo.repository.defaultBranch,
    },
  };
};

// ---------------------------------------------------------------------------
// Reviews and review threads
// ---------------------------------------------------------------------------

export const reviewViews = async (
  cx: RepoCx,
  found: PullRequestWithThread,
  rows: readonly ReviewRow[],
  comments: ReadonlyArray<ReviewCommentRow>,
): Promise<Review[]> => {
  const person = await peopleById(rows.flatMap((row) => [row.authorUserId, row.dismissedByUserId]));
  return rows.map((row) => ({
    id: row.id,
    author: person(row.authorUserId),
    state: row.state,
    body: row.body,
    commitOid: row.commitOid,
    stale: row.commitOid !== found.pull.headOid,
    commentCount: comments.filter((comment) => comment.reviewId === row.id).length,
    createdAt: iso(row.createdAt),
    submittedAt: isoOrNull(row.submittedAt),
    dismissedBy: person(row.dismissedByUserId),
    dismissalReason: row.dismissalReason,
    viewerCanDismiss:
      accessAtLeast(cx.access, "write") &&
      (row.state === "approved" || row.state === "changes_requested"),
    viewerCanEdit: row.state === "pending" && row.authorUserId === cx.userId,
  }));
};

const hunkOf = (stored: string | null): DiffHunk | null => {
  if (!stored) return null;
  try {
    return JSON.parse(stored) as DiffHunk;
  } catch {
    return null;
  }
};

type VisibleComment = ReviewCommentRow & { readonly pending: boolean };

const reviewCommentView = (
  cx: RepoCx,
  row: VisibleComment,
  person: (id: string | null) => UserRef | null,
): ReviewComment => {
  const mine = mayChangeOwn(cx, row.authorUserId);
  return {
    id: row.id,
    reviewId: row.reviewId,
    threadId: row.inReplyToId ?? row.id,
    inReplyToId: row.inReplyToId,
    author: person(row.authorUserId),
    body: row.body,
    pending: row.pending,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    edited: row.editedAt !== null,
    viewerCanEdit: mine,
    viewerCanDelete: mine,
  };
};

/** Whether the viewer may resolve a thread: the pull request's author, its starter, or `write`. */
export const mayResolve = (
  cx: RepoCx,
  found: PullRequestWithThread,
  starterUserId: string | null,
): boolean =>
  cx.userId !== null &&
  (found.thread.authorUserId === cx.userId ||
    starterUserId === cx.userId ||
    accessAtLeast(cx.access, "write"));

/** Group the review comments the viewer may see into threads, in file then line order. */
export const reviewThreadViews = async (
  cx: RepoCx,
  found: PullRequestWithThread,
  comments: readonly VisibleComment[],
): Promise<ReviewThread[]> => {
  const person = await peopleById(
    comments.flatMap((comment) => [comment.authorUserId, comment.resolvedByUserId]),
  );
  const canReply = threadViewer(cx, found.thread).canComment;
  const roots = comments.filter((comment) => comment.inReplyToId === null);
  return roots.map((root) => {
    const members = comments
      .filter((comment) => comment.id === root.id || comment.inReplyToId === root.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return {
      id: root.id,
      path: root.path,
      side: root.side,
      line: root.outdated ? null : root.line,
      startLine: root.outdated ? null : root.startLine,
      startSide: root.startSide,
      commitOid: root.commitOid,
      originalCommitOid: root.originalCommitOid,
      originalLine: root.originalLine,
      originalStartLine: root.originalStartLine,
      outdated: root.outdated,
      hunk: hunkOf(root.diffHunk),
      resolved: root.resolvedAt !== null,
      resolvedBy: person(root.resolvedByUserId),
      comments: members.map((member) => reviewCommentView(cx, member, person)),
      viewerCanResolve: mayResolve(cx, found, root.authorUserId),
      viewerCanReply: canReply,
    };
  });
};

export const reviewCommentViewOf = async (
  cx: RepoCx,
  row: VisibleComment,
): Promise<ReviewComment> => reviewCommentView(cx, row, await peopleById([row.authorUserId]));

/** A pull request's threads as the viewer sees them. */
export const threadsOf = async (cx: RepoCx, found: PullRequestWithThread) =>
  reviewThreadViews(cx, found, await listReviewComments(found.pull.issueId, cx.userId));
