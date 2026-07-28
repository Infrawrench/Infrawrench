/**
 * Deployments — running a repository's Infrafile.
 *
 * In server-core because two callers need it: the web app (routes + the
 * websocket session) and `github-watcher`, which fires deploy-on-push triggers
 * and cannot import web. Web re-exports it, so its routes are unchanged — the
 * same arrangement `workflows/runner.ts` uses.
 *
 * The Infrafile is fetched from git on every run and never written down. What
 * is persisted is the *record* of a run — env, commit, image, logs — so there
 * is an audit trail. See `db/deployment-schema.ts` for why that split matters.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { deploymentRuns, githubInstallations } from "../db/schema.js";
import {
  getBranchHeadSha,
  createGithubDeployment,
  getFileContents,
  getInstallationToken,
  getRepoTarball,
  setGithubDeploymentStatus,
  isGithubAppConfigured,
  listInstallationRepos,
} from "../github/app.js";
import {
  buildOnCloudBuild,
  cleanupStagedImage,
  cloudBuildConfig,
  runOnCloudBuild,
  type CloudBuildContext,
} from "./build-cloud.js";
import {
  buildOverSsh,
  cleanupOverSsh,
  copyToOverSsh,
  pushOverSsh,
  runOverSsh,
  type SshBuildContext,
} from "./build-ssh.js";
import { buildOrgWorkflowHost } from "../workflows/runner.js";
import { pageFromExternal } from "../paging/external-pages.js";
import { requirePaidPlan } from "../entitlements.js";
import type {
  BuildRequest,
  InfrafileHost,
  InfrafileRollback,
  InfrafileRunResult,
  InfrafileStage,
  RunInImageRequest,
  RunLogEntry,
} from "@infrawrench/workflow-runtime";

/** Where an Infrafile lives. Not configurable — that is the point of the name. */
const INFRAFILE_PATH = "Infrafile";

export class DeploymentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DeploymentError";
    this.status = status;
  }
}

/** `owner/name` from a full name or a GitHub URL. */
function repoFullName(repo: string): { owner: string; name: string } | null {
  const trimmed = repo.trim().replace(/\.git$/, "");
  const match = trimmed.match(/^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+)$/);
  if (!match) return null;
  return { owner: match[1]!, name: match[2]! };
}

/** The org's GitHub App installation that can see `repo`, if any. */
async function installationForRepo(
  organizationId: string,
  fullName: string,
): Promise<number | null> {
  if (!isGithubAppConfigured()) return null;
  const installs = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.organizationId, organizationId));
  for (const install of installs) {
    const repos = await listInstallationRepos(install.installationId).catch(() => []);
    if (repos.some((r) => r.fullName.toLowerCase() === fullName.toLowerCase())) {
      return install.installationId;
    }
  }
  return null;
}

export interface ResolvedSource {
  owner: string;
  name: string;
  fullName: string;
  branch: string;
  sha: string;
  installationId: number;
  source: string;
  /**
   * Clone URL with a short-lived installation token embedded, for the build
   * host. Minted per run; the remote is reset after cloning so it never
   * persists on the host.
   */
  cloneUrl: string;
}

/**
 * Fetch a repo's Infrafile at a branch head. Errors here are the common ones —
 * no install, no such branch, no Infrafile — so each says exactly what to fix.
 */
export async function resolveInfrafile(
  organizationId: string,
  repo: string,
  branch: string,
): Promise<ResolvedSource> {
  const parsed = repoFullName(repo);
  if (!parsed) throw new DeploymentError(`"${repo}" is not an owner/name repository.`);
  const fullName = `${parsed.owner}/${parsed.name}`;

  const installationId = await installationForRepo(organizationId, fullName);
  if (installationId === null) {
    throw new DeploymentError(
      `No GitHub App installation in this organization can see ${fullName}. ` +
        `Connect it under Settings → GitHub.`,
      404,
    );
  }

  // `branch` may be a commit SHA — a rollback re-reads the Infrafile at the
  // exact commit a past run deployed. The branches API only resolves names, so
  // a full SHA is used as the ref directly.
  const isSha = /^[0-9a-f]{40}$/i.test(branch);
  const sha = isSha
    ? branch
    : await getBranchHeadSha(installationId, parsed.owner, parsed.name, branch);
  if (!sha) throw new DeploymentError(`${fullName} has no branch named "${branch}".`, 404);

  const source = await getFileContents(
    installationId,
    parsed.owner,
    parsed.name,
    sha,
    INFRAFILE_PATH,
  );
  if (source === null) {
    throw new DeploymentError(`${fullName}@${branch} has no ${INFRAFILE_PATH} at its root.`, 404);
  }

  const token = await getInstallationToken(installationId);
  return {
    owner: parsed.owner,
    name: parsed.name,
    fullName,
    branch,
    sha,
    installationId,
    source,
    cloneUrl: `https://x-access-token:${token}@github.com/${fullName}.git`,
  };
}

/** Repos this org can deploy from, for the picker. */
export async function listDeployableRepos(
  organizationId: string,
): Promise<{ fullName: string; defaultBranch: string }[]> {
  if (!isGithubAppConfigured()) return [];
  const installs = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.organizationId, organizationId));

  const out: { fullName: string; defaultBranch: string }[] = [];
  for (const install of installs) {
    for (const repo of await listInstallationRepos(install.installationId).catch(() => [])) {
      out.push({ fullName: repo.fullName, defaultBranch: repo.defaultBranch ?? "main" });
    }
  }
  return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export interface RunDeploymentOptions {
  organizationId: string;
  userId?: string;
  repo: string;
  branch: string;
  env?: string;
  planOnly?: boolean;
  /** Pre-supplied answers for `select(key, …)`. */
  answers?: Record<string, string>;
  interactive: boolean;
  /** Raise a prompt to the caller (websocket sessions only). */
  prompt?: InfrafileHost["prompt"];
  /** Replay a past run's deploy with its recorded artifact (see rollbackDeployment). */
  rollback?: InfrafileRollback;
  onLog?: (entry: RunLogEntry) => void;
  onStage?: (stage: InfrafileStage) => void;
  signal?: AbortSignal;
}

/**
 * Run an Infrafile end to end and persist the record.
 *
 * The build happens on the resource the plan chose via `buildOn` — the web
 * app has no working tree and its pods have no Docker daemon, so unlike the
 * CLI there is no local fallback. A plan that omits `buildOn` fails saying so.
 */
export async function runDeployment(
  opts: RunDeploymentOptions,
): Promise<{ runId: string; result: InfrafileRunResult }> {
  // A plan-only preview is left open on purpose: it builds nothing and ships
  // nothing, and seeing what a deploy *would* do is how someone decides the
  // plan is worth paying for. Anything that actually builds or ships is gated.
  if (!opts.planOnly) {
    await requirePaidPlan(opts.organizationId, "Deploying from the web app");
  }

  const { runInfrafile } = await import("@infrawrench/workflow-runtime");
  const resolved = await resolveInfrafile(opts.organizationId, opts.repo, opts.branch);

  // One deploy per environment at a time. Without this two people shipping the
  // same env both proceed and the infrastructure takes whichever finished last —
  // a race whose loser has no idea it happened. The conditional insert is the
  // same claim pattern the poller uses to stop replicas double-firing.
  const inFlight = await db
    .select({ id: deploymentRuns.id, startedAt: deploymentRuns.startedAt })
    .from(deploymentRuns)
    .where(
      and(
        eq(deploymentRuns.organizationId, opts.organizationId),
        eq(deploymentRuns.env, opts.env ?? ""),
        eq(deploymentRuns.status, "running"),
      ),
    )
    .limit(1);
  if (!opts.planOnly && inFlight.length > 0) {
    throw new DeploymentError(
      `A deploy to ${opts.env} is already running (started ${inFlight[0]!.startedAt.toISOString()}). ` +
        `Wait for it to finish, or stop it first.`,
      409,
    );
  }

  const runId = randomUUID();
  await db.insert(deploymentRuns).values({
    id: runId,
    organizationId: opts.organizationId,
    env: opts.env ?? "",
    repo: resolved.fullName,
    branch: resolved.branch,
    gitSha: resolved.sha,
    status: "running",
    origin: "web",
    ...(opts.userId ? { createdByUserId: opts.userId } : {}),
  });

  // Report the deploy back into the pull request / commit it came from. Every
  // call is best-effort: GitHub being slow or the App lacking `deployments:
  // write` must never be what fails somebody's deploy.
  const ghDeployment = opts.planOnly
    ? null
    : await createGithubDeployment(resolved.installationId, resolved.owner, resolved.name, {
        ref: resolved.sha,
        environment: opts.env ?? "",
        description: opts.rollback ? "Rollback via Infrawrench" : "Deploy via Infrawrench",
      }).catch(() => null);

  const reportToGithub = async (
    state: "in_progress" | "success" | "failure",
    description: string,
  ): Promise<void> => {
    if (ghDeployment === null) return;
    await setGithubDeploymentStatus(
      resolved.installationId,
      resolved.owner,
      resolved.name,
      ghDeployment,
      state,
      { description },
    ).catch(() => {});
  };
  await reportToGithub("in_progress", "Building");

  // The build host is only known once `plan()` has returned, so the SSH
  // context is completed lazily and shared by build/push/run/copyTo.
  let sshCtx: (SshBuildContext & { workspace: string }) | null = null;

  // Hosted builds are the default; `buildOn` is an override for a project that
  // needs a specific machine, a warm cache, or private network access.
  let cloudCtx: CloudBuildContext | null = null;
  let buildSeconds = 0;

  const hostedContext = async (): Promise<CloudBuildContext> => {
    if (cloudCtx) return cloudCtx;
    const config = cloudBuildConfig();
    if (!config) {
      throw new Error(
        "Hosted builds are not configured on this deployment. Return `buildOn` from plan() " +
          "set to an SSH-reachable resource to build there instead.",
      );
    }
    cloudCtx = {
      config,
      sourceTarGz: await getRepoTarball(
        resolved.installationId,
        resolved.owner,
        resolved.name,
        resolved.sha,
      ),
      gitSha: resolved.sha,
      repo: resolved.fullName,
      log,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    return cloudCtx;
  };

  const log = (line: string) => {
    opts.onLog?.({ at: Date.now(), level: "info", message: line });
  };

  const base = buildOrgWorkflowHost(opts.organizationId, runId, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const host: InfrafileHost = {
    ...base,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    infrafileAnswer: async (key: string) => opts.answers?.[key],

    infrafileBuild: async (request: BuildRequest) => {
      // `buildOn: "local"` names the operator's own Docker daemon, which does
      // not exist here. Silently building somewhere else would be answering a
      // different question than the one the Infrafile asked.
      if (request.target?.kind === "local") {
        throw new Error(
          'plan().buildOn is "local", which means the machine running the deploy — ' +
            "there is no such machine for a web deploy. Omit buildOn to use a hosted " +
            "build, or set it to an SSH-reachable resource.",
        );
      }
      if (!request.target) {
        const built = await buildOnCloudBuild(request, await hostedContext());
        buildSeconds += built.buildSeconds;
        return built.digest ? { image: built.image, digest: built.digest } : { image: built.image };
      }
      const target = request.target.resource;
      const ctx: SshBuildContext = {
        organizationId: opts.organizationId,
        target,
        cloneUrl: resolved.cloneUrl,
        gitSha: resolved.sha,
        branch: resolved.branch,
        repo: resolved.fullName,
        log,
        ...(opts.signal ? { signal: opts.signal } : {}),
      };
      const built = await buildOverSsh(request, ctx);
      sshCtx = { ...ctx, workspace: built.workspace };
      return built.digest ? { image: built.image, digest: built.digest } : { image: built.image };
    },

    infrafilePush: async (image, registry) => {
      if (!sshCtx) throw new Error("push() ran before the build.");
      await pushOverSsh(image, registry, sshCtx);
    },

    infrafileRun: async (request: RunInImageRequest) => {
      // Whichever runner built the image is the one that can run it.
      if (sshCtx) return runOverSsh(request, sshCtx);
      if (cloudCtx) return runOnCloudBuild(request, cloudCtx);
      throw new Error("run() ran before the build.");
    },

    infrafileCopyTo: async (target, remotePath) => {
      if (!sshCtx) throw new Error("copyTo() ran before the build.");
      await copyToOverSsh(target, remotePath, sshCtx);
    },
  };

  let result: InfrafileRunResult;
  try {
    result = await runInfrafile({
      source: resolved.source,
      host,
      git: {
        sha: resolved.sha,
        branch: resolved.branch,
        repo: resolved.fullName,
      },
      ...(opts.env ? { env: opts.env } : {}),
      interactive: opts.interactive,
      ...(opts.planOnly ? { planOnly: true } : {}),
      ...(opts.rollback ? { rollback: opts.rollback } : {}),
      ...(opts.onLog ? { onLog: opts.onLog } : {}),
      ...(opts.onStage ? { onStage: opts.onStage } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    // `runInfrafile` returns failures rather than throwing, so reaching here
    // means something outside it broke (an isolate crash, an abort, a host that
    // could not be built). Without this the row stays `running` forever and the
    // history shows a deploy permanently in flight with no reason attached.
    await db
      .update(deploymentRuns)
      .set({
        status: "failure",
        error: { message: err instanceof Error ? err.message : String(err) },
        finishedAt: new Date(),
      })
      .where(eq(deploymentRuns.id, runId));
    throw err;
  } finally {
    // Always clear the scratch directory — a failed deploy leaves a clone with
    // build artifacts behind otherwise, and those accumulate silently.
    if (sshCtx) await cleanupOverSsh(sshCtx).catch(() => {});
    // Same for the staged image: it exists only so run() had something to pull.
    if (cloudCtx) await cleanupStagedImage(cloudCtx).catch(() => {});
  }

  // A production deploy that fails at 3am should wake somebody. Reuses the four
  // transports `infra.page` already fans out to; throttling is keyed per env so
  // a retry loop pages once rather than every attempt.
  if (result.status !== "success" && !opts.planOnly) {
    await pageFromExternal(
      { organizationId: opts.organizationId, source: "deployments" },
      {
        message:
          `Deploy to ${result.env} failed for ${resolved.fullName}@${resolved.sha.slice(0, 7)}: ` +
          `${result.error?.message ?? "unknown error"}`,
        title: `Deploy failed — ${result.env}`,
        key: `deploy:${result.env}`,
      },
    ).catch(() => {
      // Paging is a courtesy on top of the recorded failure, never a reason to
      // lose the run's own error.
    });
  }

  await reportToGithub(
    result.status === "success" ? "success" : "failure",
    result.status === "success"
      ? `Deployed ${result.image ?? ""}`.trim()
      : (result.error?.message ?? "Deploy failed"),
  );

  await db
    .update(deploymentRuns)
    .set({
      env: result.env,
      status: result.status,
      logs: result.logs,
      planJson: result.plan ?? null,
      dockerfile: result.dockerfile ?? null,
      image: result.image ?? null,
      stage: result.reachedStage ?? null,
      buildSeconds: buildSeconds || null,
      buildRunner: cloudCtx ? "cloud-build" : sshCtx ? "ssh" : null,
      notes: result.notes.length > 0 ? result.notes.join("\n") : null,
      error: result.error ?? null,
      finishedAt: new Date(result.finishedAt),
      durationMs: result.durationMs,
    })
    .where(eq(deploymentRuns.id, runId));

  return { runId, result };
}

type BuildTargetOrThrow = NonNullable<
  Extract<BuildRequest["target"], { kind: "resource" }>
>["resource"];

export interface DeploymentRunRow {
  id: string;
  env: string;
  repo: string | null;
  branch: string | null;
  gitSha: string | null;
  image: string | null;
  status: string;
  origin: string;
  stage: string | null;
  durationMs: number | null;
  buildSeconds: number | null;
  buildRunner: string | null;
  startedAt: Date;
}

/** Deploy history, newest first. */
export async function listDeploymentRuns(
  organizationId: string,
  opts: { env?: string; limit?: number } = {},
): Promise<DeploymentRunRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.env
    ? and(eq(deploymentRuns.organizationId, organizationId), eq(deploymentRuns.env, opts.env))
    : eq(deploymentRuns.organizationId, organizationId);

  return db
    .select({
      id: deploymentRuns.id,
      env: deploymentRuns.env,
      repo: deploymentRuns.repo,
      branch: deploymentRuns.branch,
      gitSha: deploymentRuns.gitSha,
      image: deploymentRuns.image,
      status: deploymentRuns.status,
      origin: deploymentRuns.origin,
      stage: deploymentRuns.stage,
      durationMs: deploymentRuns.durationMs,
      buildSeconds: deploymentRuns.buildSeconds,
      buildRunner: deploymentRuns.buildRunner,
      startedAt: deploymentRuns.startedAt,
    })
    .from(deploymentRuns)
    .where(where)
    .orderBy(desc(deploymentRuns.startedAt))
    .limit(limit);
}

/** One run in full, including logs and the rendered Dockerfile. */
export async function getDeploymentRun(organizationId: string, id: string) {
  const rows = await db
    .select()
    .from(deploymentRuns)
    .where(and(eq(deploymentRuns.organizationId, organizationId), eq(deploymentRuns.id, id)))
    .limit(1);
  if (rows.length === 0) throw new DeploymentError("Deployment run not found.", 404);
  return rows[0]!;
}

/**
 * Ship a previous run's artifact again.
 *
 * The Infrafile is read **at the commit that run deployed**, not at the branch
 * head — rolling back should run the deploy logic that shipped alongside those
 * bytes, not whatever the branch has since become. The plan and image come
 * from the run's record, so `plan()`, `dockerfile()` and the build are all
 * skipped and the exact known-good image is what lands.
 *
 * Only a successful run that produced an image can be rolled back to; anything
 * else has no artifact to ship.
 */
export async function rollbackDeployment(opts: {
  organizationId: string;
  runId: string;
  userId?: string;
  onLog?: (entry: RunLogEntry) => void;
  onStage?: (stage: InfrafileStage) => void;
  signal?: AbortSignal;
}): Promise<{ runId: string; result: InfrafileRunResult }> {
  const source = await getDeploymentRun(opts.organizationId, opts.runId);
  if (source.status !== "success" || !source.image) {
    throw new DeploymentError(
      "That run did not produce an image, so there is nothing to roll back to.",
    );
  }
  if (!source.repo || !source.gitSha) {
    throw new DeploymentError(
      "That run has no recorded repository and commit, so its Infrafile cannot be re-read. " +
        "CLI runs against a directory with no git remote cannot be rolled back from the web app.",
    );
  }

  return runDeployment({
    organizationId: opts.organizationId,
    ...(opts.userId ? { userId: opts.userId } : {}),
    repo: source.repo,
    // The recorded commit, not the branch head — see above.
    branch: source.gitSha,
    env: source.env,
    interactive: false,
    rollback: {
      plan: source.planJson,
      image: source.image,
      fromRunId: source.id,
    },
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
    ...(opts.onStage ? { onStage: opts.onStage } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/**
 * Record a run that happened on somebody's machine. The CLI builds locally, so
 * the server never sees the run — it only gets told what happened, which keeps
 * one history across both origins.
 */
export async function recordCliRun(
  organizationId: string,
  userId: string | undefined,
  run: {
    env: string;
    repo?: string;
    branch?: string;
    gitSha?: string;
    image?: string;
    status: string;
    stage?: string;
    logs?: RunLogEntry[];
    notes?: string[];
    durationMs?: number;
    error?: { message: string } | null;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  await db.insert(deploymentRuns).values({
    id,
    organizationId,
    env: run.env,
    repo: run.repo ?? null,
    branch: run.branch ?? null,
    gitSha: run.gitSha ?? null,
    image: run.image ?? null,
    status: run.status,
    origin: "cli",
    stage: run.stage ?? null,
    logs: run.logs ?? [],
    notes: run.notes && run.notes.length > 0 ? run.notes.join("\n") : null,
    error: run.error ?? null,
    durationMs: run.durationMs ?? null,
    finishedAt: new Date(),
    ...(userId ? { createdByUserId: userId } : {}),
  });
  return { id };
}
