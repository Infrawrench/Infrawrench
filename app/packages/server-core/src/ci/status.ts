/**
 * Where a CI run's status is shown on its commit: GitHub check runs for a
 * GitHub repository (`checks.ts`, `job-checks.ts`), commit statuses for a
 * repository on git.infrawrench.com (this module).
 *
 * The rest of CI publishes through three calls, whatever the source:
 * `upsertCheck` (the run's own status), `syncJobChecks` (one per job) and
 * `abandonJobChecks` (a lost run's unfinished jobs). Each hands a
 * git.infrawrench.com run to the {@link gitStatusPublisher} here, which
 * turns what a check would say into a commit status and gives it to the
 * {@link GitStatusWriter}.
 *
 * The contexts are the check names, so a protected branch requires the same
 * thing on either forge: `Infrawrench CI / push`, `Infrawrench CI / pull
 * request`, and `<pipeline> / <job> (<event>)` for each job. A status links
 * to the run's page in the app.
 *
 * Best-effort, like a check: a status that cannot be written is logged and
 * the run goes on.
 */
import { eq } from "drizzle-orm";
import type { CiEvent } from "@infrawrench/client-core";

import { orgAppUrl } from "../app-url.js";
import { db } from "../db/client.js";
import { ciRuns, gitCommitStatuses } from "../db/schema.js";
import { checkName, type CheckUpdate } from "./checks.js";
import {
  jobCheckFingerprint,
  jobCheckKey,
  jobCheckName,
  jobCheckState,
  MAX_JOB_CHECKS,
  type JobCheckState,
  type JobGroup,
} from "./job-checks.js";

/** `git_commit_statuses.state`. */
export type GitCommitStatusState = "pending" | "success" | "failure" | "error";

/** One row of `git_commit_statuses`: unique per repository, commit and context. */
export interface GitCommitStatus {
  /** `git_repositories.id`. */
  repositoryId: string;
  sha: string;
  context: string;
  state: GitCommitStatusState;
  description: string;
  /** The run's page in the app, or null on a server without `APP_URL`. */
  targetUrl: string | null;
}

/**
 * Writes a commit status: an upsert on (repository, sha, context), so the
 * newest state of a context replaces the last.
 */
export type GitStatusWriter = (status: GitCommitStatus) => Promise<void>;

/**
 * The writer: an upsert on `git_commit_statuses`' unique index (repository,
 * commit, context). The row keeps its id and `createdAt`; `ciRunId` is not
 * set here, since the status's link already names the run.
 */
export const writeGitCommitStatus: GitStatusWriter = async (status) => {
  const { repositoryId, sha, context, state, description, targetUrl } = status;
  await db
    .insert(gitCommitStatuses)
    .values({ id: crypto.randomUUID(), repositoryId, sha, context, state, description, targetUrl })
    .onConflictDoUpdate({
      target: [gitCommitStatuses.repositoryId, gitCommitStatuses.sha, gitCommitStatuses.context],
      set: { state, description, targetUrl, updatedAt: new Date() },
    });
};

let writer: GitStatusWriter = writeGitCommitStatus;

/** Replaces the writer, for tests; `null` restores the default. */
export function setGitStatusWriter(next: GitStatusWriter | null): void {
  writer = next ?? writeGitCommitStatus;
}

/** The most a status description holds; a forge shows it on one line. */
export const STATUS_DESCRIPTION_LENGTH = 140;

function describe(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= STATUS_DESCRIPTION_LENGTH
    ? line
    : `${line.slice(0, STATUS_DESCRIPTION_LENGTH - 1)}…`;
}

/**
 * What a check's state is as a commit status. A status has four states, so:
 * anything not finished is `pending` (a fork waiting for a maintainer
 * too: it has not run); `skipped` is `success`, as a skipped check
 * satisfies a required check, so a pull request whose `paths:` leave out
 * every pipeline can merge; a cancelled or not-run check is `error`, which
 * is "did not finish", not "the code is wrong".
 */
export function commitStatusState(
  status: CheckUpdate["status"] | JobCheckState["status"],
  conclusion: string | undefined,
): GitCommitStatusState {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
    case "skipped":
      return "success";
    case "failure":
      return "failure";
    case "action_required":
      return "pending";
    default:
      return "error";
  }
}

/** What of a run its own status needs: a run's row has all of it. */
export interface RunStatusTarget {
  id: string;
  organizationId: string;
  event: CiEvent;
  repoFullName: string;
  sha: string;
  gitRepositoryId?: string | null | undefined;
}

/** And what its jobs' statuses need. */
export interface StatusTarget extends RunStatusTarget {
  /** By `jobCheckKey`: the state last sent, so a poll only writes what changed. */
  jobChecks: Record<string, { id: number; sent: string; context?: string }>;
}

/** The three things CI says about a run on its commit, for one forge. */
export interface StatusPublisher {
  /** The run's own status: the one a protected branch requires. */
  run(target: RunStatusTarget, update: CheckUpdate): Promise<void>;
  /** Each job's status, written only when it changed. */
  jobs(target: StatusTarget, groups: readonly JobGroup[]): Promise<void>;
  /** Closes the unfinished jobs of a run nothing will report on again. */
  abandonJobs(target: StatusTarget, reason: string): Promise<void>;
}

async function write(
  target: RunStatusTarget,
  status: Pick<GitCommitStatus, "context" | "state" | "description">,
): Promise<void> {
  if (!target.gitRepositoryId) return;
  await writer({
    repositoryId: target.gitRepositoryId,
    sha: target.sha,
    targetUrl: orgAppUrl(target.organizationId, `ci/${target.id}`),
    ...status,
  });
}

/** Commit statuses on git.infrawrench.com. */
export const gitStatusPublisher: StatusPublisher = {
  async run(target, update) {
    try {
      await write(target, {
        context: checkName(target.event),
        state: commitStatusState(update.status, update.conclusion),
        description: describe(update.title),
      });
    } catch (err) {
      console.warn(`[ci] could not write the commit status of run ${target.id}:`, err);
    }
  },

  async jobs(target, groups) {
    const next = { ...target.jobChecks };
    let changed = false;
    for (const group of groups.slice(0, MAX_JOB_CHECKS)) {
      const key = jobCheckKey(group.pipeline, group.key);
      const state = jobCheckState(group);
      const sent = jobCheckFingerprint(state);
      if (next[key]?.sent === sent) continue;
      const context = jobCheckName(group, target.event);
      try {
        await write(target, {
          context,
          state: commitStatusState(state.status, state.conclusion),
          description: describe(state.title),
        });
        // A status has no id of its own: its context is its key, kept so a
        // lost run's unfinished ones can be closed.
        next[key] = { id: 0, sent, context };
        changed = true;
      } catch (err) {
        console.warn(
          `[ci] could not write the commit status of ${group.key} for run ${target.id}:`,
          err,
        );
      }
    }
    if (!changed) return;
    target.jobChecks = next;
    try {
      await db.update(ciRuns).set({ jobChecks: next }).where(eq(ciRuns.id, target.id));
    } catch (err) {
      console.warn(`[ci] could not keep the job statuses of run ${target.id}:`, err);
    }
  },

  async abandonJobs(target, reason) {
    for (const [key, known] of Object.entries(target.jobChecks)) {
      if (known.sent.startsWith("completed") || !known.context) continue;
      try {
        await write(target, {
          context: known.context,
          state: "error",
          description: describe(reason),
        });
      } catch (err) {
        console.warn(`[ci] could not close the job status ${key} of run ${target.id}:`, err);
      }
    }
  },
};
