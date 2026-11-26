import type { ReviewComment } from "@infrawrench/git-contract";
import {
  badRequest,
  conflict,
  defineMockHandlers,
  notFound,
  ok,
  paginate,
  unprocessable,
  type Mutable,
} from "../define";
import {
  currentUser,
  findRepository,
  gitOf,
  headRepositoryOf,
  requireUser,
  type RepositoryRecord,
} from "../db";
import { aheadBehind, diffCommits, statsOf, summarize, summaryOf } from "../git";
import { mergeCommits, writeCommit } from "../git-write";
import { startRun } from "../ci-data";
import { newId } from "../settings-data";
import {
  commitsOf,
  event,
  filterThreads,
  findThread,
  hunkAround,
  mergeabilityOf,
  presentThread,
  refsOf,
  reviewThreadsOf,
  reviewsOf,
  syncCounts,
  threadsOf,
  toPull,
  toPullSummary,
  touch,
  viewerOf,
  type PullRecord,
  type StoredReview,
  type StoredReviewThread,
  type ThreadRecord,
} from "../threads-data";
import { applyThreadChange } from "../threads-write";

const now = (): string => new Date().toISOString();

function pullOf(owner: string, name: string, number: number) {
  const repo = findRepository(owner, name);
  const thread = findThread(repo, number, true);
  return { repo, thread, pull: thread.pull! };
}

/** The pull request a review thread or comment belongs to. */
function locate(repo: RepositoryRecord, match: (thread: StoredReviewThread) => boolean) {
  for (const thread of threadsOf(repo).threads) {
    const found = thread.pull?.threads.find(match);
    if (found) return { thread, pull: thread.pull!, reviewThread: found };
  }
  throw notFound("Not found");
}

function pendingReviewOf(repo: RepositoryRecord, pull: PullRecord): StoredReview {
  const user = requireUser();
  let found = pull.reviews.find((item) => item.state === "pending" && item.author?.id === user.id);
  if (!found) {
    found = blankReview(repo, pull, "pending", "");
    pull.reviews.push(found);
  }
  return found;
}

function blankReview(
  repo: RepositoryRecord,
  pull: PullRecord,
  state: StoredReview["state"],
  body: string,
): StoredReview {
  const at = now();
  return {
    id: newId("rev"),
    author: requireUser(),
    state,
    body,
    commitOid: refsOf(repo, pull).headOid,
    stale: false,
    commentCount: 0,
    createdAt: at,
    submittedAt: state === "pending" ? null : at,
    dismissedBy: null,
    dismissalReason: null,
    viewerCanDismiss: false,
    viewerCanEdit: true,
  };
}

function newComment(reviewId: string, body: string, pending: boolean): Mutable<ReviewComment> {
  const id = newId("rc");
  const at = now();
  return {
    id,
    reviewId,
    threadId: id,
    inReplyToId: null,
    author: requireUser(),
    body,
    pending,
    createdAt: at,
    updatedAt: at,
    edited: false,
    viewerCanEdit: true,
    viewerCanDelete: true,
  };
}

interface Anchor {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly startLine?: number | undefined;
  readonly startSide?: "LEFT" | "RIGHT" | undefined;
}

function startThread(
  repo: RepositoryRecord,
  pull: PullRecord,
  anchor: Anchor,
  first: Mutable<ReviewComment>,
): StoredReviewThread {
  const refs = refsOf(repo, pull);
  const hunk = hunkAround(
    refs.fx,
    refs.mergeBaseOid,
    refs.headOid,
    anchor.path,
    anchor.side,
    anchor.line,
    anchor.startLine ?? null,
  );
  if (hunk === null) throw unprocessable("That line is not part of the diff");
  const created: StoredReviewThread = {
    id: first.id,
    path: anchor.path,
    side: anchor.side,
    line: anchor.line,
    startLine: anchor.startLine ?? null,
    startSide: anchor.startLine === undefined ? null : (anchor.startSide ?? anchor.side),
    commitOid: refs.headOid,
    originalCommitOid: refs.headOid,
    originalLine: anchor.line,
    originalStartLine: anchor.startLine ?? null,
    outdated: false,
    hunk,
    resolved: false,
    resolvedBy: null,
    comments: [first],
    viewerCanResolve: true,
    viewerCanReply: true,
  };
  pull.threads.push(created);
  return created;
}

function submit(
  thread: ThreadRecord,
  pull: PullRecord,
  item: StoredReview,
  kind: "comment" | "approve" | "request_changes",
  body: string | undefined,
): void {
  const user = requireUser();
  if (kind !== "comment" && thread.author?.id === user.id) {
    throw unprocessable("You cannot approve or request changes on your own pull request");
  }
  item.state =
    kind === "approve"
      ? "approved"
      : kind === "request_changes"
        ? "changes_requested"
        : "commented";
  if (body !== undefined) item.body = body;
  item.submittedAt = now();
  for (const reviewThread of pull.threads) {
    for (const comment of reviewThread.comments) {
      if (comment.reviewId === item.id) comment.pending = false;
    }
  }
  touch(thread);
}

const BLOCKER_CODE: Record<string, string> = {
  conflicts: "merge_conflict",
  checks_pending: "checks_required",
  checks_failed: "checks_required",
  approvals_required: "approvals_required",
  changes_requested: "changes_requested",
  draft: "draft",
  merged: "already_merged",
  push_restricted: "protected_branch",
};

export default defineMockHandlers({
  pulls: {
    list: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const pulls = threadsOf(repo).threads.filter((thread) => thread.pull !== null);
      let matching = filterThreads(repo, pulls, query ?? {});
      if (query?.base !== undefined)
        matching = matching.filter((t) => t.pull!.baseRef === query.base);
      if (query?.head !== undefined)
        matching = matching.filter((t) => t.pull!.headRef === query.head);
      if (query?.draft !== undefined) {
        matching = matching.filter((t) => t.pull!.draft === (query.draft === "true"));
      }
      if (query?.reviewer !== undefined) {
        const name = query.reviewer === "@me" ? currentUser()?.username : query.reviewer;
        matching = matching.filter((t) =>
          t.pull!.reviews.some((r) => r.state !== "pending" && r.author?.username === name),
        );
      }
      const state = query?.state ?? "open";
      const shown = matching.filter((thread) =>
        state === "all"
          ? true
          : state === "merged"
            ? thread.pull!.merged !== null
            : thread.state === state,
      );
      return {
        ...paginate(
          shown.map((thread) => toPullSummary(repo, thread)),
          query,
        ),
        counts: {
          open: matching.filter((thread) => thread.state === "open").length,
          closed: matching.filter((thread) => thread.state === "closed").length,
        },
      };
    },
    create: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const author = requireUser();
      const fx = gitOf(repo);
      const headRepo = headRepositoryOf(repo, payload.headRepository);
      const base = fx.branches[payload.base];
      const head = fx.branches[payload.head];
      if (base === undefined || head === undefined) {
        throw unprocessable("No such branch", "ref_not_found");
      }
      if (payload.title.trim() === "") throw badRequest("A title is required");
      if (aheadBehind(fx, base, head).ahead.length === 0) {
        throw unprocessable(
          `${payload.head} has no commits that ${payload.base} lacks`,
          "no_commits_between",
        );
      }
      const store = threadsOf(repo);
      const existing = store.threads.find(
        (thread) =>
          thread.state === "open" &&
          thread.pull?.baseRef === payload.base &&
          thread.pull.headRef === payload.head &&
          (thread.pull.headRepository === undefined) === (headRepo === repo),
      );
      if (existing) {
        throw conflict(
          `Pull request #${existing.number} is already open for these branches`,
          "pull_request_exists",
        );
      }
      const at = now();
      const thread: ThreadRecord = {
        id: newId("thread"),
        number: store.nextNumber++,
        title: payload.title.trim(),
        body: payload.body ?? "",
        bodyEditedAt: null,
        author,
        labelIds: [],
        assignees: [],
        milestone: null,
        state: "open",
        stateReason: null,
        locked: false,
        lockReason: null,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        closedBy: null,
        items: [],
        pull: {
          draft: payload.draft ?? false,
          baseRef: payload.base,
          headRef: payload.head,
          ...(headRepo === repo
            ? {}
            : { headRepository: `${headRepo.owner.slug}/${headRepo.name}` }),
          frozenHeadOid: null,
          frozenBaseOid: null,
          merged: null,
          reviews: [],
          threads: [],
        },
      };
      thread.items.push({
        type: "commits",
        id: newId("push"),
        createdAt: at,
        commits: commitsOf(refsOf(repo, thread.pull!)).map((oid) => summarize(fx, oid)),
      });
      store.threads.push(thread);
      if (viewerOf(repo).canTriage) {
        applyThreadChange(repo, thread, {
          labels: payload.labels,
          assignees: payload.assignees,
          milestone: payload.milestone,
        });
      }
      syncCounts(repo);
      return toPull(repo, thread);
    },
    get: ({ params }) => {
      const { repo, thread } = pullOf(params.owner, params.repo, params.number);
      return toPull(repo, thread);
    },
    update: ({ params, payload }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      if (payload.base !== undefined && payload.base !== pull.baseRef) {
        if (gitOf(repo).branches[payload.base] === undefined) {
          throw unprocessable("No such branch", "ref_not_found");
        }
        thread.items.push(
          event("base_changed", requireUser(), now(), { from: pull.baseRef, to: payload.base }),
        );
        pull.baseRef = payload.base;
      }
      applyThreadChange(repo, thread, payload);
      return toPull(repo, thread);
    },
    close: ({ params }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      if (pull.merged) throw unprocessable("This pull request is merged", "already_merged");
      applyThreadChange(repo, thread, { state: "closed" });
      return toPull(repo, thread);
    },
    reopen: ({ params }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      if (pull.merged) throw unprocessable("This pull request is merged", "already_merged");
      if (!refsOf(repo, pull).headRefExists) {
        throw unprocessable("Its head branch was deleted", "ref_not_found");
      }
      applyThreadChange(repo, thread, { state: "open" });
      return toPull(repo, thread);
    },
    setDraft: ({ params, payload }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      if (pull.draft !== payload.draft) {
        pull.draft = payload.draft;
        thread.items.push(
          event(
            payload.draft ? "converted_to_draft" : "ready_for_review",
            requireUser(),
            now(),
            {},
          ),
        );
        touch(thread);
      }
      return toPull(repo, thread);
    },
    files: ({ params, query }) => {
      const { repo, pull } = pullOf(params.owner, params.repo, params.number);
      const refs = refsOf(repo, pull);
      const baseOid = query?.since ?? refs.mergeBaseOid;
      const all = diffCommits(refs.fx, baseOid, refs.headOid, {
        context: query?.context,
        path: query?.path,
      });
      const page = paginate(all, query);
      return {
        baseOid,
        headOid: refs.headOid,
        stats: statsOf(all.map(summaryOf)),
        files: page.items,
        nextCursor: page.nextCursor,
      };
    },
    commits: ({ params, query }) => {
      const { repo, pull } = pullOf(params.owner, params.repo, params.number);
      const refs = refsOf(repo, pull);
      return paginate(
        commitsOf(refs).map((oid) => summarize(refs.fx, oid)),
        query,
      );
    },
    mergeability: ({ params }) => {
      const { repo, thread } = pullOf(params.owner, params.repo, params.number);
      return mergeabilityOf(repo, thread);
    },
    merge: ({ params, payload }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      const user = requireUser();
      const refs = refsOf(repo, pull);
      const state = mergeabilityOf(repo, thread);
      if (payload.expectedHeadOid !== undefined && payload.expectedHeadOid !== refs.headOid) {
        throw conflict("The branch has new commits since you looked", "head_moved");
      }
      if (!state.allowedMethods.includes(payload.method)) {
        throw unprocessable("That merge method is turned off", "merge_method_not_allowed");
      }
      const first = state.blockers[0];
      if (first && !(state.canBypass && payload.bypass === true)) {
        throw unprocessable(first.message, BLOCKER_CODE[first.code] ?? "not_mergeable");
      }
      const { fx } = refs;
      const merged = mergeCommits(fx, refs.baseOid, refs.headOid);
      const title = `${thread.title} (#${thread.number})`;
      // A rebase replays each commit; the mock writes the result as one.
      const commitOid =
        payload.method === "merge"
          ? writeCommit(
              fx,
              merged.files,
              [refs.baseOid, refs.headOid],
              payload.commitTitle ??
                `Merge pull request #${thread.number} from ${pull.headRef}\n\n${thread.title}`,
              user,
            )
          : writeCommit(
              fx,
              merged.files,
              [refs.baseOid],
              payload.method === "squash"
                ? `${payload.commitTitle ?? title}${
                    payload.commitMessage ? `\n\n${payload.commitMessage}` : ""
                  }`
                : (fx.commits[refs.headOid]?.message ?? title),
              user,
            );
      fx.branches[pull.baseRef] = commitOid;
      const at = now();
      pull.frozenHeadOid = refs.headOid;
      pull.frozenBaseOid = refs.baseOid;
      pull.merged = { at, by: user, commitOid, method: payload.method };
      thread.state = "closed";
      thread.closedAt = at;
      thread.closedBy = user;
      thread.items.push(
        event("merged", user, at, { commitOid, method: payload.method, baseRef: pull.baseRef }),
      );
      const branchDeleted =
        (payload.deleteBranch ?? repo.merge.deleteBranchOnMerge) &&
        pull.headRef !== repo.defaultBranch;
      if (branchDeleted) {
        delete fx.branches[pull.headRef];
        thread.items.push(event("head_branch_deleted", user, at, { ref: pull.headRef }));
      }
      repo.pushedAt = at;
      touch(thread);
      syncCounts(repo);
      return { merged: true as const, commitOid, method: payload.method, branchDeleted };
    },
    updateBranch: ({ params, payload }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      const user = requireUser();
      const refs = refsOf(repo, pull);
      if (payload.expectedHeadOid !== undefined && payload.expectedHeadOid !== refs.headOid) {
        throw conflict("The branch has new commits since you looked", "head_moved");
      }
      const merged = mergeCommits(refs.fx, refs.headOid, refs.baseOid);
      if (merged.conflicts.length > 0) {
        throw unprocessable("The branch has conflicts with the base", "merge_conflict");
      }
      const headOid = writeCommit(
        refs.fx,
        merged.files,
        [refs.headOid, refs.baseOid],
        `Merge branch '${pull.baseRef}' into ${pull.headRef}`,
        user,
      );
      refs.fx.branches[pull.headRef] = headOid;
      thread.items.push({
        type: "commits",
        id: newId("push"),
        createdAt: now(),
        commits: [summarize(refs.fx, headOid)],
      });
      if (repo.hasCi) {
        startRun(repo, {
          headRef: pull.headRef,
          sha: headOid,
          pullNumber: thread.number,
          actor: user,
        });
      }
      touch(thread);
      return { headOid };
    },
    restoreBranch: ({ params }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      const refs = refsOf(repo, pull);
      if (refs.headRefExists) throw conflict("The branch exists", "ref_exists");
      refs.fx.branches[pull.headRef] = refs.headOid;
      thread.items.push(event("head_branch_restored", requireUser(), now(), { ref: pull.headRef }));
      return { ref: pull.headRef, oid: refs.headOid };
    },
    listReviews: ({ params }) => {
      const { repo, thread } = pullOf(params.owner, params.repo, params.number);
      return { reviews: reviewsOf(repo, thread) };
    },
    createReview: ({ params, payload }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      requireUser();
      const item =
        payload.event === undefined
          ? pendingReviewOf(repo, pull)
          : blankReview(repo, pull, "pending", payload.body ?? "");
      if (!pull.reviews.includes(item)) pull.reviews.push(item);
      for (const draft of payload.comments ?? []) {
        startThread(repo, pull, draft, newComment(item.id, draft.body, true));
      }
      if (payload.event !== undefined) {
        try {
          submit(thread, pull, item, payload.event, payload.body);
        } catch (error) {
          pull.reviews.splice(pull.reviews.indexOf(item), 1);
          throw error;
        }
      }
      return reviewsOf(repo, thread).find((review) => review.id === item.id)!;
    },
    submitReview: ({ params, payload }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      const item = pull.reviews.find((review) => review.id === params.reviewId);
      if (!item) throw notFound("Review not found");
      if (item.state !== "pending") throw unprocessable("That review was already submitted");
      submit(thread, pull, item, payload.event, payload.body);
      return reviewsOf(repo, thread).find((review) => review.id === item.id)!;
    },
    discardReview: ({ params }) => {
      const { pull } = pullOf(params.owner, params.repo, params.number);
      const item = pull.reviews.find((review) => review.id === params.reviewId);
      if (!item) throw notFound("Review not found");
      if (item.state !== "pending") throw unprocessable("Only a pending review can be discarded");
      pull.reviews.splice(pull.reviews.indexOf(item), 1);
      for (const reviewThread of pull.threads) {
        reviewThread.comments = reviewThread.comments.filter((c) => c.reviewId !== item.id);
      }
      pull.threads = pull.threads.filter((reviewThread) => reviewThread.comments.length > 0);
      return ok;
    },
    dismissReview: ({ params, payload }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      const item = pull.reviews.find((review) => review.id === params.reviewId);
      if (!item) throw notFound("Review not found");
      const user = requireUser();
      item.state = "dismissed";
      item.dismissedBy = user;
      item.dismissalReason = payload.reason;
      thread.items.push(
        event("review_dismissed", user, now(), { reviewId: item.id, reason: payload.reason }),
      );
      return reviewsOf(repo, thread).find((review) => review.id === item.id)!;
    },
    listThreads: ({ params }) => {
      const { repo, thread } = pullOf(params.owner, params.repo, params.number);
      return { threads: reviewThreadsOf(repo, thread) };
    },
    createReviewComment: ({ params, payload }) => {
      const { repo, thread, pull } = pullOf(params.owner, params.repo, params.number);
      requireUser();
      const pending = payload.pending === true;
      let item: StoredReview;
      if (pending) item = pendingReviewOf(repo, pull);
      else {
        item = blankReview(repo, pull, "commented", "");
        pull.reviews.push(item);
      }
      const comment = newComment(item.id, payload.body, pending);
      let reviewThread: StoredReviewThread;
      if (payload.inReplyTo !== undefined) {
        const found = pull.threads.find((t) => t.comments.some((c) => c.id === payload.inReplyTo));
        if (!found) throw notFound("Thread not found");
        comment.threadId = found.id;
        comment.inReplyToId = found.id;
        found.comments.push(comment);
        reviewThread = found;
      } else {
        if (
          payload.path === undefined ||
          payload.line === undefined ||
          payload.side === undefined
        ) {
          throw badRequest("A new thread needs a path, a line and a side");
        }
        reviewThread = startThread(
          repo,
          pull,
          {
            path: payload.path,
            line: payload.line,
            side: payload.side,
            startLine: payload.startLine,
            startSide: payload.startSide,
          },
          comment,
        );
      }
      touch(thread);
      const shown = presentThread(repo, thread, reviewThread)!;
      return { thread: shown, comment: shown.comments.find((c) => c.id === comment.id)! };
    },
    updateReviewComment: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      requireUser();
      const { reviewThread } = locate(repo, (t) =>
        t.comments.some((c) => c.id === params.commentId),
      );
      const comment = reviewThread.comments.find((c) => c.id === params.commentId)!;
      comment.body = payload.body;
      comment.edited = true;
      comment.updatedAt = now();
      return { ...comment, viewerCanEdit: true, viewerCanDelete: true };
    },
    deleteReviewComment: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      requireUser();
      const { pull, reviewThread } = locate(repo, (t) =>
        t.comments.some((c) => c.id === params.commentId),
      );
      reviewThread.comments = reviewThread.comments.filter((c) => c.id !== params.commentId);
      if (reviewThread.comments.length === 0) {
        pull.threads.splice(pull.threads.indexOf(reviewThread), 1);
      }
      return ok;
    },
    resolveThread: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const { thread, reviewThread } = locate(repo, (t) => t.id === params.threadId);
      reviewThread.resolved = true;
      reviewThread.resolvedBy = requireUser();
      return presentThread(repo, thread, reviewThread)!;
    },
    unresolveThread: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const { thread, reviewThread } = locate(repo, (t) => t.id === params.threadId);
      requireUser();
      reviewThread.resolved = false;
      reviewThread.resolvedBy = null;
      return presentThread(repo, thread, reviewThread)!;
    },
  },
});
