/**
 * Re-runs asked for from GitHub: "Re-run" on one of this app's checks
 * (`check_run` `rerequested`) and "Re-run all checks" on a commit
 * (`check_suite` `rerequested`). GitHub sends these only to the app whose
 * checks they are, and only lets someone with write access to the
 * repository ask, so the delivery is the whole request: there is no
 * Infrawrench user behind it.
 *
 * A re-run is a retry (`insertRetry`), never a rerun of the old row, with
 * these rules on top of a retry's own:
 * - **Whole runs only.** A runner runs a commit's pipelines, never one job
 *   of them, so a job's check re-runs its whole run, and the new run's
 *   check says so (`runningSummary`).
 * - **No principal, and no approval by it.** The retry records no user
 *   (`startedByUserId` and `decidedByUserId` stay null); the web handler
 *   audits it as `ci.run.retry` with `source: "github"` and the GitHub
 *   login. A GitHub login carries no `ci:approve`, so a fork's re-run
 *   waits for a maintainer like a new commit of it, and a scheduled or
 *   manual run (started by a cron or by someone with `ci:approve`) is only
 *   started again from Infrawrench.
 * - **Finished runs only.** A run still queued or going is left alone, and
 *   its check says why; it can be re-run once it ends.
 * - **Once.** Only a run with no retry yet is retried, as its first retry
 *   (`firstOnly`): a newer run's checks already stand in for an older
 *   one's, so a redelivery, a double click, and "Re-run failed checks"
 *   asking for several checks of one run all start one run between them.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { CiRunStatus } from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { ciRuns } from "../db/schema.js";
import { githubAppId } from "../github/app.js";
import { noteOnCheck } from "./checks.js";
import { type CiCheckRerequest, runIdOfExternalId } from "./events.js";
import {
  announceAwaitingApproval,
  ciOrganization,
  type CiRunRow,
  dispatchRun,
  insertRetry,
  retryRefusal,
} from "./runs.js";

/** The most runs one "Re-run all checks" starts. */
export const MAX_SUITE_RERUNS = 10;

/** The most runs of one commit read to find what a re-run means. */
const MAX_COMMIT_RUNS = 200;

const GOING: readonly CiRunStatus[] = ["queued", "pending", "running"];

type RerunRow = Pick<
  CiRunRow,
  "id" | "event" | "status" | "branch" | "headRef" | "retryOfRunId" | "checkRunId" | "jobChecks"
>;

/** The runs of the commit a re-run asks for, among `rows` (all of that commit's). */
export function rerunTargets<R extends RerunRow>(rows: readonly R[], req: CiCheckRerequest): R[] {
  if (req.kind === "check_run") {
    // The check's `external_id` names its run; a check without one (or one
    // this app did not write) is found by its id among the runs' checks.
    const byExternal = runIdOfExternalId(req.externalId);
    const found =
      (byExternal ? rows.find((r) => r.id === byExternal) : undefined) ??
      rows.find(
        (r) =>
          r.checkRunId === req.checkRunId ||
          Object.values(r.jobChecks ?? {}).some((c) => c.id === req.checkRunId),
      );
    return found ? [found] : [];
  }
  // A suite is the commit's checks: the newest run of each line of retries,
  // of the events a commit starts. A branch GitHub names narrows it to that
  // branch's runs (the same commit may be on several).
  const retried = new Set(rows.map((r) => r.retryOfRunId).filter((id) => id !== null));
  return rows
    .filter((r) => !retried.has(r.id))
    .filter((r) => r.event === "push" || r.event === "pull-request")
    .filter((r) => req.headBranch === null || r.headRef === req.headBranch)
    .slice(0, MAX_SUITE_RERUNS);
}

export type RerunDecision =
  | { kind: "retry" }
  /** Nothing to do and nothing to say: the run is already re-run, or will settle its check itself. */
  | { kind: "ignore" }
  /** Nothing to do; `note` says why on the check that was re-run. */
  | { kind: "refuse"; note: string };

/** What a re-run from GitHub does with `row`; `retried` when it already has a retry. */
export function rerunDecision(row: RerunRow, retried: boolean): RerunDecision {
  if (retried) return { kind: "ignore" };
  if (row.event === "schedule" || row.event === "manual") {
    return {
      kind: "refuse",
      note:
        `A ${row.event === "schedule" ? "scheduled" : "manual"} run is started again from ` +
        "Infrawrench, not from GitHub: retry it from the CI tab.",
    };
  }
  if (GOING.includes(row.status)) {
    return {
      kind: "refuse",
      note: "This run has not finished yet. Re-run it once it has.",
    };
  }
  switch (row.status) {
    case "awaiting_approval":
      return {
        kind: "refuse",
        note: "This commit from a fork is waiting for a maintainer to approve it in Infrawrench.",
      };
    case "rejected":
      return {
        kind: "refuse",
        note: "A maintainer chose not to run CI for this commit; a re-run does not change that.",
      };
    case "skipped":
      return {
        kind: "refuse",
        note: "No pipeline in `.infrawrench/ci` runs on this commit, so there is nothing to re-run.",
      };
  }
  const refusal = retryRefusal(row);
  return refusal ? { kind: "refuse", note: refusal } : { kind: "retry" };
}

export interface CheckRerun {
  organizationId: string;
  installationId: number;
  repoFullName: string;
  /** The runs started (queued) or waiting for approval (a fork's). */
  retried: CiRunRow[];
  /** Checks to answer, and what to say on each. */
  notes: Array<{ checkRunId: number; note: string }>;
}

/**
 * Records what a re-run from GitHub asks for: the retries it starts, and
 * the checks to answer for what it does not. `null` when it is not this
 * app's, or not a commit any organization runs CI for.
 */
export async function acceptCheckRerequest(req: CiCheckRerequest): Promise<CheckRerun | null> {
  // GitHub sends these to the app that made the checks; anything else is
  // not ours to act on.
  if (req.appId !== githubAppId()) return null;
  const organizationId = await ciOrganization(req.installationId);
  if (!organizationId) return null;
  const rows = await db
    .select()
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.organizationId, organizationId),
        eq(ciRuns.installationId, req.installationId),
        sql`lower(${ciRuns.repoFullName}) = ${req.repoFullName.toLowerCase()}`,
        eq(ciRuns.sha, req.headSha),
      ),
    )
    .orderBy(asc(ciRuns.createdAt))
    .limit(MAX_COMMIT_RUNS);
  const out: CheckRerun = {
    organizationId,
    installationId: req.installationId,
    repoFullName: req.repoFullName,
    retried: [],
    notes: [],
  };
  for (const row of rerunTargets(rows, req)) {
    const decision = rerunDecision(
      row,
      rows.some((r) => r.retryOfRunId === row.id),
    );
    if (decision.kind === "retry") {
      const retry = await insertRetry(row, {
        approvedByUserId: null,
        noTaskCache: false,
        firstOnly: true,
      });
      // Raced by another retry of the same run: that one stands for both.
      if (retry) out.retried.push(retry);
    } else if (decision.kind === "refuse") {
      if (req.kind === "check_run" && req.checkRunId !== null) {
        out.notes.push({ checkRunId: req.checkRunId, note: decision.note });
      } else if (row.checkRunId !== null && !GOING.includes(row.status)) {
        // A run still going settles its own check when it ends.
        out.notes.push({ checkRunId: row.checkRunId, note: decision.note });
      }
    }
  }
  return out;
}

/**
 * What follows the answer: dispatching each retry (or showing a fork's as
 * waiting for a maintainer) and answering the checks that start nothing.
 */
export async function followUpCheckRerun(rerun: CheckRerun): Promise<void> {
  for (const run of rerun.retried) {
    if (run.status === "awaiting_approval") await announceAwaitingApproval(run.id);
    else await dispatchRun(run.id);
  }
  for (const { checkRunId, note } of rerun.notes) {
    await noteOnCheck(rerun.installationId, rerun.repoFullName, checkRunId, note);
  }
}
