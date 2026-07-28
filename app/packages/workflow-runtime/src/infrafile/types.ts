/**
 * Types for the Infrafile — a project's build-and-deploy description.
 *
 * An Infrafile is a single file at a repository's root that calls one global,
 * `defineInfra({...})`, declaring the environments the project supports plus
 * three stages. It is deliberately not a workflow: it has no trigger, it is
 * never stored in the database, and it is read from the repo every time it runs
 * (from disk by the CLI, from git by the web app).
 *
 * The stages run inside one QuickJS isolate, driven across stage boundaries by
 * the host — see {@link file://./run.ts}.
 */
import type { RunLogEntry, RunResult } from "../types.js";

/** The three stages, in the order they execute. */
export type InfrafileStage = "plan" | "dockerfile" | "build" | "deploy" | "destroy";

/**
 * Where an image is built. Either the local Docker daemon (the CLI's default —
 * warm cache, no VM needed) or an SSH-reachable resource the plan picked.
 *
 * The isolate returns a resource as a plain object: `JSON.stringify` drops the
 * methods the prelude mixed on and keeps the identifying fields, which is why
 * no special marshalling is needed on the way out.
 */
export type BuildTarget = { kind: "local" } | { kind: "resource"; resource: BuildTargetResource };

/** The identifying half of a resource handle, as it survives the JSON bridge. */
export interface BuildTargetResource {
  id: string;
  accountId: string;
  resourceTypeId: string;
  displayName?: string;
}

/** Registry credentials a plan may return so the host can `docker login`. */
export interface RegistryCredentials {
  host: string;
  username: string;
  password: string;
}

/**
 * What the isolate hands the host to build an image. The `dockerfile` is the
 * rendered output of stage 2 — the Infrafile itself never crosses this boundary.
 */
export interface BuildRequest {
  env: string;
  /** Rendered Dockerfile text. */
  dockerfile: string;
  /** Where to build. Absent means the host picks its default for the origin. */
  target?: BuildTarget;
  /** Image tag the plan asked for, e.g. `staging-a1b2c3d`. */
  tag?: string;
  /** Build args, stringified by the prelude. */
  args?: Record<string, string>;
  registry?: RegistryCredentials;
}

/** What the host reports back once the image exists. */
export interface BuildResult {
  /** Fully-qualified image reference, e.g. `registry.example.com/app:staging-a1b2c3d`. */
  image: string;
  /** Image digest when the builder reported one. */
  digest?: string;
}

/** Where the project source is mounted inside a `run(...)` container. */
export const RUN_WORKDIR = "/workspace";

/**
 * A command to execute inside the built image.
 *
 * This is what makes an Infrafile useful for targets that aren't containers.
 * A Cloudflare Worker, a static site, a Lambda zip — none of them want the
 * image *deployed*; they want a reproducible environment to be built and
 * published *from*. So the Dockerfile installs the toolchain, and the deploy
 * stage runs `npx wrangler deploy` inside it with the project mounted.
 */
export interface RunInImageRequest {
  image: string;
  /** Shell command line, run through `sh -lc` so pipes and `&&` behave. */
  command: string;
  /**
   * Environment variables for the process. Typically credentials, so hosts must
   * pass these out of band (a file, the daemon API) and never echo them into
   * the run log.
   */
  env?: Record<string, string>;
  /**
   * Entrypoint to run the command through. Defaults to `sh` (so `command` is a
   * shell line).
   *
   * This is set explicitly rather than left to the image because a container's
   * arguments are appended to whatever `ENTRYPOINT` the Dockerfile declared —
   * an image with `ENTRYPOINT ["npm"]` would otherwise turn a command into
   * `npm sh -lc "..."`. Pass the binary you want, or `""` to clear the image's
   * entrypoint and exec `command` directly.
   */
  entrypoint?: string;
  /** Working directory inside the container. Defaults to {@link RUN_WORKDIR}. */
  workdir?: string;
  /**
   * Mount the project source at {@link RUN_WORKDIR}. On by default — a build
   * environment with no source in it is rarely what anyone means. Turn it off
   * for an image that already carries everything it needs.
   */
  mountSource?: boolean;
  /**
   * Resolve with a non-zero `exitCode` instead of throwing. Off by default:
   * a failed `wrangler deploy` must fail the deploy, not scroll past.
   */
  allowFailure?: boolean;
}

/** What a `run(...)` produced. */
export interface RunInImageResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Ship a previous run's artifact again.
 *
 * A rollback deliberately does **not** rebuild. It replays `deploy()` with the
 * plan and image a past run recorded, skipping `plan()`, `dockerfile()` and the
 * build entirely — the point of rolling back is to get the exact bytes that
 * were known good, not to reconstruct something that ought to resemble them.
 *
 * The consequence worth knowing: `plan` arrives as the recorded JSON, so any
 * resource in it is plain data rather than a live handle. A `deploy()` that
 * needs handles should take them from `infra.*`, which still works normally.
 */
export interface InfrafileRollback {
  /** The `planJson` the original run recorded. */
  plan: unknown;
  /** The image that run built and shipped. */
  image: string;
  digest?: string;
  /** The run being rolled back to, for the log line and the new run's record. */
  fromRunId?: string;
}

/** Git facts about the checkout being deployed, exposed to `plan()` as `git`. */
/**
 * The pull request a preview deploy belongs to.
 *
 * A preview environment is one declared env (`"preview"`) deployed many times,
 * once per PR — rather than a dynamic env name, which would make `envs`
 * unvalidatable. The Infrafile namespaces by reading this: a hostname, a
 * Kubernetes namespace, a Worker route.
 */
export interface InfrafilePullRequest {
  number: number;
  /** Head branch, e.g. `feature/thing`. */
  branch: string;
  title?: string;
}

export interface InfrafileGitContext {
  sha: string;
  branch: string;
  /** Present only on a preview deploy. */
  pullRequest?: InfrafilePullRequest;
  /** `owner/name` when known — always set on web, best-effort from the remote on CLI. */
  repo?: string;
  /** True when the CLI is deploying a working tree with uncommitted changes. */
  dirty?: boolean;
}

/** Everything the host must tell the isolate before the first stage runs. */
export interface InfrafileRunContext {
  /** Which environment to run. Must be one of the Infrafile's declared `envs`. */
  env: string;
  git: InfrafileGitContext;
  /**
   * Stop after `plan()` and report, without building or deploying. Backs
   * `infrawrench deploy --plan` and the web "Plan" button.
   */
  planOnly?: boolean;
}

/** Outcome of executing an Infrafile once. */
export interface InfrafileRunResult extends RunResult {
  env: string;
  /** Whatever `plan()` returned, as it crossed the bridge. */
  plan?: unknown;
  /** The rendered Dockerfile, present once stage 2 ran. */
  dockerfile?: string;
  /** The built image reference, present once the build succeeded. */
  image?: string;
  /** Notes the deploy stage emitted, in order. */
  notes: string[];
  /** The last stage that started. Useful for reporting where a failure happened. */
  reachedStage?: InfrafileStage;
}

/**
 * Host capabilities an Infrafile run needs on top of {@link WorkflowHost} — the
 * parts that are real work and differ per platform. Every method is optional so
 * a host that cannot do a thing fails with the existing `WorkflowCapabilityError`
 * rather than silently no-opping.
 *
 * Bookkeeping (choosing the env, recording the plan, collecting notes) is *not*
 * here: it is identical everywhere and lives in the run's {@link InfrafileRunSink}.
 */
export interface InfrafileHostOps {
  /**
   * Build (and tag) an image. This blocks for as long as the build takes, which
   * is why `infrafile.build` is excluded from the run's execution budget.
   * Progress should be reported through the run's log sink so it streams.
   */
  infrafileBuild?(request: BuildRequest): Promise<BuildResult>;
  /** Push a built image to its registry. */
  infrafilePush?(image: string, registry?: RegistryCredentials): Promise<void>;
  /**
   * Run a command inside the built image. Like the build, this blocks for as
   * long as the command takes and is excluded from the run's execution budget.
   */
  infrafileRun?(request: RunInImageRequest): Promise<RunInImageResult>;
  /** Copy the project source onto a host (tar + SFTP + untar). */
  infrafileCopyTo?(target: BuildTargetResource, remotePath: string): Promise<void>;
  /**
   * A pre-supplied answer for `select(key, …)`, from `--set key=value` or a
   * saved choice. Returning `undefined` means "ask the user", which routes to
   * the ordinary `prompt` host method.
   */
  infrafileAnswer?(key: string): Promise<string | undefined>;
}

/**
 * Per-run bookkeeping the stage driver calls at each boundary. Owned by
 * {@link file://./run.ts}, which closes over the run's options and result.
 */
export interface InfrafileRunSink {
  /**
   * Validate the file's declared envs against the one the caller asked for.
   * Throws (naming the declared envs) when they don't match.
   */
  chooseEnv(envs: string[]): {
    env: string;
    git: InfrafileGitContext;
    /** Present on a rollback — the stage driver then skips straight to deploy. */
    rollback?: InfrafileRollback;
    /** Present on a teardown — the driver then calls `destroy()` and nothing else. */
    destroy?: boolean;
  };
  /** Record what `plan()` returned. Returns false to stop before building. */
  recordPlan(plan: unknown): boolean;
  recordDockerfile(text: string): void;
  recordNote(text: string): void;
  /** Announce that a stage is starting, for live progress rendering. */
  stage(stage: InfrafileStage): void;
}

/** Live progress callback so a CLI or WS session can render stage transitions. */
export type InfrafileStageListener = (stage: InfrafileStage) => void;

/** Re-exported for hosts that build their own log sinks. */
export type { RunLogEntry };

/**
 * The image reference a build produces.
 *
 * Shared by every driver on purpose. Each used to derive its own — the local
 * one from the context directory's name, the others from a hardcoded "app" —
 * so the *same* Infrafile produced `minimal:production` from the CLI and
 * `app:production-a1b2c3d` from the web app. A `deploy()` that names its image
 * in a manifest then worked from one origin and not the other.
 *
 * `project` is the repository name where one is known, falling back to the
 * build directory. `tag` prefers the plan's, else `<env>-<short sha>` so
 * repeated deploys of one environment stay distinguishable.
 */
export function infrafileImageRef(input: {
  project: string;
  env: string;
  tag?: string;
  gitSha?: string;
  registryHost?: string;
}): string {
  const name =
    input.project
      .split("/")
      .pop()!
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/^-+|-+$/g, "") || "app";
  const sha = input.gitSha ? input.gitSha.slice(0, 7) : "";
  const tag = input.tag || (sha ? `${input.env}-${sha}` : input.env) || "latest";
  return input.registryHost ? `${input.registryHost}/${name}:${tag}` : `${name}:${tag}`;
}
