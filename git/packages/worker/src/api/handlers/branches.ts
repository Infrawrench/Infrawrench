/**
 * Branch pages: the records, their diff and commits (through the
 * `RepoReader`), reviews and review threads, and merging under the base
 * branch's protection. A page is named by its key (`:branch`), resolved once
 * per request by `../branch-page.ts`.
 */
import { type SQL, sql } from "drizzle-orm";
import { HttpApiBuilder } from "effect/http-api";
import {
  type ErrorCode,
  type Mergeability,
  GitApi,
  accessAtLeast,
  badRequest,
  conflict,
  forbidden,
  notFound,
  ok,
  unprocessable,
} from "@infrawrench/git-contract";
import {
  gitIssues,
  gitNamespaces,
  gitPullRequests,
  gitRepositories,
  gitReviews,
} from "@infrawrench/server-core/db/schema";
import { principalActor } from "../../auth/principal";
import { db } from "../../db/client";
import { pageSize } from "../../db/cursor";
import { getNamespaceBySlug } from "../../db/namespaces";
import { openPageOfHead, pageByNumber, pageKey } from "../../db/branch-pages";
import {
  type PullRequestWithThread,
  type ReviewRow,
  addReviewComment,
  createPullRequest,
  createReview,
  deletePendingReview,
  deleteReviewComment,
  dismissReview,
  editReviewComment,
  getPendingReview,
  getPullRequest,
  getPullRequestByIssueId,
  getReview,
  getReviewComment,
  getReviewInRepository,
  listReviewComments,
  listReviews,
  markMerged,
  pullRequestsFor,
  setMergeable,
  setThreadResolved,
  submitReview,
  syncPullRequest,
  updatePullRequest,
} from "../../db/pulls";
import { type RepositoryWithOwner, getRepositoryById } from "../../db/repositories";
import { latestVersionNumbers, linkVersionsToPull, markBranchForPruning } from "../../db/review";
import { addTimelineEvent, countThreads, listThreads } from "../../db/threads";
import { getUser, userByUsername } from "../../db/users";
import { announcePullRequest } from "../../events/ci";
import { queuePullRequestPlans } from "../../events/terraform";
import { titleOf } from "../../events/versions";
import { type RepoReader, RepoReaderError } from "../../repo/reader";
import { pageOr404, pageOrOpen } from "../branch-page";
import { type RepoCx, locatorOf, repoOp } from "../context";
import { branchProtection, mayDelete } from "../protection";
import { headRepository, headRepositoryOf, mayProposeTo, plansPullRequest } from "../repos";
import {
  applyState,
  applyText,
  applyTriage,
  canTriage,
  hasTriageEdit,
  isAuthor,
  labelIdsFor,
  milestoneIdFor,
  noteMentions,
  userIdsFor,
} from "../thread-edits";
import { commitDecorator } from "../views/commits";
import {
  BYPASSABLE,
  mayResolve,
  mergeabilityDetail,
  pageDetail,
  pageSummaries,
  reviewCommentViewOf,
  reviewViews,
  threadsOf,
} from "../views/branch-pages";
import { mayChangeOwn } from "../views/threads";
import { type ThreadFilterQuery, pageInput, threadFilters } from "./issues";

/** A page as it is now, read again after a change. */
const detail = async (cx: RepoCx, found: PullRequestWithThread) => {
  const fresh = await getPullRequest(cx.repo.repository.id, found.thread.number);
  if (!fresh) throw notFound("No such branch page");
  return pageDetail(cx, fresh);
};

/** The reader the head commit can be read from: the head repository's, or the base's pull ref. */
const headInput = (cx: RepoCx, { pull }: PullRequestWithThread) =>
  pull.headRepositoryId === null || pull.headRepositoryId === cx.repo.repository.id
    ? undefined
    : pull.headRepositoryId;

/**
 * A merge commit's first line: the branch it merges, and for a fork's
 * branch the fork it is in (`Merge branch 'feature/a' of bob/infra`).
 */
const mergeTitleOf = async (cx: RepoCx, { pull }: PullRequestWithThread): Promise<string> => {
  const merged = `Merge branch '${pull.headRef}'`;
  if (pull.headRepositoryId === null || pull.headRepositoryId === cx.repo.repository.id) {
    return merged;
  }
  const head = await getRepositoryById(pull.headRepositoryId);
  return head ? `${merged} of ${head.owner.slug}/${head.repository.name}` : merged;
};

const identityOf = async (cx: RepoCx) => {
  const user = cx.userId ? await getUser(cx.userId) : null;
  return {
    name: user?.displayName ?? cx.username ?? "Infrawrench",
    email: user?.email ?? "noreply@infrawrench.com",
  };
};

/** A page's side conditions on the list, as SQL over `git_pull_requests`. */
const pullFilters = async (
  cx: RepoCx,
  query: {
    readonly state?: "open" | "closed" | "merged" | "all";
    readonly base?: string;
    readonly head?: string;
    readonly draft?: "true" | "false";
    readonly reviewer?: string;
  },
): Promise<SQL[]> => {
  const of = (condition: SQL) =>
    sql`exists (select 1 from ${gitPullRequests} where ${gitPullRequests.issueId} = ${gitIssues.id} and ${condition})`;
  const extra: SQL[] = [];
  if (query.base !== undefined) extra.push(of(sql`${gitPullRequests.baseRef} = ${query.base}`));
  if (query.draft !== undefined) {
    extra.push(of(sql`${gitPullRequests.draft} = ${query.draft === "true"}`));
  }
  if (query.head !== undefined) {
    const [owner, branch] = query.head.includes(":")
      ? [
          query.head.slice(0, query.head.indexOf(":")),
          query.head.slice(query.head.indexOf(":") + 1),
        ]
      : [null, query.head];
    const namespace = owner === null ? null : await getNamespaceBySlug(owner);
    extra.push(
      owner === null
        ? of(sql`${gitPullRequests.headRef} = ${branch}`)
        : of(
            sql`${gitPullRequests.headRef} = ${branch} and ${gitPullRequests.headRepositoryId} in (select ${gitRepositories.id} from ${gitRepositories} inner join ${gitNamespaces} on ${gitNamespaces.id} = ${gitRepositories.namespaceId} where ${gitNamespaces.id} = ${namespace?.id ?? ""})`,
          ),
    );
  }
  if (query.reviewer !== undefined) {
    const reviewerId =
      query.reviewer === "@me" ? cx.userId : ((await userByUsername(query.reviewer))?.id ?? null);
    extra.push(
      sql`exists (select 1 from ${gitReviews} where ${gitReviews.pullRequestId} = ${gitIssues.id} and ${gitReviews.authorUserId} = ${reviewerId ?? ""} and ${gitReviews.state} <> 'pending')`,
    );
  }
  return extra;
};

const BLOCKER_CODES: Record<Mergeability["blockers"][number]["code"], ErrorCode> = {
  merged: "already_merged",
  closed: "not_mergeable",
  draft: "draft",
  conflicts: "merge_conflict",
  checking: "not_mergeable",
  head_missing: "ref_not_found",
  checks_pending: "checks_required",
  checks_failed: "checks_required",
  approvals_required: "approvals_required",
  changes_requested: "changes_requested",
  push_restricted: "protected_branch",
  archived: "repository_archived",
  no_permission: "not_mergeable",
  must_fix_findings: "must_fix_findings",
};

/** The version of its head branch a page is at, for what is written on it now. */
const currentVersion = async (found: PullRequestWithThread): Promise<number | null> =>
  (await latestVersionNumbers([found.pull.issueId])).get(found.pull.issueId) ?? null;

const REVIEW_STATES = {
  comment: "commented",
  approve: "approved",
  request_changes: "changes_requested",
} as const;

/** What starting a CI run and a Terraform plan need, after a page gets a head. */
const announce = (
  cx: RepoCx,
  found: PullRequestWithThread,
  action: "opened" | "reopened" | "synchronize",
  head: RepositoryWithOwner | null,
): void => {
  const { repository } = cx.repo;
  cx.background(announcePullRequest(cx.repo, found, action, head, cx.username));
  if (!plansPullRequest(repository.id, found.pull.headRepositoryId)) return;
  cx.background(
    queuePullRequestPlans({
      repositoryId: repository.id,
      organizationId: cx.repo.owner.organizationId,
      defaultBranch: repository.defaultBranch,
      baseRef: found.pull.baseRef,
      headRef: found.pull.headRef,
      headOid: found.pull.headOid,
      pullNumber: found.thread.number,
      userId: cx.userId,
      // By id: a head anywhere but in this repository, or in none, is a fork's.
      fromFork: found.pull.headRepositoryId !== repository.id,
      reader: cx.git,
      headRepositoryId:
        found.pull.headRepositoryId !== null && found.pull.headRepositoryId !== repository.id
          ? found.pull.headRepositoryId
          : undefined,
    }),
  );
};

/** The branch, or a 422: it was named in a payload. */
const branchOr422 = async (reader: RepoReader, name: string) => {
  const branch = await reader.getBranch(name);
  if (!branch) throw unprocessable(`There is no branch named ${name}`, "ref_not_found");
  return branch;
};

const reviewOf = async (cx: RepoCx, found: PullRequestWithThread, review: ReviewRow) => {
  const comments = await listReviewComments(found.pull.issueId, cx.userId);
  const [view] = await reviewViews(cx, found, [review], comments);
  return view!;
};

const requireOpenForReview = (cx: RepoCx, found: PullRequestWithThread): void => {
  if (found.thread.locked && !canTriage(cx)) {
    throw unprocessable("This conversation is locked", "locked");
  }
};

interface Anchor {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly startLine?: number | undefined;
  readonly startSide?: "LEFT" | "RIGHT" | undefined;
}

/** The hunk an anchor is on, or a 422 when the diff does not show those lines. */
const anchorHunk = async (cx: RepoCx, found: PullRequestWithThread, anchor: Anchor) => {
  const { pull } = found;
  if (anchor.startLine !== undefined && anchor.startLine > anchor.line) {
    throw unprocessable("A comment's first line comes before its last");
  }
  const hunk = await cx.git.diffAnchor({
    baseOid: pull.mergeBaseOid ?? pull.baseOid,
    headOid: pull.headOid,
    headRepositoryId: headInput(cx, found),
    path: anchor.path,
    side: anchor.side,
    line: anchor.line,
    startLine: anchor.startLine,
  });
  if (!hunk) throw unprocessable("Those lines are not part of this branch's diff");
  return JSON.stringify(hunk);
};

export const BranchesHandlers = HttpApiBuilder.group(GitApi, "branches", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx, { query }) => {
        const filters = {
          ...(await threadFilters(cx, query as ThreadFilterQuery)),
          isPullRequest: true,
          extra: await pullFilters(cx, query),
        };
        const state = query.state ?? "open";
        const merged = sql`exists (select 1 from ${gitPullRequests} where ${gitPullRequests.issueId} = ${gitIssues.id} and ${gitPullRequests.mergedAt} is not null)`;
        const [found, counts] = await Promise.all([
          listThreads({
            ...filters,
            ...pageInput(query as ThreadFilterQuery),
            extra: state === "merged" ? [...filters.extra, merged] : filters.extra,
            state: state === "merged" ? "closed" : state,
          }),
          countThreads(filters),
        ]);
        const pulls = await pullRequestsFor(found.items.map((thread) => thread.id));
        return {
          items: await pageSummaries(
            cx,
            found.items.flatMap((thread) => {
              const pull = pulls.get(thread.id);
              return pull ? [{ thread, pull }] : [];
            }),
          ),
          nextCursor: found.nextCursor,
          counts,
        };
      }),
    )
    .handle(
      "propose",
      repoOp(async (cx, { payload }) => {
        const { repository } = cx.repo;
        const head = payload.headRepository
          ? await headRepository(cx, payload.headRepository)
          : cx.repo;
        const sameRepository = head.repository.id === repository.id;
        const baseRef = payload.base ?? repository.defaultBranch;
        if (sameRepository && baseRef === payload.head) {
          throw unprocessable("The base and the head are the same branch", "no_commits_between");
        }
        await branchOr422(cx.git, baseRef);
        await branchOr422(sameRepository ? cx.git : cx.reader(locatorOf(head)), payload.head);
        if (await openPageOfHead(repository.id, head.repository.id, payload.head)) {
          throw conflict("This branch already has an open page", "branch_page_exists");
        }
        const comparison = await cx.git.compare({
          base: baseRef,
          head: payload.head,
          headRepositoryId: sameRepository ? undefined : head.repository.id,
        });
        if (comparison.ahead === 0) {
          throw unprocessable("There is nothing to merge between them", "no_commits_between");
        }
        const title = payload.title ?? titleOf(payload.head, null);
        const triage = canTriage(cx);
        const created = await createPullRequest({
          repositoryId: repository.id,
          title,
          body: payload.body ?? "",
          authorUserId: cx.userId,
          labelIds:
            triage && payload.labels ? await labelIdsFor(repository.id, payload.labels) : [],
          assigneeUserIds: triage && payload.assignees ? await userIdsFor(payload.assignees) : [],
          milestoneId:
            triage && payload.milestone !== undefined
              ? await milestoneIdFor(repository.id, payload.milestone)
              : null,
          baseRef,
          headRepositoryId: head.repository.id,
          headRef: payload.head,
          headOid: comparison.head.commitOid,
          baseOid: comparison.base.commitOid,
          mergeBaseOid: comparison.mergeBaseOid,
          draft: payload.draft ?? false,
          commitsCount: comparison.ahead,
          additions: comparison.stats.additions,
          deletions: comparison.stats.deletions,
          changedFiles: comparison.stats.filesChanged,
        });
        if (comparison.mergeable !== null) {
          await setMergeable(created.pull.issueId, {
            state: comparison.mergeable ? "clean" : "conflicting",
            headOid: created.pull.headOid,
            baseOid: created.pull.baseOid,
            conflictFiles: [],
          });
        }
        // The pushes the branch has had so far are this page's versions.
        await linkVersionsToPull(head.repository.id, payload.head, created.pull.issueId);
        // CI fetches the head through this ref, a fork's included.
        await cx.git.setPullRef({
          number: created.thread.number,
          headRepositoryId: head.repository.id,
          oid: created.pull.headOid,
        });
        await noteMentions(created.thread, `${title}\n${payload.body ?? ""}`, cx.userId);
        announce(cx, created, "opened", head);
        return detail(cx, created);
      }),
    )
    .handle(
      "locate",
      repoOp(async (cx, { params }) => {
        const page = await pageByNumber(cx.repo.repository.id, params.number);
        if (!page) throw notFound("No such branch page");
        return { key: await pageKey(page) };
      }),
    )
    .handle(
      "get",
      repoOp(async (cx, { params }) => pageDetail(cx, await pageOrOpen(cx, params.branch))),
    )
    .handle(
      "update",
      repoOp(async (cx, { params, payload }) => {
        const found = await pageOr404(cx, params.branch);
        const { thread, pull } = found;
        const editsText =
          payload.title !== undefined || payload.body !== undefined || payload.base !== undefined;
        if (editsText && !isAuthor(cx, thread) && !accessAtLeast(cx.access, "write")) {
          throw forbidden("Only its author or someone with write access can edit this");
        }
        if (hasTriageEdit(payload) && !canTriage(cx)) {
          throw forbidden("Labels, assignees and milestones need triage access");
        }
        await applyText(cx, thread, payload);
        if (payload.base !== undefined && payload.base !== pull.baseRef) {
          if (thread.state !== "open")
            throw unprocessable("Only an open branch page can be retargeted");
          if (pull.headRepositoryId === cx.repo.repository.id && payload.base === pull.headRef) {
            throw unprocessable("The base and the head are the same branch", "no_commits_between");
          }
          const base = await branchOr422(cx.git, payload.base);
          await updatePullRequest(pull.issueId, {
            baseRef: payload.base,
            baseOid: base.commit.oid,
          });
          await addTimelineEvent(db, {
            issueId: thread.id,
            repositoryId: thread.repositoryId,
            actorUserId: cx.userId,
            type: "base_changed",
            payload: { from: pull.baseRef, to: payload.base },
          });
        }
        await applyTriage(cx, thread, payload);
        return detail(cx, found);
      }),
    )
    .handle(
      "close",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        const { thread, pull } = found;
        if (!isAuthor(cx, thread) && !canTriage(cx)) {
          throw forbidden("Only its author or a maintainer can close this");
        }
        if (pull.mergedAt) throw unprocessable("This branch has been merged", "already_merged");
        await applyState(thread, "closed", { userId: cx.userId });
        return detail(cx, found);
      }),
    )
    .handle(
      "reopen",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        const { thread, pull } = found;
        if (!isAuthor(cx, thread) && !canTriage(cx)) {
          throw forbidden("Only its author or a maintainer can reopen this");
        }
        if (pull.mergedAt) throw unprocessable("This branch has been merged", "already_merged");
        if (thread.state === "open") return detail(cx, found);
        const head = await headRepositoryOf(cx, pull.headRepositoryId);
        if (!head) throw unprocessable("The repository it came from is gone", "ref_not_found");
        // A fork made private since stays out of a base its readers could not see it from.
        if (!mayProposeTo(cx.repo, head.repo)) {
          throw unprocessable("The repository it came from is private now", "ref_not_found");
        }
        const branch = await branchOr422(cx.reader(locatorOf(head.repo)), pull.headRef);
        if (await openPageOfHead(cx.repo.repository.id, head.repo.repository.id, pull.headRef)) {
          throw unprocessable("This branch has another open page", "branch_page_exists");
        }
        await syncPullRequest(pull.issueId, { headOid: branch.commit.oid, headRefExists: true });
        await applyState(thread, "open", { userId: cx.userId });
        const reopened = await getPullRequest(cx.repo.repository.id, thread.number);
        if (!reopened) throw notFound("No such branch page");
        await cx.git.setPullRef({
          number: thread.number,
          headRepositoryId: head.repo.repository.id,
          oid: reopened.pull.headOid,
        });
        announce(cx, reopened, "reopened", head.repo);
        return pageDetail(cx, reopened);
      }),
    )
    .handle(
      "setDraft",
      repoOp(async (cx, { params, payload }) => {
        const found = await pageOr404(cx, params.branch);
        const { thread, pull } = found;
        if (!isAuthor(cx, thread) && !accessAtLeast(cx.access, "write")) {
          throw forbidden("Only its author or someone with write access can change this");
        }
        if (thread.state !== "open") throw unprocessable("This branch page is not open");
        if (pull.draft !== payload.draft) {
          await updatePullRequest(pull.issueId, { draft: payload.draft });
          await addTimelineEvent(db, {
            issueId: thread.id,
            repositoryId: thread.repositoryId,
            actorUserId: cx.userId,
            type: payload.draft ? "converted_to_draft" : "ready_for_review",
          });
        }
        return detail(cx, found);
      }),
    )
    .handle(
      "files",
      repoOp(async (cx, { params, query }) => {
        const found = await pageOr404(cx, params.branch);
        const { pull } = found;
        return cx.git.compareDiff(
          {
            base: query.since ?? pull.mergeBaseOid ?? pull.baseOid,
            head: pull.headOid,
            headRepositoryId: headInput(cx, found),
          },
          {
            cursor: query.cursor,
            limit: pageSize(query.limit),
            path: query.path,
            context: query.context,
            whitespace: query.whitespace,
          },
        );
      }),
    )
    .handle(
      "commits",
      repoOp(async (cx, { params, query }) => {
        const found = await pageOr404(cx, params.branch);
        const { pull } = found;
        const commits = await cx.git.commitsBetween(
          {
            base: pull.mergeBaseOid ?? pull.baseOid,
            head: pull.headOid,
            headRepositoryId: headInput(cx, found),
          },
          { cursor: query.cursor, limit: pageSize(query.limit) },
        );
        const decorate = await commitDecorator(cx.repo.repository.id, commits.items);
        return { items: commits.items.map(decorate), nextCursor: commits.nextCursor };
      }),
    )
    .handle(
      "mergeability",
      repoOp(
        async (cx, { params }) =>
          (await mergeabilityDetail(cx, await pageOr404(cx, params.branch))).mergeability,
      ),
    )
    .handle(
      "merge",
      repoOp(async (cx, { params, payload }) => {
        const found = await pageOr404(cx, params.branch);
        const { thread, pull } = found;
        const { repository } = cx.repo;
        if (payload.expectedHeadOid !== undefined && payload.expectedHeadOid !== pull.headOid) {
          throw conflict("The head has moved since you looked", "head_moved");
        }
        const { mergeability } = await mergeabilityDetail(cx, found);
        if (!mergeability.allowedMethods.includes(payload.method)) {
          throw unprocessable(
            "That merge method is switched off for this repository",
            "merge_method_not_allowed",
          );
        }
        if (payload.bypass === true && !mergeability.canBypass) {
          throw forbidden("This branch's protection cannot be bypassed", "protected_branch");
        }
        const blocker = mergeability.blockers.find(
          (candidate) => !(payload.bypass === true && BYPASSABLE.has(candidate.code)),
        );
        if (blocker) throw unprocessable(blocker.message, BLOCKER_CODES[blocker.code]);

        const committer = await identityOf(cx);
        const outcome = await cx.git.merge({
          baseRef: pull.baseRef,
          headRepositoryId: pull.headRepositoryId ?? repository.id,
          headOid: pull.headOid,
          method: payload.method,
          title:
            payload.commitTitle ??
            (payload.method === "squash" ? thread.title : await mergeTitleOf(cx, found)),
          message:
            payload.commitMessage ?? (payload.method === "squash" ? thread.body : thread.title),
          committer,
          actor: principalActor(cx.principal),
        });
        if (!outcome.merged) {
          if (outcome.reason === "conflicts") {
            await setMergeable(pull.issueId, {
              state: "conflicting",
              headOid: pull.headOid,
              baseOid: pull.baseOid,
              conflictFiles: outcome.conflictFiles,
            });
            throw unprocessable("The branch has conflicts with the base branch", "merge_conflict");
          }
          throw conflict("The base branch moved; try again", "head_moved");
        }

        // The refs have moved. From here on the merge is recorded, never undone.
        if (
          await markMerged(pull.issueId, {
            commitOid: outcome.commitOid,
            method: payload.method,
            byUserId: cx.userId,
          })
        ) {
          await addTimelineEvent(db, {
            issueId: thread.id,
            repositoryId: thread.repositoryId,
            actorUserId: cx.userId,
            type: "merged",
            payload: {
              commitOid: outcome.commitOid,
              mergeMethod: payload.method,
              ref: pull.baseRef,
            },
          });
          // Merged: the branch's versions are kept thirty days from now.
          if (pull.headRepositoryId !== null) {
            await markBranchForPruning(pull.headRepositoryId, pull.headRef, new Date());
          }
        }

        let branchDeleted = false;
        if (payload.deleteBranch ?? repository.deleteBranchOnMerge) {
          const head = await headRepositoryOf(cx, pull.headRepositoryId);
          if (
            head &&
            accessAtLeast(head.access, "write") &&
            pull.headRef !== head.repo.repository.defaultBranch &&
            mayDelete(await branchProtection(head.repo.repository.id, pull.headRef), head.access)
          ) {
            try {
              await cx.reader(locatorOf(head.repo)).deleteBranch({
                name: pull.headRef,
                expectedOid: pull.headOid,
                actor: principalActor(cx.principal),
              });
              branchDeleted = true;
              await syncPullRequest(pull.issueId, { headRefExists: false });
              await addTimelineEvent(db, {
                issueId: thread.id,
                repositoryId: thread.repositoryId,
                actorUserId: cx.userId,
                type: "head_branch_deleted",
                payload: { ref: pull.headRef },
              });
            } catch (error) {
              // The merge stands whether or not the branch could be removed.
              if (!(error instanceof RepoReaderError)) throw error;
            }
          }
        }
        return {
          merged: true as const,
          commitOid: outcome.commitOid,
          method: payload.method,
          branchDeleted,
        };
      }),
    )
    .handle(
      "updateBranch",
      repoOp(async (cx, { params, payload }) => {
        const found = await pageOr404(cx, params.branch);
        const { thread, pull } = found;
        if (thread.state !== "open") throw unprocessable("This branch page is not open");
        const head = await headRepositoryOf(cx, pull.headRepositoryId);
        if (!head || !pull.headRefExists) {
          throw unprocessable("The head branch is gone", "ref_not_found");
        }
        if (!accessAtLeast(head.access, "write")) {
          throw forbidden("This needs write access to the head repository");
        }
        // Updating copies the base's commits into the head: not from a private base into a fork more people read.
        if (!mayProposeTo(head.repo, cx.repo)) {
          throw unprocessable("This repository's commits cannot go to a fork more people can read");
        }
        const method = payload.method ?? "merge";
        const protection = await branchProtection(head.repo.repository.id, pull.headRef);
        if (method === "rebase" && protection && !protection.allowForcePush) {
          throw unprocessable("The head branch does not allow force pushes", "protected_branch");
        }
        const outcome = await cx.reader(locatorOf(head.repo)).updateBranch({
          headRef: pull.headRef,
          expectedHeadOid: payload.expectedHeadOid,
          baseRepositoryId: cx.repo.repository.id,
          baseRef: pull.baseRef,
          method,
          committer: await identityOf(cx),
          actor: principalActor(cx.principal),
        });
        if (!outcome.updated && outcome.reason === "conflicts") {
          throw unprocessable("The branch has conflicts with the base branch", "merge_conflict");
        }
        // The push event the update sends synchronises the page.
        return { headOid: outcome.headOid };
      }),
    )
    .handle(
      "restoreBranch",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        const { thread, pull } = found;
        const head = await headRepositoryOf(cx, pull.headRepositoryId);
        if (!head) throw unprocessable("The repository it came from is gone", "ref_not_found");
        if (!accessAtLeast(head.access, "write")) {
          throw forbidden("This needs write access to the head repository");
        }
        const branch = await cx.reader(locatorOf(head.repo)).createBranch({
          name: pull.headRef,
          from: pull.headOid,
          actor: principalActor(cx.principal),
        });
        await syncPullRequest(pull.issueId, { headRefExists: true });
        await addTimelineEvent(db, {
          issueId: thread.id,
          repositoryId: thread.repositoryId,
          actorUserId: cx.userId,
          type: "head_branch_restored",
          payload: { ref: pull.headRef },
        });
        return { ref: pull.headRef, oid: branch.commit.oid };
      }),
    )
    .handle(
      "listReviews",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        const [reviews, comments] = await Promise.all([
          listReviews(found.pull.issueId, cx.userId),
          listReviewComments(found.pull.issueId, cx.userId),
        ]);
        return { reviews: await reviewViews(cx, found, reviews, comments) };
      }),
    )
    .handle(
      "createReview",
      repoOp(async (cx, { params, payload }) => {
        const found = await pageOr404(cx, params.branch);
        const { thread, pull } = found;
        const userId = cx.userId!;
        requireOpenForReview(cx, found);
        const verdict = payload.event === "approve" || payload.event === "request_changes";
        if (verdict && thread.authorUserId === userId) {
          throw unprocessable("You cannot approve or request changes on your own branch");
        }
        if (verdict && thread.state !== "open") {
          throw unprocessable("This branch page is not open");
        }
        const drafts = payload.comments ?? [];
        if (payload.event === "comment" && drafts.length === 0 && !payload.body) {
          throw badRequest("A review needs a comment");
        }
        // Every anchor is checked before anything is written.
        const hunks: string[] = [];
        for (const draft of drafts) hunks.push(await anchorHunk(cx, found, draft));
        const commitOid = payload.commitOid ?? pull.headOid;
        const versionNumber = await currentVersion(found);
        // Adding to a pending review reuses it: a person has one at a time.
        const pending = payload.event ? null : await getPendingReview(pull.issueId, userId);
        const review = await db.transaction(async (tx) => {
          const row =
            pending ??
            (await createReview(tx, {
              pullRequestId: pull.issueId,
              repositoryId: pull.repositoryId,
              authorUserId: userId,
              state: payload.event ? REVIEW_STATES[payload.event] : "pending",
              body: payload.body ?? "",
              commitOid,
            }));
          for (const [index, draft] of drafts.entries()) {
            await addReviewComment(tx, {
              pullRequestId: pull.issueId,
              reviewId: row.id,
              repositoryId: pull.repositoryId,
              authorUserId: userId,
              body: draft.body,
              path: draft.path,
              side: draft.side,
              line: draft.line,
              startLine: draft.startLine ?? null,
              startSide: draft.startSide ?? null,
              commitOid,
              diffHunk: hunks[index] ?? null,
              versionNumber,
            });
          }
          return row;
        });
        return reviewOf(cx, found, review);
      }),
    )
    .handle(
      "submitReview",
      repoOp(async (cx, { params, payload }) => {
        const found = await pageOr404(cx, params.branch);
        const review = await getReview(found.pull.issueId, params.reviewId);
        // Somebody else's pending review does not exist, as far as the caller can tell.
        if (!review || review.authorUserId !== cx.userId) throw notFound("No such review");
        const verdict = payload.event !== "comment";
        if (verdict && found.thread.authorUserId === cx.userId) {
          throw unprocessable("You cannot approve or request changes on your own branch");
        }
        if (verdict && found.thread.state !== "open") {
          throw unprocessable("This branch page is not open");
        }
        const submitted = await submitReview(review.id, {
          state: REVIEW_STATES[payload.event],
          ...(payload.body !== undefined ? { body: payload.body } : {}),
          commitOid: found.pull.headOid,
        });
        if (!submitted) throw unprocessable("This review has already been submitted");
        return reviewOf(cx, found, submitted);
      }),
    )
    .handle(
      "discardReview",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        const review = await getReview(found.pull.issueId, params.reviewId);
        if (!review || review.authorUserId !== cx.userId) throw notFound("No such review");
        if (!(await deletePendingReview(review.id))) {
          throw unprocessable("Only a pending review can be discarded");
        }
        return ok;
      }),
    )
    .handle(
      "dismissReview",
      repoOp(async (cx, { params, payload }) => {
        const found = await pageOr404(cx, params.branch);
        const review = await getReview(found.pull.issueId, params.reviewId);
        if (!review || review.state === "pending") throw notFound("No such review");
        const dismissed = await dismissReview(review.id, cx.userId, payload.reason);
        if (!dismissed) {
          throw unprocessable("Only an approval or a request for changes can be dismissed");
        }
        await addTimelineEvent(db, {
          issueId: found.thread.id,
          repositoryId: found.thread.repositoryId,
          actorUserId: cx.userId,
          type: "review_dismissed",
          payload: { reviewId: review.id, reason: payload.reason },
        });
        return reviewOf(cx, found, dismissed);
      }),
    )
    .handle(
      "listThreads",
      repoOp(async (cx, { params }) => ({
        threads: await threadsOf(cx, await pageOr404(cx, params.branch)),
      })),
    )
    .handle(
      "createReviewComment",
      repoOp(async (cx, { params, payload }) => {
        const found = await pageOr404(cx, params.branch);
        const { pull } = found;
        const userId = cx.userId!;
        requireOpenForReview(cx, found);

        let anchor: Anchor & { readonly rootId: string | null; readonly hunk: string | null };
        if (payload.inReplyTo !== undefined) {
          const visible = await listReviewComments(pull.issueId, userId);
          const target = visible.find((comment) => comment.id === payload.inReplyTo);
          const root = target
            ? visible.find((comment) => comment.id === (target.inReplyToId ?? target.id))
            : undefined;
          if (!root) throw unprocessable("There is no such comment to reply to");
          anchor = {
            rootId: root.id,
            path: root.path,
            side: root.side,
            line: root.originalLine,
            startLine: root.originalStartLine ?? undefined,
            startSide: root.startSide ?? undefined,
            hunk: null,
          };
        } else {
          if (
            payload.path === undefined ||
            payload.line === undefined ||
            payload.side === undefined
          ) {
            throw badRequest("A new thread needs path, line and side");
          }
          const placed = {
            path: payload.path,
            line: payload.line,
            side: payload.side,
            startLine: payload.startLine,
            startSide: payload.startSide,
          };
          anchor = { ...placed, rootId: null, hunk: await anchorHunk(cx, found, placed) };
        }

        const commitOid = payload.commitOid ?? pull.headOid;
        const versionNumber = await currentVersion(found);
        const pending =
          payload.pending === true ? await getPendingReview(pull.issueId, userId) : null;
        const created = await db.transaction(async (tx) => {
          // A comment on its own is a review of one comment, submitted at once.
          const review =
            pending ??
            (await createReview(tx, {
              pullRequestId: pull.issueId,
              repositoryId: pull.repositoryId,
              authorUserId: userId,
              state: payload.pending === true ? "pending" : "commented",
              body: "",
              commitOid,
            }));
          return addReviewComment(tx, {
            pullRequestId: pull.issueId,
            reviewId: review.id,
            repositoryId: pull.repositoryId,
            authorUserId: userId,
            body: payload.body,
            inReplyToId: anchor.rootId,
            path: anchor.path,
            side: anchor.side,
            line: anchor.line,
            startLine: anchor.startLine ?? null,
            startSide: anchor.startSide ?? null,
            commitOid,
            diffHunk: anchor.hunk,
            versionNumber,
          });
        });
        const threads = await threadsOf(cx, found);
        const thread = threads.find((item) => item.id === (anchor.rootId ?? created.id));
        const comment = thread?.comments.find((item) => item.id === created.id);
        if (!thread || !comment) throw notFound("No such comment");
        return { thread, comment };
      }),
    )
    .handle(
      "updateReviewComment",
      repoOp(async (cx, { params, payload }) => {
        const comment = await visibleReviewComment(cx, params.commentId);
        if (!mayChangeOwn(cx, comment.authorUserId)) {
          throw forbidden("Only its author or a maintainer can edit this comment");
        }
        const edited = (await editReviewComment(comment.id, payload.body)) ?? comment;
        return reviewCommentViewOf(cx, { ...edited, pending: comment.pending });
      }),
    )
    .handle(
      "deleteReviewComment",
      repoOp(async (cx, { params }) => {
        const comment = await visibleReviewComment(cx, params.commentId);
        if (!mayChangeOwn(cx, comment.authorUserId)) {
          throw forbidden("Only its author or a maintainer can delete this comment");
        }
        await deleteReviewComment(comment.id);
        return ok;
      }),
    )
    .handle(
      "resolveThread",
      repoOp((cx, { params }) => setResolved(cx, params.threadId, true)),
    )
    .handle(
      "unresolveThread",
      repoOp((cx, { params }) => setResolved(cx, params.threadId, false)),
    ),
);

/** A review comment the caller may see: never one of somebody else's pending review. */
const visibleReviewComment = async (cx: RepoCx, commentId: string) => {
  const comment = await getReviewComment(cx.repo.repository.id, commentId);
  const review = comment
    ? await getReviewInRepository(cx.repo.repository.id, comment.reviewId)
    : null;
  if (!comment || !review) throw notFound("No such comment");
  const pending = review.state === "pending";
  if (pending && review.authorUserId !== cx.userId) throw notFound("No such comment");
  return { ...comment, pending };
};

const setResolved = async (cx: RepoCx, threadId: string, resolved: boolean) => {
  const root = await visibleReviewComment(cx, threadId);
  const found =
    root.inReplyToId === null ? await getPullRequestByIssueId(root.pullRequestId) : null;
  if (!found) throw notFound("No such thread");
  if (!mayResolve(cx, found, root.authorUserId)) {
    throw forbidden("Only the author, the thread's starter or a maintainer can do this");
  }
  if (resolved !== (root.resolvedAt !== null)) {
    if (resolved) await setThreadResolved(root.id, cx.userId);
    else await setThreadResolved(root.id, null);
  }
  const thread = (await threadsOf(cx, found)).find((item) => item.id === root.id);
  if (!thread) throw notFound("No such thread");
  return thread;
};
