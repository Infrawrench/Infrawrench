/**
 * Branch pages that were merged outside the merge button: by a squash or a
 * merge made somewhere else and pushed, a cherry-pick, a fast-forward. The
 * forge tells by the content (`landed` on the repository's Durable Object,
 * `landedIn` in git-ops), not by a message or a commit id, so it does not
 * matter how the change got there.
 *
 * Two moments look:
 *
 * - **A push moves a base branch.** Every open page on it whose head is in
 *   this repository and whose changes the base now has is recorded as merged
 *   by whoever pushed, and its branch is deleted: the branch has nothing left
 *   to propose, and a branch left behind keeps a stale page in every list.
 *   It is deleted only when it is still where it was measured, it is not the
 *   default branch, and no protection rule keeps it.
 * - **A push deletes a page's branch.** The page is recorded as merged when
 *   the base has its changes, and closed when it does not, so deleting a
 *   branch does not leave its page open. Its branch can be restored and the
 *   page reopened, as with any closed page. When the storage does not answer
 *   the page stays open, and the next push to its base settles it: the first
 *   moment looks at open pages whose branch is gone too.
 *
 * Both are safe to repeat: only open pages are looked at, and `markMerged`
 * and `applyState` each record a page's end once.
 */
import { applyState } from "../api/thread-edits";
import { locatorOf } from "../api/context";
import { mayProposeTo } from "../api/repos";
import { db } from "../db/client";
import { listProtectedBranches, protectionFor } from "../db/policy";
import { type PullRequestWithThread, markMerged, syncPullRequest } from "../db/pulls";
import { getRepositoryById } from "../db/repositories";
import { markBranchForPruning } from "../db/review";
import { addTimelineEvent } from "../db/threads";
import { describeError } from "../http/log";
import {
  MAX_LANDED_HEADS,
  type ReaderLanded,
  RepoReaderError,
  isUnavailable,
} from "../repo/reader";
import type { PushContext } from "./consumer";

type Landing = "contained" | "applied";

/**
 * When a page's timeline says something happened: the push's time, a
 * millisecond apart for each step after the first, since entries written in
 * the same millisecond would otherwise come back in either order.
 */
const stepOf = (cx: PushContext, step: number): Date => new Date(cx.event.at + step);

/** How a page landed, as the merge method it is recorded with. */
const methodOf = (landing: Landing): "merge" | "squash" =>
  landing === "contained" ? "merge" : "squash";

/**
 * Whether a page ever had something of its own. A branch with no commits
 * ahead of its base is an ancestor of it, which `landed` answers as
 * `contained`; that is not a merge.
 */
const hadCommits = ({ pull }: PullRequestWithThread): boolean => pull.commitsCount > 0;

/** Records a page as merged as `commitOid`. False when it already was, or was closed. */
const recordMerged = async (
  cx: PushContext,
  { thread, pull }: PullRequestWithThread,
  { landing, commitOid }: { readonly landing: Landing; readonly commitOid: string },
): Promise<boolean> => {
  if (
    !(await markMerged(pull.issueId, {
      commitOid,
      method: methodOf(landing),
      byUserId: cx.userId,
    }))
  ) {
    return false;
  }
  await addTimelineEvent(db, {
    issueId: thread.id,
    repositoryId: thread.repositoryId,
    actorUserId: cx.userId,
    type: "merged",
    payload: { commitOid, mergeMethod: methodOf(landing), ref: pull.baseRef },
    at: stepOf(cx, 0),
  });
  // Merged: the branch's versions are kept thirty days from now, as after the merge button.
  if (pull.headRepositoryId !== null) {
    await markBranchForPruning(pull.headRepositoryId, pull.headRef, new Date(cx.event.at));
  }
  return true;
};

/** Deletes a merged page's branch, when it is this repository's and nothing keeps it. */
const deleteMergedBranch = async (
  cx: PushContext,
  { thread, pull }: PullRequestWithThread,
  protections: Awaited<ReturnType<typeof listProtectedBranches>>,
): Promise<void> => {
  const { repository } = cx.repo;
  if (pull.headRepositoryId !== repository.id || !pull.headRefExists) return;
  if (pull.headRef === repository.defaultBranch) return;
  const protection = protectionFor(protections, pull.headRef);
  if (protection && !protection.allowDeletion) return;
  try {
    // Only where it was measured: a branch pushed to since keeps its new commits.
    await cx.reader.deleteBranch({
      name: pull.headRef,
      expectedOid: pull.headOid,
      actor: cx.event.actor,
    });
  } catch (error) {
    if (error instanceof RepoReaderError) return;
    throw error;
  }
  await syncPullRequest(pull.issueId, { headRefExists: false });
  await addTimelineEvent(db, {
    issueId: thread.id,
    repositoryId: thread.repositoryId,
    actorUserId: cx.userId,
    type: "head_branch_deleted",
    payload: { ref: pull.headRef },
    at: stepOf(cx, 1),
  });
};

/**
 * A push moved `branch`: the open pages based on it whose
 * changes it now has are merged, as the commit that brought them in, and
 * their branches deleted. `pulls` are the open pages whose head or base is
 * the branch.
 */
export const settleBasePush = async (
  cx: PushContext,
  branch: string,
  pulls: readonly PullRequestWithThread[],
): Promise<void> => {
  const { repository } = cx.repo;
  const candidates = pulls
    .filter(
      (found) =>
        found.pull.repositoryId === repository.id &&
        found.pull.baseRef === branch &&
        // A fork's branch is its owner's to delete, and its page is left to them.
        found.pull.headRepositoryId === repository.id &&
        found.pull.headRef !== branch &&
        found.pull.mergedAt === null &&
        hadCommits(found),
    )
    // The most recently active first, when there are more than one call measures.
    .sort((a, b) => b.pull.updatedAt.getTime() - a.pull.updatedAt.getTime())
    .slice(0, MAX_LANDED_HEADS);
  if (candidates.length === 0) return;

  let answer: ReaderLanded;
  try {
    answer = await cx.reader.landed({
      baseRef: branch,
      heads: candidates.map(({ pull }) => pull.headOid),
    });
  } catch (error) {
    // The storage not answering degrades this step; the next push to the base looks again.
    if (!(error instanceof RepoReaderError)) throw error;
    console.error(`[git] landed pages not measured: ${describeError(error)}`);
    return;
  }

  let protections: Awaited<ReturnType<typeof listProtectedBranches>> | null = null;
  for (const [index, found] of candidates.entries()) {
    const landing = answer.heads[index];
    if (!landing) continue;
    if (!(await recordMerged(cx, found, landing))) continue;
    protections ??= await listProtectedBranches(repository.id);
    await deleteMergedBranch(cx, found, protections);
  }
};

/**
 * A push deleted the head branch of `found`, an open page: merged when its
 * base has its changes, closed otherwise. `noteDeleted` writes the page's
 * "branch deleted" entry at the time it is given: after the merge and before
 * the close, the order they happened in.
 */
export const settleDeletedHead = async (
  cx: PushContext,
  found: PullRequestWithThread,
  noteDeleted: (at: Date) => Promise<void>,
): Promise<void> => {
  const { thread, pull } = found;
  if (hadCommits(found)) {
    const base =
      pull.repositoryId === cx.repo.repository.id
        ? cx.repo
        : await getRepositoryById(pull.repositoryId);
    // A fork made private since stays out of a base its readers could not see it from.
    if (base && mayProposeTo(base, cx.repo)) {
      const reader = base === cx.repo ? cx.reader : cx.readers(cx.env, locatorOf(base));
      let answer: ReaderLanded | null = null;
      try {
        answer = await reader.landed({ baseRef: pull.baseRef, heads: [pull.headOid] });
      } catch (error) {
        if (!(error instanceof RepoReaderError)) throw error;
        // The storage away: left open, for the next push to the base to settle.
        if (isUnavailable(error)) {
          console.error(`[git] a deleted branch's page not measured: ${describeError(error)}`);
          await noteDeleted(stepOf(cx, 0));
          return;
        }
        // Anything else (the base gone, a head over the limits) is not merged.
      }
      const landing = answer?.heads[0];
      if (landing) {
        await recordMerged(cx, found, landing);
        await noteDeleted(stepOf(cx, 1));
        return;
      }
    }
  }
  await noteDeleted(stepOf(cx, 0));
  await applyState(thread, "closed", { userId: cx.userId, at: stepOf(cx, 1) });
};
