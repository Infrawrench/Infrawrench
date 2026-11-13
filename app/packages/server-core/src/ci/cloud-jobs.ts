/**
 * Cloud jobs: running a pipeline job with `cloud:` on a connection the
 * organization opted in to cloud jobs (`ci_connection_access.jobs_enabled`).
 *
 * The runner keeps the job in the pipeline graph and waits for it as
 * `external`; this module is its executor (`ci-runner/README.md`, "Cloud
 * jobs: the executor's routes"):
 *
 * 1. **Match and claim.** For each running run with a cloud job waiting, find
 *    the opted-in connection: the job's provider (a plugin id) and kind,
 *    optionally its connection name, this repository and branch, a free
 *    slot under the connection's concurrency limit, a timeout under its
 *    minutes limit. None: the job fails at once with a reason naming what to
 *    opt in. Then claim it, keeping the claim's secret part encrypted.
 * 2. **Start** compute through the plugin (`ciStart`) with the bootstrap
 *    script, which only holds the job's callback URL and token, and tags
 *    `infrawrench-ci` (+ run and job). The machine gets no cloud credentials.
 * 3. **Relay.** The machine fetches the job script once from the callback,
 *    and posts its output, heartbeats and result there; each is relayed to
 *    the runner with the claim, which masks it. Until the machine first
 *    calls, the pass heartbeats for it, so a slow boot is not taken as lost.
 * 4. **Teardown, twice.** When the job finishes, fails, is cancelled (any
 *    409 or 404 from the runner), times out, or its machine never calls
 *    back, the row goes to `tearing_down` and the pass calls `ciTeardown`
 *    until it succeeds. And the reaper lists everything tagged for this
 *    organization's CI on each connection that ran jobs, and removes what
 *    no live job owns.
 *
 * Calls plugins for arbitrary accounts: a gateway pass.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { CI_JOB_TAG, CI_RUN_TAG, CI_TAG, type CiHandle } from "@infrawrench/plugin-base";
import { ciBranchMatches, ciRepoAllowed } from "@infrawrench/client-core";

import { appBaseUrl } from "../app-url.js";
import { db } from "../db/client.js";
import { accounts, auditLogs, ciCloudJobs, ciConnectionAccess, ciRuns } from "../db/schema.js";
import { buildAad, decrypt, encrypt } from "../encryption.js";
import { getInstallationToken } from "../github/app.js";
import { getOrgAccountClient } from "../org-accounts.js";
import { bootstrapScript, jobScript, parseFinishBody } from "./bootstrap.js";
import { CiProxyError, ciProxyConfigured, proxyJson } from "./proxy.js";
import { dispatchRun } from "./runs.js";

type RunRow = typeof ciRuns.$inferSelect;
type JobRow = typeof ciCloudJobs.$inferSelect;

/** A cloud job as the runner lists it (`GET /v1/runs/{id}/jobs`); nothing secret. */
export interface CloudJobSpec {
  run: string;
  job: string;
  name: string;
  pipeline: string;
  state: string;
  cloud: {
    provider: string;
    kind: string;
    connection?: string;
    machine?: string;
    image?: string;
    region?: string;
    gpu?: string;
  };
  commit: { repo: string; sha: string; branch: string; ref: string };
  clone: { depth: number | "full"; into: string } | null;
  cwd: string;
  script: string;
  timeout_secs: number;
  deadline_secs?: number;
  outputs?: string[];
  changes?: "ignore" | "fail";
  inputs: { files: number; bytes: number } | null;
  artifacts: { paths: string[]; max_bytes: number } | null;
}

/** The claim's answer: the spec and its secret part. */
interface ClaimAnswer extends CloudJobSpec {
  claim: string;
  env: Record<string, string>;
  files?: Array<{ path: string; mode?: string; content: string }>;
  inputs: (CloudJobSpec["inputs"] & { url?: string }) | null;
  artifacts: (CloudJobSpec["artifacts"] & { url?: string }) | null;
}

/** What is kept, encrypted, until the job ends. */
interface SealedClaim {
  claim: string;
  env: Record<string, string>;
  files: Array<{ path: string; mode?: string; content: string }>;
  inputsUrl: string | null;
  artifacts: { url: string; paths: string[] } | null;
  script: string;
  cwd: string;
  cloneInto: string | null;
  changes: "ignore" | "fail";
  repoFullName: string;
  sha: string;
}

/** A machine that has not called back in this long after the claim never will. */
const BOOT_DEADLINE_MS = 15 * 60_000;
/** Claim attempts (for passing failures) before the job is reported failed. */
export const MAX_CLAIM_ATTEMPTS = 6;
/** Teardown attempts before the row is closed and left to the reaper. */
const MAX_TEARDOWN_ATTEMPTS = 20;
/** Tagged compute younger than this may belong to a job still being recorded. */
const REAP_GRACE_MS = 10 * 60_000;
const REAP_EVERY_MS = 10 * 60_000;
const STOP_STATES = new Set(["cancelled", "finished", "lost", "timed-out"]);

/** The job id as one path segment: everything but `A-Za-z0-9-_.~` encoded. */
export function jobSegment(job: string): string {
  return encodeURIComponent(job).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function jobPath(proxyRunId: string, job: string, tail = ""): string {
  return `/v1/runs/${encodeURIComponent(proxyRunId)}/jobs/${jobSegment(job)}${tail}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function claimAad(id: string): string {
  return buildAad("ciCloudJob", id, "claim");
}

/** The tag value that marks compute as this organization's CI's. */
export function orgTag(organizationId: string): string {
  return `org-${organizationId}`;
}

function callbackUrl(): string {
  const base = appBaseUrl();
  if (!base) throw new Error("APP_URL is not set, so a cloud job's machine cannot call back.");
  return `${base}/api/ci-jobs`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function audit(
  row: Pick<JobRow, "organizationId" | "id">,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      organizationId: row.organizationId,
      userId: null,
      action,
      entityType: "ci_cloud_job",
      entityId: row.id,
      metadata,
    })
    .catch((err: unknown) => console.warn("[ci-cloud] could not audit:", err));
}

/** Fails a job nobody can run, without claiming it. */
async function refuseJob(proxyRunId: string, job: string, reason: string): Promise<void> {
  await proxyJson(jobPath(proxyRunId, job, "/finish"), {
    method: "POST",
    body: JSON.stringify({ status: "error", error: reason.slice(0, 4000) }),
  }).catch((err: unknown) => {
    if (!(err instanceof CiProxyError && (err.status === 409 || err.status === 404))) throw err;
  });
}

interface Candidate {
  accountId: string;
  displayName: string;
  maxConcurrentJobs: number;
  maxJobMinutes: number;
}

/** Why no opted-in connection can run a job, or the connections that can. */
export function matchConnections(
  run: Pick<RunRow, "repoFullName" | "headRef">,
  spec: Pick<CloudJobSpec, "cloud" | "timeout_secs">,
  rows: Array<{
    accountId: string;
    displayName: string;
    pluginId: string;
    jobsEnabled: boolean;
    jobKinds: string[];
    jobRepos: string[] | null;
    jobBranchPattern: string | null;
    maxConcurrentJobs: number;
    maxJobMinutes: number;
  }>,
): Candidate[] | { refuse: string } {
  const { provider, kind, connection } = spec.cloud;
  const where = `for ${run.repoFullName} on ${run.headRef}`;
  const ofProvider = rows.filter(
    (r) => r.pluginId === provider && (!connection || r.displayName === connection),
  );
  const named = connection ? ` called \`${connection}\`` : "";
  if (ofProvider.length === 0) {
    return {
      refuse: `No \`${provider}\` connection${named} is opted in to cloud jobs. Turn one on in CI, CI access.`,
    };
  }
  const enabled = ofProvider.filter((r) => r.jobsEnabled && r.jobKinds.includes(kind));
  if (enabled.length === 0) {
    return {
      refuse: `No \`${provider}\` connection${named} is opted in to \`${kind}\` cloud jobs. Turn it on in CI, CI access.`,
    };
  }
  const scoped = enabled.filter(
    (r) =>
      ciRepoAllowed(r.jobRepos, run.repoFullName) &&
      ciBranchMatches(r.jobBranchPattern, run.headRef),
  );
  if (scoped.length === 0) {
    return { refuse: `No \`${provider}\` connection${named} runs cloud jobs ${where}.` };
  }
  const long = scoped.filter((r) => spec.timeout_secs <= r.maxJobMinutes * 60);
  if (long.length === 0) {
    const most = Math.max(...scoped.map((r) => r.maxJobMinutes));
    return {
      refuse: `The job's timeout (${Math.ceil(spec.timeout_secs / 60)} minutes) is over what its connection allows a cloud job (${most} minutes). Lower \`timeout:\` or raise the limit in CI, CI access.`,
    };
  }
  return long.map((r) => ({
    accountId: r.accountId,
    displayName: r.displayName,
    maxConcurrentJobs: r.maxConcurrentJobs,
    maxJobMinutes: r.maxJobMinutes,
  }));
}

async function liveJobsOf(accountIds: string[]): Promise<Map<string, number>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .select({ accountId: ciCloudJobs.accountId, n: sql<number>`count(*)::int` })
    .from(ciCloudJobs)
    .where(and(inArray(ciCloudJobs.accountId, accountIds), ne(ciCloudJobs.state, "done")))
    .groupBy(ciCloudJobs.accountId);
  return new Map(rows.flatMap((r) => (r.accountId ? [[r.accountId, r.n] as const] : [])));
}

/** Claims and starts one waiting cloud job, or refuses it. */
export async function startCloudJob(run: RunRow, spec: CloudJobSpec): Promise<void> {
  if (!run.proxyRunId) return;
  if (run.fromFork) {
    // The runner never lists a fork's cloud jobs; this is belt and braces.
    await refuseJob(run.proxyRunId, spec.job, "Cloud jobs only run for trusted runs.");
    return;
  }
  const rows = await db
    .select({
      accountId: accounts.id,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
      jobsEnabled: ciConnectionAccess.jobsEnabled,
      jobKinds: ciConnectionAccess.jobKinds,
      jobRepos: ciConnectionAccess.jobRepos,
      jobBranchPattern: ciConnectionAccess.jobBranchPattern,
      maxConcurrentJobs: ciConnectionAccess.maxConcurrentJobs,
      maxJobMinutes: ciConnectionAccess.maxJobMinutes,
    })
    .from(ciConnectionAccess)
    .innerJoin(accounts, eq(accounts.id, ciConnectionAccess.accountId))
    .where(eq(ciConnectionAccess.organizationId, run.organizationId))
    .orderBy(accounts.displayName);
  const match = matchConnections(run, spec, rows);
  if (!Array.isArray(match)) {
    await refuseJob(run.proxyRunId, spec.job, match.refuse);
    return;
  }
  const live = await liveJobsOf(match.map((m) => m.accountId));
  const chosen = match.find((m) => (live.get(m.accountId) ?? 0) < m.maxConcurrentJobs);
  // Every matching connection is busy: the job waits for a slot (the runner
  // fails it as lost if nothing frees one within its timeout).
  if (!chosen) return;

  const [row] = await db
    .insert(ciCloudJobs)
    .values({
      id: crypto.randomUUID(),
      organizationId: run.organizationId,
      runId: run.id,
      proxyRunId: run.proxyRunId,
      jobId: spec.job,
      jobName: spec.name,
      pipeline: spec.pipeline,
      accountId: chosen.accountId,
      pluginId: spec.cloud.provider,
      kind: spec.cloud.kind,
      machine: spec.cloud.machine ?? null,
      image: spec.cloud.image ?? null,
      region: spec.cloud.region ?? null,
      state: "claiming",
      // Replaced with the real one's hash when the claim succeeds.
      callbackTokenHash: hashToken(randomBytes(32).toString("hex")),
      timeoutSeconds: spec.timeout_secs,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return; // Another pass got it first.
  await claimAndStart(row, run, spec, chosen.displayName);
}

/** How long to wait before claim attempt `n` (1-based) again. */
export function claimBackoffMs(attempt: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
}

/**
 * Claims a job its row was made for, and starts it. A claim the runner
 * refuses (already claimed, or the job has ended: 409, 404) ends the row,
 * since nothing was started. Anything else (a busy proxy, the network) is
 * retried with backoff by the pass, and after {@link MAX_CLAIM_ATTEMPTS} the
 * job is reported failed to the runner rather than left waiting.
 */
async function claimAndStart(
  row: JobRow,
  run: Pick<RunRow, "id" | "organizationId" | "repoFullName" | "sha">,
  spec: CloudJobSpec,
  connectionName: string,
): Promise<void> {
  const resolved = row.accountId
    ? await getOrgAccountClient(row.accountId, run.organizationId).catch(() => null)
    : null;
  const kindInfo = resolved?.plugin.manifest.ciExecutor?.kinds.find(
    (k) => k.kind === spec.cloud.kind,
  );
  const executor = `${resolved?.plugin.manifest.displayName ?? spec.cloud.provider} ${spec.cloud.kind} on ${connectionName}`;

  let claim: ClaimAnswer;
  try {
    claim = await proxyJson<ClaimAnswer>(jobPath(row.proxyRunId, spec.job, "/claim"), {
      method: "POST",
      body: JSON.stringify({ executor: executor.slice(0, 200) }),
    });
  } catch (err) {
    if (err instanceof CiProxyError && (err.status === 409 || err.status === 404)) {
      // Claimed elsewhere, or ended: nothing was started, nothing to tear down.
      await db
        .update(ciCloudJobs)
        .set({
          state: "done",
          outcome: "skipped",
          reason: `not claimed: ${message(err)}`.slice(0, 2000),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(ciCloudJobs.id, row.id), eq(ciCloudJobs.state, "claiming")));
      return;
    }
    await claimFailed(row, err);
    return;
  }

  const token = randomBytes(32).toString("hex");
  const sealed: SealedClaim = {
    claim: claim.claim,
    env: claim.env ?? {},
    files: claim.files ?? [],
    inputsUrl: claim.inputs?.url ?? null,
    artifacts:
      claim.artifacts?.url && claim.artifacts.paths.length > 0
        ? { url: claim.artifacts.url, paths: claim.artifacts.paths }
        : null,
    script: claim.script,
    cwd: claim.cwd,
    cloneInto: claim.clone?.into ?? null,
    changes: claim.changes === "fail" ? "fail" : "ignore",
    repoFullName: run.repoFullName,
    sha: run.sha,
  };
  const encrypted = await encrypt(JSON.stringify(sealed), claimAad(row.id));
  await db
    .update(ciCloudJobs)
    .set({
      state: "starting",
      callbackTokenHash: hashToken(token),
      encryptedClaim: encrypted.ciphertext,
      claimIv: encrypted.iv,
      claimedAt: new Date(),
      reason: null,
      updatedAt: new Date(),
    })
    .where(eq(ciCloudJobs.id, row.id));

  const fail = async (reason: string) => {
    await finishOnRunner(row, sealed.claim, { status: "error", error: reason });
    await close(row, "error", reason);
  };
  if (!resolved?.client.ciStart || !kindInfo) {
    await fail(`The connection ${connectionName} can no longer run \`${spec.cloud.kind}\` jobs.`);
    return;
  }
  try {
    const handle = await resolved.client.ciStart({
      kind: kindInfo.kind,
      ...((spec.cloud.machine ?? kindInfo.defaults.machine)
        ? { machine: spec.cloud.machine ?? kindInfo.defaults.machine }
        : {}),
      ...((spec.cloud.image ?? kindInfo.defaults.image)
        ? { image: spec.cloud.image ?? kindInfo.defaults.image }
        : {}),
      ...((spec.cloud.region ?? kindInfo.defaults.region)
        ? { region: spec.cloud.region ?? kindInfo.defaults.region }
        : {}),
      ...(spec.cloud.gpu ? { gpu: spec.cloud.gpu } : {}),
      bootstrap: bootstrapScript(callbackUrl(), token),
      tags: { [CI_TAG]: orgTag(run.organizationId), [CI_RUN_TAG]: run.id, [CI_JOB_TAG]: row.id },
      name: `infrawrench-ci-${spec.name}`.slice(0, 120),
      maxSeconds: spec.timeout_secs + 600,
    });
    await db
      .update(ciCloudJobs)
      .set({ handle: { ...handle }, region: handle.region ?? row.region, updatedAt: new Date() })
      .where(eq(ciCloudJobs.id, row.id));
    await audit(row, "ci.cloud_job.start", {
      runId: run.id,
      job: spec.job,
      accountId: row.accountId,
      provider: spec.cloud.provider,
      kind: spec.cloud.kind,
      machine: spec.cloud.machine ?? kindInfo.defaults.machine ?? null,
      executor: handle.label,
    });
  } catch (err) {
    await fail(`${connectionName} could not start the job's ${kindInfo.label}: ${message(err)}`);
  }
}

/**
 * A claim that failed for a passing reason: tried again with backoff, and
 * after {@link MAX_CLAIM_ATTEMPTS} reported failed to the runner.
 */
async function claimFailed(row: JobRow, err: unknown): Promise<void> {
  const attempts = row.claimAttempts + 1;
  if (attempts >= MAX_CLAIM_ATTEMPTS) {
    const reason = `Infrawrench could not claim the job after ${attempts} attempts: ${message(err)}`;
    await refuseJob(row.proxyRunId, row.jobId, reason).catch(() => {});
    await db
      .update(ciCloudJobs)
      .set({
        state: "done",
        outcome: "error",
        reason: reason.slice(0, 2000),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ciCloudJobs.id, row.id));
    return;
  }
  await db
    .update(ciCloudJobs)
    .set({
      claimAttempts: attempts,
      reason: `claim failed, retrying: ${message(err)}`.slice(0, 2000),
      nextAttemptAt: new Date(Date.now() + claimBackoffMs(attempts)),
      updatedAt: new Date(),
    })
    .where(eq(ciCloudJobs.id, row.id));
}

/** Retries the claims that failed for a passing reason. */
async function retryClaims(): Promise<void> {
  const due = await db
    .select({ job: ciCloudJobs, run: ciRuns, accountName: accounts.displayName })
    .from(ciCloudJobs)
    .innerJoin(ciRuns, eq(ciRuns.id, ciCloudJobs.runId))
    .leftJoin(accounts, eq(accounts.id, ciCloudJobs.accountId))
    .where(and(eq(ciCloudJobs.state, "claiming"), lte(ciCloudJobs.nextAttemptAt, new Date())))
    .limit(20);
  for (const { job, run, accountName } of due) {
    // A run that has ended took its jobs with it.
    if (run.status !== "running") {
      await db
        .update(ciCloudJobs)
        .set({
          state: "done",
          outcome: "skipped",
          reason: "the run ended before the job was claimed",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(ciCloudJobs.id, job.id), eq(ciCloudJobs.state, "claiming")));
      continue;
    }
    let spec: CloudJobSpec;
    try {
      spec = await proxyJson<CloudJobSpec>(jobPath(job.proxyRunId, job.jobId));
    } catch (err) {
      if (err instanceof CiProxyError && (err.status === 404 || err.status === 409)) {
        await db
          .update(ciCloudJobs)
          .set({ state: "done", outcome: "skipped", finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(ciCloudJobs.id, job.id));
        continue;
      }
      await claimFailed(job, err);
      continue;
    }
    if (spec.state !== "external") {
      await db
        .update(ciCloudJobs)
        .set({
          state: "done",
          outcome: "skipped",
          reason: `the job is ${spec.state}`,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(ciCloudJobs.id, job.id));
      continue;
    }
    await claimAndStart(job, run, spec, accountName ?? job.pluginId);
  }
}

async function finishOnRunner(
  row: Pick<JobRow, "proxyRunId" | "jobId">,
  claim: string,
  body: Record<string, unknown>,
): Promise<"ok" | "stop"> {
  try {
    await proxyJson(jobPath(row.proxyRunId, row.jobId, "/finish"), {
      method: "POST",
      body: JSON.stringify({ claim, ...body }),
    });
    return "ok";
  } catch (err) {
    if (err instanceof CiProxyError && (err.status === 409 || err.status === 404)) return "stop";
    throw err;
  }
}

/** Ends a row: its secret part goes, and teardown starts. */
async function close(
  row: Pick<JobRow, "id">,
  outcome: string,
  reason: string | null,
): Promise<void> {
  await db
    .update(ciCloudJobs)
    .set({
      state: "tearing_down",
      outcome,
      reason: reason?.slice(0, 2000) ?? null,
      encryptedClaim: null,
      claimIv: null,
      finishedAt: new Date(),
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(ciCloudJobs.id, row.id), inArray(ciCloudJobs.state, ["starting", "running"])));
}

async function unseal(row: JobRow): Promise<SealedClaim | null> {
  if (!row.encryptedClaim || !row.claimIv) return null;
  return JSON.parse(
    await decrypt(row.encryptedClaim, row.claimIv, claimAad(row.id)),
  ) as SealedClaim;
}

/* ------------------------------------------------------------------ *
 * The machine's callback (`/api/ci-jobs/...`, the token in the `X-Infrawrench-Ci-Job` header).
 * ------------------------------------------------------------------ */

export class CloudJobCallbackError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
    this.name = "CloudJobCallbackError";
  }
}

async function byToken(token: string): Promise<JobRow> {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new CloudJobCallbackError("No such job.", 404);
  const [row] = await db
    .select()
    .from(ciCloudJobs)
    .where(eq(ciCloudJobs.callbackTokenHash, hashToken(token)))
    .limit(1);
  if (!row) throw new CloudJobCallbackError("No such job.", 404);
  if (row.state !== "starting" && row.state !== "running") {
    throw new CloudJobCallbackError("The job has ended.", 409);
  }
  return row;
}

/**
 * The job script, served once: the first fetch moves the job to `running`
 * and every later one is refused, so the token in user data is spent.
 */
export async function cloudJobScript(token: string): Promise<string> {
  const row = await byToken(token);
  const [taken] = await db
    .update(ciCloudJobs)
    .set({ state: "running", lastSeenAt: new Date(), updatedAt: new Date() })
    .where(and(eq(ciCloudJobs.id, row.id), eq(ciCloudJobs.state, "starting")))
    .returning({ id: ciCloudJobs.id });
  if (!taken) throw new CloudJobCallbackError("The job script was already fetched.", 409);
  const sealed = await unseal(row);
  if (!sealed) throw new CloudJobCallbackError("The job has ended.", 409);
  const proxyUrl = process.env["CI_PROXY_URL"] ?? "";
  return jobScript({
    callbackUrl: callbackUrl(),
    token,
    proxyUrl,
    name: row.jobName,
    script: sealed.script,
    cwd: sealed.cwd,
    cloneInto: sealed.cloneInto,
    timeoutSecs: row.timeoutSeconds,
    changes: sealed.changes,
    env: sealed.env,
    files: sealed.files,
    inputsUrl: sealed.inputsUrl,
    artifacts: sealed.artifacts,
    // A `host` job runs on a machine that outlives it: in a root of its own,
    // which goes with the job. Every other kind gets fresh compute.
    isolate: row.kind === "host",
  });
}

/**
 * Where the machine downloads the commit: GitHub's short-lived source
 * archive link for it, made with the App's installation token, which itself
 * never reaches the machine.
 */
export async function cloudJobSource(token: string): Promise<string> {
  const row = await byToken(token);
  const sealed = await unseal(row);
  if (!sealed) throw new CloudJobCallbackError("The job has ended.", 409);
  const [run] = await db
    .select({ installationId: ciRuns.installationId })
    .from(ciRuns)
    .where(eq(ciRuns.id, row.runId))
    .limit(1);
  if (!run) throw new CloudJobCallbackError("No such job.", 404);
  const installationToken = await getInstallationToken(run.installationId);
  const res = await fetch(
    `https://api.github.com/repos/${sealed.repoFullName}/tarball/${encodeURIComponent(sealed.sha)}`,
    {
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${installationToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "infrawrench-ci",
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  await res.body?.cancel().catch(() => {});
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) {
    throw new Error(`GitHub answered ${res.status} for the commit's source archive`);
  }
  return location;
}

/** Relays the machine's output (or a heartbeat) to the runner. */
export async function cloudJobLog(
  token: string,
  stream: "stdout" | "stderr",
  text: string,
): Promise<void> {
  const row = await byToken(token);
  const sealed = await unseal(row);
  if (!sealed) throw new CloudJobCallbackError("The job has ended.", 409);
  await db
    .update(ciCloudJobs)
    .set({ lastSeenAt: new Date(), ...(row.state === "starting" ? { state: "running" } : {}) })
    .where(eq(ciCloudJobs.id, row.id));
  try {
    await proxyJson(jobPath(row.proxyRunId, row.jobId, "/log"), {
      method: "POST",
      body: JSON.stringify({ claim: sealed.claim, stream, ...(text ? { text } : {}) }),
    });
  } catch (err) {
    if (err instanceof CiProxyError && (err.status === 409 || err.status === 404)) {
      await close(row, "cancelled", "The runner ended the job.");
      throw new CloudJobCallbackError("The job has ended.", 409);
    }
    throw err;
  }
}

/** Relays how the job ended, and starts tearing its machine down. */
export async function cloudJobFinish(
  token: string,
  result: {
    status: "passed" | "failed" | "error";
    exitCode: number;
    timedOut: boolean;
    body: string;
  },
): Promise<void> {
  const row = await byToken(token);
  const sealed = await unseal(row);
  if (!sealed) throw new CloudJobCallbackError("The job has ended.", 409);
  const { output, changes } = parseFinishBody(result.body);
  const body: Record<string, unknown> = { status: result.status };
  if (result.status !== "error") body["exit_code"] = result.exitCode;
  if (output) body["output"] = output;
  if (result.timedOut) {
    body["timed_out"] = true;
    body["error"] = `timed out after ${row.timeoutSeconds}s`;
  }
  if (result.status === "error")
    body["error"] = "The job could not run on its machine; its log says why.";
  if (sealed.changes === "fail" && changes.length > 0) body["changes"] = changes;
  await finishOnRunner(row, sealed.claim, body);
  await close(
    row,
    result.status === "passed" ? "passed" : result.timedOut ? "timed-out" : result.status,
    null,
  );
  await audit(row, "ci.cloud_job.finish", {
    job: row.jobId,
    status: result.status,
    exitCode: result.exitCode,
  });
}

/* ------------------------------------------------------------------ *
 * The pass.
 * ------------------------------------------------------------------ */

/** Runs with a cloud job that may be waiting. */
async function runsWithCloudJobs(limit: number): Promise<RunRow[]> {
  return db
    .select()
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.status, "running"),
        isNotNull(ciRuns.proxyRunId),
        eq(ciRuns.fromFork, false),
        sql`exists (select 1 from jsonb_array_elements(coalesce(${ciRuns.access}, '[]'::jsonb)) e where e ? 'cloud')`,
      ),
    )
    .orderBy(ciRuns.startedAt)
    .limit(limit);
}

async function claimWaiting(run: RunRow): Promise<void> {
  if (!run.proxyRunId) return;
  let listed: { jobs?: CloudJobSpec[] };
  try {
    listed = await proxyJson(`/v1/runs/${encodeURIComponent(run.proxyRunId)}/jobs`);
  } catch (err) {
    if (err instanceof CiProxyError && (err.status === 404 || err.status === 409)) return;
    throw err;
  }
  const waiting = (listed.jobs ?? []).filter((j) => j.state === "external");
  if (waiting.length === 0) return;
  const known = await db
    .select({ jobId: ciCloudJobs.jobId })
    .from(ciCloudJobs)
    .where(
      and(
        eq(ciCloudJobs.proxyRunId, run.proxyRunId),
        inArray(
          ciCloudJobs.jobId,
          waiting.map((j) => j.job),
        ),
      ),
    );
  const seen = new Set(known.map((k) => k.jobId));
  for (const spec of waiting) {
    if (seen.has(spec.job)) continue;
    await startCloudJob(run, spec).catch((err: unknown) =>
      console.warn(`[ci-cloud] starting ${run.id} ${spec.job} failed:`, err),
    );
  }
}

/** Keeps a live job's lease while its machine boots, and ends what has run out of time. */
async function followLive(row: JobRow): Promise<void> {
  const now = Date.now();
  const claimed = row.claimedAt.getTime();
  if (now > claimed + (row.timeoutSeconds + 600) * 1000) {
    await close(
      row,
      "timed-out",
      `No result ${Math.round((row.timeoutSeconds + 600) / 60)} minutes after it was claimed.`,
    );
    return;
  }
  if (row.state === "starting") {
    if (now > claimed + BOOT_DEADLINE_MS) {
      const sealed = await unseal(row);
      const reason =
        "Its machine never called back. Check that it can reach Infrawrench over HTTPS.";
      if (sealed)
        await finishOnRunner(row, sealed.claim, { status: "error", error: reason }).catch(() => {});
      await close(row, "error", reason);
      return;
    }
    // Heartbeat for the machine until it calls back itself.
    const sealed = await unseal(row);
    if (!sealed) return;
    try {
      await proxyJson(jobPath(row.proxyRunId, row.jobId, "/log"), {
        method: "POST",
        body: JSON.stringify({ claim: sealed.claim }),
      });
    } catch (err) {
      if (err instanceof CiProxyError && (err.status === 409 || err.status === 404)) {
        await close(row, "cancelled", "The runner ended the job.");
      }
    }
    return;
  }
  // Running: the machine's own calls keep the lease. One that has gone
  // quiet is checked with the runner, which ends it as lost after 5 minutes.
  if (row.lastSeenAt && now - row.lastSeenAt.getTime() > 5 * 60_000) {
    try {
      const spec = await proxyJson<CloudJobSpec>(jobPath(row.proxyRunId, row.jobId));
      if (STOP_STATES.has(spec.state)) await close(row, spec.state, "The runner ended the job.");
    } catch (err) {
      if (err instanceof CiProxyError && err.status === 404) {
        await close(row, "lost", "The runner no longer has the run.");
      }
    }
  }
}

async function tearDown(row: JobRow): Promise<void> {
  const done = async (error: string | null) =>
    db
      .update(ciCloudJobs)
      .set({ state: "done", teardownError: error, updatedAt: new Date() })
      .where(eq(ciCloudJobs.id, row.id));
  if (!row.handle || !row.accountId) {
    await done(null);
    return;
  }
  try {
    const resolved = await getOrgAccountClient(row.accountId, row.organizationId);
    if (!resolved?.client.ciTeardown) throw new Error("the connection can no longer tear it down");
    await resolved.client.ciTeardown(row.handle as CiHandle);
    await done(null);
  } catch (err) {
    const attempts = row.teardownAttempts + 1;
    if (attempts >= MAX_TEARDOWN_ATTEMPTS) {
      await done(`Gave up after ${attempts} attempts: ${message(err)}`);
      return;
    }
    await db
      .update(ciCloudJobs)
      .set({
        teardownAttempts: attempts,
        teardownError: message(err).slice(0, 2000),
        nextAttemptAt: new Date(Date.now() + Math.min(15_000 * 2 ** attempts, 15 * 60_000)),
        updatedAt: new Date(),
      })
      .where(eq(ciCloudJobs.id, row.id));
  }
}

let lastReap = 0;

/**
 * Removes compute tagged for an organization's CI that no live job owns,
 * on every connection that has run a cloud job in the last week: what a
 * lost row, a crash between start and save, or a failed teardown left.
 */
export async function reapTagged(): Promise<number> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const used = await db
    .select({
      accountId: ciCloudJobs.accountId,
      organizationId: ciCloudJobs.organizationId,
      regions: sql<string[]>`array_remove(array_agg(distinct ${ciCloudJobs.region}), null)`,
    })
    .from(ciCloudJobs)
    .where(and(isNotNull(ciCloudJobs.accountId), gte(ciCloudJobs.createdAt, since)))
    .groupBy(ciCloudJobs.accountId, ciCloudJobs.organizationId);
  let removed = 0;
  for (const { accountId, organizationId, regions } of used) {
    if (!accountId) continue;
    const resolved = await getOrgAccountClient(accountId, organizationId).catch(() => null);
    if (!resolved?.client.ciListTagged || !resolved.client.ciTeardown) continue;
    let tagged;
    try {
      tagged = await resolved.client.ciListTagged(CI_TAG, regions ?? []);
    } catch (err) {
      console.warn(`[ci-cloud] listing tagged compute on ${accountId} failed:`, err);
      continue;
    }
    const mine = tagged.filter((t) => t.tags[CI_TAG] === orgTag(organizationId));
    const jobIds = mine.flatMap((t) => (t.tags[CI_JOB_TAG] ? [t.tags[CI_JOB_TAG]] : []));
    const live = new Set(
      jobIds.length === 0
        ? []
        : (
            await db
              .select({ id: ciCloudJobs.id })
              .from(ciCloudJobs)
              .where(
                and(
                  inArray(ciCloudJobs.id, jobIds),
                  inArray(ciCloudJobs.state, ["starting", "running"]),
                ),
              )
          ).map((r) => r.id),
    );
    for (const t of mine) {
      const job = t.tags[CI_JOB_TAG];
      if (job && live.has(job)) continue;
      const created = t.createdAt ? Date.parse(t.createdAt) : 0;
      if (Date.now() - created < REAP_GRACE_MS) continue;
      try {
        await resolved.client.ciTeardown(t.handle);
        removed++;
        await audit({ organizationId, id: job ?? t.handle.id }, "ci.cloud_job.reap", {
          accountId,
          executor: t.handle.label,
        });
      } catch (err) {
        console.warn(`[ci-cloud] removing ${t.handle.label} failed:`, err);
      }
    }
  }
  return removed;
}

/**
 * The executor's pass: claim and start waiting cloud jobs, keep starting
 * ones alive, end the ones out of time, tear down the ended, and now and
 * then reap what nothing owns. Every step claims or settles its rows.
 */
export async function runCiCloudPass(): Promise<void> {
  if (!ciProxyConfigured()) return;
  // Runs the edge could not send because their jobs are lent something,
  // which only plugin code can read.
  const deferred = await db
    .select({ id: ciRuns.id })
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.status, "queued"),
        lte(ciRuns.nextAttemptAt, new Date()),
        sql`jsonb_array_length(coalesce(${ciRuns.access}, '[]'::jsonb)) > 0`,
      ),
    )
    .limit(20);
  for (const { id } of deferred) {
    await dispatchRun(id).catch((err: unknown) =>
      console.warn(`[ci-cloud] dispatching ${id}:`, err),
    );
  }
  for (const run of await runsWithCloudJobs(50)) {
    await claimWaiting(run).catch((err: unknown) => console.warn(`[ci-cloud] run ${run.id}:`, err));
  }
  await retryClaims().catch((err: unknown) => console.warn("[ci-cloud] retrying claims:", err));
  const live = await db
    .select()
    .from(ciCloudJobs)
    .where(inArray(ciCloudJobs.state, ["starting", "running"]))
    .limit(200);
  for (const row of live) {
    await followLive(row).catch((err: unknown) => console.warn(`[ci-cloud] job ${row.id}:`, err));
  }
  const ending = await db
    .select()
    .from(ciCloudJobs)
    .where(and(eq(ciCloudJobs.state, "tearing_down"), lte(ciCloudJobs.nextAttemptAt, new Date())))
    .limit(50);
  for (const row of ending) {
    await tearDown(row).catch((err: unknown) =>
      console.warn(`[ci-cloud] teardown ${row.id}:`, err),
    );
  }
  if (Date.now() - lastReap > REAP_EVERY_MS) {
    lastReap = Date.now();
    await reapTagged().catch((err: unknown) => console.warn("[ci-cloud] reaping failed:", err));
  }
}
