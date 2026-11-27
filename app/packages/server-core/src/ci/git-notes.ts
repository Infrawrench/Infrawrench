/**
 * A CI job's note commands, on its commit's branch page.
 *
 * A job of a repository on git.infrawrench.com prints `::must-fix ...::`,
 * `::doubt ...::` and their kin (client-core's `ci-notes.ts` is the syntax).
 * When the run ends, this reads each job's output from the runner's report
 * and writes what it says to the branch page of the run's commit:
 *
 * - **Findings** (`must-fix`, `should-fix`, `note`) under the reviewer
 *   `ci:<pipeline>/<job>`, through the same functions the forge's own
 *   reviewers and `findings.report` write with (`git-review/findings.ts`):
 *   masked, fingerprinted, one row for the life of the page, a must-fix sent
 *   to the page's agent. The forge's merge block reads those rows, so a
 *   must-fix from CI holds a merge like any other.
 * - **Trace entries** (`doubt`, `decision`, `step`, `evidence`) written by
 *   the agent `{ kind: "ci", name: "<pipeline>/<job>" }` on the version, not
 *   left waiting for a push: a run is of one commit.
 *
 * Why the app writes the rows itself, as it writes commit statuses, instead
 * of calling the forge's API with a job token: the app and the forge share
 * these tables and the app never calls the forge's Worker for what is in
 * them (KNOWLEDGE.md, the forge's boundaries). What would otherwise be two
 * copies of the rules is one module both import.
 *
 * What holds it to the right place:
 *
 * - **One repository.** The page is looked up in the run's own repository
 *   (`ci_runs.git_repository_id`): a page's run by the page's number there,
 *   any other run by a branch of that repository whose page is in that
 *   repository. A push to a fork is the fork's run; it never writes on the
 *   page its branch has in the repository it was forked from.
 * - **One version.** The notes go on the version whose commit is the run's.
 *   A run of a commit that is no version's tip (a default branch, a branch
 *   with no page, a version a force push replaced before its row was read)
 *   leaves nothing.
 * - **One reviewer per job.** The name is made here from the report, never
 *   read from the output, so a job cannot report as another reviewer or mark
 *   another's findings fixed. A job that passed answers for its own name:
 *   what it reported before and not now is fixed. A job that failed, was
 *   skipped or was cancelled fixes nothing; one the task cache stood in for
 *   did not look again, and its findings are carried to the version as they
 *   were.
 * - **A fork's run** (never trusted, never given secrets) reports findings:
 *   they are about the fork's own code, and its page is where a maintainer
 *   reads them. It records no trace entries, as the forge's own
 *   `traces.record` refuses a fork's job: the trace is the base
 *   repository's record of the work.
 * - **Only the report.** The output read here is the runner's report, which
 *   its `Masker` has been over; `prepareFinding` and `prepareTraceEntries`
 *   mask by shape again before anything is stored.
 *
 * Best-effort, like a commit status: a failure is logged and the run ends
 * as it would have.
 */
import {
  CI_AGENT_KIND,
  CI_NOTE_LIMITS,
  type CiNote,
  type CiNotesIgnored,
  ciJobName,
  ciNoteTitle,
  ciReviewerName,
  parseCiNotes,
} from "@infrawrench/client-core";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  type ciRuns,
  gitBranchVersions,
  gitIssues,
  gitPullRequests,
  gitTraceEntries,
} from "../db/schema.js";
import {
  type FindingInput,
  carryFindings,
  fingerprintOf,
  markOthersFixed,
  recordFindings,
} from "../git-review/findings.js";
import { prepareTraceEntries, type TraceEntryInput } from "../git-review/trace.js";
import { insertTraceEntries } from "../git-review/trace-rows.js";
import type { ProxyRun } from "./proxy.js";
import { gitBaseUrl } from "./source.js";

type VersionRow = typeof gitBranchVersions.$inferSelect;

/** What of a run this needs: a run's row has all of it. */
export type NotesRun = Pick<
  typeof ciRuns.$inferSelect,
  | "id"
  | "gitRepositoryId"
  | "repoFullName"
  | "event"
  | "headRef"
  | "sha"
  | "pullNumber"
  | "fromFork"
  | "terraformRunId"
>;

/** One job of a finished run, as far as its notes go. */
export interface NotesJob {
  readonly pipeline: string;
  readonly id: string;
  readonly status: string;
  /** The task cache stood in for it: it did not run. */
  readonly cached: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** The jobs of a finished run that have an id, with their output. */
export function notesJobs(run: ProxyRun): NotesJob[] {
  const jobs: NotesJob[] = [];
  for (const pipeline of run.result?.pipelines ?? []) {
    const name = pipeline.report?.pipeline ?? pipeline.name ?? "";
    for (const job of pipeline.report?.jobs ?? []) {
      if (typeof job.id !== "string" || job.id === "" || name === "") continue;
      jobs.push({
        pipeline: name,
        id: job.id,
        status: job.status ?? "",
        cached: job.cached === true,
        stdout: job.execution?.stdout ?? "",
        stderr: job.execution?.stderr ?? "",
      });
    }
  }
  return jobs;
}

/** The job's page on the forge, at a line of its log. */
export function ciLogLineUrl(
  run: Pick<NotesRun, "id" | "repoFullName">,
  job: string,
  line: number,
) {
  const repo = run.repoFullName.split("/").map(encodeURIComponent).join("/");
  return `${gitBaseUrl()}/${repo}/ci/runs/${encodeURIComponent(run.id)}?job=${encodeURIComponent(job)}#L${line}`;
}

/**
 * A job's finding commands as findings. Two with the same file and title
 * (a linter's rule broken twice in one file) would share a fingerprint and
 * be one row, so the second and later carry their place in the output.
 */
export async function findingInputs(
  reviewer: string,
  notes: readonly CiNote[],
  source: (note: CiNote) => { text: string; url: string },
): Promise<FindingInput[]> {
  const seen = new Map<string, number>();
  const inputs: FindingInput[] = [];
  for (const note of notes) {
    if (note.severity === null) continue;
    const { title, body } = ciNoteTitle(note);
    const key = `${note.file ?? ""}\n${title}`;
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    inputs.push({
      severity: note.severity,
      title,
      body,
      path: note.file,
      startLine: note.line,
      endLine: note.endLine,
      needsCode: note.needsCode ?? undefined,
      evidence: [{ kind: "ci", ...source(note) }],
      fingerprint: await fingerprintOf(reviewer, note.file, nth === 1 ? title : `${title} #${nth}`),
    });
  }
  return inputs;
}

/** A job's trace commands as trace entries, each linked to the run and its line. */
export function traceInputs(
  runId: string,
  notes: readonly CiNote[],
  source: (note: CiNote) => { text: string; url: string },
): TraceEntryInput[] {
  return notes.flatMap((note) =>
    note.traceKind === null
      ? []
      : [
          {
            kind: note.traceKind,
            body: note.title === null ? note.message : `**${note.title}**\n\n${note.message}`,
            anchors:
              note.file === null
                ? []
                : [{ path: note.file, startLine: note.line, endLine: note.endLine }],
            needsCode: note.needsCode ?? undefined,
            evidence: { ciRunId: runId, url: source(note).url },
          },
        ],
  );
}

/**
 * The open branch page a run's notes belong on, in the run's own
 * repository, or null. See the module's comment for why nothing else is
 * ever looked at.
 */
async function pageOfRun(
  run: NotesRun,
): Promise<{ pull: typeof gitPullRequests.$inferSelect } | null> {
  const repositoryId = run.gitRepositoryId;
  if (!repositoryId) return null;
  const open = and(
    eq(gitPullRequests.repositoryId, repositoryId),
    eq(gitIssues.repositoryId, repositoryId),
    eq(gitIssues.state, "open"),
  );
  const [found] = await db
    .select({ pull: gitPullRequests })
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      run.event === "pull-request"
        ? run.pullNumber === null
          ? sql`false`
          : and(open, eq(gitIssues.number, run.pullNumber))
        : and(
            open,
            eq(gitPullRequests.headRepositoryId, repositoryId),
            eq(gitPullRequests.headRef, run.headRef),
          ),
    )
    .orderBy(desc(gitIssues.number))
    .limit(1);
  if (!found) return null;
  // A page's own run names its head; anything else is not this page's commit.
  if (run.event === "pull-request" && found.pull.headRef !== run.headRef) return null;
  // Only a fork's run reports on a head that is somewhere else.
  if (!run.fromFork && found.pull.headRepositoryId !== repositoryId) return null;
  return found;
}

/**
 * The version of a page whose commit is `sha`: the newest of its newest
 * lineage (the forge's `versionsForPull`, which also reads a branch's own
 * versions for a page that shares its head with an older one).
 */
async function versionOfCommit(
  pull: typeof gitPullRequests.$inferSelect,
  sha: string,
): Promise<VersionRow | null> {
  const order = [asc(gitBranchVersions.lineage), asc(gitBranchVersions.number)] as const;
  let rows = await db
    .select()
    .from(gitBranchVersions)
    .where(eq(gitBranchVersions.pullRequestId, pull.issueId))
    .orderBy(...order);
  if (rows.length === 0 && pull.headRepositoryId !== null) {
    rows = await db
      .select()
      .from(gitBranchVersions)
      .where(
        and(
          eq(gitBranchVersions.repositoryId, pull.headRepositoryId),
          eq(gitBranchVersions.branch, pull.headRef),
        ),
      )
      .orderBy(...order);
  }
  const lineage = rows.at(-1)?.lineage;
  // The newest first: a branch pushed back to a commit it was at has two versions of it.
  for (let at = rows.length - 1; at >= 0; at--) {
    const row = rows[at]!;
    if (row.lineage === lineage && row.tipOid === sha) return row;
  }
  return null;
}

/** What landing a run's notes did. */
export interface NotesOutcome {
  /** Why nothing was written, when nothing could be. */
  readonly skipped: "not-forge" | "no-page" | "no-version" | null;
  readonly findings: number;
  readonly fixed: number;
  readonly carried: number;
  readonly traceEntries: number;
  /** Trace commands of a fork's run, which are not recorded. */
  readonly traceRefused: number;
  readonly ignored: CiNotesIgnored;
}

const nothing = (skipped: NotesOutcome["skipped"]): NotesOutcome => ({
  skipped,
  findings: 0,
  fixed: 0,
  carried: 0,
  traceEntries: 0,
  traceRefused: 0,
  ignored: { malformed: 0, tooLong: 0, overLimit: 0 },
});

/** Write a finished run's notes to its commit's branch page. Throws what the database throws. */
export async function landCiNotes(run: NotesRun, jobs: readonly NotesJob[]): Promise<NotesOutcome> {
  if (!run.gitRepositoryId || run.terraformRunId) return nothing("not-forge");
  // Nothing ran and nothing was stood in for: no page to look up.
  const relevant = jobs.filter(
    (job) => job.cached || job.status === "passed" || job.status === "failed",
  );
  if (relevant.length === 0) return nothing(null);
  const page = await pageOfRun(run);
  if (!page) return nothing("no-page");
  const { pull } = page;
  const version = await versionOfCommit(pull, run.sha);
  if (!version) return nothing("no-version");

  const outcome = { ...nothing(null), ignored: { malformed: 0, tooLong: 0, overLimit: 0 } };
  const target = {
    repositoryId: pull.repositoryId,
    pullRequestId: pull.issueId,
    version,
    runId: null,
  };
  let left: number = CI_NOTE_LIMITS.perRun;
  for (const job of relevant) {
    const name = ciJobName(job.pipeline, job.id);
    const reviewer = ciReviewerName(job.pipeline, job.id);
    if (job.cached) {
      outcome.carried += (await carryFindings(pull.issueId, reviewer, version)).length;
      continue;
    }
    const { notes, ignored } = parseCiNotes(job, left);
    left -= notes.length;
    outcome.ignored.malformed += ignored.malformed;
    outcome.ignored.tooLong += ignored.tooLong;
    outcome.ignored.overLimit += ignored.overLimit;
    const source = (note: CiNote) => ({
      text: `Reported by the job ${job.id} of the pipeline ${job.pipeline}, on line ${note.logLine} of its log.`,
      url: ciLogLineUrl(run, name, note.logLine),
    });

    const written = await recordFindings(
      target,
      reviewer,
      await findingInputs(reviewer, notes, source),
    );
    outcome.findings += written.length;
    if (job.status === "passed") {
      const fixed = await markOthersFixed(
        pull.issueId,
        reviewer,
        version.number,
        written.map(({ row }) => row.id),
      );
      outcome.fixed += fixed.length;
    }

    const entries = traceInputs(run.id, notes, source);
    if (run.fromFork) {
      outcome.traceRefused += entries.length;
      continue;
    }
    const prepared = prepareTraceEntries(entries);
    // A message is held far inside a body's limit, so nothing is refused here.
    if (!Array.isArray(prepared)) continue;
    const agent = { kind: CI_AGENT_KIND, name, sessionRef: run.id };
    // The job's entries on this version are what it said last: a run again replaces them.
    await db
      .delete(gitTraceEntries)
      .where(
        and(
          eq(gitTraceEntries.versionId, version.id),
          sql`${gitTraceEntries.agent}->>'kind' = ${CI_AGENT_KIND}`,
          sql`${gitTraceEntries.agent}->>'name' = ${name}`,
        ),
      );
    const rows = await insertTraceEntries({
      repositoryId: version.repositoryId,
      branch: version.branch,
      versionId: version.id,
      authorUserId: null,
      agent,
      entries: prepared,
    });
    outcome.traceEntries += rows.length;
  }
  return outcome;
}

/**
 * {@link landCiNotes} for the end of a run: never throws, since a run has
 * ended whether or not its notes could be written.
 */
export async function landRunNotes(run: NotesRun, report: ProxyRun): Promise<void> {
  if (!run.gitRepositoryId || run.terraformRunId) return;
  try {
    const outcome = await landCiNotes(run, notesJobs(report));
    const wrote = outcome.findings + outcome.traceEntries + outcome.fixed + outcome.carried;
    if (wrote > 0) {
      console.log(
        `[ci] run ${run.id}: ${outcome.findings} finding(s), ${outcome.traceEntries} trace entr(ies), ${outcome.fixed} fixed, ${outcome.carried} carried on its branch page`,
      );
    }
  } catch (err) {
    // Its kind alone: a failed query's message quotes the statement and what it was given.
    console.warn(
      `[ci] could not write the notes of run ${run.id}: ${err instanceof Error ? err.name : "unknown error"}`,
    );
  }
}
