/**
 * Builds and pushes images with the Docker daemon on the machine running the
 * CLI. This is the CLI's build path on purpose: it reuses your local layer
 * cache and needs no VM, which is what makes iterating on an Infrafile quick.
 *
 * It shells out to the `docker` binary rather than using the docker plugin's
 * dockerode driver — the driver has no build or push op, and the binary is what
 * every developer already has configured (contexts, credential helpers, buildx).
 * Per CLAUDE.md the CLI takes no new runtime dependencies, so this is
 * `node:child_process` and nothing else.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  BuildRequest,
  BuildResult,
  RegistryCredentials,
  RunInImageRequest,
  RunInImageResult,
} from "@infrawrench/workflow-runtime" with { "resolution-mode": "import" };

/** Where the project source is mounted inside a `run(...)` container. */
const RUN_WORKDIR = "/workspace";

export interface LocalBuildOptions {
  /** Build context — the repo root the Infrafile was found in. */
  contextDir: string;
  /** `owner/name` when the repo has a remote, so the image matches a web deploy. */
  projectName?: string;
  /** Commit being deployed, for the default tag. */
  gitSha?: string;
  /** Live output sink; every line of docker's stdout/stderr lands here. */
  log: (line: string) => void;
  signal?: AbortSignal;
}

/** Run `docker` with its output streamed line-by-line. Rejects on non-zero exit. */
async function docker(
  args: string[],
  opts: { log: (line: string) => void; cwd?: string; stdin?: string; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    let collected = "";
    let pending = "";
    const onChunk = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      collected += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) opts.log(line);
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "The `docker` command was not found. Install Docker, or set plan().buildOn to a " +
              "resource so the image is built there instead.",
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (pending) opts.log(pending);
      if (code === 0) {
        resolve(collected);
        return;
      }
      reject(new Error(`docker ${args[0]} exited with code ${code}.`));
    });

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export async function buildLocally(
  request: BuildRequest,
  opts: LocalBuildOptions,
): Promise<BuildResult> {
  // Shared with the SSH and Cloud Build drivers so the same Infrafile names the
  // same image wherever it is deployed from. Imported dynamically because the
  // runtime is ESM-only and this is a CommonJS module.
  const { infrafileImageRef } = await import("@infrawrench/workflow-runtime");
  const image = infrafileImageRef({
    project: opts.projectName ?? path.basename(path.resolve(opts.contextDir)),
    env: request.env,
    ...(request.tag ? { tag: request.tag } : {}),
    ...(opts.gitSha ? { gitSha: opts.gitSha } : {}),
    ...(request.registry ? { registryHost: request.registry.host } : {}),
  });

  // The rendered Dockerfile lives outside the build context so a deploy never
  // writes into the user's working tree. Both the classic builder and BuildKit
  // accept a `-f` outside the context.
  const dir = await mkdtemp(path.join(tmpdir(), "infrawrench-build-"));
  const dockerfilePath = path.join(dir, "Dockerfile");
  try {
    await writeFile(dockerfilePath, request.dockerfile, "utf8");

    const args = ["build", "-f", dockerfilePath, "-t", image];
    for (const [key, value] of Object.entries(request.args ?? {})) {
      args.push("--build-arg", `${key}=${value}`);
    }
    args.push(opts.contextDir);

    opts.log(`$ docker build -t ${image} ${opts.contextDir}`);
    await docker(args, {
      log: opts.log,
      cwd: opts.contextDir,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    // `--quiet` would give us the id directly, but it suppresses the build
    // output people actually want to watch, so ask for the digest afterwards.
    let digest: string | undefined;
    try {
      const out = await docker(["image", "inspect", image, "--format", "{{.Id}}"], {
        log: () => {},
      });
      digest = out.trim() || undefined;
    } catch {
      // A missing digest is cosmetic — the image exists either way.
    }

    return digest ? { image, digest } : { image };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run a command inside the built image, with the project mounted.
 *
 * This is the path for deploying things that aren't containers: the Dockerfile
 * builds a toolchain (node + wrangler, say) and the command publishes from it.
 * The image is a reproducible build environment rather than an artifact.
 *
 * Output is captured separately per stream and streamed to the log as it
 * arrives, so a long `wrangler deploy` shows progress rather than going quiet.
 */
export async function runInImage(
  request: RunInImageRequest,
  opts: LocalBuildOptions,
): Promise<RunInImageResult> {
  const workdir = request.workdir || RUN_WORKDIR;
  // The entrypoint is always set explicitly. Container arguments are appended
  // to whatever ENTRYPOINT the image declares, so an image built `FROM` one
  // that sets it would otherwise mangle the command into `<entrypoint> sh -lc …`.
  const entrypoint = request.entrypoint ?? "sh";
  const args = ["run", "--rm", "-w", workdir, "--entrypoint", entrypoint];

  if (request.mountSource !== false) {
    args.push("-v", `${path.resolve(opts.contextDir)}:${RUN_WORKDIR}`);
  }

  // Environment goes in through a file, never argv: `docker run -e K=secret`
  // puts the secret in the process list for every user on the machine.
  let envFile: string | undefined;
  const dir = await mkdtemp(path.join(tmpdir(), "infrawrench-run-"));
  try {
    const env = request.env ?? {};
    if (Object.keys(env).length > 0) {
      envFile = path.join(dir, "env");
      // Values are newline-free (the dispatch layer rejects newlines), so the
      // KEY=value form is unambiguous.
      await writeFile(
        envFile,
        Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      args.push("--env-file", envFile);
    }

    // `sh -lc <line>` for the default shell entrypoint; anything else gets the
    // command as its single argument.
    args.push(request.image);
    if (entrypoint === "sh" || entrypoint === "bash" || entrypoint === "/bin/sh") {
      args.push("-lc", request.command);
    } else if (entrypoint !== "") {
      args.push(request.command);
    } else {
      // Cleared entrypoint: exec the command line through the image's shell.
      args.push("sh", "-lc", request.command);
    }

    // Log the command but never the environment — these are credentials.
    opts.log(`$ ${request.command}`);
    return await new Promise<RunInImageResult>((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      let stdout = "";
      let stderr = "";
      const streamTo = (sink: (chunk: string) => void) => {
        let pending = "";
        return (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          sink(text);
          pending += text;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) opts.log(line);
        };
      };
      child.stdout.on(
        "data",
        streamTo((t) => {
          stdout += t;
        }),
      );
      child.stderr.on(
        "data",
        streamTo((t) => {
          stderr += t;
        }),
      );

      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "ENOENT"
            ? new Error("The `docker` command was not found — install Docker to use run().")
            : err,
        );
      });
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Log in (when credentials were supplied) and push. The password goes in on
 * stdin rather than argv so it never appears in the process list, and it is
 * never echoed to the run log.
 */
export async function pushLocally(
  image: string,
  registry: RegistryCredentials | undefined,
  opts: { log: (line: string) => void; signal?: AbortSignal },
): Promise<void> {
  if (registry) {
    opts.log(`$ docker login ${registry.host} -u ${registry.username}`);
    await docker(["login", registry.host, "-u", registry.username, "--password-stdin"], {
      log: opts.log,
      stdin: registry.password,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }
  opts.log(`$ docker push ${image}`);
  await docker(["push", image], {
    log: opts.log,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}
