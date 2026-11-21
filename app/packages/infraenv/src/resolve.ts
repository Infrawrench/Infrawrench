/**
 * The library's resolution, shared by `load()`, `config()` and the worker
 * behind `configSync()`: find `.infraenv` the way `infraenv pull` does, then
 * take its values from the API (with credentials) or from the generated
 * `.env` a pull or a git hook left beside it (without).
 *
 * Nothing here writes a file or prints a value. Errors are `InfraenvError`s
 * whose messages name files, keys and environments, never values.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  INFRAENV_FILE_NAME,
  infraenvEnvironmentNames,
  infraenvOutputPath,
  isGeneratedDotenv,
  parseInfraenv,
} from "@infrawrench/client-core";
import {
  DEFAULT_BASE_URL,
  chooseOrg,
  configPath,
  findCredentials,
  normalizeBaseUrl,
  readStored,
  type Credentials,
} from "./config";
import { Failure, problemLine } from "./io";
import { display, locateInfraenv } from "./locate";

/** One variable that did not resolve, or a syntax problem: never a value. */
export interface InfraenvProblem {
  /** 1-based line in `.infraenv`; 0 for the file as a whole. */
  readonly line: number;
  readonly message: string;
  readonly key?: string | undefined;
}

/** Where the values came from: the Infrawrench API, or the generated `.env`. */
export type InfraenvSource = "api" | "file";

export interface LoadOptions {
  /** Where to look for `.infraenv` from (up to the repository root). Default: `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** An `.infraenv` path, relative to `cwd`, instead of looking for one. */
  readonly file?: string | undefined;
  /**
   * The `[env.<name>]` section to lay over `[env]`. Default:
   * `INFRAENV_ENVIRONMENT`, else `[env]` alone.
   */
  readonly environment?: string | null | undefined;
  /** Substitutions for `${name}` in references, over the file's `[vars]`. */
  readonly vars?: Readonly<Record<string, string>> | undefined;
  /** Organization id. Default: `INFRAWRENCH_ORG_ID`, the file's `org`, the login's, the key's own. */
  readonly org?: string | undefined;
  /** An `iwk_` API key. Default: `INFRAWRENCH_API_KEY`, else the key `infraenv login` stored. */
  readonly apiKey?: string | undefined;
  /** Default: `INFRAWRENCH_BASE_URL`, else https://app.infrawrench.com. */
  readonly baseUrl?: string | undefined;
  /**
   * `auto` (the default): the API when there are credentials, else the
   * generated `.env`. `api` or `file` forces one.
   */
  readonly source?: "auto" | InfraenvSource | undefined;
  /** Keys that must have a value afterwards; missing ones throw, naming the keys. */
  readonly required?: readonly string[] | undefined;
  /** Throw on any problem instead of returning it. */
  readonly strict?: boolean | undefined;
  /** Do not write problems to stderr. */
  readonly quiet?: boolean | undefined;
}

export interface LoadResult {
  /** The resolved values. Keep them in memory: never log them. */
  readonly values: Record<string, string>;
  readonly problems: readonly InfraenvProblem[];
  readonly environment: string | null;
  readonly source: InfraenvSource;
  /** The `.infraenv` resolved. */
  readonly file: string;
}

/** Everything the library throws. The message never holds a value. */
export class InfraenvError extends Error {
  constructor(
    message: string,
    /** The problems behind a `strict` failure. */
    readonly problems: readonly InfraenvProblem[] = [],
    /** The keys behind a `required` failure. */
    readonly missing: readonly string[] = [],
  ) {
    super(message);
    this.name = "InfraenvError";
  }
}

function toInfraenvError(error: unknown): unknown {
  if (error instanceof InfraenvError) return error;
  if (error instanceof Failure) return new InfraenvError(error.message);
  return error;
}

const HOW_TO_AUTHENTICATE =
  "set INFRAWRENCH_API_KEY to an iwk_ key, run `infraenv login`, or run `infraenv pull` to write the .env";

/** The environment a generated `.env` says it holds (its `# Source:` header line). */
export function generatedEnvironment(text: string): string | null {
  const header = /^# Source: .*\(environment: ([^)\n]+)\)\.$/m.exec(text.split("\n\n")[0] ?? "");
  return header ? header[1]! : null;
}

/**
 * The values of a `.env` that `infraenv pull` wrote. The generated file is a
 * plain dotenv of literals in the quoting `renderDotenv` writes, which is a
 * subset of the `.infraenv` format, so client-core's parser reads it; anything
 * else in it (a reference, a syntax error) means it was not generated.
 */
export function parseGeneratedDotenv(text: string): Record<string, string> | null {
  if (!isGeneratedDotenv(text)) return null;
  const { document, problems } = parseInfraenv(text);
  if (problems.length > 0 || document.environments.length > 0) return null;
  const values: Record<string, string> = {};
  for (const entry of document.shared) {
    if (entry.value.kind !== "literal") return null;
    values[entry.key] = entry.value.value;
  }
  return values;
}

function credentialsFor(options: LoadOptions, env: NodeJS.ProcessEnv): Credentials | null {
  const baseUrl = options.baseUrl ?? env.INFRAWRENCH_BASE_URL;
  if (options.apiKey !== undefined) {
    if (!options.apiKey.trim()) throw new InfraenvError("The apiKey option is empty.");
    return {
      apiKey: options.apiKey.trim(),
      source: "env",
      baseUrl: normalizeBaseUrl(baseUrl?.trim() || DEFAULT_BASE_URL),
      storedOrg: null,
    };
  }
  const stored = readStored(configPath({ env, home: homedir(), platform: process.platform }));
  const found = findCredentials({ ...env, INFRAWRENCH_BASE_URL: baseUrl }, stored);
  return found;
}

/** Resolve `.infraenv` without touching `process.env` or printing anything. */
export async function resolveValues(options: LoadOptions = {}): Promise<LoadResult> {
  try {
    return await resolveUnwrapped(options);
  } catch (error) {
    throw toInfraenvError(error);
  }
}

async function resolveUnwrapped(options: LoadOptions): Promise<LoadResult> {
  const env = process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const path = await locateInfraenv(cwd, options.file ?? null);
  const shown = display(cwd, path);
  const text = readFileSync(path, "utf8");
  const { document, problems: syntax } = parseInfraenv(text);
  if (syntax.length > 0) {
    throw new InfraenvError(
      `${shown} does not parse: ${syntax.map((p) => problemLine(shown, p)).join("; ")}`,
      syntax,
    );
  }

  const requested =
    options.environment !== undefined ? options.environment : env.INFRAENV_ENVIRONMENT;
  const environment = requested?.trim() ? requested.trim() : null;
  const declared = infraenvEnvironmentNames(document);
  if (environment !== null && !declared.includes(environment)) {
    throw new InfraenvError(
      `${shown} has no [env.${environment}] section. ${
        declared.length > 0
          ? `Its environments: ${declared.join(", ")}.`
          : "It declares no environments, only [env]."
      }`,
    );
  }

  const mode = options.source ?? "auto";
  const credentials = mode === "file" ? null : credentialsFor(options, env);
  if (mode === "api" && credentials === null) {
    throw new InfraenvError(
      'No Infrawrench API key for source: "api": set INFRAWRENCH_API_KEY to an iwk_ key, or run `infraenv login`.',
    );
  }

  if (credentials !== null) {
    // The network half loads on first use, kill-emudhra first (api.ts).
    const { createApi } = await import("./api");
    const { explainWrongOrg } = await import("./session");
    const api = createApi(credentials);
    const chosen = chooseOrg({
      flag: options.org ?? null,
      env,
      file: document.settings.org,
      credentials,
    });
    const org = chosen ?? { id: (await api.whoami()).organizationId, from: "key" as const };
    const vars = options.vars && Object.keys(options.vars).length > 0 ? options.vars : undefined;
    const resolved = await api
      .resolve(org.id, {
        source: text,
        ...(environment === null ? {} : { environment }),
        ...(vars ? { vars } : {}),
        sourceName: INFRAENV_FILE_NAME,
      })
      .catch((error: unknown) => explainWrongOrg(error, org, api.whoami));
    const values: Record<string, string> = {};
    for (const { key, value } of resolved.values) values[key] = value;
    return {
      values,
      problems: resolved.problems.map(({ line, message, key }) => ({ line, message, key })),
      environment: resolved.environment ?? environment,
      source: "api",
      file: path,
    };
  }

  const output = resolve(dirname(path), infraenvOutputPath(document));
  const outputShown = display(cwd, output);
  if (!existsSync(output)) {
    throw new InfraenvError(
      mode === "file"
        ? `${outputShown} does not exist. Run \`infraenv pull\` to write it.`
        : `No Infrawrench API key and no ${outputShown} to read: ${HOW_TO_AUTHENTICATE}.`,
    );
  }
  const dotenv = readFileSync(output, "utf8");
  const values = parseGeneratedDotenv(dotenv);
  if (values === null) {
    throw new InfraenvError(
      `${outputShown} was not written by \`infraenv pull\` (it does not start with Infrawrench's generated header), so it is not read as ${shown}'s values. ${
        mode === "file" ? "Run `infraenv pull --force` to replace it" : HOW_TO_AUTHENTICATE
      }.`,
    );
  }
  const held = generatedEnvironment(dotenv);
  if (held !== environment) {
    const pull = environment === null ? "infraenv pull" : `infraenv pull --env ${environment}`;
    throw new InfraenvError(
      `${outputShown} holds ${held === null ? "[env] alone" : `environment ${held}`}, not ${
        environment === null ? "[env] alone" : `environment ${environment}`
      }. Run \`${pull}\`, or set INFRAWRENCH_API_KEY.`,
    );
  }
  return { values, problems: [], environment, source: "file", file: path };
}

/**
 * Apply `strict` and print problems once: what `load` and `config` do with a
 * result before anything else.
 */
export function settleProblems(result: LoadResult, options: LoadOptions, cwd: string): void {
  if (result.problems.length === 0) return;
  const shown = display(cwd, result.file);
  const lines = result.problems.map((p) => problemLine(shown, p));
  if (options.strict) {
    throw new InfraenvError(
      `${result.problems.length === 1 ? "1 variable" : `${result.problems.length} variables`} did not resolve: ${lines.join("; ")}`,
      result.problems,
    );
  }
  if (!options.quiet) {
    for (const line of lines) process.stderr.write(`infraenv: ${line}\n`);
  }
}

/** Throw when any of `required` is unset in `has`, naming the keys. */
export function checkRequired(
  required: readonly string[] | undefined,
  has: (key: string) => boolean,
): void {
  const missing = (required ?? []).filter((key) => !has(key));
  if (missing.length > 0) {
    throw new InfraenvError(
      `Required ${missing.length === 1 ? "variable is" : "variables are"} not set: ${missing.join(", ")}.`,
      [],
      missing,
    );
  }
}
