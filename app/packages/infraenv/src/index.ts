/**
 * `@infrawrench/infraenv` as a library, dotenv style:
 *
 * ```ts
 * import { config } from "@infrawrench/infraenv";
 * await config(); // process.env now has what .infraenv describes
 * ```
 *
 * `config()` resolves the nearest `.infraenv` and assigns the values into
 * `process.env` without replacing what is already set; `load()` returns them
 * instead; `configSync()` does `config()`'s work for callers that cannot
 * await (CommonJS), blocking in a child process. `@infrawrench/infraenv/config`
 * runs `config()` (or `configSync()` under `require`) on import.
 *
 * With credentials (the `apiKey` option, INFRAWRENCH_API_KEY, or the key
 * `infraenv login` stored) the values come from the Infrawrench API: each call
 * is an audited `secrets:read` resolve, so call it once at startup. Without,
 * they come from the `.env` that `infraenv pull` or its git hooks wrote, and
 * only when it carries the generated header. Nothing here writes a file or
 * prints a value.
 *
 * This module imports none of the CLI's code, and the CLI none of it.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  InfraenvError,
  checkRequired,
  resolveValues,
  settleProblems,
  type InfraenvProblem,
  type InfraenvSource,
  type LoadOptions,
  type LoadResult,
} from "./resolve";
import { PACKAGE_ROOT } from "./version";

export {
  InfraenvError,
  type InfraenvProblem,
  type InfraenvSource,
  type LoadOptions,
  type LoadResult,
};

export interface ConfigOptions extends LoadOptions {
  /** Replace variables that are already set in `process.env`. Default: false. */
  readonly override?: boolean | undefined;
}

export interface ConfigResult {
  /** The keys assigned into `process.env`. */
  readonly keys: string[];
  /** The keys left alone because they were already set (without `override`). */
  readonly skipped: string[];
  readonly problems: readonly InfraenvProblem[];
  readonly environment: string | null;
  readonly source: InfraenvSource;
}

export interface ConfigSyncOptions extends ConfigOptions {
  /** How long to wait for the resolve, in milliseconds. Default: 120000. */
  readonly timeout?: number | undefined;
}

/**
 * Resolve `.infraenv` and return its values without touching `process.env`.
 * Problems are returned (and written once to stderr, keys and messages only)
 * unless `strict`, which throws.
 */
export async function load(options: LoadOptions = {}): Promise<LoadResult> {
  const result = await resolveValues(options);
  settleProblems(result, options, resolve(options.cwd ?? process.cwd()));
  checkRequired(options.required, (key) => Object.hasOwn(result.values, key));
  return result;
}

function assign(result: LoadResult, options: ConfigOptions): ConfigResult {
  const keys: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(result.values)) {
    if (!options.override && process.env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    keys.push(key);
  }
  checkRequired(options.required, (key) => process.env[key] !== undefined);
  return {
    keys,
    skipped,
    problems: result.problems,
    environment: result.environment,
    source: result.source,
  };
}

/**
 * Resolve `.infraenv` and assign its values into `process.env`, keeping any
 * variable that is already set unless `override`. Returns which keys it
 * assigned and skipped, never the values.
 */
export async function config(options: ConfigOptions = {}): Promise<ConfigResult> {
  const result = await resolveValues(options);
  settleProblems(result, options, resolve(options.cwd ?? process.cwd()));
  return assign(result, options);
}

/** Set in the worker's environment, so a preloaded `/config` there does nothing. */
export const WORKER_FLAG = "INFRAENV_WORKER";

interface WorkerReply {
  readonly ok: boolean;
  readonly result?: LoadResult;
  readonly error?: {
    readonly message: string;
    readonly problems?: readonly InfraenvProblem[];
    readonly missing?: readonly string[];
  };
}

/**
 * `config()` for callers that cannot await: resolves in a child Node process
 * (the package's own `dist/load-worker.mjs`) and blocks until it answers, up
 * to `timeout`. The options, the API key included, go to it on stdin, never
 * on its command line; the values come back on its stdout and only into
 * `process.env`.
 */
export function configSync(options: ConfigSyncOptions = {}): ConfigResult {
  const worker = join(PACKAGE_ROOT, "dist", "load-worker.mjs");
  if (!existsSync(worker)) {
    throw new InfraenvError(`configSync needs the built package: ${worker} is missing.`);
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const {
    timeout = 120_000,
    required: _required,
    strict: _strict,
    quiet: _quiet,
    ...rest
  } = options;
  const request: LoadOptions = { ...rest, cwd };
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [worker], {
      input: JSON.stringify(request),
      encoding: "utf8",
      // stderr is the worker's own diagnostics, which never hold a value.
      stdio: ["pipe", "pipe", "inherit"],
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      // ELECTRON_RUN_AS_NODE: inside Electron, execPath is the app, not Node.
      env: { ...process.env, [WORKER_FLAG]: "1", ELECTRON_RUN_AS_NODE: "1" },
    });
  } catch (error) {
    const failed = error as { stdout?: unknown; signal?: unknown; code?: unknown };
    if (failed.code === "ETIMEDOUT" || (failed.signal === "SIGTERM" && !failed.stdout)) {
      throw new InfraenvError(`configSync: resolving .infraenv took longer than ${timeout} ms.`);
    }
    stdout = typeof failed.stdout === "string" ? failed.stdout : "";
  }
  let reply: WorkerReply;
  try {
    reply = JSON.parse(stdout) as WorkerReply;
  } catch {
    // Never quote stdout: it may hold values.
    throw new InfraenvError("configSync: the resolve worker gave no answer.");
  }
  if (!reply.ok || !reply.result) {
    throw new InfraenvError(
      reply.error?.message ?? "configSync: the resolve failed.",
      reply.error?.problems ?? [],
      reply.error?.missing ?? [],
    );
  }
  settleProblems(reply.result, options, cwd);
  return assign(reply.result, options);
}

const truthy = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

/**
 * The options `@infrawrench/infraenv/config` runs with, from the environment:
 * INFRAENV_ENVIRONMENT, INFRAENV_FILE, INFRAENV_OVERRIDE=1, INFRAENV_STRICT=1.
 */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigOptions {
  return {
    ...(env.INFRAENV_FILE ? { file: env.INFRAENV_FILE } : {}),
    override: truthy(env.INFRAENV_OVERRIDE),
    strict: truthy(env.INFRAENV_STRICT),
  };
}
