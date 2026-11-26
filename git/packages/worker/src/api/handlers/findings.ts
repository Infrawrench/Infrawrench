/**
 * Findings: what review agents found on a version, and the runs that found
 * them (`git_review_findings`, `git_review_runs`, `git_merge_overrides`).
 *
 * Not built yet: every endpoint answers 503 `not_implemented`. What is
 * already in place for whoever builds it:
 *
 * - **The merge block is live.** `views/pulls.ts` `mergeabilityDetail` lists
 *   the `must_fix_findings` blocker while the repository holds merges on
 *   them and an open must-fix finding is not covered by an override
 *   (`db/review.ts` `findingsCount`, `overriddenFindingIds`). `override` only
 *   has to insert the `git_merge_overrides` row.
 * - A dismissal is remembered by `fingerprint` (unique per pull request):
 *   `report` upserts on it and leaves a dismissed finding dismissed.
 * - Tallies for the branch page and the inbox come from `findingsCount`.
 * - Write handlers with `repoOp` (`../context.ts`), as every other group does.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { GitApi, notImplemented } from "@infrawrench/git-contract";

/** Until an endpoint is built it answers the contract's 503 `not_implemented`, after its gates have run. */
const unbuilt = (what: string) => Effect.die(notImplemented(what));

export const FindingsHandlers = HttpApiBuilder.group(GitApi, "findings", (handlers) =>
  handlers
    .handle("list", () => unbuilt("Review findings"))
    .handle("report", () => unbuilt("Reporting findings"))
    .handle("dismiss", () => unbuilt("Dismissing a finding"))
    .handle("reopen", () => unbuilt("Reopening a finding"))
    .handle("override", () => unbuilt("Overriding the merge block"))
    .handle("listRuns", () => unbuilt("Review runs"))
    .handle("getRun", () => unbuilt("Review runs"))
    .handle("requestRun", () => unbuilt("Requesting a review run"))
    .handle("updateRun", () => unbuilt("Updating a review run")),
);
