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
import { and, desc, eq, gt, lt } from "drizzle-orm";

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
import { writeDeploymentBuildCost } from "../cost/deployment-costs.js";
import { reportHostedBuildToMeter } from "../billing/build-meter.js";
import type {
  BuildRequest,
  InfrafileCreatedResource,
  InfrafileHost,
  InfrafileRollback,
  InfrafileRunResult,
  InfrafileStage,
  RunInImageRequest,
  RunLogEntry,
} from "@infrawrench/workflow-runtime";

/**
 * A `running` row older than this is treated as abandoned. Double the hosted
 * build timeout: nothing legitimate outlives that, and a row that does has
 * lost its process — leaving it would wedge the environment's deploy lock.
 */
const STALE_RUN_MS = 2 * 1200 * 1000;

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
  /**
   * Which surface started this run: `web` (default) or `trigger`
   * (deploy-on-push via github-watcher). The CLI records its own runs through
   * `recordCliRun` instead, which is why `cli` is not an option here.
   */
  origin?: "web" | "trigger";
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
    await requirePaidPlan(
      opts.organizationId,
      opts.origin === "trigger" ? "Deploy-on-push" : "Deploying from the web app",
    );
  }

  // One deploy per environment at a time — enforced by the DATABASE, via the
  // partial unique index `deployment_runs_one_running`. An earlier version
  // checked then inserted, which reads as a lock and is not one: two deploys
  // arriving in the same window both saw zero running rows and both proceeded,
  // which is exactly the race the lock exists to prevent (and the watcher fans
  // several triggers out concurrently). Here the insert IS the claim; a
  // conflict means somebody else holds the environment.
  //
  // Claimed BEFORE the Infrafile is fetched: it needs nothing from git, and
  // paying for a GitHub round-trip only to refuse is both slower and a worse
  // error (the caller sees whatever git said, not that the env is busy).
  //
  // First, unwedge: a pod killed mid-deploy leaves its row `running` forever,
  // and with the index enforcing uniqueness that would block every future
  // deploy to the environment. Anything still "running" after double the build
  // timeout is dead — its process is gone and nothing will ever finish it.
  const staleBefore = new Date(Date.now() - STALE_RUN_MS);
  await db
    .update(deploymentRuns)
    .set({
      status: "failure",
      error: { message: "Abandoned — the process running this deploy went away." },
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(deploymentRuns.organizationId, opts.organizationId),
        eq(deploymentRuns.env, opts.env ?? ""),
        eq(deploymentRuns.status, "running"),
        lt(deploymentRuns.startedAt, staleBefore),
      ),
    );

  const runId = randomUUID();
  const claimed = await db
    .insert(deploymentRuns)
    .values({
      id: runId,
      organizationId: opts.organizationId,
      env: opts.env ?? "",
      // A plan-only preview starts as `pending`, deliberately outside the
      // partial index: previews neither hold the environment nor wait for it.
      status: opts.planOnly ? "pending" : "running",
      origin: opts.origin ?? "web",
      ...(opts.userId ? { createdByUserId: opts.userId } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: deploymentRuns.id });

  if (claimed.length === 0) {
    const holder = await db
      .select({ startedAt: deploymentRuns.startedAt })
      .from(deploymentRuns)
      .where(
        and(
          eq(deploymentRuns.organizationId, opts.organizationId),
          eq(deploymentRuns.env, opts.env ?? ""),
          eq(deploymentRuns.status, "running"),
        ),
      )
      .limit(1);
    throw new DeploymentError(
      `A deploy to ${opts.env} is already running` +
        (holder[0] ? ` (started ${holder[0].startedAt.toISOString()})` : "") +
        `. Wait for it to finish, or stop it first.`,
      409,
    );
  }

  const { runInfrafile } = await import("@infrawrench/workflow-runtime");

  let resolved: ResolvedSource;
  try {
    resolved = await resolveInfrafile(opts.organizationId, opts.repo, opts.branch);
    await db
      .update(deploymentRuns)
      .set({ repo: resolved.fullName, branch: resolved.branch, gitSha: resolved.sha })
      .where(eq(deploymentRuns.id, runId));
  } catch (err) {
    // The claim row exists before git is consulted, so a failed resolve must
    // release the environment rather than leave it held by a run that never
    // started.
    await db
      .update(deploymentRuns)
      .set({
        status: "failure",
        error: { message: err instanceof Error ? err.message : String(err) },
        finishedAt: new Date(),
      })
      .where(eq(deploymentRuns.id, runId));
    throw err;
  }

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
      if (cloudCtx) {
        // Each hosted run() is its own Cloud Build submission, so its worker
        // time is money we spent exactly like the image build's — and for the
        // Worker/static-site pattern the run() steps ARE most of the deploy.
        // Counting only the build would under-meter precisely the use case
        // hosted builds exist for. Timed even on failure: the worker ran.
        const startedAt = Date.now();
        try {
          return await runOnCloudBuild(request, cloudCtx);
        } finally {
          buildSeconds += Math.round((Date.now() - startedAt) / 1000);
        }
      }
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
      logs: cappedLogs(result.logs),
      planJson: result.plan ?? null,
      dockerfile: result.dockerfile ?? null,
      image: result.image ?? null,
      stage: result.reachedStage ?? null,
      buildSeconds: buildSeconds || null,
      buildRunner: cloudCtx ? "cloud-build" : sshCtx ? "ssh" : null,
      notes: result.notes.length > 0 ? result.notes.join("\n") : null,
      output: cappedJson(result.output),
      createdResources: cappedCreatedResources(result.createdResources ?? []),
      error: result.error ?? null,
      finishedAt: new Date(result.finishedAt),
      durationMs: result.durationMs,
    })
    .where(eq(deploymentRuns.id, runId));

  // Hosted build time is money we actually spent, so it belongs in the same
  // graphs as everything else the org pays for. Best-effort: a cost row must
  // never be what fails an otherwise-successful deploy.
  if (buildSeconds > 0) {
    await writeDeploymentBuildCost({
      organizationId: opts.organizationId,
      runId,
      env: result.env,
      buildSeconds,
      startedAt: new Date(result.startedAt),
    }).catch(() => {});
    // And bill it. Best-effort like the cost row: build_seconds is recorded on
    // the run either way, and a null meter_event_id beside a non-null
    // build_seconds is what a replay job would look for.
    await reportHostedBuildToMeter({
      organizationId: opts.organizationId,
      runId,
      buildSeconds,
    }).catch(() => {});
  }

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
  /**
   * Also delete the resources that runs *after* the target created through
   * `infra.accounts` — undoing the provisioning, not just the shipping.
   * Opt-in because those resources can hold data (a database created by the
   * bad deploy is still a database); the default rollback never touches them.
   */
  deleteCreated?: boolean;
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

  const outcome = await runDeployment({
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

  // Only after the known-good image is confirmed live: a rollback that failed
  // must leave everything alone, or a broken environment gets *more* broken.
  if (opts.deleteCreated && outcome.result.status === "success") {
    const { deleted, failed } = await deleteResourcesCreatedAfter({
      organizationId: opts.organizationId,
      env: source.env,
      after: source.startedAt,
      // The rollback's own run row is newer than the target by definition, and
      // its deploy() may itself have created resources — those are live now.
      excludeRunIds: [outcome.runId],
      ...(opts.onLog ? { onLog: opts.onLog } : {}),
    });
    const lines = [
      ...deleted.map((r) => `deleted ${r.resourceTypeId} ${r.displayName}`),
      ...failed.map(
        (f) =>
          `could not delete ${f.resource.resourceTypeId} ${f.resource.displayName}: ${f.message}`,
      ),
    ];
    if (lines.length > 0) {
      outcome.result.notes.push(...lines);
      await db
        .update(deploymentRuns)
        .set({ notes: outcome.result.notes.join("\n") })
        .where(eq(deploymentRuns.id, outcome.runId));
    }
  }

  return outcome;
}

/**
 * Delete the resources that deploys to `env` after `after` created, newest run
 * first and within each run in reverse creation order — children before the
 * parents they were created under. Failed runs count too: a deploy that
 * provisioned a database and then died still provisioned the database.
 *
 * Per-resource best-effort: a resource somebody already deleted by hand (or
 * whose account is gone) is reported, not fatal — the rollback this runs after
 * has already succeeded.
 */
async function deleteResourcesCreatedAfter(opts: {
  organizationId: string;
  env: string;
  after: Date;
  excludeRunIds: string[];
  onLog?: (entry: RunLogEntry) => void;
}): Promise<{
  deleted: InfrafileCreatedResource[];
  failed: { resource: InfrafileCreatedResource; message: string }[];
}> {
  const rows = await db
    .select({ id: deploymentRuns.id, createdResources: deploymentRuns.createdResources })
    .from(deploymentRuns)
    .where(
      and(
        eq(deploymentRuns.organizationId, opts.organizationId),
        eq(deploymentRuns.env, opts.env),
        gt(deploymentRuns.startedAt, opts.after),
      ),
    )
    .orderBy(desc(deploymentRuns.startedAt));

  const host = buildOrgWorkflowHost(opts.organizationId, "deploy-rollback-cleanup");
  const seen = new Set<string>();
  const deleted: InfrafileCreatedResource[] = [];
  const failed: { resource: InfrafileCreatedResource; message: string }[] = [];

  for (const row of rows) {
    if (opts.excludeRunIds.includes(row.id)) continue;
    const created = Array.isArray(row.createdResources)
      ? (row.createdResources as InfrafileCreatedResource[])
      : [];
    for (const resource of [...created].reverse()) {
      const key = `${resource.accountId}:${resource.resourceTypeId}:${resource.resourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await host.deleteResource?.(
          resource.accountId,
          resource.resourceTypeId,
          resource.resourceId,
          resource.sidecar,
        );
        deleted.push(resource);
        opts.onLog?.({
          at: Date.now(),
          level: "info",
          message: `deleted ${resource.resourceTypeId} ${resource.displayName}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ resource, message });
        opts.onLog?.({
          at: Date.now(),
          level: "warn",
          message: `could not delete ${resource.resourceTypeId} ${resource.displayName}: ${message}`,
        });
      }
    }
  }
  return { deleted, failed };
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
    output?: unknown;
    plan?: unknown;
    createdResources?: InfrafileCreatedResource[];
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
    // Same cap the web path applies — this column is client-supplied here, and
    // an uncapped jsonb array is read back in full by the history view.
    logs: cappedLogs(run.logs ?? []),
    notes: run.notes && run.notes.length > 0 ? run.notes.join("\n") : null,
    output: cappedJson(run.output),
    // CLI runs used to drop their plan; storing it is what lets `deploy --plan`
    // diff against the last CLI deploy.
    planJson: cappedJson(run.plan),
    createdResources: cappedCreatedResources(run.createdResources ?? []),
    error: run.error ?? null,
    durationMs: run.durationMs ?? null,
    finishedAt: new Date(),
    ...(userId ? { createdByUserId: userId } : {}),
  });
  return { id };
}

/**
 * How many log entries a run persists.
 *
 * A hosted build streams every line Docker prints, so an unbounded jsonb column
 * grows without limit and is read back in full by the history view. The tail is
 * what people actually want when something failed, so the head is what gets
 * dropped — with a marker, because silently truncated logs are worse than none.
 */
const MAX_PERSISTED_LOGS = 2000;

/**
 * A run that legitimately provisions does so tens of times, not thousands —
 * but this column is client-supplied through `recordCliRun`, so it gets the
 * same treatment as `logs`: bounded on write.
 */
const MAX_CREATED_RESOURCES = 500;

function cappedCreatedResources(list: InfrafileCreatedResource[]): InfrafileCreatedResource[] {
  return list.length <= MAX_CREATED_RESOURCES ? list : list.slice(0, MAX_CREATED_RESOURCES);
}

/**
 * Client-supplied and unbounded jsonb values (`output`, a CLI-reported plan)
 * get the same treatment as `logs`: bounded on write. Oversized or
 * unserializable values become a marker rather than the payload.
 */
function cappedJson(value: unknown, maxChars = 100_000): unknown {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value).length > maxChars ? { truncated: true } : value;
  } catch {
    return null;
  }
}

/**
 * A single entry's message is bounded too: the entry cap alone still lets a
 * hostile CLI persist 2000 multi-megabyte strings through `recordCliRun`.
 */
const MAX_LOG_MESSAGE_CHARS = 10_000;

function cappedLogs(logs: RunLogEntry[]): RunLogEntry[] {
  const bounded = logs.map((entry) =>
    entry.message.length > MAX_LOG_MESSAGE_CHARS
      ? { ...entry, message: `${entry.message.slice(0, MAX_LOG_MESSAGE_CHARS)}… (truncated)` }
      : entry,
  );
  if (bounded.length <= MAX_PERSISTED_LOGS) return bounded;
  const dropped = bounded.length - MAX_PERSISTED_LOGS;
  return [
    {
      at: bounded[0]!.at,
      level: "warn" as const,
      message: `… ${dropped} earlier log ${dropped === 1 ? "line" : "lines"} not stored (limit ${MAX_PERSISTED_LOGS}).`,
    },
    ...bounded.slice(dropped),
  ];
}
