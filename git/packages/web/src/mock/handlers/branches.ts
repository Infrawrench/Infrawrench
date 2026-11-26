/**
 * The mock of the branches group: listing, proposing and finding branch
 * pages, and everything a page does (reviews, comments, merging).
 */
import type { ReviewComment, UserRef } from "@infrawrench/git-contract";
import { parseBranchKey } from "@infrawrench/git-contract";
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
import { FIXTURE_PEOPLE, aheadBehind, diffCommits, statsOf, summarize, summaryOf } from "../git";
import { copyObjects, mergeCommits, writeCommit } from "../git-write";
import { startRun } from "../ci-data";
import { newId } from "../settings-data";
import {
  commitsOf,
  event,
  filterThreads,
  findPage,
  hunkAround,
  mergeabilityOf,
  openPageOf,
  pageKeyOf,
  presentThread,
  refsOf,
  reviewThreadsOf,
  reviewsOf,
  syncCounts,
  threadsOf,
  titleOfBranch,
  toBranchPage,
  toBranchPageSummary,
  touch,
  viewerOf,
  type PageRecord,
  type StoredReview,
  type StoredReviewThread,
  type ThreadRecord,
} from "../threads-data";
import { applyThreadChange } from "../threads-write";

const now = (): string => new Date().toISOString();

function pageOf(owner: string, name: string, key: string) {
  const repo = findRepository(owner, name);
  const thread = findPage(repo, key);
  return { repo, thread, page: thread.page! };
}

interface Opening {
  readonly head: string;
  /** The fork the head is in; the repository itself when it is the same one. */
  readonly headRepo: RepositoryRecord;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly author: UserRef | null;
}

/**
 * Opens a page: what proposing does, and what `get` does for a branch that
 * was pushed without one. Refuses a head with nothing the base lacks, or
 * one that already has an open page.
 */
function openPage(repo: RepositoryRecord, opening: Opening): ThreadRecord {
  const fx = gitOf(repo);
  const cross = opening.headRepo !== repo;
  const headFx = gitOf(opening.headRepo);
  const base = fx.branches[opening.base];
  const head = headFx.branches[opening.head];
  if (base === undefined || head === undefined) {
    throw unprocessable("No such branch", "ref_not_found");
  }
  if (cross) copyObjects(headFx, fx, head);
  if (aheadBehind(fx, base, head).ahead.length === 0) {
    throw unprocessable(
      `${opening.head} has no commits that ${opening.base} lacks`,
      "no_commits_between",
    );
  }
  const headRepository = cross
    ? `${opening.headRepo.owner.slug}/${opening.headRepo.name}`
    : undefined;
  if (openPageOf(repo, opening.head, headRepository) !== undefined) {
    throw conflict(`${opening.head} already has an open page`, "branch_page_exists");
  }
  const store = threadsOf(repo);
  const at = now();
  const thread: ThreadRecord = {
    id: newId("thread"),
    number: store.nextNumber++,
    title: opening.title,
    body: opening.body,
    bodyEditedAt: null,
    author: opening.author,
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
    page: {
      draft: opening.draft,
      baseRef: opening.base,
      headRef: opening.head,
      ...(headRepository === undefined ? {} : { headRepository }),
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
    commits: commitsOf(refsOf(repo, thread.page!)).map((oid) => summarize(fx, oid)),
  });
  store.threads.push(thread);
  syncCounts(repo);
  return thread;
}

/** The person behind a commit, as a user of the mock when they are one. */
function authorOf(fx: ReturnType<typeof gitOf>, oid: string): UserRef | null {
  const email = fx.commits[oid]?.author.email;
  return (email === undefined ? undefined : FIXTURE_PEOPLE[email]) ?? currentUser();
}

/** The review thread or comment's page. */
function locate(repo: RepositoryRecord, match: (thread: StoredReviewThread) => boolean) {
  for (const thread of threadsOf(repo).threads) {
    const found = thread.page?.threads.find(match);
    if (found) return { thread, page: thread.page!, reviewThread: found };
  }
  throw notFound("Not found");
}

function pendingReviewOf(repo: RepositoryRecord, page: PageRecord): StoredReview {
  const user = requireUser();
  let found = page.reviews.find((item) => item.state === "pending" && item.author?.id === user.id);
  if (!found) {
    found = blankReview(repo, page, "pending", "");
    page.reviews.push(found);
  }
  return found;
}

function blankReview(
  repo: RepositoryRecord,
  page: PageRecord,
  state: StoredReview["state"],
  body: string,
): StoredReview {
  const at = now();
  return {
    id: newId("rev"),
    author: requireUser(),
    state,
    body,
    commitOid: refsOf(repo, page).headOid,
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
  page: PageRecord,
  anchor: Anchor,
  first: Mutable<ReviewComment>,
): StoredReviewThread {
  const refs = refsOf(repo, page);
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
  page.threads.push(created);
  return created;
}

function submit(
  thread: ThreadRecord,
  page: PageRecord,
  item: StoredReview,
  kind: "comment" | "approve" | "request_changes",
  body: string | undefined,
): void {
  const user = requireUser();
  if (kind !== "comment" && thread.author?.id === user.id) {
    throw unprocessable("You cannot approve or request changes on your own branch");
  }
  item.state =
    kind === "approve"
      ? "approved"
      : kind === "request_changes"
        ? "changes_requested"
        : "commented";
  if (body !== undefined) item.body = body;
  item.submittedAt = now();
  for (const reviewThread of page.threads) {
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
  branches: {
    list: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const pages = threadsOf(repo).threads.filter((thread) => thread.page !== null);
      let matching = filterThreads(repo, pages, query ?? {});
      if (query?.base !== undefined)
        matching = matching.filter((t) => t.page!.baseRef === query.base);
      if (query?.head !== undefined) {
        // `owner:branch` for a branch in a fork.
        const colon = query.head.indexOf(":");
        const owner = colon < 0 ? null : query.head.slice(0, colon).toLowerCase();
        const ref = colon < 0 ? query.head : query.head.slice(colon + 1);
        matching = matching.filter(
          (t) =>
            t.page!.headRef === ref &&
            (owner === null
              ? t.page!.headRepository === undefined
              : t.page!.headRepository?.toLowerCase().startsWith(`${owner}/`) === true),
        );
      }
      if (query?.draft !== undefined) {
        matching = matching.filter((t) => t.page!.draft === (query.draft === "true"));
      }
      if (query?.reviewer !== undefined) {
        const name = query.reviewer === "@me" ? currentUser()?.username : query.reviewer;
        matching = matching.filter((t) =>
          t.page!.reviews.some((r) => r.state !== "pending" && r.author?.username === name),
        );
      }
      const state = query?.state ?? "open";
      const shown = matching.filter((thread) =>
        state === "all"
          ? true
          : state === "merged"
            ? thread.page!.merged !== null
            : thread.state === state,
      );
      return {
        ...paginate(
          shown.map((thread) => toBranchPageSummary(repo, thread)),
          query,
        ),
        counts: {
          open: matching.filter((thread) => thread.state === "open").length,
          closed: matching.filter((thread) => thread.state === "closed").length,
        },
      };
    },
    propose: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const author = requireUser();
      const headRepo = headRepositoryOf(repo, payload.headRepository);
      const title = payload.title?.trim() ?? "";
      if (payload.title !== undefined && title === "") throw badRequest("A title is required");
      const thread = openPage(repo, {
        head: payload.head,
        headRepo,
        base: payload.base ?? repo.defaultBranch,
        title: title === "" ? titleOfBranch(payload.head) : title,
        body: payload.body ?? "",
        draft: payload.draft ?? false,
        author,
      });
      if (viewerOf(repo).canTriage) {
        applyThreadChange(repo, thread, {
          labels: payload.labels,
          assignees: payload.assignees,
          milestone: payload.milestone,
        });
      }
      return toBranchPage(repo, thread);
    },
    locate: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const thread = threadsOf(repo).threads.find((item) => item.number === params.number);
      if (thread === undefined || thread.page === null) throw notFound("Branch page not found");
      return { key: pageKeyOf(repo, thread) };
    },
    get: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      let thread: ThreadRecord;
      try {
        thread = findPage(repo, params.branch);
      } catch (error) {
        // A branch of this repository pushed before pages were opened on push gets its page now.
        const parsed = parseBranchKey(params.branch);
        const fx = repo.fixture === null ? null : gitOf(repo);
        const head = parsed === null || fx === null ? undefined : fx.branches[parsed.branch];
        if (
          parsed === null ||
          fx === null ||
          head === undefined ||
          parsed.fork !== null ||
          parsed.ordinal !== null ||
          parsed.branch === repo.defaultBranch
        ) {
          throw error;
        }
        try {
          thread = openPage(repo, {
            head: parsed.branch,
            headRepo: repo,
            base: repo.defaultBranch,
            title: titleOfBranch(parsed.branch),
            body: "",
            draft: false,
            author: authorOf(fx, head),
          });
        } catch {
          throw error;
        }
      }
      return toBranchPage(repo, thread);
    },
    update: ({ params, payload }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      if (payload.base !== undefined && payload.base !== page.baseRef) {
        if (gitOf(repo).branches[payload.base] === undefined) {
          throw unprocessable("No such branch", "ref_not_found");
        }
        thread.items.push(
          event("base_changed", requireUser(), now(), { from: page.baseRef, to: payload.base }),
        );
        page.baseRef = payload.base;
      }
      applyThreadChange(repo, thread, payload);
      return toBranchPage(repo, thread);
    },
    close: ({ params }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      if (page.merged) throw unprocessable("This branch is merged", "already_merged");
      applyThreadChange(repo, thread, { state: "closed" });
      return toBranchPage(repo, thread);
    },
    reopen: ({ params }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      if (page.merged) throw unprocessable("This branch is merged", "already_merged");
      if (!refsOf(repo, page).headRefExists) {
        throw unprocessable("Its head branch was deleted", "ref_not_found");
      }
      applyThreadChange(repo, thread, { state: "open" });
      return toBranchPage(repo, thread);
    },
    setDraft: ({ params, payload }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      if (page.draft !== payload.draft) {
        page.draft = payload.draft;
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
      return toBranchPage(repo, thread);
    },
    files: ({ params, query }) => {
      const { repo, page } = pageOf(params.owner, params.repo, params.branch);
      const refs = refsOf(repo, page);
      const baseOid = query?.since ?? refs.mergeBaseOid;
      const all = diffCommits(refs.fx, baseOid, refs.headOid, {
        context: query?.context,
        path: query?.path,
      });
      const slice = paginate(all, query);
      return {
        baseOid,
        headOid: refs.headOid,
        stats: statsOf(all.map(summaryOf)),
        files: slice.items,
        nextCursor: slice.nextCursor,
      };
    },
    commits: ({ params, query }) => {
      const { repo, page } = pageOf(params.owner, params.repo, params.branch);
      const refs = refsOf(repo, page);
      return paginate(
        commitsOf(refs).map((oid) => summarize(refs.fx, oid)),
        query,
      );
    },
    mergeability: ({ params }) => {
      const { repo, thread } = pageOf(params.owner, params.repo, params.branch);
      return mergeabilityOf(repo, thread);
    },
    merge: ({ params, payload }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      const user = requireUser();
      const refs = refsOf(repo, page);
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
      const title = thread.title;
      // A rebase replays each commit; the mock writes the result as one.
      const commitOid =
        payload.method === "merge"
          ? writeCommit(
              fx,
              merged.files,
              [refs.baseOid, refs.headOid],
              payload.commitTitle ?? `Merge branch '${page.headRef}'\n\n${thread.title}`,
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
      fx.branches[page.baseRef] = commitOid;
      const at = now();
      page.frozenHeadOid = refs.headOid;
      page.frozenBaseOid = refs.baseOid;
      page.merged = { at, by: user, commitOid, method: payload.method };
      thread.state = "closed";
      thread.closedAt = at;
      thread.closedBy = user;
      thread.items.push(
        event("merged", user, at, { commitOid, method: payload.method, baseRef: page.baseRef }),
      );
      const branchDeleted =
        (payload.deleteBranch ?? repo.merge.deleteBranchOnMerge) &&
        page.headRef !== repo.defaultBranch;
      if (branchDeleted) {
        delete refs.headFx.branches[page.headRef];
        thread.items.push(event("head_branch_deleted", user, at, { ref: page.headRef }));
      }
      repo.pushedAt = at;
      touch(thread);
      syncCounts(repo);
      return { merged: true as const, commitOid, method: payload.method, branchDeleted };
    },
    updateBranch: ({ params, payload }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      const user = requireUser();
      const refs = refsOf(repo, page);
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
        `Merge branch '${page.baseRef}' into ${page.headRef}`,
        user,
      );
      if (refs.headFx !== refs.fx) copyObjects(refs.fx, refs.headFx, headOid);
      refs.headFx.branches[page.headRef] = headOid;
      thread.items.push({
        type: "commits",
        id: newId("push"),
        createdAt: now(),
        commits: [summarize(refs.fx, headOid)],
      });
      if (repo.hasCi) {
        startRun(repo, {
          headRef: page.headRef,
          sha: headOid,
          branchPage: pageKeyOf(repo, thread),
          actor: user,
        });
      }
      touch(thread);
      return { headOid };
    },
    restoreBranch: ({ params }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      const refs = refsOf(repo, page);
      if (refs.headRefExists) throw conflict("The branch exists", "ref_exists");
      refs.headFx.branches[page.headRef] = refs.headOid;
      thread.items.push(event("head_branch_restored", requireUser(), now(), { ref: page.headRef }));
      return { ref: page.headRef, oid: refs.headOid };
    },
    listReviews: ({ params }) => {
      const { repo, thread } = pageOf(params.owner, params.repo, params.branch);
      return { reviews: reviewsOf(repo, thread) };
    },
    createReview: ({ params, payload }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      requireUser();
      const item =
        payload.event === undefined
          ? pendingReviewOf(repo, page)
          : blankReview(repo, page, "pending", payload.body ?? "");
      if (!page.reviews.includes(item)) page.reviews.push(item);
      for (const draft of payload.comments ?? []) {
        startThread(repo, page, draft, newComment(item.id, draft.body, true));
      }
      if (payload.event !== undefined) {
        try {
          submit(thread, page, item, payload.event, payload.body);
        } catch (error) {
          page.reviews.splice(page.reviews.indexOf(item), 1);
          throw error;
        }
      }
      return reviewsOf(repo, thread).find((review) => review.id === item.id)!;
    },
    submitReview: ({ params, payload }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      const item = page.reviews.find((review) => review.id === params.reviewId);
      if (!item) throw notFound("Review not found");
      if (item.state !== "pending") throw unprocessable("That review was already submitted");
      submit(thread, page, item, payload.event, payload.body);
      return reviewsOf(repo, thread).find((review) => review.id === item.id)!;
    },
    discardReview: ({ params }) => {
      const { page } = pageOf(params.owner, params.repo, params.branch);
      const item = page.reviews.find((review) => review.id === params.reviewId);
      if (!item) throw notFound("Review not found");
      if (item.state !== "pending") throw unprocessable("Only a pending review can be discarded");
      page.reviews.splice(page.reviews.indexOf(item), 1);
      for (const reviewThread of page.threads) {
        reviewThread.comments = reviewThread.comments.filter((c) => c.reviewId !== item.id);
      }
      page.threads = page.threads.filter((reviewThread) => reviewThread.comments.length > 0);
      return ok;
    },
    dismissReview: ({ params, payload }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      const item = page.reviews.find((review) => review.id === params.reviewId);
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
      const { repo, thread } = pageOf(params.owner, params.repo, params.branch);
      return { threads: reviewThreadsOf(repo, thread) };
    },
    createReviewComment: ({ params, payload }) => {
      const { repo, thread, page } = pageOf(params.owner, params.repo, params.branch);
      requireUser();
      const pending = payload.pending === true;
      let item: StoredReview;
      if (pending) item = pendingReviewOf(repo, page);
      else {
        item = blankReview(repo, page, "commented", "");
        page.reviews.push(item);
      }
      const comment = newComment(item.id, payload.body, pending);
      let reviewThread: StoredReviewThread;
      if (payload.inReplyTo !== undefined) {
        const found = page.threads.find((t) => t.comments.some((c) => c.id === payload.inReplyTo));
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
          page,
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
      const { page, reviewThread } = locate(repo, (t) =>
        t.comments.some((c) => c.id === params.commentId),
      );
      reviewThread.comments = reviewThread.comments.filter((c) => c.id !== params.commentId);
      if (reviewThread.comments.length === 0) {
        page.threads.splice(page.threads.indexOf(reviewThread), 1);
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
