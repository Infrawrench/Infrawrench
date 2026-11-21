// `infrawrench env`: a project's `.infraenv` (committed, references only)
// resolved into the `.env` it describes (generated, secret, gitignored).
//
//   env pull     resolve one environment and write `.env` (or print it)
//   env check    what every reference points at, and what is broken
//   env init     start a `.infraenv`, optionally from an existing `.env`'s keys
//   env hooks    git hooks that pull again whenever a commit changes the file
//
// Cloud-only: `resource()` and `secret()` resolve against the organization's
// synced resources and secrets on the server, which is also where the audit
// entry for a resolve is written. The file format is client-core's
// `infraenv.ts` (the same parser and printer the server and the editors use),
// loaded with a dynamic import like the main process's other client-core
// helpers; the response schemas are checked against its wire types by `wire`.
// So is the hook block (`infraenv-hooks.ts`), which the npm package's
// installer writes too; `../env-git.ts` does the git and file I/O around it.
//
// The organization is `--org`, else the file's optional `org` setting, else
// the current one. `env init` never writes `org`: a file without it resolves
// in whichever organization pulls it.
//
// `--json` shapes:
//   env pull    → { org, file, path, ...resolveResponse }   (path null with --stdout is refused)
//   env check   → { org, file, ...describeResponse }
//   env init    → { path, variables, gitignore, hooks: [...install rows] | null }
//   env hooks   → { hooksDir, hooks: [{ hook, path, state, change? }] }
//                 (install adds infraenv and output, the paths the block names)
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type {
  InfraenvDescribeResponse,
  InfraenvDocument,
  InfraenvEntry,
  InfraenvHookState,
  InfraenvHookWrite,
  InfraenvProblem,
  InfraenvResolveResponse,
  InfraenvValue,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, decodeBody } from "../effect/cloud-api";
import { CliExit, CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import {
  type GitRepository,
  gitRepository,
  gitRoot,
  ignoreState,
  readHookFile,
  replaceHookFile,
  writeHookFile,
} from "../env-git";
import { c, safe } from "../output";

const RESOLVE_PATH = "/env-files/resolve";
const DESCRIBE_PATH = "/env-files/describe";

/** client-core at runtime: the parser, the printer and the hook block. */
const infraenv = Effect.promise(() => import("@infrawrench/client-core"));

const Problem = Schema.Struct({
  line: Schema.Finite,
  message: Schema.String,
  key: Schema.optional(Schema.String),
});

const ResolveWire = wire<InfraenvResolveResponse>()(
  Schema.Struct({
    environment: Schema.NullOr(Schema.String),
    values: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
    problems: Schema.Array(Problem),
    dotenv: Schema.String,
  }),
);

const DescribeWire = wire<InfraenvDescribeResponse>()(
  Schema.Struct({
    problems: Schema.Array(Problem),
    environments: Schema.Array(Schema.String),
    resources: Schema.Array(
      Schema.Struct({
        // Optional here so a server from before by-name references still renders.
        ref: Schema.optional(Schema.String),
        resourceId: Schema.optional(Schema.String),
        match: Schema.optional(
          Schema.Struct({
            pluginId: Schema.String,
            resourceTypeId: Schema.String,
            name: Schema.String,
            account: Schema.optional(Schema.String),
          }),
        ),
        matches: Schema.optional(Schema.Finite),
        output: Schema.String,
        found: Schema.Boolean,
        displayName: Schema.optional(Schema.String),
        pluginName: Schema.optional(Schema.String),
        resourceTypeName: Schema.optional(Schema.String),
        accountName: Schema.optional(Schema.String),
        outputLabel: Schema.optional(Schema.String),
        outputKnown: Schema.Boolean,
      }),
    ),
    secrets: Schema.Array(
      Schema.Struct({ name: Schema.String, found: Schema.Boolean, hasValue: Schema.Boolean }),
    ),
  }),
);
type Described = typeof DescribeWire.Type;

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** A file-system step, its failure one sentence naming what was being done. */
const fsStep = <A>(what: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      new CliFailure({
        message: `${what}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

/** A path as the person typed relative to: from the working directory. */
const display = (path: string): string => relative(process.cwd(), path) || ".";

/** A relative path with `/` separators, as it is written into files. */
const posix = (path: string): string => path.split(sep).join("/");

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliUsageError({
      message:
        "Env files resolve through Infrawrench Cloud: their references point at your organization's resources and secrets. Drop --local.",
    });
  }
});

const fileFlag = Flag.String("file").pipe(
  Flag.withAlias("f"),
  Flag.withMetavar("path"),
  Flag.withDescription(
    "The .infraenv file (default: the nearest one from here up to the repository root)",
  ),
  Flag.optional,
);

const varFlag = Flag.String("var").pipe(
  Flag.withMetavar("name=value"),
  Flag.withDescription(
    "Set the ${name} substitution, over the file's [vars] and [vars.<env>]. Repeatable",
  ),
  Flag.atLeast(0),
);

/** `--var name=value` lines as the request's `vars`; a later one wins. */
const parseVars = Effect.fnUntraced(function* (raw: ReadonlyArray<string>) {
  const ie = yield* infraenv;
  const vars = new Map<string, string>();
  for (const item of raw) {
    const at = item.indexOf("=");
    const name = at < 0 ? item : item.slice(0, at);
    if (at < 0 || !ie.isInfraenvKey(name)) {
      return yield* new CliUsageError({
        message: `--var takes name=value, the name letters, digits and underscores not starting with a digit: got ${JSON.stringify(item)}`,
      });
    }
    vars.set(name, item.slice(at + 1));
  }
  return Object.fromEntries(vars) as Record<string, string>;
});

/** The `vars` field of a request: absent when no `--var` was given. */
const varsField = (vars: Record<string, string>) => (Object.keys(vars).length > 0 ? { vars } : {});

/**
 * The `.infraenv` to use: `--file`, else the nearest one walking up from the
 * working directory, stopping at the repository root (the working directory
 * alone outside a repository).
 */
const locate = Effect.fnUntraced(function* (file: Option.Option<string>) {
  const cwd = process.cwd();
  const ie = yield* infraenv;
  if (Option.isSome(file)) {
    const path = resolve(cwd, file.value);
    if (!existsSync(path)) {
      return yield* new CliFailure({ message: `${file.value} does not exist.` });
    }
    return path;
  }
  const root = yield* Effect.promise(() => gitRoot(cwd));
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, ie.INFRAENV_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    const atRoot = root === null || parent === dir || realpathOr(dir) === root;
    if (atRoot) break;
    dir = parent;
  }
  return yield* new CliFailure({
    message: `No ${ie.INFRAENV_FILE_NAME} here${root === null ? "" : " or in a parent directory up to the repository root"}. Run \`infrawrench env init\` to create one, or pass -f <path>.`,
  });
});

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The organization a file's references live in: `--org`, the file's `org`, the current one. */
const orgFor = Effect.fnUntraced(function* (fromFile: string | undefined) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  return yield* api.resolveOrg(session.org ?? (fromFile || null));
});

/** `.infraenv:12 DATABASE_URL: Resource not found`. */
const problemLine = (file: string, problem: InfraenvProblem | typeof Problem.Type): string =>
  `${file}${problem.line > 0 ? `:${problem.line}` : ""} ${problem.key ? `${safe(problem.key)}: ` : ""}${safe(problem.message)}`;

/**
 * Write `text` to `path` with mode 0600, atomically: a temporary file beside
 * it renamed over it, so a reader never sees half a file and an existing
 * file's wider mode never survives.
 */
function writeSecretFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// env pull
// ---------------------------------------------------------------------------

const pull = Command.make(
  "pull",
  {
    env: Flag.String("env").pipe(
      Flag.withMetavar("name"),
      Flag.withDescription("Lay this [env.<name>] section over [env] (default: [env] alone)"),
      Flag.optional,
    ),
    file: fileFlag,
    var: varFlag,
    out: Flag.String("out").pipe(
      Flag.withMetavar("path"),
      Flag.withDescription("Write here (default: the file's output setting, else .env beside it)"),
      Flag.optional,
    ),
    stdout: Flag.Boolean("stdout").pipe(
      Flag.withDescription("Print the .env instead of writing it"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("Replace a target that was not generated by Infrawrench"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    quiet: Flag.Boolean("quiet").pipe(
      Flag.withAlias("q"),
      Flag.withDescription("Print nothing on success (for git hooks)"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("env.pull")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const json = session.output === "json";
    if (input.stdout && Option.isSome(input.out)) {
      return yield* new CliUsageError({ message: "--stdout and --out are mutually exclusive" });
    }
    if (input.stdout && json) {
      return yield* new CliUsageError({
        message: "--stdout prints the .env itself; drop --json, or drop --stdout to write the file",
      });
    }
    const vars = yield* parseVars(input.var);
    const ie = yield* infraenv;
    const path = yield* locate(input.file);
    const shown = display(path);
    const source = yield* fsStep(`Could not read ${shown}`, () => readFileSync(path, "utf8"));
    const { document, problems: syntax } = ie.parseInfraenv(source);

    // The server refuses a file that does not parse; say where, offline.
    if (syntax.length > 0) {
      if (json) yield* Print.json({ file: path, problems: syntax });
      else for (const problem of syntax) yield* Print.errLine(problemLine(shown, problem));
      return yield* new CliExit({ exitCode: 1 });
    }

    const environment = Option.getOrNull(input.env);
    const declared = ie.infraenvEnvironmentNames(document);
    if (environment !== null && !declared.includes(environment)) {
      return yield* new CliFailure({
        message: `${shown} has no [env.${environment}] section. ${
          declared.length > 0
            ? `Its environments: ${declared.join(", ")}.`
            : "It declares no environments, only [env]."
        }`,
      });
    }

    const target = input.stdout
      ? null
      : Option.isSome(input.out)
        ? resolve(process.cwd(), input.out.value)
        : resolve(dirname(path), document.settings.output || ie.INFRAENV_DEFAULT_OUTPUT);

    if (target !== null) {
      if (target === path) {
        return yield* new CliFailure({
          message: `Refusing to write the .env over ${shown} itself. Check the output setting or --out.`,
        });
      }
      if (existsSync(target) && !input.force) {
        const existing = yield* fsStep(`Could not read ${display(target)}`, () =>
          statSync(target).isFile() ? readFileSync(target, "utf8") : null,
        );
        if (existing === null || !ie.isGeneratedDotenv(existing)) {
          return yield* new CliFailure({
            message: `${display(target)} exists and looks hand-written (it does not start with Infrawrench's generated header). Move it aside, or pass --force to replace it. \`infrawrench env init --from ${display(target)}\` turns its keys into a .infraenv.`,
          });
        }
      }
    }

    const org = yield* orgFor(document.settings.org);
    const sourceName = posix(relative(target === null ? process.cwd() : dirname(target), path));
    const body = yield* api.json(org.id, RESOLVE_PATH, {
      method: "POST",
      body: JSON.stringify({
        source,
        ...(environment === null ? {} : { environment }),
        ...varsField(vars),
        sourceName: sourceName || ie.INFRAENV_FILE_NAME,
      }),
    });
    const resolved = yield* decodeBody(ResolveWire, RESOLVE_PATH)(body);

    if (target !== null) {
      yield* fsStep(`Could not write ${display(target)}`, () =>
        writeSecretFile(target, resolved.dotenv),
      );
    }

    if (json) {
      yield* Print.json(
        yield* spreadBody({ org: org.id, file: path, path: target }, body, RESOLVE_PATH),
      );
    } else if (target === null) {
      yield* Print.write(resolved.dotenv);
    } else if (!input.quiet) {
      const count = resolved.values.length;
      const env = resolved.environment ?? environment;
      yield* Print.line(
        `Wrote ${display(target)} (${plural(count, "variable")}${env ? `, environment ${safe(env)}` : ""})`,
      );
    }

    if (!json) {
      for (const problem of resolved.problems) yield* Print.errLine(problemLine(shown, problem));
    }

    if (target !== null && !input.quiet && !json) {
      const ignored = yield* Effect.promise(() => ignoreState(target));
      if (ignored === "not-ignored") {
        yield* Print.errLine(
          c.yellow(
            `warning: ${display(target)} is not ignored by Git, and it holds secret values. Add it to .gitignore.`,
          ),
        );
      }
    }

    if (resolved.problems.length > 0) {
      if (!json) {
        yield* Print.errLine(
          c.red(
            resolved.problems.length === 1
              ? "1 variable did not resolve and was left out."
              : `${resolved.problems.length} variables did not resolve and were left out.`,
          ),
        );
      }
      return yield* new CliExit({ exitCode: 1 });
    }
  }),
).pipe(Command.withDescription("Resolve .infraenv and write the .env it describes"));

// ---------------------------------------------------------------------------
// env check
// ---------------------------------------------------------------------------

type Mark = { readonly status: string; readonly label: string };
type DescribedResource = Described["resources"][number];

/** One variable's reference as one scope resolves it. */
interface Reference {
  /** The value with its substitutions filled in, or as written when they could not be. */
  readonly value: InfraenvValue;
  /** client-core `infraenvReferenceKey` of the expanded value; null when it did not expand. */
  readonly ref: string | null;
  /** The substitutions that had no value, when it did not expand. */
  readonly missing: readonly string[];
  /** The value as the file writes it. */
  readonly written: string;
}

/** `neon/neon-branch@acme "storefront / dev"`: what a by-name reference looks for. */
const wantedLabel = (
  value: Extract<InfraenvValue, { kind: "named-resource" }>,
  match: DescribedResource["match"],
): string => {
  const m = match ?? value.match;
  const kind = `${m.pluginId}/${m.resourceTypeId}${m.account !== undefined ? `@${m.account}` : ""}`;
  return `${safe(kind)} ${safe(JSON.stringify(m.name))} ${c.dim(`· ${safe(value.output)}`)}`;
};

/** `main · Neon Branch · acme-neon · Connection string`: the resource a reference found. */
const foundLabel = (found: DescribedResource): string => {
  const kind = [found.pluginName, found.resourceTypeName].filter(Boolean).join(" ");
  const details = [kind, found.accountName, found.outputLabel ?? found.output]
    .filter((part): part is string => Boolean(part))
    .map(safe);
  return `${safe(found.displayName ?? found.resourceId ?? "")} ${c.dim(`· ${details.join(" · ")}`)}`;
};

function describeEntry(reference: Reference, described: Described): Mark {
  const value = reference.value;
  if (value.kind === "literal") return { status: "", label: c.dim("literal") };
  if (reference.ref === null) {
    const names = reference.missing.map((name) => `\${${name}}`).join(", ");
    return { status: c.red(`✗ no value for ${safe(names)}`), label: safe(reference.written) };
  }
  const ref = reference.ref;
  switch (value.kind) {
    case "secret": {
      const found = described.secrets.find((s) => s.name === value.name);
      const label = `${c.dim("secret")} ${safe(value.name)}`;
      if (!found?.found) return { status: c.red("✗ no such secret"), label };
      if (!found.hasValue) return { status: c.yellow("! no value set"), label };
      return { status: c.green("✓"), label };
    }
    case "resource": {
      const found =
        described.resources.find((r) => r.ref === ref) ??
        described.resources.find(
          (r) =>
            r.ref === undefined && r.resourceId === value.resourceId && r.output === value.output,
        );
      if (!found?.found) {
        return {
          status: c.red("✗ resource not found"),
          label: `${safe(value.resourceId)} ${c.dim(`· ${safe(value.output)}`)}`,
        };
      }
      const label = foundLabel(found);
      if (!found.outputKnown) return { status: c.yellow("! unknown output"), label };
      return { status: c.green("✓"), label };
    }
    case "named-resource": {
      const found = described.resources.find((r) => r.ref === ref);
      if (!found?.found) {
        const matches = found?.matches ?? 0;
        return {
          status: c.red(
            matches > 1 ? `✗ ambiguous: ${matches} resources match` : "✗ no resource by that name",
          ),
          label: wantedLabel(value, found?.match),
        };
      }
      const label = foundLabel(found);
      if (!found.outputKnown) return { status: c.yellow("! unknown output"), label };
      return { status: c.green("✓"), label };
    }
  }
}

const printSections = Effect.fnUntraced(function* (
  document: InfraenvDocument,
  described: Described,
  overrides: Record<string, string>,
) {
  const ie = yield* infraenv;
  const sections: Array<{
    name: string;
    scope: string | null;
    entries: readonly InfraenvEntry[];
  }> = [
    { name: "[env]", scope: null, entries: document.shared },
    ...document.environments.map((env) => ({
      name: `[env.${env.name}]`,
      scope: env.name,
      entries: env.entries,
    })),
  ];
  const width = Math.max(
    0,
    ...sections.flatMap((section) => section.entries.map((entry) => entry.key.length)),
  );
  for (const section of sections) {
    yield* Print.line();
    yield* Print.line(c.bold(safe(section.name)));
    if (section.entries.length === 0) {
      yield* Print.line(`  ${c.dim("(no variables)")}`);
      continue;
    }
    // Each section resolves with its own substitutions: [vars], then the
    // environment's name and [vars.<env>], then --var.
    const vars = ie.infraenvVariables(document, section.scope, overrides);
    for (const entry of section.entries) {
      const expanded = ie.expandInfraenvValue(entry.value, vars);
      const reference: Reference = expanded.ok
        ? {
            value: expanded.value,
            ref: ie.infraenvReferenceKey(expanded.value),
            missing: [],
            written: "",
          }
        : {
            value: entry.value,
            ref: null,
            missing: expanded.missing,
            written: ie.printInfraenvValue(entry.value),
          };
      const mark = describeEntry(reference, described);
      yield* Print.line(
        `  ${safe(entry.key).padEnd(width)}  ${mark.label}${mark.status ? `  ${mark.status}` : ""}`,
      );
    }
  }
});

const sameProblem = (a: InfraenvProblem, b: InfraenvProblem) =>
  a.line === b.line && a.message === b.message && (a.key ?? "") === (b.key ?? "");

const check = Command.make(
  "check",
  { file: fileFlag, var: varFlag },
  Effect.fn("env.check")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const vars = yield* parseVars(input.var);
    const ie = yield* infraenv;
    const path = yield* locate(input.file);
    const shown = display(path);
    const source = yield* fsStep(`Could not read ${shown}`, () => readFileSync(path, "utf8"));
    const { document } = ie.parseInfraenv(source);
    const org = yield* orgFor(document.settings.org);
    const body = yield* api.json(org.id, DESCRIBE_PATH, {
      method: "POST",
      body: JSON.stringify({ source, ...varsField(vars) }),
    });
    const described = yield* decodeBody(DescribeWire, DESCRIBE_PATH)(body);

    // A substitution with no value is the server's to report as well; the
    // same client-core check here keeps it in the list either way.
    const problems: InfraenvProblem[] = [...described.problems];
    for (const problem of ie.infraenvReferences(document, vars).problems) {
      if (!problems.some((known) => sameProblem(known, problem))) problems.push(problem);
    }

    if (session.output === "json") {
      yield* Print.json(yield* spreadBody({ org: org.id, file: path }, body, DESCRIBE_PATH));
    } else {
      yield* Print.line(`${c.bold(shown)} ${c.dim(`· ${safe(org.displayName)}`)}`);
      yield* Print.line(
        c.dim(
          described.environments.length > 0
            ? `environments: ${described.environments.map(safe).join(", ")}`
            : "no environments: [env] only",
        ),
      );
      yield* printSections(document, described, vars);
      yield* Print.line();
      if (problems.length === 0) {
        yield* Print.line(c.green("No problems."));
      } else {
        yield* Print.line(c.red(plural(problems.length, "problem")));
        for (const problem of problems) {
          yield* Print.line(`  ${problemLine(shown, problem)}`);
        }
      }
    }
    if (problems.length > 0) return yield* new CliExit({ exitCode: 1 });
  }),
).pipe(Command.withDescription("What every reference in .infraenv points at, and what is broken"));

// ---------------------------------------------------------------------------
// env hooks: the install shared by `env hooks install` and `env init`
// ---------------------------------------------------------------------------

interface HookRow {
  readonly hook: string;
  readonly path: string;
  readonly state: InfraenvHookState;
  readonly change: InfraenvHookWrite | "skipped";
  readonly reason?: string;
}

/**
 * The paths the hook block names, relative to the repository root where git
 * runs hooks: the `.infraenv`, and the output it writes (its `output`
 * setting, else `.env` beside it), which the block pulls when missing.
 */
const hookPaths = Effect.fnUntraced(function* (repo: GitRepository, infraenvPath: string) {
  const ie = yield* infraenv;
  const file = posix(relative(repo.root, realpathOr(infraenvPath)));
  if (file.startsWith("../") || isAbsolute(file)) {
    return yield* new CliFailure({
      message: `${display(infraenvPath)} is outside this repository.`,
    });
  }
  const source = yield* fsStep(`Could not read ${display(infraenvPath)}`, () =>
    readFileSync(infraenvPath, "utf8"),
  );
  const setting = ie.parseInfraenv(source).document.settings.output;
  const output = posix(
    relative(
      repo.root,
      resolve(realpathOr(dirname(infraenvPath)), setting || ie.INFRAENV_DEFAULT_OUTPUT),
    ),
  );
  return { file, output };
});

const readHook = (path: string) =>
  fsStep(`Could not read ${display(path)}`, () => readHookFile(path));

/**
 * Put the block in every hook. A hook someone else wrote keeps its text with
 * the block appended, unless its interpreter is not a shell (skipped, with
 * why); one that may exit before the block runs gets a warning.
 */
const installHooks = Effect.fnUntraced(function* (
  repo: GitRepository,
  paths: { readonly file: string; readonly output: string },
) {
  const ie = yield* infraenv;
  yield* fsStep(`Could not create ${display(repo.hooksDir)}`, () =>
    mkdirSync(repo.hooksDir, { recursive: true }),
  );
  const rows: HookRow[] = [];
  for (const hook of ie.INFRAENV_HOOKS) {
    const path = join(repo.hooksDir, hook);
    const before = yield* readHook(path);
    const refused =
      before !== null && ie.infraenvHookState(before) === "foreign"
        ? ie.infraenvForeignHookProblem(before)
        : null;
    if (refused) {
      rows.push({ hook, path, state: "foreign", change: "skipped", reason: refused });
      continue;
    }
    const next = ie.withInfraenvHook(before, ie.infraenvHookBlock(hook, paths));
    yield* fsStep(`Could not write ${display(path)}`, () =>
      writeHookFile(path, next.text, before !== null, next.change !== "unchanged"),
    );
    rows.push({ hook, path, state: ie.infraenvHookState(next.text), change: next.change });
    if (next.change === "appended" && before !== null && ie.infraenvHookMayExitEarly(before)) {
      yield* Print.errLine(
        c.yellow(
          `warning: ${display(path)} has an exit before the end; move the infrawrench block above it if pull never runs.`,
        ),
      );
    }
  }
  return rows;
});

/** Whether a hook already carries a block for another file (another `.infraenv` here). */
const hooksTaken = Effect.fnUntraced(function* (
  repo: GitRepository,
  paths: { readonly file: string; readonly output: string },
) {
  const ie = yield* infraenv;
  for (const hook of ie.INFRAENV_HOOKS) {
    const text = yield* readHook(join(repo.hooksDir, hook));
    const state = ie.infraenvHookState(text);
    if (text === null || state === "absent" || state === "foreign") continue;
    if (ie.withInfraenvHook(text, ie.infraenvHookBlock(hook, paths)).change !== "unchanged") {
      return true;
    }
  }
  return false;
});

const skippedText = (row: HookRow) =>
  `skipped: ${row.reason ?? "it is not a shell script"}; add \`infrawrench env pull --quiet\` to it yourself`;

// ---------------------------------------------------------------------------
// env init
// ---------------------------------------------------------------------------

type GitignoreOutcome = "added" | "ignored" | "not-a-repo";

/** Make sure `output` (the generated `.env`) is ignored, adding it to the root `.gitignore`. */
const ensureIgnored = Effect.fnUntraced(function* (
  output: string,
): Effect.fn.Return<GitignoreOutcome, CliFailure> {
  const state = yield* Effect.promise(() => ignoreState(output));
  if (state === "ignored") return "ignored";
  if (state === "no-repo") return "not-a-repo";
  const root = yield* Effect.promise(() => gitRoot(dirname(output)));
  if (root === null) return "not-a-repo";
  const inRepo = posix(relative(root, join(realpathOr(dirname(output)), basename(output))));
  const pattern = inRepo === ".env" ? ".env" : `/${inRepo}`;
  const gitignore = join(root, ".gitignore");
  yield* fsStep(`Could not update ${display(gitignore)}`, () => {
    const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    const lead = existing === "" || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(
      gitignore,
      `${existing}${lead}# Generated from .infraenv by \`infrawrench env pull\`; holds secret values\n${pattern}\n`,
    );
  });
  return "added";
});

const init = Command.make(
  "init",
  {
    file: Flag.String("file").pipe(
      Flag.withAlias("f"),
      Flag.withMetavar("path"),
      Flag.withDescription("Where to create the file (default: .infraenv here)"),
      Flag.optional,
    ),
    from: Flag.String("from").pipe(
      Flag.withMetavar("dotenv"),
      Flag.withDescription(
        'Add each variable of this .env as KEY = secret("KEY") (keys only, never values)',
      ),
      Flag.optional,
    ),
    hooks: Flag.Boolean("hooks").pipe(
      Flag.withDescription(
        "Install the Git hooks that pull when a commit changes the file (--no-hooks skips them)",
      ),
      Flag.withDefault(true),
    ),
  },
  Effect.fn("env.init")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const ie = yield* infraenv;
    const cwd = process.cwd();
    const target = resolve(
      cwd,
      Option.getOrElse(input.file, () => ie.INFRAENV_FILE_NAME),
    );
    if (existsSync(target)) {
      return yield* new CliFailure({
        message: `${display(target)} already exists. Edit it, or run \`infrawrench env check\` to see what it references.`,
      });
    }

    const keys: string[] = [];
    if (Option.isSome(input.from)) {
      const from = resolve(cwd, input.from.value);
      const text = yield* fsStep(`Could not read ${input.from.value}`, () =>
        readFileSync(from, "utf8"),
      );
      const parsed = ie.parseInfraenv(text);
      for (const entry of parsed.document.shared) keys.push(entry.key);
      for (const problem of parsed.problems) {
        yield* Print.errLine(c.yellow(`skipped ${problemLine(display(from), problem)}`));
      }
    }

    // No `org` setting: the file resolves in whichever organization pulls it.
    const document: InfraenvDocument = {
      ...ie.emptyInfraenvDocument(),
      shared: keys.map((key) => ({ key, value: { kind: "secret", name: key } })),
    };
    yield* fsStep(`Could not create ${display(target)}`, () => {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, ie.serializeInfraenv(document), { flag: "wx" });
    });

    const gitignore = yield* ensureIgnored(join(dirname(target), ie.INFRAENV_DEFAULT_OUTPUT));

    // Hooks, unless --no-hooks, outside a repository, or the repository's
    // hooks already pull another .infraenv (pointing them here is
    // `env hooks install -f`, a deliberate step).
    let hookRows: HookRow[] | null = null;
    let taken = false;
    const repo = input.hooks ? yield* Effect.promise(() => gitRepository(dirname(target))) : null;
    if (repo !== null) {
      const paths = yield* hookPaths(repo, target);
      taken = yield* hooksTaken(repo, paths);
      if (!taken) hookRows = yield* installHooks(repo, paths);
    }

    if (session.output === "json") {
      return yield* Print.json({ path: target, variables: keys, gitignore, hooks: hookRows });
    }
    yield* Print.line(
      `Created ${display(target)}${
        Option.isSome(input.from)
          ? ` with ${plural(keys.length, "variable")} from ${input.from.value}`
          : ""
      }`,
    );
    if (keys.length > 0) {
      yield* Print.line(
        c.dim(
          'Each is secret("<KEY>"): add the values as organization secrets in Infrawrench, or swap a line for a resource reference in the app. No value was copied.',
        ),
      );
    }
    if (gitignore === "added") yield* Print.line(c.dim("Added .env to .gitignore"));
    if (hookRows !== null) {
      for (const row of hookRows) {
        if (row.change === "skipped") {
          yield* Print.errLine(c.yellow(`warning: ${display(row.path)} ${skippedText(row)}`));
        }
      }
      yield* Print.line(
        c.dim(
          "Installed Git hooks that pull .env when a commit changes it; `infrawrench env hooks uninstall` removes them.",
        ),
      );
    } else if (taken) {
      yield* Print.line(
        c.dim(
          `Left the Git hooks alone: they pull another .infraenv. \`infrawrench env hooks install -f ${display(target)}\` points them here.`,
        ),
      );
    }
    yield* Print.line(c.dim("Commit it, then run `infrawrench env pull` to write .env."));
  }),
).pipe(Command.withDescription("Create a .infraenv and install the Git hooks that pull it"));

// ---------------------------------------------------------------------------
// env hooks
// ---------------------------------------------------------------------------

/** The repository and its hooks directory, or a failure outside one. */
const repository = Effect.gen(function* () {
  const repo = yield* Effect.promise(() => gitRepository(process.cwd()));
  if (repo === null) {
    return yield* new CliFailure({
      message: "Not inside a Git repository: env hooks are Git hooks.",
    });
  }
  return repo;
});

const STATE_TEXT: Record<InfraenvHookState, string> = {
  absent: c.dim("not installed"),
  foreign: c.dim("not installed (another hook is there)"),
  ours: c.green("installed"),
  shared: c.green("installed (inside an existing hook)"),
};

const hookWidth = (hooks: readonly string[]) => Math.max(...hooks.map((hook) => hook.length));

const hooksStatus = Effect.fn("env.hooks.status")(function* () {
  const session = yield* CliSession;
  const ie = yield* infraenv;
  const { hooksDir } = yield* repository;
  const rows: Array<{ hook: string; path: string; state: InfraenvHookState }> = [];
  for (const hook of ie.INFRAENV_HOOKS) {
    const path = join(hooksDir, hook);
    rows.push({ hook, path, state: ie.infraenvHookState(yield* readHook(path)) });
  }
  if (session.output === "json") return yield* Print.json({ hooksDir, hooks: rows });
  const width = hookWidth(ie.INFRAENV_HOOKS);
  for (const row of rows) yield* Print.line(`${row.hook.padEnd(width)}  ${STATE_TEXT[row.state]}`);
  yield* Print.line(c.dim(display(hooksDir)));
});

const CHANGE_TEXT: Record<InfraenvHookWrite, string> = {
  created: "installed",
  updated: "updated",
  unchanged: "already installed",
  appended: "added to the existing hook",
};

const hooksInstall = Command.make(
  "install",
  { file: fileFlag },
  Effect.fn("env.hooks.install")(function* (input) {
    const session = yield* CliSession;
    const ie = yield* infraenv;
    const repo = yield* repository;
    const infraenvPath = yield* locate(input.file);
    const paths = yield* hookPaths(repo, infraenvPath);
    const rows = yield* installHooks(repo, paths);

    if (session.output === "json") {
      yield* Print.json({
        hooksDir: repo.hooksDir,
        infraenv: paths.file,
        output: paths.output,
        hooks: rows,
      });
    } else {
      const width = hookWidth(ie.INFRAENV_HOOKS);
      for (const row of rows) {
        yield* Print.line(
          `${row.hook.padEnd(width)}  ${
            row.change === "skipped"
              ? c.red(skippedText(row))
              : row.change === "unchanged"
                ? c.dim(CHANGE_TEXT[row.change])
                : c.green(CHANGE_TEXT[row.change])
          }`,
        );
      }
      yield* Print.line(
        c.dim(
          `${safe(paths.file)} is pulled into ${safe(paths.output)} when a checkout, merge, rebase or commit changes it.`,
        ),
      );
    }
    if (rows.some((row) => row.change === "skipped")) return yield* new CliExit({ exitCode: 1 });
  }),
).pipe(
  Command.withDescription(
    "Pull again whenever a checkout, merge, rebase or commit changes the file",
  ),
);

const hooksUninstall = Command.make(
  "uninstall",
  {},
  Effect.fn("env.hooks.uninstall")(function* () {
    const session = yield* CliSession;
    const ie = yield* infraenv;
    const { hooksDir } = yield* repository;
    const rows: Array<{ hook: string; path: string; change: "removed" | "restored" | "none" }> = [];
    for (const hook of ie.INFRAENV_HOOKS) {
      const path = join(hooksDir, hook);
      const before = yield* readHook(path);
      const state = ie.infraenvHookState(before);
      if (before === null || state === "absent" || state === "foreign") {
        rows.push({ hook, path, change: "none" });
        continue;
      }
      const rest = ie.withoutInfraenvHook(before);
      yield* fsStep(`Could not update ${display(path)}`, () => replaceHookFile(path, rest));
      rows.push({ hook, path, change: rest === null ? "removed" : "restored" });
    }
    if (session.output === "json") return yield* Print.json({ hooksDir, hooks: rows });
    const width = hookWidth(ie.INFRAENV_HOOKS);
    for (const row of rows) {
      yield* Print.line(
        `${row.hook.padEnd(width)}  ${
          row.change === "removed"
            ? "removed"
            : row.change === "restored"
              ? "removed from the existing hook"
              : c.dim("not installed")
        }`,
      );
    }
  }),
).pipe(Command.withDescription("Remove the hooks (or the block, from a hook someone else wrote)"));

const hooks = Command.make("hooks", {}, hooksStatus).pipe(
  Command.withDescription("Git hooks that keep .env in step with .infraenv (bare: status)"),
  Command.withSubcommands([
    hooksInstall,
    hooksUninstall,
    Command.make("status", {}, hooksStatus).pipe(
      Command.withDescription("Whether each hook is installed"),
    ),
  ]),
);

export const env = Command.make("env").pipe(
  Command.withDescription(
    "Resolve a project's committed .infraenv (references, never values) into its .env",
  ),
  Command.withSubcommands([pull, check, init, hooks]),
);
