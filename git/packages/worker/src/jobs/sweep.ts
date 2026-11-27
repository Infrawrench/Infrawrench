/**
 * The sweep behind the jobs queue: every two minutes it sends the push
 * mirrors and issue imports that are owed a run and that no message is
 * carrying (a failed run whose next try is due, a message that was lost, a
 * consumer that died holding the lease). Hourly (`reconcile`) every mirror
 * is marked as owed a run, so a push whose event never reached the queue is
 * mirrored within the hour: a run that finds the target equal costs one
 * request.
 *
 * Where the queue is not bound the sweep runs a few jobs itself, so the
 * features work, slowly, on a Worker that has no queue yet.
 */
import type { Env, GitJobMessage } from "../env";
import { describeError } from "../http/log";
import { enqueueJob, runJob } from "./consumer";

/** Most jobs the sweep runs itself when there is no queue to send them to. */
const INLINE_JOBS = 2;

export const sweepJobs = async (
  env: Env,
  options: { readonly reconcile: boolean },
): Promise<{ readonly sent: number }> => {
  const [{ mirrorsDue, markEveryMirrorPending }, { issueImportsDue }] = await Promise.all([
    import("../mirror/store"),
    import("../import/store"),
  ]);
  if (options.reconcile) await markEveryMirrorPending();
  const messages: GitJobMessage[] = [
    ...(await mirrorsDue()).map((mirrorId) => ({ type: "mirror" as const, mirrorId })),
    ...(await issueImportsDue()).map((importId) => ({ type: "issue-import" as const, importId })),
  ];
  let ran = 0;
  for (const message of messages) {
    try {
      if (await enqueueJob(env, message)) continue;
      if (ran++ < INLINE_JOBS) await runJob(env, message);
    } catch (error) {
      console.error(`[git] a swept job failed: ${describeError(error)}`);
    }
  }
  return { sent: messages.length };
};
