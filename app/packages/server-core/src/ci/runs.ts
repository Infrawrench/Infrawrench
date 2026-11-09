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
 *
 * Dispatch claims the row first (one UPDATE that only one caller can win),
 * because both the webhook and the poller pass dispatch.
 */
import { and, desc, eq, isNull, lte, ne, sql } from "drizzle-orm";
import type {
  CiJobOutput,
  CiJobSummary,
  CiRun,
  CiRunDetail,
  CiRunStatus,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { ciAccounts, ciRuns, githubInstallations } from "../db/schema.js";
import { planAccess } from "../entitlements.js";
import { orgHasFeature } from "../features.js";
import { getInstallationToken } from "../github/app.js";
import { upsertCheck } from "./checks.js";
import type { CiEvent } from "./events.js";
import { ownerKey, repoKey } from "./events.js";
import { CiProxyError, proxyFetch, proxyJson, type ProxyRun } from "./proxy.js";

type CiRunRow = typeof ciRuns.$inferSelect;

/** How long a claim on a queued run lasts before another dispatcher may retry it. */
const CLAIM_MS = 2 * 60_000;
/** Dispatch attempts (busy or unreachable runners) before a run is given up on. */
const MAX_ATTEMPTS = 40;
/** A run the runners have not reported on for this long is given up on. */
const LOST_AFTER_MS = 2 * 60 * 60_000;
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
  status: "passed" | "failed" | "error" | "rejected",
  reason: string | null,
  extra: Partial<typeof ciRuns.$inferInsert> = {},
): Promise<void> {
  const now = new Date();
  await db
    .update(ciRuns)
    .set({ status, statusReason: reason, finishedAt: now, updatedAt: now, ...extra })
    .where(eq(ciRuns.id, row.id));
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

  let token: string;
  try {
    token = await getInstallationToken(row.installationId);
  } catch (err) {
    await retryLater(row, `GitHub refused an installation token: ${String(err)}`);
    return;
  }
  const body = dispatchBody(row, token);

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
  await db
    .update(ciRuns)
    .set({ status: "running", proxyRunId: answer.id, startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(ciRuns.id, row.id), eq(ciRuns.status, "queued")));
  await upsertCheck(row, {
    status: "in_progress",
    title: "Running",
    summary: row.fromFork ? "Running a fork's pull request, without secrets." : "Running.",
  });
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
    for (const job of pipeline.report?.jobs ?? []) {
      const status =
        job.status === "passed" || job.status === "failed" || job.status === "skipped"
          ? job.status
          : "error";
      const summary: CiJobSummary = {
        pipeline: pipeline.report?.pipeline ?? pipeline.name ?? "",
        id: job.id ?? "",
        name: job.name ?? job.id ?? "",
        status,
        reason: job.reason ?? job.message ?? null,
        durationMs: typeof job.duration_ms === "number" ? job.duration_ms : null,
      };
      out.push(
        withOutput
          ? { ...summary, stdout: job.execution?.stdout ?? "", stderr: job.execution?.stderr ?? "" }
          : summary,
      );
    }
  }
  return out;
}

function checkSummary(jobs: CiJobSummary[]): string {
  if (jobs.length === 0) return "No pipeline ran for this event.";
  const mark = (s: string) => (s === "passed" ? "✅" : s === "skipped" ? "⏭️" : "❌");
  const rows = jobs.map(
    (j) =>
      `| ${mark(j.status)} | ${j.pipeline.replace(/\|/g, "\\|")} | ${j.name.replace(/\|/g, "\\|")} | ${(j.reason ?? "").replace(/\|/g, "\\|").slice(0, 200)} |`,
  );
  return ["| | Pipeline | Job | |", "|---|---|---|---|", ...rows].join("\n");
}

/** Brings a running run up to date from the proxy. */
export async function syncRun(row: CiRunRow): Promise<void> {
  if (row.status !== "running" || !row.proxyRunId) return;
  let run: ProxyRun;
  try {
    run = await proxyJson<ProxyRun>(
      `/v1/runs/${encodeURIComponent(row.proxyRunId)}?owner=${encodeURIComponent(row.ownerKey)}`,
    );
  } catch (err) {
    const started = (row.startedAt ?? row.createdAt).getTime();
    if (Date.now() - started > LOST_AFTER_MS) {
      await finish(row, "error", "The runner stopped reporting on this run.");
      await upsertCheck(row, {
        status: "completed",
        conclusion: "failure",
        title: "Lost",
        summary: "The runner stopped reporting on this run.",
      });
    } else if (!(err instanceof CiProxyError) || err.status !== 404) {
      console.warn(`[ci] could not read run ${row.id}:`, err);
    }
    return;
  }
  if (run.state === "running") return;
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
  await finish(row, passed ? "passed" : "failed", null, {
    jobs,
    vcpuSeconds: run.result?.usage?.vcpu_seconds ?? 0,
    memoryGibSeconds: run.result?.usage?.memory_gib_seconds ?? 0,
  });
  const failedCount = jobs.filter((j) => j.status === "failed" || j.status === "error").length;
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
      ? `${jobs.length} job(s) passed`
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

export function toWire(row: CiRunRow): CiRun {
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
  return rows.map(toWire);
}

/** A run and, once it has finished, each job's output from the runners. */
export async function getRun(organizationId: string, id: string): Promise<CiRunDetail> {
  const [row] = await db
    .select()
    .from(ciRuns)
    .where(and(eq(ciRuns.id, id), eq(ciRuns.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new CiInputError("No such run.", 404);
  let jobs: CiJobOutput[] | null = null;
  if (row.proxyRunId && (row.status === "passed" || row.status === "failed")) {
    try {
      const run = await proxyJson<ProxyRun>(
        `/v1/runs/${encodeURIComponent(row.proxyRunId)}?owner=${encodeURIComponent(row.ownerKey)}`,
      );
      jobs = jobsOf(run, true);
    } catch (err) {
      console.warn(`[ci] could not read the output of run ${row.id}:`, err);
    }
  }
  return { run: toWire(row), jobs };
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
