/**
 * One GitHub check per job of a CI run, beside the run's own check, so a
 * commit or pull request lists each job with its own tick as it starts and
 * finishes.
 *
 * A job is a job key of a pipeline: the entries of a matrix and the
 * packages of a `packages:` job share one check (`Test / build`), as they
 * share a box on the run page. One per entry would post hundreds of checks
 * for a monorepo's pipeline and spend the installation's API budget on
 * every poll. The run's own check (`checks.ts`) stays the one result a
 * branch protection rule requires.
 *
 * While the run is going the checks come from the runner's progress (each
 * pipeline's plan and its jobs' states so far); once it has finished, from
 * its report. Each poll calls GitHub only for a check whose state changed:
 * the state last sent is kept with the run (`ci_runs.job_checks`).
 * Best-effort, like the run's check: an installation without
 * `checks: write` still runs CI.
 */
import { eq } from "drizzle-orm";
import type { CiJobSummary } from "@infrawrench/client-core";

import { orgAppUrl } from "../app-url.js";
import { db } from "../db/client.js";
import { ciRuns } from "../db/schema.js";
import { githubInstallationFetch } from "../github/app.js";

/** What the runner reports of a running run (`GET /v1/runs/{id}`'s `progress`). */
export interface ProxyProgress {
  pipelines?: Array<{
    name?: string;
    jobs?: Array<{ key?: string; name?: string; ids?: string[] | null }>;
    states?: Record<string, { status?: string; duration_ms?: number; cached?: boolean }>;
  }>;
}

export type JobEntryStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "error";

export interface JobEntry {
  name: string;
  status: JobEntryStatus;
  durationMs: number | null;
  cached: boolean;
}

/** One check's worth: a job key of a pipeline and its entries. */
export interface JobGroup {
  pipeline: string;
  key: string;
  /** The job's name, or for several entries its key. */
  name: string;
  entries: JobEntry[];
}

/** The most job checks one run gets; past it the run's own check still says everything. */
export const MAX_JOB_CHECKS = 50;

const FINISHED: readonly string[] = ["passed", "failed", "skipped", "error"];

/**
 * The key a group's check is kept under in `ci_runs.job_checks`. A JSON
 * pair, not the two joined with a separator: Postgres refuses `\u0000` in a
 * `jsonb` value, and a pipeline's name may hold any other character.
 */
export function jobCheckKey(pipeline: string, key: string): string {
  return JSON.stringify([pipeline, key]);
}

/** `build[app/packages/ui]` and `test[1,2]` belong to `build` and `test`. */
function baseKey(id: string): string {
  const bracket = id.indexOf("[");
  return bracket === -1 ? id : id.slice(0, bracket);
}

function entryStatus(status: string | undefined): JobEntryStatus {
  if (status === undefined) return "pending";
  if (status === "running") return "running";
  return (FINISHED.includes(status) ? status : "error") as JobEntryStatus;
}

function addTo(
  groups: Map<string, JobGroup>,
  pipeline: string,
  key: string,
  name: string,
  entry: JobEntry,
) {
  const id = jobCheckKey(pipeline, key);
  let group = groups.get(id);
  if (!group) {
    group = { pipeline, key, name, entries: [] };
    groups.set(id, group);
  }
  group.entries.push(entry);
  if (group.entries.length > 1) group.name = key;
}

/** A running run's jobs, from the runner's progress: every planned job, waiting until it starts. */
export function groupsFromProgress(progress: ProxyProgress): JobGroup[] {
  const groups = new Map<string, JobGroup>();
  for (const pipeline of progress.pipelines ?? []) {
    const name = pipeline.name ?? "";
    const states = pipeline.states ?? {};
    for (const job of pipeline.jobs ?? []) {
      if (!job.key) continue;
      const key = baseKey(job.key);
      // A matrix that waits on another job's outputs has no ids yet: its
      // entries are whatever has started.
      const ids =
        job.ids ?? Object.keys(states).filter((id) => baseKey(id) === key && id !== job.key);
      const entries = ids.length > 0 ? ids : [job.key];
      for (const id of entries) {
        // A key skipped or failed as a whole reports under the key itself.
        const state = states[id] ?? states[job.key];
        const entryName = entries.length === 1 ? (job.name ?? id) : id;
        addTo(groups, name, key, entryName, {
          name: entryName,
          status: entryStatus(state?.status),
          durationMs: state?.duration_ms ?? null,
          cached: state?.cached === true,
        });
      }
    }
  }
  return [...groups.values()];
}

/** A finished run's jobs, from its report. */
export function groupsFromJobs(jobs: readonly CiJobSummary[], cachedReason: string): JobGroup[] {
  const groups = new Map<string, JobGroup>();
  for (const job of jobs) {
    addTo(groups, job.pipeline, baseKey(job.id), job.name, {
      name: job.name,
      status: job.status,
      durationMs: job.durationMs,
      cached: job.reason === cachedReason,
    });
  }
  return [...groups.values()];
}

function seconds(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const MARK: Record<JobEntryStatus, string> = {
  pending: "⏳",
  running: "🔄",
  passed: "✅",
  failed: "❌",
  error: "❌",
  skipped: "⏭️",
};

export interface JobCheckState {
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "skipped";
  title: string;
  summary: string;
}

/** What a group's check says: waiting, going, or how it finished. */
export function jobCheckState(group: JobGroup): JobCheckState {
  const count = (s: JobEntryStatus) => group.entries.filter((e) => e.status === s).length;
  const total = group.entries.length;
  const failed = count("failed") + count("error");
  const passed = count("passed");
  const skipped = count("skipped");
  const pending = count("pending");
  const running = count("running");
  const done = passed + failed + skipped;
  const status: JobCheckState["status"] =
    done === total ? "completed" : pending === total ? "queued" : "in_progress";
  const conclusion =
    status !== "completed"
      ? undefined
      : failed > 0
        ? "failure"
        : skipped === total
          ? "skipped"
          : "success";
  let title: string;
  if (total === 1) {
    const only = group.entries[0]!;
    const time = seconds(only.durationMs);
    title =
      only.status === "pending"
        ? "Waiting"
        : only.status === "running"
          ? "Running"
          : only.status === "skipped"
            ? "Skipped"
            : only.cached
              ? "Passed (from the task cache)"
              : only.status === "passed"
                ? `Passed in ${time}`
                : `Failed after ${time}`;
  } else {
    const parts = [`${passed} of ${total} passed`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (running > 0) parts.push(`${running} running`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    title = parts.join(", ");
  }
  const rows = group.entries.map(
    (e) =>
      `| ${MARK[e.status]} | ${e.name.replace(/\|/g, "\\|")} | ${seconds(e.durationMs)}${e.cached ? " (cached)" : ""} |`,
  );
  const summary = ["| | Job | Time |", "|---|---|---|", ...rows].join("\n");
  return { status, ...(conclusion ? { conclusion } : {}), title, summary };
}

export function jobCheckName(group: JobGroup, event: "push" | "pull-request"): string {
  return `${group.pipeline} / ${group.name} (${event === "pull-request" ? "pull request" : "push"})`;
}

/** A short fingerprint of what a check says, to tell whether it changed. */
function fingerprint(state: JobCheckState): string {
  const text = `${state.status}|${state.conclusion ?? ""}|${state.title}|${state.summary}`;
  // FNV-1a: small, and the same everywhere this runs.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${state.status}:${hash.toString(16)}`;
}

export interface JobCheckTarget {
  id: string;
  organizationId: string;
  installationId: number;
  repoFullName: string;
  sha: string;
  event: "push" | "pull-request";
  jobChecks: Record<string, { id: number; sent: string }>;
}

/** Brings the run's job checks up to date with `groups`, calling GitHub only for what changed. */
export async function syncJobChecks(
  run: JobCheckTarget,
  groups: readonly JobGroup[],
): Promise<void> {
  const repo = run.repoFullName.split("/").map(encodeURIComponent).join("/");
  const detailsUrl = orgAppUrl(run.organizationId, `ci/${run.id}`);
  const next = { ...run.jobChecks };
  let changed = false;
  for (const group of groups.slice(0, MAX_JOB_CHECKS)) {
    const key = jobCheckKey(group.pipeline, group.key);
    const state = jobCheckState(group);
    const sent = fingerprint(state);
    const known = next[key];
    if (known?.sent === sent) continue;
    const now = new Date().toISOString();
    const body: Record<string, unknown> = {
      status: state.status,
      output: { title: state.title.slice(0, 255), summary: state.summary.slice(0, 65_000) },
      ...(detailsUrl ? { details_url: detailsUrl } : {}),
      ...(state.status === "in_progress" && !known?.sent.startsWith("in_progress")
        ? { started_at: now }
        : {}),
      ...(state.status === "completed"
        ? { conclusion: state.conclusion ?? "neutral", completed_at: now }
        : {}),
    };
    try {
      if (!known) {
        const res = await githubInstallationFetch(run.installationId, `/repos/${repo}/check-runs`, {
          method: "POST",
          body: JSON.stringify({
            name: jobCheckName(group, run.event),
            head_sha: run.sha,
            external_id: `${run.id}:${group.pipeline}:${group.key}`.slice(0, 255),
            ...body,
          }),
        });
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        const created = (await res.json()) as { id?: number };
        if (typeof created.id !== "number") continue;
        next[key] = { id: created.id, sent };
      } else {
        const res = await githubInstallationFetch(
          run.installationId,
          `/repos/${repo}/check-runs/${known.id}`,
          { method: "PATCH", body: JSON.stringify(body) },
        );
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        next[key] = { id: known.id, sent };
      }
      changed = true;
    } catch (err) {
      console.warn(
        `[ci] could not update the GitHub check of ${group.key} for run ${run.id}:`,
        err,
      );
    }
  }
  if (changed) {
    run.jobChecks = next;
    // Best-effort like the rest: a run's own check must still be finished
    // when this cannot be kept (the next poll then creates the checks again).
    try {
      await db.update(ciRuns).set({ jobChecks: next }).where(eq(ciRuns.id, run.id));
    } catch (err) {
      console.warn(`[ci] could not keep the job checks of run ${run.id}:`, err);
    }
  }
}
