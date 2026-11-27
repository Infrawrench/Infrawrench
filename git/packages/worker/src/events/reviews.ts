/**
 * Starting the review agents on a new version: when a push has made a
 * version of a branch that has an open pull request, and the repository has
 * review agents on, one run is queued for it.
 *
 * - **One run a version.** A second delivery of the push finds the version's
 *   run and queues nothing (`queuePushRun`).
 * - **The newest version wins.** A run an older version queued that nothing
 *   has started yet is removed; one that is running stops itself between
 *   reviewers when it sees it has been overtaken (`review/runner.ts`).
 * - **Not for a fork's pull request.** The run is billed to the organisation
 *   that owns the base repository, and anyone can push to their fork of a
 *   public repository. Someone with `write` there asks for a fork's review by
 *   hand (`findings.requestRun`), as CI waits for approval before it runs a
 *   fork's code.
 * - **Not where nobody can be billed**: a person's own namespace that is
 *   connected to no organisation, or a deployment with no model configured.
 */
import { queuePushRun } from "../db/findings";
import type { PullRequestWithThread } from "../db/pulls";
import { getReviewSettings, versionsForPull } from "../db/review";
import { describeError } from "../http/log";
import { isForgeReviewer } from "../review/findings";
import { reviewAvailability } from "../review/policy";
import { enqueueReviewRun } from "../review/queue";
import type { PushContext } from "./consumer";

/** Queue the review of a pull request's new head. Answers the run's id, or null when none was queued. */
export const queueReviewForVersion = async (
  cx: PushContext,
  { thread, pull }: PullRequestWithThread,
  newOid: string,
): Promise<string | null> => {
  const { repository } = cx.repo;
  if (thread.state !== "open") return null;
  // The head is this repository's branch; a pull request anywhere else is a fork's.
  if (pull.repositoryId !== repository.id || pull.headRepositoryId !== repository.id) return null;
  if (!reviewAvailability(cx.repo).available) return null;
  const settings = await getReviewSettings(repository.id);
  if (!settings.reviewAgentsEnabled) return null;
  const reviewerKinds = [...new Set(settings.reviewerKinds.filter(isForgeReviewer))];
  if (reviewerKinds.length === 0) return null;
  const version = (await versionsForPull(pull)).at(-1);
  // Not copied (the storage was away), or the branch has moved on: that push's event does it.
  if (!version || version.tipOid !== newOid) return null;
  const run = await queuePushRun({
    repositoryId: repository.id,
    pullRequestId: pull.issueId,
    version,
    reviewerKinds,
    requestedByUserId: cx.userId,
  });
  if (!run) return null;
  try {
    await enqueueReviewRun(cx.env, run.id);
  } catch (error) {
    // Queued all the same: the hourly sweep sends what a failed send left behind.
    console.error(`[git] could not send review run ${run.id}: ${describeError(error)}`);
  }
  return run.id;
};
