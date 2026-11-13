/**
 * CI runs: recorded from GitHub App webhooks, dispatched to the CI proxy,
 * followed until they finish, and reported back to GitHub as a check run.
 *
 * Who gets what:
 * - A push, or a pull request from a branch of the repository itself, runs
 *   at once, trusted: the proxy gives it the organization's and repository's
 *   secrets.
 * - A pull request from a fork waits for a maintainer (`awaiting_approval`,
 *   an "Action required" check on GitHub) and, once approved, runs untrusted:
 *   the request never carries `trusted`, so the proxy gives it no secrets.
 *   Approval is for one commit: a new push to the fork waits again, and the
 *   older commit's wait is closed.
 * - Pull request runs use `pull/<n>` as their branch, which is what the
 *   runner keys caches on, so a fork can never write a cache that the
 *   repository's own branches, or another pull request, would restore.
 * - A pipeline's `on.schedule` cron starts a run from the poller pass
 *   (`schedules.ts`): trusted like a push to the default branch, whose
 *   caches it shares, and carrying that one pipeline's text.
 *
 * Dispatch claims the row first (one UPDATE that only one caller can win),
 * because both the webhook and the poller pass dispatch.
 */
import { and, desc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  CI_CANCELLABLE_STATUSES,
  CI_RETRYABLE_STATUSES,
  type CiCloudJob,
  type CiDownload,
  type CiDownloadLink,
  type CiJobOutput,
  type CiJobSummary,
  type CiRun,
  type CiRunDetail,
  type CiRunStatus,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { accounts, ciAccounts, ciCloudJobs, ciRuns, githubInstallations } from "../db/schema.js";
import { planAccess } from "../entitlements.js";
import { orgHasFeature } from "../features.js";
import { getInstallationToken } from "../github/app.js";
import { upsertCheck } from "./checks.js";
import { admitRun, resendCancels, resolveConcurrency, sendCancel } from "./concurrency.js";
import {
  abandonJobChecks,
  groupsFromJobs,
  groupsFromProgress,
  syncJobChecks,
} from "./job-checks.js";
import type { CiEvent } from "./events.js";
import { ownerKey, repoKey } from "./events.js";
import { DownloadLinkError, downloadLink, toDownload } from "./downloads.js";
import { CiProxyError, proxyFetch, proxyJson, type ProxyRun } from "./proxy.js";
import { pluginCodeAvailable } from "../plugin-loader.js";
import type { CiJobAccess } from "../db/schema.js";
import { noteRepository } from "./schedules.js";

type CiRunRow = typeof ciRuns.$inferSelect;

/** How long a claim on a queued run lasts before another dispatcher may retry it. */
const CLAIM_MS = 2 * 60_000;
/** Dispatch attempts (busy or unreachable runners) before a run is given up on. */
const MAX_ATTEMPTS = 40;
/** A run the runners have not reported on for this long is given up on. */
const LOST_AFTER_MS = 2 * 60 * 60_000;
/**
 * A run its runner answers 404 for, this long after it started, is gone:
 * the read names the owner, so a finished run is found in the store, and a
 * running one is in the runner's memory. A runner that restarts (a crash,
 * a deploy) loses what it was running. The wait covers a read racing the
 * dispatch, never a live run.
 */
const GONE_AFTER_MS = 2 * 60_000;
const GONE_REASON =
  "The runner restarted while this run was going, and the run went with it. Retry it from the CI tab, or push again.";
/** Finished runs whose report the runners keep, with each job's output. */
const FINISHED_WITH_REPORT: readonly CiRunStatus[] = ["passed", "failed", "cancelled"];
const CANCELLED_BY_PERSON = "Cancelled from Infrawrench.";

function cancelledCheck(reason: string) {
  return {
    status: "completed",
    conclusion: "cancelled",
    title: "Cancelled",
    summary: reason,
  } as const;
}

/** Why a finished run was cancelled: a person, or a newer run of one of its groups. */
function cancelledReason(row: CiRunRow): string {
  if (row.cancelRequestedAt) return CANCELLED_BY_PERSON;
  const group = (row.concurrency ?? []).find((e) => e.cancelled)?.group;
  return group ? `Cancelled by a newer run of its concurrency group \`${group}\`.` : "Cancelled.";
}

/** A fork's run nobody approved in this long is closed. */
export const APPROVAL_EXPIRES_MS = 14 * 24 * 60 * 60_000;

export class CiInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "CiInputError";
  }
}

/** The organization that connected `installationId` and runs CI for it, if any. */
async function ciOrganization(installationId: number): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: ciAccounts.organizationId })
    .from(ciAccounts)
    .innerJoin(
      githubInstallations,
      and(
        eq(githubInstallations.installationId, ciAccounts.installationId),
        eq(githubInstallations.organizationId, ciAccounts.organizationId),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .where(eq(ciAccounts.installationId, installationId))
    .limit(1);
  if (!row) return null;
  return (await orgHasFeature(row.organizationId, "ci")) ? row.organizationId : null;
}

/**
 * Records the run a webhook delivery asks for. Returns it, or `null` when
 * the delivery starts nothing (CI off, account not chosen, a redelivery).
 */
export async function acceptCiEvent(
  ev: CiEvent,
): Promise<{ id: string; status: CiRunStatus } | null> {
  const organizationId = await ciOrganization(ev.installationId);
  if (!organizationId) return null;
  const isPull = ev.kind === "pull_request";
  // Where its `on.schedule` pipelines are fired from: a push to the default
  // branch is the only way they change, so it re-reads them.
  await noteRepository({
    organizationId,
    installationId: ev.installationId,
    repoFullName: ev.repoFullName,
    defaultBranch: ev.defaultBranch,
    refreshNow: !isPull && ev.branch === ev.defaultBranch,
  }).catch((err) => console.warn(`[ci] noting ${ev.repoFullName} for schedules failed:`, err));
  const sha = isPull ? ev.headSha : ev.sha;
  const status: CiRunStatus = isPull && ev.fromFork ? "awaiting_approval" : "queued";
  const dedupeKey = isPull
    ? `pr:${ev.installationId}:${ev.repoFullName.toLowerCase()}:${ev.number}:${sha}`
    : `push:${ev.installationId}:${ev.repoFullName.toLowerCase()}:${ev.branch}:${sha}`;
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(ciRuns)
    .values({
      id,
      organizationId,
      installationId: ev.installationId,
      repoFullName: ev.repoFullName,
      ownerKey: ownerKey(ev.repoFullName),
      repoKey: repoKey(ev.repoFullName),
      event: isPull ? "pull-request" : "push",
      branch: isPull ? `pull/${ev.number}` : ev.branch,
      headRef: isPull ? ev.headRef : ev.branch,
      defaultBranch: ev.defaultBranch,
      sha,
      baseSha: isPull ? ev.baseSha : null,
      pullNumber: isPull ? ev.number : null,
      headRepoFullName: isPull ? ev.headRepoFullName : null,
      fromFork: isPull && ev.fromFork,
      actorLogin: ev.actorLogin,
      status,
      dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: ciRuns.id });
  if (!row) return null;

  if (isPull) {
    // An older commit of the same pull request no longer needs approving.
    await db
      .update(ciRuns)
      .set({
        status: "rejected",
        statusReason: "A newer commit was pushed to the pull request.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ciRuns.organizationId, organizationId),
          eq(ciRuns.installationId, ev.installationId),
          eq(ciRuns.repoFullName, ev.repoFullName),
          eq(ciRuns.pullNumber, ev.number),
          eq(ciRuns.status, "awaiting_approval"),
          ne(ciRuns.id, row.id),
        ),
      );
  }
  return { id: row.id, status };
}

async function load(id: string): Promise<CiRunRow | null> {
  const [row] = await db.select().from(ciRuns).where(eq(ciRuns.id, id)).limit(1);
  return row ?? null;
}

async function finish(
  row: CiRunRow,
  status: "passed" | "failed" | "error" | "rejected" | "cancelled",
  reason: string | null,
  extra: Partial<typeof ciRuns.$inferInsert> = {},
): Promise<void> {
  const now = new Date();
  await db
    .update(ciRuns)
    .set({ status, statusReason: reason, finishedAt: now, updatedAt: now, ...extra })
    .where(eq(ciRuns.id, row.id));
  // Its cloud jobs' machines go with it: the executor's pass tears them down.
  await db
    .update(ciCloudJobs)
    .set({
      state: "tearing_down",
      outcome: sql`coalesce(${ciCloudJobs.outcome}, 'cancelled')`,
      reason: sql`coalesce(${ciCloudJobs.reason}, 'The run ended.')`,
      encryptedClaim: null,
      claimIv: null,
      finishedAt: now,
      nextAttemptAt: now,
      updatedAt: now,
    })
    .where(and(eq(ciCloudJobs.runId, row.id), inArray(ciCloudJobs.state, ["starting", "running"])));
}

/** Shows a fork's run on GitHub as waiting for a maintainer. */
export async function announceAwaitingApproval(id: string): Promise<void> {
  const row = await load(id);
  if (!row || row.status !== "awaiting_approval") return;
  await upsertCheck(row, {
    status: "completed",
    conclusion: "action_required",
    title: "Waiting for a maintainer",
    summary:
      `This pull request comes from a fork (${row.headRepoFullName ?? "a deleted repository"}), ` +
      "so CI runs only after a maintainer approves this commit in Infrawrench. It will run without secrets.",
  });
}

/**
 * Sends a queued run to the proxy. Claims it first, so the webhook and the
 * poller never both dispatch it; a busy or unreachable runner pool leaves it
 * queued for the next attempt.
 */
/**
 * The CI proxy's `POST /v1/runs` body for a run. A push and a pull request
 * from the repository itself run with secrets; a fork's pull request is never
 * sent `trusted`, so the proxy gives it none. The token only clones: the
 * runner never hands it to a job.
 */
export function dispatchBody(
  row: Pick<
    CiRunRow,
    | "repoFullName"
    | "sha"
    | "branch"
    | "event"
    | "ownerKey"
    | "repoKey"
    | "defaultBranch"
    | "pullNumber"
    | "baseSha"
    | "fromFork"
    | "noTaskCache"
    | "pipelineText"
  >,
  token: string,
): Record<string, unknown> {
  const isPull = row.event === "pull-request";
  const body: Record<string, unknown> = {
    repo: `https://github.com/${row.repoFullName}.git`,
    sha: row.sha,
    branch: row.branch,
    event: row.event,
    owner: row.ownerKey,
    "repo-id": row.repoKey,
    "default-branch": row.defaultBranch,
    token,
  };
  if (isPull) {
    body["ref"] = `refs/pull/${row.pullNumber}/head`;
    if (row.baseSha) body["base"] = row.baseSha;
    // Only a pull request from the repository itself is trusted with
    // secrets. A fork's request carries no `trusted`, and no secrets of its
    // own, so the proxy gives it none.
    if (!row.fromFork) body["trusted"] = true;
  }
  // A scheduled run runs the one pipeline whose cron fired, as read from
  // `sha`, not every pipeline of the commit with `on.schedule`.
  if (row.pipelineText !== null) body["pipeline"] = row.pipelineText;
  // Only when asked: a runner before 0.3.8 refuses fields it does not know.
  if (row.noTaskCache) body["no-task-cache"] = true;
  return body;
}

export async function dispatchRun(id: string): Promise<void> {
  const now = new Date();
  const [row] = await db
    .update(ciRuns)
    .set({
      attempts: sql`${ciRuns.attempts} + 1`,
      nextAttemptAt: new Date(now.getTime() + CLAIM_MS),
      updatedAt: now,
    })
    .where(and(eq(ciRuns.id, id), eq(ciRuns.status, "queued"), lte(ciRuns.nextAttemptAt, now)))
    .returning();
  if (!row) return;

  if (!(await orgHasFeature(row.organizationId, "ci"))) {
    await finish(row, "error", "CI is not turned on for this organization.");
    return;
  }
  if (!(await planAccess(row.organizationId)).paid) {
    await finish(row, "error", "CI needs a paid plan.");
    await upsertCheck(row, {
      status: "completed",
      conclusion: "neutral",
      title: "Not run",
      summary: "CI needs a paid Infrawrench plan.",
    });
    return;
  }

  // A run whose jobs are lent something is sent where plugin code runs; on
  // the edge it waits for the gateway's pass, before spending a token on it.
  if (!row.fromFork && namesSomethingLent(row.access) && !pluginCodeAvailable()) {
    await deferToGateway(row);
    return;
  }

  let token: string;
  try {
    token = await getInstallationToken(row.installationId);
  } catch (err) {
    await retryLater(row, `GitHub refused an installation token: ${String(err)}`);
    return;
  }
  const body = dispatchBody(row, token);

  // Its pipelines' concurrency groups, and what its jobs name to be lent,
  // read once, before it first goes.
  let access = row.access;
  if (row.concurrency === null) {
    const resolved = await resolveConcurrency(body);
    if ("retry" in resolved) {
      await retryLater(row, resolved.retry);
      return;
    }
    const { entries } = resolved;
    access = resolved.access;
    await db.update(ciRuns).set({ access }).where(eq(ciRuns.id, row.id));
    if (entries.some((e) => e.group !== null)) {
      if (!(await admitRun(row, entries))) return;
    } else {
      await db.update(ciRuns).set({ concurrency: entries }).where(eq(ciRuns.id, row.id));
    }
  }

  // Connections, SSH keys and resources its jobs name, checked and read now
  // (never for a fork's run). Reading them calls plugins, which the edge
  // cannot: there the run waits for the gateway's pass to send it.
  if (!row.fromFork && namesSomethingLent(access)) {
    if (!pluginCodeAvailable()) {
      await deferToGateway(row);
      return;
    }
    // Loaded here: lending reaches plugin code, which only this branch needs.
    const { auditLends, buildLent, fitLent } = await import("./lend.js");
    const built = await buildLent(row, access);
    if (built) {
      // Audited as soon as it is minted or read, whatever happens to the
      // request next (a proxy that times out, a cancel while it is sent).
      await auditLends(row, built.records);
      body["lent"] = fitLent(built.lent, Buffer.byteLength(JSON.stringify(body), "utf8"));
    }
  }

  let res: Response;
  try {
    res = await proxyFetch("/v1/runs", { method: "POST", body: JSON.stringify(body) });
  } catch (err) {
    await retryLater(row, `The CI proxy did not answer: ${String(err)}`);
    return;
  }
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel();
    await retryLater(row, `Every runner was busy (${res.status}).`);
    return;
  }
  const answer = (await res.json().catch(() => ({}))) as { id?: unknown; error?: unknown };
  if (!res.ok || typeof answer.id !== "string") {
    const reason =
      typeof answer.error === "string" ? answer.error : `The CI proxy answered ${res.status}.`;
    await finish(row, "error", reason);
    await upsertCheck(row, {
      status: "completed",
      conclusion: "failure",
      title: "Could not start",
      summary: reason,
    });
    return;
  }
  const [started] = await db
    .update(ciRuns)
    .set({ status: "running", proxyRunId: answer.id, startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(ciRuns.id, row.id), eq(ciRuns.status, "queued")))
    .returning();
  if (!started) {
    // Cancelled while it was being sent: the runner has it, so stop it there.
    await sendCancel(answer.id);
    await db.update(ciRuns).set({ proxyRunId: answer.id }).where(eq(ciRuns.id, row.id));
    return;
  }
  // Pipelines a newer run cancelled before this one started.
  await resendCancels(started);
  await upsertCheck(row, {
    status: "in_progress",
    title: "Running",
    summary: row.fromFork ? "Running a fork's pull request, without secrets." : "Running.",
  });
}

/** Leaves a run for the gateway's `ci-cloud` pass, without counting an attempt. */
async function deferToGateway(row: CiRunRow): Promise<void> {
  await db
    .update(ciRuns)
    .set({
      attempts: sql`greatest(${ciRuns.attempts} - 1, 0)`,
      nextAttemptAt: new Date(),
      statusReason: "Waiting for the gateway to read what its jobs are lent.",
      updatedAt: new Date(),
    })
    .where(and(eq(ciRuns.id, row.id), eq(ciRuns.status, "queued")));
}

/** A job of the run names a connection, SSH key or resource to be lent. */
export function namesSomethingLent(access: readonly CiJobAccess[] | null): boolean {
  return (access ?? []).some(
    (j) =>
      (j.connections?.length ?? 0) > 0 ||
      (j.sshKeys?.length ?? 0) > 0 ||
      Object.keys(j.resources ?? {}).length > 0 ||
      (j.envFrom?.length ?? 0) > 0,
  );
}

async function retryLater(row: CiRunRow, reason: string): Promise<void> {
  if (row.attempts >= MAX_ATTEMPTS) {
    await finish(row, "error", `Gave up after ${row.attempts} attempts. ${reason}`);
    await upsertCheck(row, {
      status: "completed",
      conclusion: "failure",
      title: "Could not start",
      summary: reason,
    });
    return;
  }
  // 15s, 30s, 60s ... capped at 5 minutes.
  const delay = Math.min(15_000 * 2 ** Math.max(0, row.attempts - 1), 5 * 60_000);
  await db
    .update(ciRuns)
    .set({
      statusReason: reason,
      nextAttemptAt: new Date(Date.now() + delay),
      updatedAt: new Date(),
    })
    .where(and(eq(ciRuns.id, row.id), eq(ciRuns.status, "queued")));
}

/**
 * What a job the runner's task cache stood in for says, in place of a
 * reason: it passed without running, because nothing it reads changed since
 * a run that passed. Carried in `reason` so every client that shows one
 * (the CI tab, the GitHub check) shows it, with no change to the job's shape.
 */
export const CACHED_REASON = "Cached: nothing it reads changed since a run that passed";

/** The jobs of a finished run, with or without their output. */
export function jobsOf(run: ProxyRun, withOutput: true): CiJobOutput[];
export function jobsOf(run: ProxyRun, withOutput: false): CiJobSummary[];
export function jobsOf(run: ProxyRun, withOutput: boolean): Array<CiJobSummary | CiJobOutput> {
  const out: Array<CiJobSummary | CiJobOutput> = [];
  for (const pipeline of run.result?.pipelines ?? []) {
    if (pipeline.outcome === "invalid") {
      const summary: CiJobSummary = {
        pipeline: pipeline.file ?? "pipeline",
        id: pipeline.file ?? "pipeline",
        name: "Pipeline file",
        status: "error",
        reason: (pipeline.errors ?? []).join("; ") || "The pipeline file is not valid.",
        durationMs: null,
      };
      out.push(withOutput ? { ...summary, stdout: "", stderr: summary.reason ?? "" } : summary);
      continue;
    }
    if (pipeline.outcome === "cancelled") {
      const summary: CiJobSummary = {
        pipeline: pipeline.name ?? pipeline.file ?? "pipeline",
        id: pipeline.file ?? "pipeline",
        name: "Pipeline",
        status: "cancelled",
        reason: "Cancelled before it started.",
        durationMs: null,
      };
      out.push(withOutput ? { ...summary, stdout: "", stderr: "" } : summary);
      continue;
    }
    for (const job of pipeline.report?.jobs ?? []) {
      const status =
        job.status === "passed" ||
        job.status === "failed" ||
        job.status === "skipped" ||
        job.status === "cancelled"
          ? job.status
          : "error";
      const summary: CiJobSummary = {
        pipeline: pipeline.report?.pipeline ?? pipeline.name ?? "",
        id: job.id ?? "",
        name: job.name ?? job.id ?? "",
        status,
        reason: job.reason ?? job.message ?? (job.cached === true ? CACHED_REASON : null),
        durationMs: typeof job.duration_ms === "number" ? job.duration_ms : null,
        ...(Array.isArray(job.needs) && job.needs.every((n) => typeof n === "string")
          ? { needs: job.needs }
          : {}),
        ...accessOf(job.access),
        ...cloudOf(job.cloud),
      };
      if (!withOutput) {
        out.push(summary);
        continue;
      }
      const downloads = (Array.isArray(job.downloads) ? job.downloads : [])
        .map(toDownload)
        .filter((d): d is CiDownload => d !== null);
      out.push({
        ...summary,
        stdout: job.execution?.stdout ?? "",
        stderr: job.execution?.stderr ?? "",
        ...(downloads.length > 0 ? { downloads } : {}),
      });
    }
  }
  return out;
}

function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  // `resources` may come as a map of name to outputs.
  if (typeof value === "object" && value !== null) return Object.keys(value);
  return [];
}

/** A job report's `access`, as the run page lists it (names only). */
export function accessOf(
  access: Record<string, unknown> | undefined,
): Pick<CiJobSummary, "access"> {
  if (!access) return {};
  const out: NonNullable<CiJobSummary["access"]> = {};
  const connections = names(access["connections"]);
  const sshKeys = names(access["ssh-keys"]);
  const resources = names(access["resources"]);
  const envFrom = names(access["env-from"]);
  if (connections.length > 0) out.connections = connections;
  if (sshKeys.length > 0) out.sshKeys = sshKeys;
  if (resources.length > 0) out.resources = resources;
  if (envFrom.length > 0) out.envFrom = envFrom;
  return Object.keys(out).length > 0 ? { access: out } : {};
}

/** A job report's `cloud`. */
export function cloudOf(cloud: Record<string, unknown> | undefined): Pick<CiJobSummary, "cloud"> {
  if (!cloud || typeof cloud["provider"] !== "string" || typeof cloud["kind"] !== "string")
    return {};
  const str = (k: string) => (typeof cloud[k] === "string" ? { [k]: cloud[k] as string } : {});
  return {
    cloud: {
      provider: cloud["provider"],
      kind: cloud["kind"],
      ...str("machine"),
      ...str("region"),
      ...str("executor"),
    },
  };
}

/** Failures first, then skips, so a summary cut to fit still shows them. */
const SUMMARY_ORDER: Record<CiJobSummary["status"], number> = {
  error: 0,
  failed: 0,
  cancelled: 1,
  skipped: 1,
  passed: 2,
};

export function checkSummary(jobs: CiJobSummary[]): string {
  if (jobs.length === 0) return "No pipeline ran for this event.";
  const mark = (s: string) =>
    s === "passed" ? "✅" : s === "skipped" ? "⏭️" : s === "cancelled" ? "⏹️" : "❌";
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const rows = jobs
    .map((j, i) => ({ j, i }))
    .sort((a, b) => SUMMARY_ORDER[a.j.status] - SUMMARY_ORDER[b.j.status] || a.i - b.i)
    .map(({ j }) => {
      const reason = j.reason === CACHED_REASON ? "cached" : cell(j.reason ?? "").slice(0, 200);
      return `| ${mark(j.status)} | ${cell(j.pipeline)} | ${cell(j.name)} | ${reason} |`;
    });
  return ["| | Pipeline | Job | |", "|---|---|---|---|", ...rows].join("\n");
}

/** Brings a running run up to date from the proxy. */
export async function syncRun(row: CiRunRow): Promise<void> {
  if (row.status !== "running" || !row.proxyRunId) return;
  await resendCancels(row);
  let run: ProxyRun;
  try {
    run = await proxyJson<ProxyRun>(
      `/v1/runs/${encodeURIComponent(row.proxyRunId)}?owner=${encodeURIComponent(row.ownerKey)}`,
    );
  } catch (err) {
    const started = (row.startedAt ?? row.createdAt).getTime();
    const gone = err instanceof CiProxyError && err.status === 404;
    if (gone && row.cancelRequestedAt && Date.now() - started > GONE_AFTER_MS) {
      // Asked to stop, and gone: nothing is left to cancel.
      await finish(row, "cancelled", CANCELLED_BY_PERSON);
      await abandonJobChecks(row, CANCELLED_BY_PERSON);
      await upsertCheck(row, cancelledCheck(CANCELLED_BY_PERSON));
    } else if (Date.now() - started > (gone ? GONE_AFTER_MS : LOST_AFTER_MS)) {
      const reason = gone ? GONE_REASON : "The runner stopped reporting on this run.";
      await finish(row, "error", reason);
      // Its jobs' checks would otherwise say "in progress" for good.
      await abandonJobChecks(row, reason);
      await upsertCheck(row, {
        status: "completed",
        conclusion: "failure",
        title: "Lost",
        summary: reason,
      });
    } else if (!gone) {
      console.warn(`[ci] could not read run ${row.id}:`, err);
    }
    return;
  }
  if (run.state === "running") {
    // Each job's own check, as it starts and finishes.
    if (run.progress) await syncJobChecks(row, groupsFromProgress(run.progress));
    return;
  }
  if (run.state === "failed") {
    const reason = run.error ?? "The runner could not run this commit.";
    await finish(row, "error", reason);
    await upsertCheck(row, {
      status: "completed",
      conclusion: "failure",
      title: "Could not run",
      summary: reason,
    });
    return;
  }
  const jobs = jobsOf(run, false);
  const passed = run.result?.passed === true;
  const failedCount = jobs.filter((j) => j.status === "failed" || j.status === "error").length;
  // A failure says more than the cancel that followed it.
  const cancelled =
    !passed &&
    failedCount === 0 &&
    (run.result?.cancelled === true || jobs.some((j) => j.status === "cancelled"));
  const cancelReason = cancelled ? cancelledReason(row) : null;
  await finish(row, passed ? "passed" : cancelled ? "cancelled" : "failed", cancelReason, {
    jobs,
    vcpuSeconds: run.result?.usage?.vcpu_seconds ?? 0,
    memoryGibSeconds: run.result?.usage?.memory_gib_seconds ?? 0,
  });
  // Every job's check finished, including any no poll saw running.
  await syncJobChecks(row, groupsFromJobs(jobs, CACHED_REASON));
  if (cancelReason !== null) {
    await upsertCheck(row, {
      ...cancelledCheck(cancelReason),
      summary: `${cancelReason}\n\n${checkSummary(jobs)}`,
    });
    return;
  }
  const cachedCount = jobs.filter((j) => j.reason === CACHED_REASON).length;
  // No pipeline matched this event (a push to a branch when `on.push` only
  // names main): skipped, not a green pass for code nothing checked.
  if (passed && jobs.length === 0) {
    const what = row.event === "pull-request" ? "pull request" : "push";
    await upsertCheck(row, {
      status: "completed",
      conclusion: "skipped",
      title: `No pipeline runs on this ${what}`,
      summary: `No pipeline in \`.infrawrench/ci\` runs on this ${what}.`,
    });
    return;
  }
  await upsertCheck(row, {
    status: "completed",
    conclusion: passed ? "success" : "failure",
    title: passed
      ? cachedCount > 0
        ? `${jobs.length} job(s) passed, ${cachedCount} from the task cache`
        : `${jobs.length} job(s) passed`
      : `${failedCount} of ${jobs.length} job(s) failed`,
    summary: checkSummary(jobs),
  });
}

/** Approves a fork's commit: it runs, without secrets. */
export async function approveRun(
  organizationId: string,
  id: string,
  userId: string,
): Promise<void> {
  const [row] = await db
    .update(ciRuns)
    .set({
      status: "queued",
      decidedByUserId: userId,
      decidedAt: new Date(),
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ciRuns.id, id),
        eq(ciRuns.organizationId, organizationId),
        eq(ciRuns.status, "awaiting_approval"),
      ),
    )
    .returning({ id: ciRuns.id });
  if (!row) throw new CiInputError("This run is not waiting for approval.", 409);
}

/** Rejects a fork's commit: it never runs. */
export async function rejectRun(organizationId: string, id: string, userId: string): Promise<void> {
  const [row] = await db
    .update(ciRuns)
    .set({
      status: "rejected",
      statusReason: "Rejected by a maintainer.",
      decidedByUserId: userId,
      decidedAt: new Date(),
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ciRuns.id, id),
        eq(ciRuns.organizationId, organizationId),
        eq(ciRuns.status, "awaiting_approval"),
      ),
    )
    .returning();
  if (!row) throw new CiInputError("This run is not waiting for approval.", 409);
  await upsertCheck(row, {
    status: "completed",
    conclusion: "cancelled",
    title: "Not approved",
    summary: "A maintainer chose not to run CI for this commit from a fork.",
  });
}

/**
 * Cancels a run: one that has not started (queued, or waiting for its
 * concurrency group) ends at once; a running one is stopped by its runner,
 * and ends as cancelled when the next poll reads its report. Takes the
 * approval permission, as a retry does. A runner from before cancelling
 * answers 404, and the run is left to finish.
 */
export async function cancelRun(organizationId: string, id: string): Promise<CiRun> {
  const row = await loadOwned(organizationId, id);
  if (!CI_CANCELLABLE_STATUSES.includes(row.status)) {
    throw new CiInputError(
      row.status === "awaiting_approval"
        ? "This run is waiting for approval; reject it instead."
        : "Only a queued, waiting or running run can be cancelled.",
      409,
    );
  }
  const now = new Date();
  if (row.status !== "running") {
    const [cancelled] = await db
      .update(ciRuns)
      .set({
        status: "cancelled",
        statusReason: CANCELLED_BY_PERSON,
        cancelRequestedAt: now,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(ciRuns.id, row.id), inArray(ciRuns.status, ["queued", "pending"])))
      .returning();
    // It started in between: cancel it as a running one.
    if (!cancelled) return cancelRun(organizationId, id);
    await upsertCheck(cancelled, cancelledCheck(CANCELLED_BY_PERSON));
    return toWire(cancelled);
  }
  const [marked] = await db
    .update(ciRuns)
    .set({ cancelRequestedAt: now, updatedAt: now })
    .where(and(eq(ciRuns.id, row.id), eq(ciRuns.status, "running")))
    .returning();
  if (!marked) throw new CiInputError("The run has just finished.", 409);
  if (!marked.proxyRunId) return toWire(marked);
  let res: Response;
  try {
    res = await proxyFetch(`/v1/runs/${encodeURIComponent(marked.proxyRunId)}/cancel`, {
      method: "POST",
      body: "{}",
    });
  } catch {
    // The next poll sends it again.
    return toWire(marked);
  }
  await res.body?.cancel();
  if (res.status === 404) {
    await db
      .update(ciRuns)
      .set({ cancelRequestedAt: null, updatedAt: new Date() })
      .where(eq(ciRuns.id, row.id));
    throw new CiInputError(
      "The runner with this run cannot cancel it (it predates cancelling, or lost the run); it will finish on its own.",
      409,
    );
  }
  if (res.status < 500) {
    const [sent] = await db
      .update(ciRuns)
      .set({ cancelSentAt: new Date() })
      .where(eq(ciRuns.id, row.id))
      .returning();
    return toWire(sent ?? marked);
  }
  return toWire(marked);
}

/**
 * Why a run cannot be retried, or `null` when it can. Only a finished run
 * is: one waiting for approval is approved instead (a retry is never a way
 * around it), and a rejected one stays rejected.
 */
export function retryRefusal(row: Pick<CiRunRow, "status">): string | null {
  if (CI_RETRYABLE_STATUSES.includes(row.status)) return null;
  switch (row.status) {
    case "awaiting_approval":
      return "This run is waiting for approval; approve it instead.";
    case "rejected":
      return "A rejected run cannot be retried.";
    default:
      return "This run has not finished yet.";
  }
}

/**
 * Starts a run again: a new run of the same repository, commit, branch and
 * event, linked to the one it retries, queued and dispatched like any other.
 * With `noTaskCache` every `task-cache:` job runs. A fork's run stays a
 * fork's (no secrets); its retry counts as approved by whoever asks, which
 * takes the same permission as approving it. Two retries of a run at once
 * are one: the second answers 409.
 */
export async function retryRun(
  organizationId: string,
  id: string,
  userId: string,
  opts: { noTaskCache: boolean },
): Promise<CiRun> {
  const original = await loadOwned(organizationId, id);
  const refusal = retryRefusal(original);
  if (refusal) throw new CiInputError(refusal, 409);
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ciRuns)
    .where(eq(ciRuns.retryOfRunId, original.id));
  const now = new Date();
  const [row] = await db
    .insert(ciRuns)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      installationId: original.installationId,
      repoFullName: original.repoFullName,
      ownerKey: original.ownerKey,
      repoKey: original.repoKey,
      event: original.event,
      pipelineFile: original.pipelineFile,
      pipelineText: original.pipelineText,
      branch: original.branch,
      headRef: original.headRef,
      defaultBranch: original.defaultBranch,
      sha: original.sha,
      baseSha: original.baseSha,
      pullNumber: original.pullNumber,
      headRepoFullName: original.headRepoFullName,
      fromFork: original.fromFork,
      actorLogin: original.actorLogin,
      retryOfRunId: original.id,
      noTaskCache: opts.noTaskCache,
      status: "queued",
      // One retry per count: a second click racing the first conflicts.
      dedupeKey: `retry:${original.id}:${count + 1}`,
      ...(original.fromFork ? { decidedByUserId: userId || null, decidedAt: now } : {}),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new CiInputError("This run is already being retried.", 409);
  return toWire(row);
}

async function loadOwned(organizationId: string, id: string): Promise<CiRunRow> {
  const [row] = await db
    .select()
    .from(ciRuns)
    .where(and(eq(ciRuns.id, id), eq(ciRuns.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new CiInputError("No such run.", 404);
  return row;
}

/** Each run's newest retry, by the id of the run it retries. */
async function newestRetries(organizationId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: ciRuns.id, retryOfRunId: ciRuns.retryOfRunId })
    .from(ciRuns)
    .where(and(eq(ciRuns.organizationId, organizationId), inArray(ciRuns.retryOfRunId, ids)))
    .orderBy(ciRuns.createdAt);
  const out = new Map<string, string>();
  // Oldest first, so the newest wins.
  for (const r of rows) if (r.retryOfRunId) out.set(r.retryOfRunId, r.id);
  return out;
}

export function toWire(row: CiRunRow, retriedAsRunId: string | null = null): CiRun {
  const githubUrl =
    row.pullNumber !== null
      ? `https://github.com/${row.repoFullName}/pull/${row.pullNumber}`
      : `https://github.com/${row.repoFullName}/commit/${row.sha}`;
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    event: row.event,
    headRef: row.headRef,
    sha: row.sha,
    pullNumber: row.pullNumber,
    headRepoFullName: row.headRepoFullName,
    fromFork: row.fromFork,
    actorLogin: row.actorLogin,
    status: row.status,
    statusReason: row.statusReason,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    jobs: (row.jobs as CiJobSummary[] | null) ?? null,
    vcpuSeconds: row.vcpuSeconds,
    memoryGibSeconds: row.memoryGibSeconds,
    githubUrl,
    retryOfRunId: row.retryOfRunId,
    retriedAsRunId,
    noTaskCache: row.noTaskCache,
    ...(row.pipelineFile !== null ? { pipelineFile: row.pipelineFile } : {}),
    ...(row.concurrency !== null
      ? {
          concurrencyGroups: [
            ...new Set(row.concurrency.flatMap((e) => (e.group === null ? [] : [e.group]))),
          ],
        }
      : {}),
    ...(row.cancelRequestedAt !== null && row.status === "running"
      ? { cancelRequested: true }
      : {}),
  };
}

export async function listRuns(
  organizationId: string,
  opts: { limit: number; status?: CiRunStatus },
): Promise<CiRun[]> {
  const rows = await db
    .select()
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.organizationId, organizationId),
        opts.status ? eq(ciRuns.status, opts.status) : undefined,
      ),
    )
    .orderBy(desc(ciRuns.createdAt))
    .limit(opts.limit);
  const retries = await newestRetries(
    organizationId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toWire(r, retries.get(r.id) ?? null));
}

/** A run and, once it has finished, each job's output from the runners. */
export async function getRun(organizationId: string, id: string): Promise<CiRunDetail> {
  const row = await loadOwned(organizationId, id);
  const retries = await newestRetries(organizationId, [row.id]);
  let jobs: CiJobOutput[] | null = null;
  if (row.proxyRunId && FINISHED_WITH_REPORT.includes(row.status)) {
    try {
      const run = await proxyJson<ProxyRun>(
        `/v1/runs/${encodeURIComponent(row.proxyRunId)}?owner=${encodeURIComponent(row.ownerKey)}`,
      );
      jobs = jobsOf(run, true);
    } catch (err) {
      console.warn(`[ci] could not read the output of run ${row.id}:`, err);
    }
  }
  const cloudJobs = await cloudJobsOfRun(organizationId, row.id);
  return {
    run: toWire(row, retries.get(row.id) ?? null),
    jobs,
    ...(cloudJobs.length > 0 ? { cloudJobs } : {}),
  };
}

/** A run's cloud jobs, for the run page (no secrets: the sealed claim is never read here). */
async function cloudJobsOfRun(organizationId: string, runId: string): Promise<CiCloudJob[]> {
  const rows = await db
    .select({ job: ciCloudJobs, accountName: accounts.displayName })
    .from(ciCloudJobs)
    .leftJoin(accounts, eq(accounts.id, ciCloudJobs.accountId))
    .where(and(eq(ciCloudJobs.organizationId, organizationId), eq(ciCloudJobs.runId, runId)))
    .orderBy(ciCloudJobs.claimedAt);
  return rows.map(({ job, accountName }) => ({
    jobId: job.jobId,
    jobName: job.jobName,
    pipeline: job.pipeline,
    accountId: job.accountId,
    accountName,
    pluginId: job.pluginId,
    kind: job.kind,
    machine: job.machine,
    region: job.region,
    state: job.state,
    outcome: job.outcome,
    reason: job.reason,
    label: job.handle?.label ?? null,
    claimedAt: job.claimedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  }));
}

/**
 * A link to one file a job of a finished run kept with `downloads:`, signed
 * for the CI proxy to serve. The run must be the organization's; the file
 * must be in the run's report, as the runner wrote it.
 */
export async function getDownloadLink(
  organizationId: string,
  id: string,
  jobId: string,
  path: string,
): Promise<CiDownloadLink> {
  const [row] = await db
    .select()
    .from(ciRuns)
    .where(and(eq(ciRuns.id, id), eq(ciRuns.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new CiInputError("No such run.", 404);
  if (!row.proxyRunId || !FINISHED_WITH_REPORT.includes(row.status)) {
    throw new CiInputError("The run has not finished.", 409);
  }
  const run = await proxyJson<ProxyRun>(
    `/v1/runs/${encodeURIComponent(row.proxyRunId)}?owner=${encodeURIComponent(row.ownerKey)}`,
  ).catch((err: unknown) => {
    throw err instanceof CiProxyError && err.status === 404
      ? new CiInputError("The runners no longer have this run's report.", 404)
      : err;
  });
  const download = (run.result?.pipelines ?? [])
    .flatMap((p) => p.report?.jobs ?? [])
    .filter((j) => j.id === jobId)
    .flatMap((j) => j.downloads ?? [])
    .find((d) => d.path === path);
  if (!download) throw new CiInputError("No such download in this run.", 404);
  // The proxy's id is `<runner>.<run>`; the files are under the runner's.
  const runnerRunId = run.result?.run_id ?? row.proxyRunId.slice(row.proxyRunId.indexOf(".") + 1);
  try {
    return downloadLink(row.ownerKey, row.repoKey, runnerRunId, download);
  } catch (err) {
    if (err instanceof DownloadLinkError) throw new CiInputError(err.message, err.status);
    throw err;
  }
}

/**
 * A running run's live log from the proxy (`/v1/runs/{id}/logs`): the
 * runner's events as Server-Sent Events, everything so far and then live,
 * passed through unread. `signal` is the client's: the stream lasts as long
 * as the run or the reader, not the proxy calls' usual 20 seconds.
 */
export async function openRunLogs(
  organizationId: string,
  id: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const [row] = await db
    .select()
    .from(ciRuns)
    .where(and(eq(ciRuns.id, id), eq(ciRuns.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new CiInputError("No such run.", 404);
  if (row.status !== "running" || !row.proxyRunId) {
    throw new CiInputError("The run is not running; its jobs' output is in the run.", 409);
  }
  const res = await proxyFetch(
    `/v1/runs/${encodeURIComponent(row.proxyRunId)}/logs?owner=${encodeURIComponent(row.ownerKey)}`,
    { signal },
  );
  if (!res.ok || res.body === null) {
    // The runner can lose a run's log (a restart), or the run can end in
    // between: the finished run's report has the output.
    await res.body?.cancel().catch(() => {});
    throw new CiInputError(
      `The run's log is not available (the CI proxy answered ${res.status}).`,
      409,
    );
  }
  return res.body;
}

/** Rows the poller pass works on. */
export async function dueQueuedRunIds(limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: ciRuns.id })
    .from(ciRuns)
    .where(and(eq(ciRuns.status, "queued"), lte(ciRuns.nextAttemptAt, new Date())))
    .orderBy(ciRuns.nextAttemptAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function runningRuns(limit: number): Promise<CiRunRow[]> {
  return db
    .select()
    .from(ciRuns)
    .where(eq(ciRuns.status, "running"))
    .orderBy(ciRuns.startedAt)
    .limit(limit);
}

/** Closes forks' runs nobody approved in time. */
export async function expireApprovals(): Promise<number> {
  const before = new Date(Date.now() - APPROVAL_EXPIRES_MS);
  const rows = await db
    .update(ciRuns)
    .set({
      status: "rejected",
      statusReason: "Nobody approved it within 14 days.",
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(ciRuns.status, "awaiting_approval"), lte(ciRuns.createdAt, before)))
    .returning({ id: ciRuns.id });
  return rows.length;
}
