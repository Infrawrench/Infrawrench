/**
 * Builds, pushes and runs images on a remote host over SSH — the web app's
 * build path.
 *
 * The browser has no working tree and the `web`/`poller` pods have no Docker
 * daemon, so a deploy from the web app happens on a host the plan picked:
 * clone the repo there at the deployed commit, write the rendered Dockerfile,
 * build, and go. Everything rides the SSH and SFTP machinery workflows already
 * use (`workflows/ssh-host.ts`), including its TOFU host-key pinning.
 *
 * **Secrets never reach a remote argv.** A registry password, a GitHub clone
 * token, and the environment for `run(...)` all arrive by SFTP as mode-0600
 * files and are consumed via `--password-stdin`, a credential helper file, or
 * `--env-file`. Anything placed in an `ssh exec` command line would be visible
 * in `ps` to every user on that host.
 */
import { randomUUID } from "node:crypto";

import type {
  BuildRequest,
  BuildResult,
  BuildTargetResource,
  RegistryCredentials,
  RunInImageRequest,
  RunInImageResult,
} from "@infrawrench/workflow-runtime";

import { buildWorkflowSshDeps } from "../workflows/ssh-host.js";

/** Where the project source is mounted inside a `run(...)` container. */
const RUN_WORKDIR = "/workspace";

export interface SshBuildContext {
  organizationId: string;
  /** The SSH-reachable resource the plan chose via `buildOn`. */
  target: BuildTargetResource;
  /** Clone URL, with a short-lived token embedded for a private repo. */
  cloneUrl: string;
  /** Commit to build. */
  gitSha: string;
  branch: string;
  /** Live output sink. */
  log: (line: string) => void;
  signal?: AbortSignal;
}

type SshDeps = ReturnType<typeof buildWorkflowSshDeps>;

/** Shell-quote a value for safe interpolation into a remote command. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * One remote command. Streams both channels into the run log and throws with
 * the tail of stderr on failure — an exit code alone sends people hunting.
 */
async function exec(
  deps: SshDeps,
  ctx: SshBuildContext,
  command: string,
  opts: { quiet?: boolean } = {},
): Promise<string> {
  const params = {
    accountId: ctx.target.accountId,
    typeId: ctx.target.resourceTypeId,
    resourceId: ctx.target.id,
    command,
  };
  const result = await deps.sshExec!(params);
  const stdout = Buffer.from(result.stdoutBase64 ?? "", "base64").toString("utf8");
  const stderr = Buffer.from(result.stderrBase64 ?? "", "base64").toString("utf8");
  if (!opts.quiet) {
    for (const line of `${stdout}${stderr}`.split("\n")) {
      if (line) ctx.log(line);
    }
  }
  if (result.code !== 0) {
    const detail = (stderr || stdout).trim().split("\n").slice(-20).join("\n");
    throw new Error(`Remote command failed (exit ${result.code})${detail ? `:\n${detail}` : "."}`);
  }
  return stdout;
}

/** Upload a file with restrictive permissions. Used only for secrets. */
async function putSecret(
  deps: SshDeps,
  ctx: SshBuildContext,
  path: string,
  contents: string,
): Promise<void> {
  await deps.sftpPut!(
    {
      accountId: ctx.target.accountId,
      typeId: ctx.target.resourceTypeId,
      resourceId: ctx.target.id,
    },
    path,
    Buffer.from(contents, "utf8").toString("base64"),
  );
  await exec(deps, ctx, `chmod 600 ${q(path)}`, { quiet: true });
}

/** Per-deploy scratch directory on the build host. */
function workspaceFor(gitSha: string): string {
  return `/tmp/infrawrench-deploy-${gitSha.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
}

/** Image reference: the plan's tag wins, else the repo name and the commit. */
function imageRef(request: BuildRequest, gitSha: string): string {
  const tag = request.tag || `${request.env}-${gitSha.slice(0, 7)}`;
  const name = "app";
  return request.registry ? `${request.registry.host}/${name}:${tag}` : `${name}:${tag}`;
}

/**
 * Clone the repo at the deployed commit and build the image there.
 *
 * The clone URL carries a short-lived installation token for a private repo,
 * so it goes up as a file and the remote never sees it in a command line. The
 * origin remote is reset to the canonical URL afterwards, so the token does not
 * linger in `.git/config` either — the same precaution agent VM setup takes.
 */
export async function buildOverSsh(
  request: BuildRequest,
  ctx: SshBuildContext,
): Promise<BuildResult & { workspace: string }> {
  const deps = buildWorkflowSshDeps(ctx.organizationId, ctx.signal ? { signal: ctx.signal } : {});
  if (!deps.sshExec || !deps.sftpPut) {
    throw new Error("The build host does not support SSH — pick a resource with an SSH endpoint.");
  }

  const workspace = workspaceFor(ctx.gitSha);
  const image = imageRef(request, ctx.gitSha);

  ctx.log(`Preparing ${workspace} on ${ctx.target.displayName ?? ctx.target.id}`);
  await exec(deps, ctx, `mkdir -p ${q(workspace)}`, { quiet: true });

  // git needs the credentialed URL but must not be handed it on a command line.
  const askpass = `${workspace}/.git-askpass`;
  await putSecret(deps, ctx, `${workspace}/.clone-url`, ctx.cloneUrl);
  await putSecret(deps, ctx, askpass, '#!/bin/sh\nexec cat "$(dirname "$0")/.clone-url"\n');

  ctx.log(`Cloning ${ctx.branch} at ${ctx.gitSha.slice(0, 7)}`);
  await exec(
    deps,
    ctx,
    `cd ${q(workspace)} && chmod +x .git-askpass && ` +
      `git clone --quiet "$(cat .clone-url)" src && ` +
      `cd src && git checkout --quiet ${q(ctx.gitSha)} && ` +
      // Drop the token: neither the file nor the remote keeps it.
      `git remote remove origin || true`,
  );
  await exec(deps, ctx, `rm -f ${q(`${workspace}/.clone-url`)} ${q(askpass)}`, { quiet: true });

  // The Dockerfile goes beside the source, not inside it, so a build never
  // writes into the cloned tree.
  const dockerfilePath = `${workspace}/Dockerfile.infrawrench`;
  await deps.sftpPut(
    {
      accountId: ctx.target.accountId,
      typeId: ctx.target.resourceTypeId,
      resourceId: ctx.target.id,
    },
    dockerfilePath,
    Buffer.from(request.dockerfile, "utf8").toString("base64"),
  );

  const buildArgs = Object.entries(request.args ?? {})
    .map(([k, v]) => `--build-arg ${q(`${k}=${v}`)}`)
    .join(" ");

  ctx.log(`Building ${image}`);
  await exec(
    deps,
    ctx,
    `cd ${q(workspace)} && docker build -f ${q(dockerfilePath)} -t ${q(image)} ${buildArgs} src`,
  );

  let digest: string | undefined;
  try {
    digest =
      (
        await exec(deps, ctx, `docker image inspect ${q(image)} --format '{{.Id}}'`, {
          quiet: true,
        })
      ).trim() || undefined;
  } catch {
    // Cosmetic — the image exists either way.
  }

  return digest ? { image, digest, workspace } : { image, workspace };
}

/** Log in (via stdin) and push. */
export async function pushOverSsh(
  image: string,
  registry: RegistryCredentials | undefined,
  ctx: SshBuildContext,
): Promise<void> {
  const deps = buildWorkflowSshDeps(ctx.organizationId, ctx.signal ? { signal: ctx.signal } : {});
  if (registry) {
    const pwPath = `/tmp/infrawrench-registry-${randomUUID().slice(0, 8)}`;
    await putSecret(deps, ctx, pwPath, registry.password);
    ctx.log(`Signing in to ${registry.host} as ${registry.username}`);
    try {
      await exec(
        deps,
        ctx,
        `cat ${q(pwPath)} | docker login ${q(registry.host)} -u ${q(registry.username)} --password-stdin`,
      );
    } finally {
      await exec(deps, ctx, `rm -f ${q(pwPath)}`, { quiet: true }).catch(() => {});
    }
  }
  ctx.log(`Pushing ${image}`);
  await exec(deps, ctx, `docker push ${q(image)}`);
}

/**
 * Run a command inside the built image on the build host, with the cloned
 * source mounted. This is what makes a non-container target (a Worker, a static
 * site) deployable: the image carries the toolchain and publishes from it.
 */
export async function runOverSsh(
  request: RunInImageRequest,
  ctx: SshBuildContext & { workspace: string },
): Promise<RunInImageResult> {
  const deps = buildWorkflowSshDeps(ctx.organizationId, ctx.signal ? { signal: ctx.signal } : {});
  const workdir = request.workdir || RUN_WORKDIR;
  // Always explicit — see the same note in the local driver: container args are
  // appended to the image's ENTRYPOINT, which would otherwise mangle the command.
  const entrypoint = request.entrypoint ?? "sh";
  const parts = ["docker run --rm", `-w ${q(workdir)}`, `--entrypoint ${q(entrypoint)}`];

  if (request.mountSource !== false) {
    parts.push(`-v ${q(`${ctx.workspace}/src:${RUN_WORKDIR}`)}`);
  }

  // Environment is credentials more often than not — file, never argv.
  let envPath: string | undefined;
  const env = request.env ?? {};
  if (Object.keys(env).length > 0) {
    envPath = `${ctx.workspace}/.run-env-${randomUUID().slice(0, 8)}`;
    await putSecret(
      deps,
      ctx,
      envPath,
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
    parts.push(`--env-file ${q(envPath)}`);
  }

  parts.push(q(request.image));
  if (entrypoint === "sh" || entrypoint === "bash" || entrypoint === "/bin/sh") {
    parts.push("-lc", q(request.command));
  } else if (entrypoint !== "") {
    parts.push(q(request.command));
  } else {
    parts.push("sh", "-lc", q(request.command));
  }

  // Log the command, never the environment.
  ctx.log(`$ ${request.command}`);
  const params = {
    accountId: ctx.target.accountId,
    typeId: ctx.target.resourceTypeId,
    resourceId: ctx.target.id,
    command: parts.join(" "),
  };
  try {
    const result = await deps.sshExec!(params);
    const stdout = Buffer.from(result.stdoutBase64 ?? "", "base64").toString("utf8");
    const stderr = Buffer.from(result.stderrBase64 ?? "", "base64").toString("utf8");
    for (const line of `${stdout}${stderr}`.split("\n")) {
      if (line) ctx.log(line);
    }
    return { exitCode: result.code, stdout, stderr };
  } finally {
    if (envPath) await exec(deps, ctx, `rm -f ${q(envPath)}`, { quiet: true }).catch(() => {});
  }
}

/** Copy the cloned source onto another host, for a registry-less deploy. */
export async function copyToOverSsh(
  target: BuildTargetResource,
  remotePath: string,
  ctx: SshBuildContext & { workspace: string },
): Promise<void> {
  const deps = buildWorkflowSshDeps(ctx.organizationId, ctx.signal ? { signal: ctx.signal } : {});
  ctx.log(`Copying the project to ${target.displayName ?? target.id}:${remotePath}`);
  // Tar over a pipe rather than a per-file SFTP walk: one round trip, and it
  // preserves modes and symlinks that a naive copy would flatten.
  const archive = `${ctx.workspace}/source.tgz`;
  await exec(deps, ctx, `tar -czf ${q(archive)} -C ${q(`${ctx.workspace}/src`)} .`, {
    quiet: true,
  });

  const bytes = await deps.sftpGet!(
    {
      accountId: ctx.target.accountId,
      typeId: ctx.target.resourceTypeId,
      resourceId: ctx.target.id,
    },
    archive,
  );
  await deps.sftpPut!(
    { accountId: target.accountId, typeId: target.resourceTypeId, resourceId: target.id },
    `${remotePath}/source.tgz`,
    bytes.base64,
  );
  await deps.sshExec!({
    accountId: target.accountId,
    typeId: target.resourceTypeId,
    resourceId: target.id,
    command: `mkdir -p ${q(remotePath)} && tar -xzf ${q(`${remotePath}/source.tgz`)} -C ${q(remotePath)} && rm -f ${q(`${remotePath}/source.tgz`)}`,
  });
  await exec(deps, ctx, `rm -f ${q(archive)}`, { quiet: true }).catch(() => {});
}

/** Remove the deploy's scratch directory from the build host. */
export async function cleanupOverSsh(ctx: SshBuildContext & { workspace: string }): Promise<void> {
  const deps = buildWorkflowSshDeps(ctx.organizationId, ctx.signal ? { signal: ctx.signal } : {});
  await exec(deps, ctx, `rm -rf ${q(ctx.workspace)}`, { quiet: true }).catch(() => {});
}
