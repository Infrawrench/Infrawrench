/**
 * Runs an Infrafile: read from a repo root, executed as one isolate whose
 * stages the host drives.
 *
 * The shape mirrors `runWorkflow` deliberately — same isolate, same prelude,
 * same host RPC — so everything an author knows about writing a workflow
 * transfers. What differs is the epilogue: instead of one flat body, the guest
 * calls `plan()`, `dockerfile()` and `deploy()` in turn, checking in with the
 * host between each. That check-in is what lets the *Docker build happen outside
 * the sandbox* and still read like a straight line in the Infrafile.
 */
import { runIsolate, toError } from "../isolate.js";
import type { InfrafileHost } from "../host.js";
import type { WorkflowRunContext } from "../host.js";
import { PRELUDE } from "../prelude.js";
import { transpileWorkflow } from "../transpile.js";
import {
  DEFAULT_RUN_LIMITS,
  type RunLimits,
  type RunLogEntry,
  type WorkflowPluginInfo,
} from "../types.js";
import { INFRAFILE_EPILOGUE, INFRAFILE_PRELUDE } from "./prelude.js";
import type {
  InfrafileCreatedResource,
  InfrafileGitContext,
  InfrafilePlannedChange,
  InfrafileRollback,
  InfrafileRunResult,
  InfrafileRunSink,
  InfrafileStage,
  InfrafileStageListener,
} from "./types.js";

/**
 * The name we look for at a repo root. Deliberately extensionless: it is a
 * well-known filename like `Dockerfile` or `Makefile`, not a module anybody
 * imports. Editors need `"files.associations": { "Infrafile": "typescript" }`.
 */
export const INFRAFILE_NAME = "Infrafile";

/**
 * An image build is not guest execution — it is minutes of waiting on a daemon.
 * Excluding it from the budget is the same reasoning that keeps `ssh.exec` out
 * (see `PAUSED_METHODS`): the run's timeout exists to bound runaway *code*.
 */
const INFRAFILE_PAUSED_METHODS = [
  "infrafile.build",
  "infrafile.push",
  "infrafile.copyTo",
  "infrafile.run",
  // `select` waits on a person reading their options — the same reasoning that
  // keeps the generic `prompt` out of the budget. Without this, taking a moment
  // to choose a build host can fail an otherwise-fine deploy.
  "infrafile.select",
];

export interface RunInfrafileOptions {
  /** The Infrafile's TypeScript source, read from the repo root. */
  source: string;
  host: InfrafileHost;
  /**
   * Which environment to run. Must be one the file declares. Omit it and a
   * file that declares exactly one env uses that one — so the common
   * single-environment project needs no flag — while a file with several fails
   * naming them, rather than guessing which one you meant to ship to.
   */
  env?: string;
  git: InfrafileGitContext;
  /**
   * Whether `select(...)` may prompt. False in CI: every select must then be
   * answered by `host.infrafileAnswer` or the run fails naming the key.
   */
  interactive: boolean;
  /** Stop after `plan()` (still rendering the Dockerfile, so it can be previewed). */
  planOnly?: boolean;
  /**
   * Tear down instead of deploying: skips plan, dockerfile and build and calls
   * `destroy({ env, git })`. Used when a preview's pull request closes.
   */
  destroy?: boolean;
  /**
   * The env's last successful deploy's recorded plan, when the caller has one
   * (the CLI reads its deploy history, the web the run row). Passed to
   * `destroy()` as `plan` — recorded JSON, so plain data rather than handles.
   */
  destroyPlan?: unknown;
  /**
   * Replay a past run's `deploy()` with its recorded plan and image instead of
   * planning and building afresh. See {@link InfrafileRollback}.
   */
  rollback?: InfrafileRollback;
  limits?: Partial<RunLimits>;
  onLog?: (entry: RunLogEntry) => void;
  onStage?: InfrafileStageListener;
  signal?: AbortSignal;
}

export async function runInfrafile(opts: RunInfrafileOptions): Promise<InfrafileRunResult> {
  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...opts.limits };
  const startedAt = Date.now();
  const logs: RunLogEntry[] = [];
  const notes: string[] = [];
  const createdResources: InfrafileCreatedResource[] = [];
  const plannedChanges: InfrafilePlannedChange[] = [];
  let output: unknown;
  let plan: unknown;
  let dockerfile: string | undefined;
  let image: string | undefined;
  let reachedStage: InfrafileStage | undefined;

  const log = (level: RunLogEntry["level"], message: string): void => {
    const entry: RunLogEntry = { at: Date.now(), level, message };
    logs.push(entry);
    opts.onLog?.(entry);
  };

  const setStage = (stage: InfrafileStage): void => {
    reachedStage = stage;
    opts.onStage?.(stage);
  };

  // Resolved inside chooseEnv, which is the first moment the declared envs are
  // known — the file has to be evaluated before we can validate against them.
  let env = opts.env ?? "";

  const sink: InfrafileRunSink = {
    dryRun: opts.planOnly === true,
    chooseEnv: (envs) => {
      if (!opts.env) {
        if (envs.length !== 1) {
          throw new Error(
            `This Infrafile declares ${envs.length} environments (${envs.join(", ")}). ` +
              `Pass --env <name> to choose one.`,
          );
        }
        env = envs[0]!;
      } else if (!envs.includes(opts.env)) {
        throw new Error(
          `This Infrafile does not declare an environment named ${JSON.stringify(opts.env)}. ` +
            `It declares: ${envs.join(", ")}.`,
        );
      }
      if (opts.destroy) {
        log(
          "info",
          `Tearing down ${env}${opts.git.pullRequest ? ` for PR #${opts.git.pullRequest.number}` : ""}`,
        );
        setStage("destroy");
        return {
          env,
          git: opts.git,
          destroy: true,
          ...(opts.destroyPlan !== undefined ? { plan: opts.destroyPlan } : {}),
        };
      }
      if (opts.rollback) {
        // Nothing to plan or build — the artifact already exists.
        log(
          "info",
          `Rolling back to ${opts.rollback.image}` +
            (opts.rollback.fromRunId ? ` (run ${opts.rollback.fromRunId})` : ""),
        );
        setStage("deploy");
        return { env, git: opts.git, rollback: opts.rollback };
      }
      setStage("plan");
      // planOnly rides on this return — the earliest host round-trip — because
      // plan() itself needs the flag; the `infrafile.plan` RPC answers too late.
      return { env, git: opts.git, ...(opts.planOnly ? { planOnly: true } : {}) };
    },
    recordPlan: (value) => {
      plan = value;
      if (opts.planOnly) {
        log("info", "Plan only — stopping before the build.");
        return false;
      }
      setStage("dockerfile");
      return true;
    },
    recordDockerfile: (text) => {
      dockerfile = text;
    },
    recordNote: (text) => {
      if (!text) return;
      notes.push(text);
      log("info", text);
    },
    recordCreated: (resource) => {
      createdResources.push(resource);
      log("info", `created ${resource.resourceTypeId} ${resource.displayName}`);
    },
    recordPlanned: (change) => {
      plannedChanges.push(change);
      log("info", `plan: would ${change.action} ${change.resourceTypeId} ${change.displayName}`);
      return plannedChanges.length - 1;
    },
    stage: setStage,
  };

  const ctx: WorkflowRunContext = {
    interactive: opts.interactive,
    log: (entry) => {
      logs.push(entry);
      opts.onLog?.(entry);
    },
    setOutput: (value) => {
      output = value;
    },
    infrafile: sink,
  };

  if (opts.rollback) image = opts.rollback.image;

  const finish = (
    status: InfrafileRunResult["status"],
    error?: InfrafileRunResult["error"],
  ): InfrafileRunResult => {
    const finishedAt = Date.now();
    const result: InfrafileRunResult = {
      status,
      logs,
      notes,
      createdResources,
      plannedChanges,
      env,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    };
    if (output !== undefined) result.output = output;
    if (plan !== undefined) result.plan = plan;
    if (dockerfile !== undefined) result.dockerfile = dockerfile;
    if (image !== undefined) result.image = image;
    if (reachedStage !== undefined) result.reachedStage = reachedStage;
    if (error !== undefined) result.error = error;
    return result;
  };

  // The build result has to reach the run result, and the only place it exists
  // is the host's return value — so wrap the host's build op to capture it.
  // Returning from the build is also the moment the deploy stage begins, which
  // is what makes a deploy failure report `deploy` rather than `build`.
  const host: InfrafileHost = opts.host.infrafileBuild
    ? {
        ...opts.host,
        infrafileBuild: async (request) => {
          const built = await opts.host.infrafileBuild!(request);
          image = built.image;
          setStage("deploy");
          return built;
        },
      }
    : opts.host;

  let tree: WorkflowPluginInfo[];
  try {
    tree = await host.listPlugins();
  } catch (err) {
    return finish("failure", toError(err));
  }

  let userJs: string;
  try {
    userJs = (await transpileWorkflow(opts.source)).code;
  } catch (err) {
    return finish("failure", toError(err, `Failed to compile ${INFRAFILE_NAME}`));
  }

  const outcome = await runIsolate({
    program: buildProgram(userJs),
    host,
    ctx,
    env: {
      accountsTree: JSON.stringify(tree),
      // An Infrafile has no declared metrics — `infra.metrics` stays an empty
      // (but working) surface rather than being absent and throwing.
      metrics: "{}",
      // Deployment credentials use the Infrafile env/run surfaces. Workflow
      // secret assignments are deliberately unavailable to repository code.
      secrets: "{}",
      event: JSON.stringify({ kind: "manual" }),
    },
    limits,
    extraPausedMethods: INFRAFILE_PAUSED_METHODS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return outcome.error ? finish("failure", outcome.error) : finish("success");
}

/**
 * Assemble the guest program: the same header and workflow prelude a workflow
 * gets, then `defineInfra`, then the user's file, then the stage driver.
 *
 * The user's file is evaluated for its *side effect* — registering the
 * definition — so it sits at the top level rather than inside a task wrapper.
 * The whole thing is wrapped so a throw anywhere reaches the `__error` sentinel.
 */
function buildProgram(userJs: string): string {
  return [
    `export {};`,
    `const __host = env.__host;`,
    `const __accountsTree = env.__accountsTree;`,
    `const __metrics = env.__metrics;`,
    `const __secrets = env.__secrets;`,
    `const __event = env.__event;`,
    PRELUDE,
    INFRAFILE_PRELUDE,
    `const __task = (async () => {`,
    `  try {`,
    userJs,
    INFRAFILE_EPILOGUE,
    `  } catch (e) {`,
    `    await __host("__error", JSON.stringify({ message: (e && e.message) ? String(e.message) : String(e), stack: (e && e.stack) ? String(e.stack) : undefined }));`,
    `  }`,
    `})();`,
    `await __task;`,
  ].join("\n");
}
