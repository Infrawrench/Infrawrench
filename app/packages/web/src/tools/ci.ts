/**
 * CI tools: the chat and MCP view of the CI tab. Runs, their jobs and logs,
 * the actions a maintainer takes on a run (start, retry, cancel, approve,
 * reject), and read-only views of what CI is set up with.
 *
 * Everything goes through `server-core/src/ci/`, the modules behind the
 * HTTP routes (`http/domains/ci/`), so the two surfaces cannot drift:
 * - **Permissions** are the routes' own: `ci:read` to read runs, logs,
 *   pipelines, access and usage; `ci:approve` for every action on a run (a
 *   start, a retry and an approval all run code with the repository's
 *   secrets, or a fork's code); `ci:write` to list secret and variable names,
 *   as `GET /ci/values` takes.
 * - **Audit** actions are the routes' (`ci.run.start`, `ci.run.retry`,
 *   `ci.run.cancel`, `ci.run.approve`, `ci.run.reject`) with `source`.
 *
 * Nothing here returns more than the CI tab shows, and in places less: job
 * output is what the runner wrote with the run's secrets masked (its report,
 * or its live log while it runs), secret values are never readable at all,
 * variable values are left out, and download links (bearer URLs) are not
 * signed here. Usage is vCPU, memory and storage quantities, never money, as
 * on the routes, which apply no cost visibility to them.
 */
import { Schema } from "effect";
import { pattern } from "@infrawrench/api-contract/schemas";
import {
  CI_EVENTS,
  CI_RUN_STATUSES,
  ciLogEvent,
  emptyCiLiveRun,
  parseSseFrames,
  reduceCiLogEvents,
  type CiInputValue,
  type CiJobSummary,
  type CiLiveJob,
  type CiLogEvent,
  type CiRun,
} from "@infrawrench/client-core";
import { ciStatus } from "@infrawrench/server-core/ci/accounts";
import { ciAccessOverview } from "@infrawrench/server-core/ci/access";
import { ciUsage } from "@infrawrench/server-core/ci/billing";
import {
  approveRun,
  cancelRun,
  CiInputError,
  dispatchRun,
  getRun,
  listRuns,
  openRunLogs,
  rejectRun,
  retryRun,
  startManualRun,
} from "@infrawrench/server-core/ci/runs";
import { listCiRepositories } from "@infrawrench/server-core/ci/schedules";
import { listCiValues } from "@infrawrench/server-core/ci/values";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import { logAudit } from "../services/audit";
import { PlanRequiredError } from "../services/entitlements";
import { err, ok, type ToolAuthContext, type ToolDefinition, type ToolResult } from "./types";

const DEFAULT_RUN_LIMIT = 25;
const MAX_RUN_LIMIT = 100;
/** Log lines per stream per call: enough for a stack trace, little enough for a model's context. */
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 1000;
/** Longer lines are cut, so one minified bundle cannot fill a page. */
const MAX_LINE_CHARS = 2000;
/** How long a running run's live log is read for, and how long a pause in it ends the read. */
const LIVE_READ_MS = 4000;
const LIVE_IDLE_MS = 750;
/** The most of a live log one call reads; past it, the run's report has the rest. */
const LIVE_MAX_BYTES = 8 * 1024 * 1024;

const runIdSchema = Schema.String.annotate({ description: "The run's `id`, from list_ci_runs." });

/** A refusal the CI modules mean for the caller (not found, conflict, bad input) as a tool error. */
function ciError(e: unknown): ToolResult {
  if (e instanceof CiInputError || e instanceof PlanRequiredError) return err(e.message);
  throw e;
}

/** Sends a run the poller would otherwise pick up on its next pass, as the routes do. */
function dispatchSoon(runId: string): void {
  void keepAlive(dispatchRun(runId)).catch((e: unknown) => {
    console.warn(`[ci] dispatch of run ${runId} after a tool call failed:`, e);
  });
}

function audit(
  auth: ToolAuthContext,
  action: string,
  runId: string,
  metadata: Record<string, unknown> = {},
): void {
  void logAudit({
    organizationId: auth.organizationId,
    userId: auth.userId,
    action,
    entityType: "ci_run",
    entityId: runId,
    metadata: { ...metadata, source: auth.source },
  });
}

type JobCounts = Partial<Record<CiJobSummary["status"], number>>;

/** A run as a list shows it: its jobs counted, with the ones that did not pass named. */
export function runListEntry(run: CiRun) {
  const { jobs, ...rest } = run;
  const counts: JobCounts = {};
  for (const job of jobs ?? []) counts[job.status] = (counts[job.status] ?? 0) + 1;
  return {
    ...rest,
    jobCounts: jobs ? counts : null,
    failedJobs: (jobs ?? [])
      .filter((j) => j.status === "failed" || j.status === "error")
      .map((j) => ({ pipeline: j.pipeline, id: j.id, name: j.name, reason: j.reason })),
  };
}

function lineCount(text: string): number {
  return splitLines(text).length;
}

/** A stream's text as lines, without the empty one after a final newline. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface LogPage {
  totalLines: number;
  /** 1-based, inclusive; 0 when the page is empty. */
  fromLine: number;
  toLine: number;
  lines: string[];
  moreBefore: boolean;
  moreAfter: boolean;
}

/**
 * One page of a stream's lines: from `fromLine` (1-based) when given, else
 * the last `count` lines. Lines past {@link MAX_LINE_CHARS} are cut.
 */
export function pageLines(all: readonly string[], count: number, fromLine?: number): LogPage {
  const total = all.length;
  const start =
    fromLine === undefined
      ? Math.max(0, total - count)
      : Math.min(Math.max(fromLine - 1, 0), total);
  const end = Math.min(total, start + count);
  const lines = all
    .slice(start, end)
    .map((line) =>
      line.length > MAX_LINE_CHARS
        ? `${line.slice(0, MAX_LINE_CHARS)}… [${line.length - MAX_LINE_CHARS} more characters]`
        : line,
    );
  return {
    totalLines: total,
    fromLine: lines.length > 0 ? start + 1 : 0,
    toLine: lines.length > 0 ? end : 0,
    lines,
    moreBefore: start > 0,
    moreAfter: end < total,
  };
}

/** Resolves after `ms`, with `value`; the timer is cleared by `clear`. */
function timeout<T>(ms: number, value: T): { promise: Promise<T>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

/**
 * What a running run's live log says so far. The proxy sends everything so
 * far and then follows the run, so the read stops when the stream goes quiet
 * for {@link LIVE_IDLE_MS}, after {@link LIVE_READ_MS} in all, or at
 * {@link LIVE_MAX_BYTES}; `complete` says whether it saw the stream end.
 * The output lines are the runner's, masked as in the CI tab.
 */
export async function readLiveLog(
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
  limits: { totalMs: number; idleMs: number; maxBytes: number } = {
    totalMs: LIVE_READ_MS,
    idleMs: LIVE_IDLE_MS,
    maxBytes: LIVE_MAX_BYTES,
  },
): Promise<{ events: CiLogEvent[]; complete: boolean; cut: boolean }> {
  const abort = new AbortController();
  const body = await open(abort.signal);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  let cut = false;
  const deadline = Date.now() + limits.totalMs;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const wait = timeout(chunks.length === 0 ? left : Math.min(left, limits.idleMs), null);
      const next = await Promise.race([reader.read(), wait.promise]);
      wait.clear();
      if (next === null) break;
      if (next.done) {
        complete = true;
        break;
      }
      chunks.push(next.value);
      bytes += next.value.byteLength;
      if (bytes >= limits.maxBytes) {
        cut = true;
        break;
      }
    }
  } finally {
    abort.abort();
    void reader.cancel().catch(() => {});
  }
  const collected = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const events: CiLogEvent[] = [];
  for await (const frame of parseSseFrames(collected)) {
    const event = ciLogEvent(frame);
    if (event) events.push(event);
  }
  return { events, complete, cut };
}

/** The jobs matching `jobId` (and `pipeline`, when given). */
function matchJobs<T extends { id: string; pipeline: string }>(
  jobs: readonly T[],
  jobId: string,
  pipeline: string | undefined,
): T[] {
  return jobs.filter((j) => j.id === jobId && (pipeline === undefined || j.pipeline === pipeline));
}

function noSuchJob(jobId: string, jobs: readonly { id: string; pipeline: string }[]): ToolResult {
  const known = jobs.map((j) => `${j.pipeline} / ${j.id}`).join(", ");
  return err(
    `No job ${jobId} in this run.${known ? ` Its jobs (pipeline / id): ${known}.` : ""} ` +
      "Pass the job's `id` from get_ci_run, and its `pipeline` when two pipelines have a job of that id.",
  );
}

function ambiguousJob(jobId: string, jobs: readonly { pipeline: string }[]): ToolResult {
  return err(
    `More than one pipeline has a job ${jobId}: ${jobs.map((j) => j.pipeline).join(", ")}. Pass \`pipeline\` too.`,
  );
}

type Stream = "stdout" | "stderr" | "both";

function streamPages(
  lines: { stdout: string[]; stderr: string[] },
  stream: Stream,
  count: number,
  fromLine: number | undefined,
) {
  return {
    ...(stream !== "stderr" ? { stdout: pageLines(lines.stdout, count, fromLine) } : {}),
    ...(stream !== "stdout" ? { stderr: pageLines(lines.stderr, count, fromLine) } : {}),
  };
}

function liveLines(job: CiLiveJob) {
  return {
    stdout: job.lines.filter((l) => l.stream === "stdout").map((l) => l.line),
    stderr: job.lines.filter((l) => l.stream === "stderr").map((l) => l.line),
  };
}

const intInput = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined;

const stringInput = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

export function ciTools(): ToolDefinition[] {
  return [
    {
      name: "list_ci_repositories",
      title: "List CI repositories",
      description:
        "Where Infrawrench CI runs for this organization. `status` says whether CI is set up " +
        "(`configured`: the runner pool is; `githubConfigured`: the GitHub App is; " +
        "`planIncludesCi`). `accounts` are the connected GitHub accounts (App installations), " +
        "each with its `installationId` and `ciEnabled`. `repositories` are the repositories of " +
        "accounts that run CI that have sent a push or pull request, each with its " +
        "`installationId`, `repoFullName` (`owner/name`), default branch and how many scheduled " +
        "and manual pipelines its default branch has. Pass `repoFullName` to list_ci_runs, " +
        "list_ci_pipelines and start_ci_run, and `installationId` to start_ci_run and " +
        "list_ci_values.",
      inputSchema: {},
      risk: "read",
      permission: "ci:read",
      handler: async (_input, auth) => {
        const [status, repos] = await Promise.all([
          ciStatus(auth.organizationId),
          listCiRepositories(auth.organizationId),
        ]);
        return ok({
          status: {
            configured: status.configured,
            githubConfigured: status.githubConfigured,
            planIncludesCi: status.planIncludesCi,
          },
          accounts: status.accounts,
          repositories: repos.map((r) => ({
            installationId: r.installationId,
            repoFullName: r.repoFullName,
            defaultBranch: r.defaultBranch,
            scheduledPipelines: r.pipelines.length,
            manualPipelines: r.manual?.length ?? 0,
            readAt: r.refreshedAt,
            readError: r.error,
          })),
        });
      },
    },

    {
      name: "list_ci_pipelines",
      title: "List CI pipelines",
      description:
        "The pipelines Infrawrench knows on each repository's default branch, as of its last " +
        "read (`readAt`, at the commit `sha`): `scheduled` are the ones with `on.schedule` (file, " +
        "name, cron expressions in UTC and `nextRunAt`), `manual` the ones with `on.manual` " +
        "that someone may start, with their typed inputs (name, type, required, default, " +
        "choice options). A pipeline that only runs on pushes and pull requests is in neither " +
        "list; list_ci_runs shows those by the jobs of their runs. `readError` says why the " +
        "last read failed or which files did not parse. To start a manual pipeline, pass its " +
        "repository's `installationId` and `repoFullName` and the pipeline's `file` to " +
        "start_ci_run.",
      inputSchema: {
        repoFullName: Schema.optionalKey(
          Schema.String.annotate({
            description: "Only this repository (`owner/name`). Omit for every repository.",
          }),
        ),
      },
      risk: "read",
      permission: "ci:read",
      handler: async (input, auth) => {
        const repo = stringInput(input["repoFullName"])?.toLowerCase();
        const repos = (await listCiRepositories(auth.organizationId)).filter(
          (r) => repo === undefined || r.repoFullName.toLowerCase() === repo,
        );
        if (repo !== undefined && repos.length === 0) {
          return err(
            `No repository ${String(input["repoFullName"])} runs CI here. list_ci_repositories lists the ones that do.`,
          );
        }
        return ok({
          repositories: repos.map((r) => ({
            installationId: r.installationId,
            repoFullName: r.repoFullName,
            defaultBranch: r.defaultBranch,
            sha: r.sha,
            readAt: r.refreshedAt,
            readError: r.error,
            scheduled: r.pipelines,
            manual: r.manual ?? [],
          })),
        });
      },
    },

    {
      name: "list_ci_runs",
      title: "List CI runs",
      description:
        "CI runs, newest first, with what started them (`event`: push, pull-request, schedule, " +
        "manual), the repository, branch (`headRef`), commit, pull request number, status and " +
        "`statusReason`, timings (`createdAt`, `startedAt`, `finishedAt`), vCPU-seconds and " +
        "memory GiB-seconds used, `jobCounts` by status, and `failedJobs` (pipeline, id, name " +
        "and reason of each job that failed or errored). Statuses: awaiting_approval (a fork's " +
        "pull request waiting for approve_ci_run or reject_ci_run), queued, pending (waiting for " +
        "its concurrency group), running, passed, failed, error, rejected, cancelled, skipped. " +
        "Runs with nothing to run (`skipped`) are left out unless `status` is `skipped` or " +
        "`includeSkipped` is true, as in the CI tab. Pass a run's `id` to get_ci_run for its " +
        "jobs and to get_ci_job_log for a job's output. For the next page, pass the last run's " +
        "`id` as `before`; `nextBefore` is that id when there may be more.",
      inputSchema: {
        repoFullName: Schema.optionalKey(
          Schema.String.annotate({ description: "Only runs of this repository (`owner/name`)." }),
        ),
        branch: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "Only runs for this branch: a push's branch or a pull request's head branch.",
          }),
        ),
        status: Schema.optionalKey(
          Schema.Literals(CI_RUN_STATUSES).annotate({ description: "Only runs with this status." }),
        ),
        event: Schema.optionalKey(
          Schema.Literals(CI_EVENTS).annotate({ description: "Only runs started by this event." }),
        ),
        pullNumber: Schema.optionalKey(
          Schema.Int.annotate({ description: "Only runs of this pull request." }),
        ),
        includeSkipped: Schema.optionalKey(
          Schema.Boolean.annotate({
            description: "Also list runs that had nothing to run (`skipped`). Default false.",
          }),
        ),
        limit: Schema.optionalKey(
          Schema.Int.annotate({
            description: `Runs per page, 1 to ${MAX_RUN_LIMIT}. Default ${DEFAULT_RUN_LIMIT}.`,
          }),
        ),
        before: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "A run `id`: list the runs older than it (the previous page's `nextBefore`).",
          }),
        ),
      },
      risk: "read",
      permission: "ci:read",
      handler: async (input, auth) => {
        const limit = Math.min(
          Math.max(intInput(input["limit"]) ?? DEFAULT_RUN_LIMIT, 1),
          MAX_RUN_LIMIT,
        );
        const status = CI_RUN_STATUSES.find((s) => s === input["status"]);
        const event = CI_EVENTS.find((e) => e === input["event"]);
        const repo = stringInput(input["repoFullName"]);
        const branch = stringInput(input["branch"]);
        const pullNumber = intInput(input["pullNumber"]);
        const before = stringInput(input["before"]);
        const runs = await listRuns(auth.organizationId, {
          limit,
          ...(status ? { status } : {}),
          ...(input["includeSkipped"] === true ? { includeHidden: true } : {}),
          ...(repo ? { repo } : {}),
          ...(branch ? { branch } : {}),
          ...(event ? { event } : {}),
          ...(pullNumber !== undefined ? { pullNumber } : {}),
          ...(before ? { beforeRunId: before } : {}),
        });
        return ok({
          runs: runs.map(runListEntry),
          nextBefore: runs.length === limit ? (runs[runs.length - 1]?.id ?? null) : null,
        });
      },
    },

    {
      name: "get_ci_run",
      title: "Get CI run",
      description:
        "One CI run: everything list_ci_runs gives for it (status, `statusReason`, event, " +
        "repository, branch, commit, `githubUrl`, timings, vCPU-seconds and memory " +
        "GiB-seconds, the manual inputs it was started with, its concurrency groups, the run it " +
        "retries and its newest retry) plus each job: pipeline, `id`, name, status, `reason`, " +
        "`durationMs`, the jobs it waited for (`needs`), what it was lent (names only), its " +
        "cloud machine, how many lines of stdout and stderr it printed, and the files it kept " +
        "(`downloads`: path, size, expiry, whether text was masked). `cloudJobs` lists where " +
        "each cloud job ran. Job output comes from the runners' report once a run has finished; " +
        "while it runs, `jobs` is what the run knew when it started (or null), and " +
        "get_ci_job_log reads the live log. Pass a job's `id` (and its `pipeline` if two " +
        "pipelines share the id) to get_ci_job_log for its output.",
      inputSchema: { runId: runIdSchema },
      risk: "read",
      permission: "ci:read",
      handler: async (input, auth) => {
        try {
          const detail = await getRun(auth.organizationId, String(input["runId"]));
          const { jobs: summaries, ...run } = detail.run;
          // The output itself is get_ci_job_log's: a run's can run to megabytes.
          const jobs = detail.jobs
            ? detail.jobs.map(({ stdout, stderr, ...job }) => ({
                ...job,
                stdoutLines: lineCount(stdout),
                stderrLines: lineCount(stderr),
              }))
            : (summaries ?? null);
          return ok({
            run,
            jobs,
            outputAvailable: detail.jobs !== null,
            ...(detail.cloudJobs ? { cloudJobs: detail.cloudJobs } : {}),
          });
        } catch (e) {
          return ciError(e);
        }
      },
    },

    {
      name: "get_ci_job_log",
      title: "Get CI job log",
      description:
        "A page of one job's output, as the CI tab shows it: what the job printed with the " +
        "run's secrets masked by the runner. A finished run's output comes from its report " +
        "(`source: report`); a running run's from its live log so far (`source: live`, read for " +
        "a few seconds; call again for more). By default the last " +
        `${DEFAULT_LOG_LINES} lines of both stdout and stderr; pass \`stream\` for one, ` +
        `\`lines\` for a page size up to ${MAX_LOG_LINES}, and \`fromLine\` (1-based) to page ` +
        "from the start or step back: each page has `totalLines`, `fromLine`, `toLine`, " +
        "`moreBefore` and `moreAfter`. Get the run id from list_ci_runs and the job id (and " +
        "pipeline) from get_ci_run.",
      inputSchema: {
        runId: runIdSchema,
        jobId: Schema.String.annotate({ description: "The job's `id`, as get_ci_run lists it." }),
        pipeline: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "The job's `pipeline`, when more than one pipeline has a job with that id.",
          }),
        ),
        stream: Schema.optionalKey(
          Schema.Literals(["stdout", "stderr", "both"]).annotate({
            description: "Which output to page through. Default both.",
          }),
        ),
        lines: Schema.optionalKey(
          Schema.Int.annotate({
            description: `Lines per stream, 1 to ${MAX_LOG_LINES}. Default ${DEFAULT_LOG_LINES}.`,
          }),
        ),
        fromLine: Schema.optionalKey(
          Schema.Int.annotate({
            description: "The first line to return, counting from 1. Omit for the last lines.",
          }),
        ),
      },
      risk: "read",
      permission: "ci:read",
      handler: async (input, auth) => {
        const runId = String(input["runId"]);
        const jobId = String(input["jobId"]);
        const pipeline = stringInput(input["pipeline"]);
        const stream: Stream =
          input["stream"] === "stdout" || input["stream"] === "stderr" ? input["stream"] : "both";
        const count = Math.min(
          Math.max(intInput(input["lines"]) ?? DEFAULT_LOG_LINES, 1),
          MAX_LOG_LINES,
        );
        const fromLine = intInput(input["fromLine"]);
        try {
          const detail = await getRun(auth.organizationId, runId);
          const run = detail.run;
          const header = { runId: run.id, runStatus: run.status };
          if (detail.jobs) {
            const found = matchJobs(detail.jobs, jobId, pipeline);
            if (found.length === 0) return noSuchJob(jobId, detail.jobs);
            if (found.length > 1) return ambiguousJob(jobId, found);
            const job = found[0]!;
            return ok({
              ...header,
              source: "report",
              pipeline: job.pipeline,
              jobId: job.id,
              jobName: job.name,
              jobStatus: job.status,
              reason: job.reason,
              durationMs: job.durationMs,
              ...streamPages(
                { stdout: splitLines(job.stdout), stderr: splitLines(job.stderr) },
                stream,
                count,
                fromLine,
              ),
            });
          }
          if (run.status !== "running") {
            return err(
              run.finishedAt
                ? "The runners no longer have this run's report, so its jobs' output is gone."
                : `The run has not started (${run.status}); it has no output yet.`,
            );
          }
          const live = await readLiveLog((signal) =>
            openRunLogs(auth.organizationId, runId, signal),
          );
          const state = reduceCiLogEvents(emptyCiLiveRun(), live.events);
          const jobs = Object.values(state.jobs);
          const found = matchJobs(jobs, jobId, pipeline);
          if (found.length === 0) {
            if (jobs.length === 0) {
              return err("The run's live log has no job output yet. Try again in a few seconds.");
            }
            return noSuchJob(jobId, jobs);
          }
          if (found.length > 1) return ambiguousJob(jobId, found);
          const job = found[0]!;
          return ok({
            ...header,
            source: "live",
            pipeline: job.pipeline,
            jobId: job.id,
            jobName: job.name,
            jobStatus: job.status,
            durationMs: job.durationMs,
            ...streamPages(liveLines(job), stream, count, fromLine),
            ...(state.truncated
              ? { runnerTruncated: "The runner dropped output past its log limit." }
              : {}),
            ...(live.cut
              ? {
                  incomplete:
                    "The live log is longer than one call reads; the rest is in the run's report once it finishes.",
                }
              : {}),
          });
        } catch (e) {
          return ciError(e);
        }
      },
    },

    {
      name: "start_ci_run",
      title: "Start CI run",
      description:
        "Start a pipeline that declares `on.manual`, on a branch of the repository itself, with " +
        "its inputs: the CI tab's Manual runs card. The run is trusted like a push to that " +
        "branch, so it gets the repository's secrets and what is lent to that branch, and it " +
        "runs the pipeline file as the branch's head has it. Get `installationId`, " +
        "`repoFullName`, the pipeline `file` and its inputs from list_ci_pipelines. Inputs " +
        "left out take the pipeline's defaults; a required one must be given. Returns the new " +
        "run (pass its `id` to get_ci_run). Audit-logged with the inputs.",
      inputSchema: {
        installationId: Schema.Int.annotate({
          description: "The repository's `installationId`, from list_ci_pipelines.",
        }),
        repoFullName: Schema.String.annotate({ description: "`owner/name`." }),
        pipelineFile: Schema.String.annotate({
          description: "The pipeline's `file`, e.g. `.infrawrench/ci/deploy.yml`.",
        }),
        branch: Schema.optionalKey(
          Schema.String.annotate({
            description: "A branch of the repository. Default: its default branch.",
          }),
        ),
        inputs: Schema.optionalKey(
          Schema.Record(
            Schema.String,
            Schema.Union([Schema.String, Schema.Boolean, Schema.Finite]),
          ).annotate({
            description: "Input values by name: text, true/false for a boolean, a number.",
          }),
        ),
      },
      risk: "destructive",
      permission: "ci:approve",
      openWorld: true,
      handler: async (input, auth) => {
        const installationId = intInput(input["installationId"]);
        if (installationId === undefined) return err("installationId must be a number.");
        const branch = stringInput(input["branch"]);
        const given = input["inputs"];
        try {
          const run = await startManualRun(auth.organizationId, auth.userId, auth.email ?? null, {
            installationId,
            repoFullName: String(input["repoFullName"] ?? ""),
            pipelineFile: String(input["pipelineFile"] ?? ""),
            ...(branch ? { branch } : {}),
            ...(given && typeof given === "object"
              ? { inputs: { ...(given as Record<string, CiInputValue>) } }
              : {}),
          });
          dispatchSoon(run.id);
          audit(auth, "ci.run.start", run.id, {
            repo: run.repoFullName,
            pipeline: run.pipelineFile ?? input["pipelineFile"],
            branch: run.headRef,
            sha: run.sha,
            inputs: run.inputs ?? {},
          });
          return ok(runListEntry(run));
        } catch (e) {
          return ciError(e);
        }
      },
    },

    {
      name: "retry_ci_run",
      title: "Retry CI run",
      description:
        "Run a finished run (passed, failed, error or cancelled) again: a new run of the same " +
        "repository, commit, branch, event and inputs, linked to the one it retries. There is " +
        "no retry of single jobs; jobs with `task-cache:` whose inputs did not change are " +
        "answered from the cache, which never keeps a failure, so in practice the failed ones " +
        "run again. Set `noTaskCache` to run every job. A fork's run is retried without " +
        "secrets, and retrying it counts as approving that code again. A run awaiting " +
        "approval is approved with approve_ci_run instead. Returns the new run (its `id` for " +
        "get_ci_run).",
      inputSchema: {
        runId: runIdSchema,
        noTaskCache: Schema.optionalKey(
          Schema.Boolean.annotate({
            description: "Run every `task-cache:` job instead of reading the cache. Default false.",
          }),
        ),
      },
      risk: "destructive",
      permission: "ci:approve",
      openWorld: true,
      handler: async (input, auth) => {
        const runId = String(input["runId"]);
        const noTaskCache = input["noTaskCache"] === true;
        try {
          const run = await retryRun(auth.organizationId, runId, auth.userId, { noTaskCache });
          dispatchSoon(run.id);
          audit(auth, "ci.run.retry", run.id, {
            retryOf: runId,
            repo: run.repoFullName,
            noTaskCache,
          });
          return ok(runListEntry(run));
        } catch (e) {
          return ciError(e);
        }
      },
    },

    {
      name: "cancel_ci_run",
      title: "Cancel CI run",
      description:
        "Cancel a queued, pending or running run. One that has not started ends at once; a " +
        "running one is stopped by its runner and reads `cancelRequested: true` until the next " +
        "poll finds it cancelled (a few seconds). A run awaiting approval is rejected with " +
        "reject_ci_run instead. Returns the run.",
      inputSchema: { runId: runIdSchema },
      risk: "destructive",
      permission: "ci:approve",
      openWorld: true,
      handler: async (input, auth) => {
        const runId = String(input["runId"]);
        try {
          const run = await cancelRun(auth.organizationId, runId);
          audit(auth, "ci.run.cancel", runId, { repo: run.repoFullName, status: run.status });
          return ok(runListEntry(run));
        } catch (e) {
          return ciError(e);
        }
      },
    },

    {
      name: "approve_ci_run",
      title: "Approve CI run",
      description:
        "Approve a pull request run from a fork that is `awaiting_approval`, for that one " +
        "commit: it runs the fork's code, without the repository's secrets. Read the change " +
        "first (`githubUrl` on the run). A newer commit to the pull request waits again.",
      inputSchema: { runId: runIdSchema },
      risk: "destructive",
      permission: "ci:approve",
      openWorld: true,
      handler: async (input, auth) => {
        const runId = String(input["runId"]);
        try {
          await approveRun(auth.organizationId, runId, auth.userId);
          dispatchSoon(runId);
          audit(auth, "ci.run.approve", runId);
          return ok({ ok: true, runId, status: "queued" });
        } catch (e) {
          return ciError(e);
        }
      },
    },

    {
      name: "reject_ci_run",
      title: "Reject CI run",
      description:
        "Reject a pull request run from a fork that is `awaiting_approval`: it never runs, and " +
        "its GitHub check closes as not approved. A rejected run cannot be retried; a newer " +
        "commit to the pull request asks again.",
      inputSchema: { runId: runIdSchema },
      risk: "destructive",
      permission: "ci:approve",
      openWorld: true,
      handler: async (input, auth) => {
        const runId = String(input["runId"]);
        try {
          await rejectRun(auth.organizationId, runId, auth.userId);
          audit(auth, "ci.run.reject", runId);
          return ok({ ok: true, runId, status: "rejected" });
        } catch (e) {
          return ciError(e);
        }
      },
    },

    {
      name: "list_ci_values",
      title: "List CI secret and variable names",
      description:
        "The names of the CI secrets and variables set for a GitHub account (an installation) " +
        "or one of its repositories, with when each was last set. Names only: a secret's value " +
        "can never be read back, and variable values are left out here too. Pipelines read " +
        "them as `${{ secrets.NAME }}` and `${{ vars.NAME }}`. Get `installationId` from " +
        "list_ci_repositories. Setting values is done in the CI tab.",
      inputSchema: {
        installationId: Schema.Int.annotate({
          description: "The GitHub App installation, from list_ci_repositories.",
        }),
        repo: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "A repository's name (without the owner) for its own values. Omit for the account's.",
          }),
        ),
      },
      risk: "read",
      permission: "ci:write",
      handler: async (input, auth) => {
        const installationId = intInput(input["installationId"]);
        if (installationId === undefined || installationId <= 0) {
          return err("installationId must be a GitHub App installation id.");
        }
        try {
          const values = await listCiValues(
            auth.organizationId,
            installationId,
            stringInput(input["repo"]) ?? null,
          );
          return ok({
            installationId: values.installationId,
            repo: values.repo,
            secrets: values.secrets.map((s) => ({ name: s.name, updatedAt: s.updatedAt })),
            variables: values.variables.map((v) => ({ name: v.name, updatedAt: v.updatedAt })),
          });
        } catch (e) {
          return ciError(e);
        }
      },
    },

    {
      name: "get_ci_access",
      title: "Get CI access settings",
      description:
        "What CI jobs may use, read-only: `connections` (each connected account's CI settings: " +
        "whether cloud jobs may run on it and of which kinds, whether it is lent to jobs that " +
        "name it in `connections:`, the repositories and branch pattern each applies to, and " +
        "its permission checks), `grants` (resources lent to CI by a CI name: which outputs, a " +
        "secret version, or the resource as a peer connection, and for which repositories and " +
        "branches) and `sshKeys` (members' SSH keys lent to CI). No credential or value is " +
        "included. Changing these is done in the CI tab.",
      inputSchema: {},
      risk: "read",
      permission: "ci:read",
      handler: async (_input, auth) => {
        const { connections, grants, sshKeys } = await ciAccessOverview(
          auth.organizationId,
          auth.agentRegistrationId ? null : auth.userId,
        );
        return ok({ connections, grants, sshKeys });
      },
    },

    {
      name: "get_ci_usage",
      title: "Get CI usage",
      description:
        "What CI used in a month: runs (not counting ones with nothing to run), vCPU-seconds, " +
        "memory GiB-seconds and storage GiB-hours, and `storageBytes` stored now when the " +
        "runners answered. Quantities, not money.",
      inputSchema: {
        month: Schema.optionalKey(
          Schema.String.check(pattern(/^\d{4}-\d{2}$/)).annotate({
            description: "`YYYY-MM`, in UTC. Default: this month.",
          }),
        ),
      },
      risk: "read",
      permission: "ci:read",
      handler: async (input, auth) => {
        const month = stringInput(input["month"]);
        return ok(await ciUsage(auth.organizationId, month));
      },
    },
  ];
}
