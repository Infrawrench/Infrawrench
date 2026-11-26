/**
 * The review queue (`infrawrench-git-reviews`): where a review run waits and
 * where it runs.
 *
 * **Why a queue of its own, and not the push queue or a Workflow.** A run is
 * minutes of waiting on a model. In the push queue's consumer it would sit
 * in a batch in front of other pushes and share their retries. A Workflow
 * would lift the consumer's 15 minutes, but it keeps each step's result, and
 * a run's steps are prompts and answers made of a repository's code: the
 * conversation would be stored and shown in a dashboard, for no gain, since a
 * run is bounded well inside 15 minutes (`policy.ts`) and restarts cleanly
 * (findings are upserts). So: one message a batch, a deadline, a lease on the
 * row.
 *
 * A message is only a run's id; the row is the truth. Three things keep a row
 * from being stranded: a delivery that finds it held asks again later, a
 * delivery past its attempts fails it, and the hourly sweep sends queued runs
 * nothing picked up and fails what has been waiting or running too long.
 */
import type { MessageBatch } from "@cloudflare/workers-types/index";
import { activeRunsBefore, finishReviewRun } from "../db/findings";
import { withDb } from "../db/client";
import type { Env, GitReviewMessage as ReviewMessage } from "../env";
import { describeError } from "../http/log";
import { type RepoReaderFactory, repoReaderFor } from "../repo/select";
import { isForgeReviewer } from "./findings";
import { REVIEW_LIMITS } from "./policy";
import { type ReviewDeps, runReview } from "./runner";

export type { GitReviewMessage as ReviewMessage } from "../env";

/**
 * Send a run to the queue. False where the queue is not bound (tests, a
 * local Worker without it): the run stays queued and the sweep fails it with
 * a reason when nothing ever takes it.
 */
export const enqueueReviewRun = async (
  env: Pick<Env, "REVIEWS">,
  runId: string,
): Promise<boolean> => {
  if (!env.REVIEWS) return false;
  await env.REVIEWS.send({ type: "review", runId });
  return true;
};

/** How long before a run that is held is asked about again. */
const BUSY_DELAY_SECONDS = 120;

/** The Worker's `queue` handler for the review queue. One run a batch. */
export const consumeReviewRuns = async (
  batch: MessageBatch<ReviewMessage>,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  overrides: Partial<Pick<ReviewDeps, "model" | "readers">> = {},
): Promise<void> => {
  await withDb(env, ctx, async () => {
    for (const message of batch.messages) {
      try {
        const outcome = await runReview(message.body.runId, {
          env,
          readers: overrides.readers ?? repoReaderFor,
          model:
            overrides.model ??
            // The SDK is not loaded for a run that is skipped.
            (() => lazyModel()),
          attempt: message.attempts,
        });
        if (outcome === "busy") message.retry({ delaySeconds: BUSY_DELAY_SECONDS });
        else message.ack();
      } catch (error) {
        console.error(
          `[git] review run ${message.body.runId} could not be worked on and will be retried: ${describeError(error)}`,
        );
        message.retry({ delaySeconds: 30 });
      }
    }
  });
};

/** A model that loads the Anthropic client at its first call. */
const lazyModel = (): ReturnType<ReviewDeps["model"]> => {
  let loaded: Promise<ReturnType<ReviewDeps["model"]>> | undefined;
  return {
    create: async (params, options) => {
      loaded ??= import("./model").then(({ anthropicReviewModel }) =>
        anthropicReviewModel(REVIEW_LIMITS.turnTimeoutMs),
      );
      return (await loaded).create(params, options);
    },
  };
};

export interface SweepResult {
  readonly resent: number;
  readonly failed: number;
}

/** A queued run older than this was never delivered: send it again. */
const RESEND_AFTER_MS = 5 * 60_000;
/** A queued run older than this is given up on. */
const QUEUED_TOO_LONG_MS = 3 * 60 * 60_000;
/** A reviewer outside the forge has this long to finish a run it started. */
const EXTERNAL_TOO_LONG_MS = 24 * 60 * 60_000;

/**
 * The hourly pass (the Worker's cron trigger): no run is left waiting or
 * running for ever. Queued runs of the forge's that nothing picked up are
 * sent again, and failed once they have waited hours. Running ones past the
 * lease are failed (a delivery would have taken them over by now). A
 * reviewer's own run outside the forge is failed after a day.
 */
export const sweepReviewRuns = async (
  env: Pick<Env, "REVIEWS">,
  options: { readonly now?: Date; readonly readers?: RepoReaderFactory } = {},
): Promise<SweepResult> => {
  const now = options.now ?? new Date();
  const age = (at: Date | null): number => (at ? now.getTime() - at.getTime() : 0);
  let resent = 0;
  let failed = 0;
  const fail = async (id: string, error: string) => {
    if (await finishReviewRun(id, { status: "failed", error }, now)) failed++;
  };
  for (const run of await activeRunsBefore(new Date(now.getTime() - RESEND_AFTER_MS), 500)) {
    if (!run.reviewerKinds.some(isForgeReviewer)) {
      if (age(run.createdAt) > EXTERNAL_TOO_LONG_MS) {
        await fail(run.id, "The reviewer never reported that this run ended");
      }
      continue;
    }
    if (run.status === "running") {
      // Twice the lease: a delivery that would take it over has had its chance.
      if (age(run.startedAt) > REVIEW_LIMITS.leaseMs * 2) {
        await fail(run.id, "The review stopped without finishing");
      }
      continue;
    }
    if (age(run.createdAt) > QUEUED_TOO_LONG_MS) {
      await fail(run.id, "The review was never started");
      continue;
    }
    try {
      if (await enqueueReviewRun(env, run.id)) resent++;
    } catch (error) {
      console.error(`[git] could not send review run ${run.id}: ${describeError(error)}`);
    }
  }
  return { resent, failed };
};
