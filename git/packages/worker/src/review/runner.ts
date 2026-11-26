/**
 * One review run: the forge's reviewers over one version of a branch page.
 *
 * Called by the review queue's consumer (`./queue.ts`) with the id of a
 * `git_review_runs` row. Everything it decides it decides from the database
 * as it is now, not as it was when the run was queued, and every way out
 * leaves the row finished:
 *
 * - **Claimed by lease.** A run is taken when it is queued, or when it has
 *   been `running` longer than the lease (the invocation that held it died).
 *   A second delivery of the same message finds it finished, or held, and
 *   does nothing. So one run never runs twice at once, and none stays
 *   `running` for ever.
 * - **Skipped with a reason** when there is nothing to review or nobody to
 *   bill: the page closed, a newer version arrived, review agents
 *   were turned off, the repository is a person's own, the organisation is at
 *   its AI spend cap. The run ends `failed` with the reason as its `error`,
 *   which starts with "Skipped".
 * - **Bounded.** A deadline inside the consumer's 15 minutes, a number of
 *   model calls and a budget per reviewer (`policy.ts`).
 * - **Billed as it goes.** The organisation's AI spend pool is asked before
 *   the first model call, and what each reviewer used is written to it (and
 *   to the run) as that reviewer ends, however it ended.
 *
 * A failure of the model is the run's, recorded on it. Only the database
 * being away is thrown, after the claim is given back, so the message is
 * retried.
 */
import type { ReviewerKind } from "@infrawrench/git-contract";
import {
  AiSpendCapExceededError,
  recordWorkflowAiUsage,
  releaseAiSpendReservation,
  reserveAiSpend,
  touchAiSpendReservation,
} from "@infrawrench/server-core/billing/ai-usage";
import { locatorOf } from "../api/context";
import { mayProposeTo } from "../api/repos";
import { listTerraformRuns } from "../db/automation";
import {
  type ReviewRunRow,
  addRunUsage,
  claimReviewRun,
  finishReviewRun,
  getReviewRunById,
  listFindings,
  releaseReviewRun,
  traceEntryCount,
} from "../db/findings";
import { type PullRequestWithThread, getPullRequestByIssueId } from "../db/pulls";
import { type RepositoryWithOwner, getRepositoryById } from "../db/repositories";
import { type VersionRow, getAgentLink, getReviewSettings, versionsForPull } from "../db/review";
import type { Env } from "../env";
import type { RepoReaderFactory } from "../repo/select";
import { isForgeReviewer } from "./findings";
import type { ReviewModel } from "./model";
import { REVIEW_LIMITS, type ReviewLimits, reviewAvailability } from "./policy";
import { runReviewer } from "./reviewer";
import { type CiJobsReader, type ReviewerContext, appCiJobs } from "./tools";

export interface ReviewDeps {
  readonly env: Env;
  readonly readers: RepoReaderFactory;
  /** Built when the first reviewer is about to ask, so a skipped run needs no model. */
  readonly model: () => ReviewModel;
  readonly limits?: ReviewLimits | undefined;
  readonly ciJobs?: CiJobsReader | undefined;
  readonly now?: (() => number) | undefined;
  /** Whether Claude is configured. The deployment's own answer when left out. */
  readonly configured?: boolean | undefined;
  /** Which delivery of the run's message this is: 1 for the first. */
  readonly attempt?: number | undefined;
}

/**
 * - `done`, `failed`: the run was worked on and ended that way.
 * - `ignored`: nothing to do (finished already, gone, or not the forge's).
 * - `busy`: somebody holds it inside the lease; ask again later.
 */
export type ReviewOutcome = "done" | "failed" | "ignored" | "busy";

/** The identifier a repository's review usage carries in the organisation's AI spend (`workflow_ai_usage`). */
export const reviewUsageSource = (repositoryId: string): string => `git-review:${repositoryId}`;

export const SPEND_CAP_REACHED =
  "Skipped: the organisation has reached its monthly AI spend cap. An administrator can raise it under Settings > AI Chat in the Infrawrench app, or it resets when the month starts";

const NAMES: Readonly<Record<ReviewerKind, string>> = {
  general: "general",
  security: "security",
  tests: "tests",
  terraform: "Terraform",
  intent: "intent",
};

interface Loaded {
  readonly found: PullRequestWithThread;
  readonly base: RepositoryWithOwner;
  readonly version: VersionRow;
  readonly previous: VersionRow | null;
  readonly organizationId: string;
}

/** What the run is of, or the reason it is skipped. */
const load = async (
  run: ReviewRunRow,
  deps: ReviewDeps,
): Promise<Loaded | { readonly skipped: string }> => {
  const found = await getPullRequestByIssueId(run.pullRequestId);
  const base = found ? await getRepositoryById(found.pull.repositoryId) : null;
  if (!found || !base) return { skipped: "Skipped: the branch page is gone" };
  if (found.thread.state !== "open") {
    return { skipped: "Skipped: the branch page is no longer open" };
  }
  const versions = await versionsForPull(found.pull);
  const version = versions.find((candidate) => candidate.id === run.versionId);
  if (!version) return { skipped: "Skipped: the version is no longer kept" };
  const latest = versions.at(-1)!;
  if (latest.id !== version.id) {
    return { skipped: `Skipped: version ${latest.number} was pushed before this review started` };
  }
  const availability = reviewAvailability(base, deps.configured);
  if (!availability.available) return { skipped: `Skipped: ${availability.reason}` };
  if (!(await getReviewSettings(base.repository.id)).reviewAgentsEnabled) {
    return { skipped: "Skipped: review agents are off for this repository" };
  }
  return {
    found,
    base,
    version,
    previous: versions.find((candidate) => candidate.number === version.number - 1) ?? null,
    organizationId: availability.organizationId,
  };
};

/** The newest version's number, when it is no longer the one being reviewed. */
const overtakenBy = async (loaded: Loaded): Promise<number | null> => {
  const latest = (await versionsForPull(loaded.found.pull)).at(-1);
  return latest && latest.id !== loaded.version.id ? latest.number : null;
};

/** Reviewers with nothing to read are not asked: a plan reviewer with no plan, an intent reviewer with no ask. */
const applies = async (kind: ReviewerKind, loaded: Loaded, fork: boolean): Promise<boolean> => {
  const { thread, pull } = loaded.found;
  if (kind === "intent") return thread.body.trim() !== "";
  if (kind === "terraform") {
    if (fork) return false;
    const plans = await listTerraformRuns(pull.repositoryId, {
      pull: thread.number,
      kind: "plan",
      limit: 1,
    });
    return plans.items.length > 0;
  }
  return true;
};

const review = async (
  run: ReviewRunRow,
  loaded: Loaded,
  deps: ReviewDeps,
  limits: ReviewLimits,
  startedAt: number,
): Promise<{ readonly status: "done" | "failed"; readonly error: string | null }> => {
  const now = deps.now ?? Date.now;
  const { found, base, version, previous, organizationId } = loaded;
  const { thread, pull } = found;
  const kinds = run.reviewerKinds.filter(isForgeReviewer);

  const fork = pull.headRepositoryId !== pull.repositoryId;
  const head =
    pull.headRepositoryId === null
      ? null
      : fork
        ? await getRepositoryById(pull.headRepositoryId)
        : base;
  // The head repository keeps every version's commit; a fork that is gone, or that
  // the base's readers may no longer be shown, leaves the heads the base was given.
  const reader = deps.readers(deps.env, locatorOf(head && mayProposeTo(base, head) ? head : base));

  let reservation: string;
  try {
    reservation = await reserveAiSpend(
      organizationId,
      limits.reserveMicrosPerReviewer * kinds.length,
    );
  } catch (error) {
    if (error instanceof AiSpendCapExceededError)
      return { status: "failed", error: SPEND_CAP_REACHED };
    throw error;
  }

  const notes: string[] = [];
  let asked = 0;
  let failed = 0;
  let model: ReviewModel | undefined;
  try {
    const agent = await getAgentLink(pull.issueId);
    const traceEntries = await traceEntryCount(version.id);
    for (const kind of kinds) {
      const newer = await overtakenBy(loaded);
      if (newer !== null) {
        return {
          status: "failed",
          error:
            `Stopped: version ${newer} was pushed while this review ran. ${notes.join(" ")}`.trim(),
        };
      }
      if (!(await applies(kind, loaded, fork))) continue;
      const cx: ReviewerContext = {
        kind,
        base,
        found,
        version,
        previous,
        reader,
        fork,
        runId: run.id,
        limits,
        ciJobs: deps.ciJobs ?? appCiJobs,
      };
      const ownOpen = await listFindings(pull.issueId, { status: "open", reviewerKind: kind });
      model ??= deps.model();
      asked++;
      const result = await runReviewer(
        cx,
        model,
        {
          repository: `${base.owner.slug}/${base.repository.name}`,
          number: thread.number,
          title: thread.title,
          body: thread.body,
          baseRef: pull.baseRef,
          headRef: pull.headRef,
          version: version.number,
          previousVersion: previous?.number ?? null,
          forced: version.forced,
          stats:
            version.changedFiles === null ||
            version.additions === null ||
            version.deletions === null
              ? null
              : {
                  files: version.changedFiles,
                  additions: version.additions,
                  deletions: version.deletions,
                },
          agent: agent?.displayName ?? null,
          traceEntries,
          ownOpenFindings: ownOpen.length,
          fork,
        },
        { deadline: startedAt + limits.deadlineMs, now },
      );
      if (result.turns > 0) {
        // The organisation's pool first, then the run: what is on the run was billed.
        const costMicros = await recordWorkflowAiUsage({
          organizationId,
          workflowId: reviewUsageSource(base.repository.id),
          runId: run.id,
          model: result.model,
          usage: result.usage,
        });
        await addRunUsage(run.id, {
          model: result.model,
          inputTokens:
            result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens,
          outputTokens: result.usage.outputTokens,
          costMicros,
        });
      }
      await touchAiSpendReservation(reservation);
      if (result.outcome === "failed") {
        failed++;
        notes.push(`The ${NAMES[kind]} reviewer failed: ${result.reason}.`);
      } else if (result.outcome === "stopped") {
        notes.push(`The ${NAMES[kind]} reviewer stopped early: ${result.reason}.`);
      }
    }
  } finally {
    // A hold that outlives the run would count against the organisation until it expires.
    await releaseAiSpendReservation(reservation).catch(() => {});
  }
  const error = notes.length > 0 ? notes.join(" ") : null;
  return { status: asked > 0 && failed === asked ? "failed" : "done", error };
};

export const runReview = async (runId: string, deps: ReviewDeps): Promise<ReviewOutcome> => {
  const limits = deps.limits ?? REVIEW_LIMITS;
  const now = deps.now ?? Date.now;
  const existing = await getReviewRunById(runId);
  // Gone (superseded before it started), finished, or a reviewer's own run outside the forge.
  if (!existing || existing.status === "done" || existing.status === "failed") return "ignored";
  if (!existing.reviewerKinds.some(isForgeReviewer)) return "ignored";
  if ((deps.attempt ?? 1) > limits.maxAttempts) {
    await finishReviewRun(
      runId,
      { status: "failed", error: "The review did not finish after several tries" },
      new Date(now()),
    );
    return "failed";
  }

  const startedAt = now();
  const run = await claimReviewRun(runId, new Date(startedAt), limits.leaseMs);
  if (!run) return "busy";

  let outcome: { readonly status: "done" | "failed"; readonly error: string | null };
  try {
    const loaded = await load(run, deps);
    outcome =
      "skipped" in loaded
        ? { status: "failed", error: loaded.skipped }
        : await review(run, loaded, deps, limits, startedAt);
  } catch (error) {
    // Ours, not the model's (the database, most likely): give the run back and let the delivery retry.
    await releaseReviewRun(runId).catch(() => {});
    throw error;
  }
  await finishReviewRun(runId, outcome, new Date(now()));
  return outcome.status;
};
