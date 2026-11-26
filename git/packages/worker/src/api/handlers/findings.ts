/**
 * Findings: what review agents found on a version, the runs that found them,
 * and the overrides that let a merge past them (`git_review_findings`,
 * `git_review_runs`, `git_merge_overrides`).
 *
 * Two kinds of reviewer write here. The forge's own (`REVIEWER_KINDS`) run in
 * the review queue's consumer (`review/runner.ts`); `requestRun` queues one
 * of those runs again. A reviewer outside the forge names itself something
 * else, reports with `report`, and may keep a run of its own (`requestRun`
 * with its name, then `updateRun`). Nobody outside reports as one of the
 * forge's reviewers: a report that says it is complete marks that reviewer's
 * other findings fixed, and the merge block reads them.
 *
 * A CI job's token lists and reports and nothing else: it never dismisses,
 * overrides or asks for a run.
 */
import { HttpApiBuilder } from "effect/http-api";
import { GitApi, conflict, forbidden, notFound, unprocessable } from "@infrawrench/git-contract";
import {
  type FindingRow,
  dismissFinding,
  getFinding,
  getReviewRun,
  insertMergeOverride,
  listFindings,
  listReviewRuns,
  markUnseenFixed,
  queueManualRun,
  reopenFinding,
  updateExternalRun,
} from "../../db/findings";
import type { PullRequestWithThread } from "../../db/pulls";
import {
  type VersionRow,
  findingsCount,
  getReviewSettings,
  overriddenFindingIds,
  versionsForPull,
} from "../../db/review";
import { describeError } from "../../http/log";
import { isForgeReviewer, recordFindings } from "../../review/findings";
import { maskOptional } from "../../review/masking";
import { reviewAvailability } from "../../review/policy";
import { enqueueReviewRun } from "../../review/queue";
import { pageOr404 } from "../branch-page";
import { type RepoCx, repoOp } from "../context";
import {
  findingView,
  findingViews,
  mayDismiss,
  mergeOverrideView,
  reviewRunView,
  reviewRunViews,
} from "../views/findings";

const openPageOr422 = async (cx: RepoCx, key: string): Promise<PullRequestWithThread> => {
  const found = await pageOr404(cx, key);
  if (found.thread.state !== "open") {
    throw unprocessable("The branch page is not open");
  }
  return found;
};

const findingOr404 = async (
  found: PullRequestWithThread,
  findingId: string,
): Promise<FindingRow> => {
  const finding = await getFinding(found.pull.issueId, findingId);
  if (!finding) throw notFound("No such finding");
  return finding;
};

/** What a CI job's token may not do here. */
const refuseJob = (cx: RepoCx, what: string): void => {
  if (cx.principal.kind === "job") throw forbidden(`A CI job's token does not ${what}`);
};

/** The version a payload names, or the newest. 422 when the branch has none, or not that one. */
const versionOr422 = (
  versions: readonly VersionRow[],
  number: number | undefined,
): { readonly version: VersionRow; readonly latest: VersionRow } => {
  const latest = versions.at(-1);
  if (!latest) throw unprocessable("The branch has no version yet");
  const version =
    number === undefined ? latest : versions.find((candidate) => candidate.number === number);
  if (!version) throw unprocessable("The branch has no such version");
  return { version, latest };
};

const unique = (kinds: readonly string[]): string[] => [...new Set(kinds)];

export const FindingsHandlers = HttpApiBuilder.group(GitApi, "findings", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx, { params, query }) => {
        const found = await pageOr404(cx, params.branch);
        const [rows, tally] = await Promise.all([
          listFindings(found.pull.issueId, { version: query.version, status: query.status }),
          findingsCount(found.pull.issueId),
        ]);
        return { findings: await findingViews(cx, found.pull.issueId, rows), tally };
      }),
    )
    .handle(
      "report",
      repoOp(async (cx, { params, payload }) => {
        const found = await openPageOr422(cx, params.branch);
        const { pull } = found;
        if (isForgeReviewer(payload.reviewerKind)) {
          throw unprocessable(
            `\`${payload.reviewerKind}\` is one of the forge's own reviewers: report under another name`,
          );
        }
        const { version } = versionOr422(await versionsForPull(pull), payload.version);
        if (payload.runId !== undefined) {
          const run = await getReviewRun(pull.issueId, payload.runId);
          if (!run) throw unprocessable("The branch page has no such review run");
          if (run.reviewerKinds.some(isForgeReviewer)) {
            throw unprocessable("That run is the forge's own");
          }
        }
        const written = await recordFindings(
          {
            repositoryId: pull.repositoryId,
            pullRequestId: pull.issueId,
            version,
            runId: payload.runId ?? null,
          },
          payload.reviewerKind,
          payload.findings,
        );
        // Everything it finds on this version: what it found before and not now is fixed.
        if (payload.complete) {
          await markUnseenFixed(pull.issueId, payload.reviewerKind, version.number);
        }
        return {
          findings: await findingViews(
            cx,
            pull.issueId,
            written.map(({ row }) => row),
          ),
        };
      }),
    )
    .handle(
      "dismiss",
      repoOp(async (cx, { params, payload }) => {
        if (!mayDismiss(cx)) throw forbidden("A CI job's token does not dismiss findings");
        const found = await pageOr404(cx, params.branch);
        const finding = await findingOr404(found, params.findingId);
        const reason = payload.reason.trim();
        if (reason === "") throw unprocessable("Say why the finding is dismissed");
        const dismissed = await dismissFinding(finding.id, cx.userId, reason);
        if (!dismissed) {
          throw unprocessable(
            finding.status === "dismissed"
              ? "The finding is already dismissed"
              : "A fixed finding has nothing to dismiss",
          );
        }
        return findingView(cx, found.pull.issueId, dismissed);
      }),
    )
    .handle(
      "reopen",
      repoOp(async (cx, { params }) => {
        if (!mayDismiss(cx)) throw forbidden("A CI job's token does not reopen findings");
        const found = await pageOr404(cx, params.branch);
        const finding = await findingOr404(found, params.findingId);
        const reopened = await reopenFinding(finding.id);
        if (!reopened) throw unprocessable("The finding is not dismissed");
        return findingView(cx, found.pull.issueId, reopened);
      }),
    )
    .handle(
      "override",
      repoOp(async (cx, { params, payload }) => {
        // Recorded with who: a person, never a key or a job.
        if (cx.userId === null) throw forbidden("This needs a signed-in person");
        const found = await openPageOr422(cx, params.branch);
        const { pull } = found;
        const reason = payload.reason.trim();
        if (reason === "") throw unprocessable("Say why the merge may go ahead");
        const [open, covered] = await Promise.all([
          listFindings(pull.issueId, { status: "open" }),
          overriddenFindingIds(pull.issueId),
        ]);
        const mustFix = open.filter((finding) => finding.severity === "must_fix");
        let findingIds: string[];
        if (payload.findingIds === undefined) {
          findingIds = mustFix.filter((finding) => !covered.has(finding.id)).map(({ id }) => id);
          if (findingIds.length === 0) {
            throw unprocessable("No open must-fix finding holds this merge");
          }
        } else {
          findingIds = unique(payload.findingIds);
          const known = new Set(mustFix.map((finding) => finding.id));
          if (findingIds.length === 0 || findingIds.some((id) => !known.has(id))) {
            throw unprocessable("An override names open must-fix findings of this branch page");
          }
        }
        return mergeOverrideView(
          await insertMergeOverride({
            repositoryId: pull.repositoryId,
            pullRequestId: pull.issueId,
            userId: cx.userId,
            reason,
            findingIds,
            headOid: pull.headOid,
          }),
        );
      }),
    )
    .handle(
      "listRuns",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        return { runs: await reviewRunViews(await listReviewRuns(found.pull.issueId)) };
      }),
    )
    .handle(
      "getRun",
      repoOp(async (cx, { params }) => {
        const found = await pageOr404(cx, params.branch);
        const run = await getReviewRun(found.pull.issueId, params.runId);
        if (!run) throw notFound("No such review run");
        return reviewRunView(run);
      }),
    )
    .handle(
      "requestRun",
      repoOp(async (cx, { params, payload }) => {
        refuseJob(cx, "ask for a review run");
        const found = await openPageOr422(cx, params.branch);
        const { pull } = found;
        const settings = await getReviewSettings(cx.repo.repository.id);
        const kinds = unique(payload.reviewerKinds ?? settings.reviewerKinds);
        if (kinds.length === 0) throw unprocessable("Name a reviewer to run");
        const forge = kinds.filter(isForgeReviewer);
        if (forge.length > 0 && forge.length < kinds.length) {
          throw unprocessable("A run is the forge's reviewers or a reviewer of your own, not both");
        }
        const { version, latest } = versionOr422(await versionsForPull(pull), payload.version);
        if (forge.length > 0) {
          const availability = reviewAvailability(cx.repo);
          if (!availability.available) {
            throw unprocessable(availability.reason);
          }
          if (!settings.reviewAgentsEnabled) {
            throw unprocessable(
              "Review agents are off for this repository: an administrator turns them on in its settings",
            );
          }
          // An older version's findings would be read as the branch's.
          if (version.id !== latest.id) {
            throw unprocessable("The forge reviews the newest version");
          }
        }
        const run = await queueManualRun({
          repositoryId: pull.repositoryId,
          pullRequestId: pull.issueId,
          version,
          reviewerKinds: kinds,
          requestedByUserId: cx.userId,
        });
        if (!run) {
          throw conflict("A review of this version is already queued or running");
        }
        if (forge.length > 0) {
          try {
            await enqueueReviewRun(cx.env, run.id);
          } catch (error) {
            // Queued all the same: the hourly sweep sends what a failed send left behind.
            console.error(`[git] could not send review run ${run.id}: ${describeError(error)}`);
          }
        }
        return reviewRunView(run);
      }),
    )
    .handle(
      "updateRun",
      repoOp(async (cx, { params, payload }) => {
        const found = await pageOr404(cx, params.branch);
        const run = await getReviewRun(found.pull.issueId, params.runId);
        if (!run) throw notFound("No such review run");
        if (run.reviewerKinds.some(isForgeReviewer)) {
          throw unprocessable("The forge runs this review and reports on it itself");
        }
        const ended = run.status === "done" || run.status === "failed";
        if (ended && (payload.status === "queued" || payload.status === "running")) {
          throw unprocessable("The run has ended");
        }
        const updated = await updateExternalRun(run.id, {
          status: payload.status,
          model: payload.model,
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          costMicros:
            payload.costUsd === undefined ? undefined : Math.round(payload.costUsd * 1_000_000),
          error: payload.error === undefined ? undefined : maskOptional(payload.error),
        });
        return reviewRunView(updated ?? run);
      }),
    ),
);
