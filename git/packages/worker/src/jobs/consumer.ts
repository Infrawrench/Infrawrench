/**
 * The jobs queue (`infrawrench-git-jobs`): work that talks to another host
 * and can take minutes. A push mirror's run (`mirror/job.ts`) and a step of
 * an issue import (`import/job.ts`).
 *
 * **A queue of its own** for the reason the review queue is one: a mirror's
 * first run pushes a whole history, and in the push queue's consumer it
 * would sit in a batch in front of other repositories' pushes.
 *
 * **A message names a row and nothing else.** The row holds the state, the
 * lease and when the next try is due, so a message delivered twice finds
 * nothing left to do, and one that is lost is sent again by the sweep
 * (`sweep.ts`). A job that has more to do (an import's next page, a mirror
 * that was pushed to while it ran) answers `again` and the consumer sends
 * the next message itself. The queue's own retry is only for a failure of
 * the consumer (the database away), never of the work.
 */
import type { MessageBatch } from "@cloudflare/workers-types/index";
import { withDb } from "../db/client";
import type { Env, GitJobMessage } from "../env";
import { describeError } from "../http/log";

/** What a job answers: done for now, or send its message again after this many seconds. */
export interface JobOutcome {
  readonly again?: number;
}

/** Runs one message's work. The modules are loaded when a message of their kind arrives. */
export const runJob = async (env: Env, message: GitJobMessage): Promise<JobOutcome> => {
  if (message.type === "mirror") {
    return (await import("../mirror/job")).runMirrorJob(env, message.mirrorId);
  }
  return (await import("../import/job")).runIssueImportJob(env, message.importId);
};

/** What a message is about, for a log line: a kind and a row id, nothing a person wrote. */
const nameOf = (message: GitJobMessage): string =>
  message.type === "mirror" ? `mirror ${message.mirrorId}` : `issue import ${message.importId}`;

/**
 * Send a job. False where the queue is not bound (tests, a Worker deployed
 * before the queue exists): the row waits for the sweep.
 */
export const enqueueJob = async (
  env: Pick<Env, "JOBS">,
  message: GitJobMessage,
  delaySeconds = 0,
): Promise<boolean> => {
  if (!env.JOBS) return false;
  await env.JOBS.send(message, delaySeconds > 0 ? { delaySeconds } : undefined);
  return true;
};

/** The Worker's `queue` handler for the jobs queue. One job a batch. */
export const consumeJobs = async (
  batch: MessageBatch<GitJobMessage>,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> => {
  await withDb(env, ctx, async () => {
    for (const message of batch.messages) {
      try {
        const outcome = await runJob(env, message.body);
        if (outcome.again !== undefined) await enqueueJob(env, message.body, outcome.again);
        message.ack();
      } catch (error) {
        console.error(
          `[git] ${nameOf(message.body)} could not be worked on and will be retried: ${describeError(error)}`,
        );
        message.retry({ delaySeconds: 30 });
      }
    }
  });
};
