/**
 * `infraenv install`, `uninstall` and `status`: the git hooks that pull again
 * when a checkout, merge, rebase or commit changes `.infraenv`.
 *
 * The block is client-core's (`infraenv-hooks.ts`), byte for byte the one
 * `infrawrench env hooks` writes, so each tool recognises, updates and
 * removes the other's. This module only does the I/O: where git runs hooks
 * from (`git rev-parse --git-path hooks`, so `core.hooksPath` is honoured),
 * reading and writing them, and keeping them executable. A hook someone else
 * wrote keeps its text; the block is appended, or the hook is skipped when it
 * is not a shell script.
 *
 * `install` is meant for a `prepare` script, so like Husky it does nothing and
 * exits 0 outside a repository, in CI (`CI` set) or with
 * `INFRAENV_SKIP_INSTALL=1`, and a hook it has to skip is a warning, not a
 * failed `npm install`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  INFRAENV_DEFAULT_OUTPUT,
  INFRAENV_FILE_NAME,
  INFRAENV_HOOKS,
  infraenvForeignHookProblem,
  infraenvHookBlock,
  infraenvHookMayExitEarly,
  infraenvHookState,
  parseInfraenv,
  withInfraenvHook,
  withoutInfraenvHook,
  type InfraenvHookState,
  type InfraenvHookWrite,
} from "@infrawrench/client-core";
import type { ParsedArgs } from "../args";
import { gitHooksDir, gitRoot, realpathOr } from "../git";
import { Failure, printer, type Io } from "../io";
import { display, findInfraenv, posix } from "../locate";

/** Why `install` should do nothing here, or null to go ahead. */
export function installSkipReason(env: Io["env"]): string | null {
  const skip = env.INFRAENV_SKIP_INSTALL?.trim();
  if (skip && skip !== "0" && skip.toLowerCase() !== "false") {
    return "INFRAENV_SKIP_INSTALL is set";
  }
  const ci = env.CI?.trim();
  if (ci && ci !== "0" && ci.toLowerCase() !== "false") return "CI is set";
  return null;
}

interface Repository {
  readonly root: string;
  readonly hooksDir: string;
}

async function repository(cwd: string): Promise<Repository | null> {
  const root = await gitRoot(cwd);
  const hooksDir = await gitHooksDir(cwd);
  if (root === null || hooksDir === null) return null;
  return { root, hooksDir };
}

function readHook(cwd: string, path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch (error) {
    throw new Failure(
      `Could not read ${display(cwd, path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const width = Math.max(...INFRAENV_HOOKS.map((hook) => hook.length));

/**
 * The `.infraenv` the hooks watch and the output they check for, relative to
 * the repository root: the nearest file, else `.infraenv` in the working
 * directory (the hooks check for it, so installing before it exists works).
 */
export async function hookTargets(
  cwd: string,
  root: string,
  file: string | null,
): Promise<{ file: string; output: string }> {
  const path =
    file !== null
      ? resolve(cwd, file)
      : ((await findInfraenv(cwd)) ?? join(cwd, INFRAENV_FILE_NAME));
  const real = join(realpathOr(dirname(path)), basename(path));
  let output = INFRAENV_DEFAULT_OUTPUT;
  if (existsSync(path)) {
    const { document } = parseInfraenv(readFileSync(path, "utf8"));
    if (document.settings.output) output = document.settings.output;
  }
  const inRepo = posix(relative(root, real));
  const outputInRepo = posix(relative(root, resolve(dirname(real), output)));
  for (const p of [inRepo, outputInRepo]) {
    if (p === "" || p.startsWith("../") || p === ".." || isAbsolute(p)) {
      throw new Failure(`${display(cwd, path)} (or its output) is outside this repository.`);
    }
  }
  return { file: inRepo, output: outputInRepo };
}

const CHANGE_TEXT: Record<InfraenvHookWrite, string> = {
  created: "installed",
  updated: "updated",
  unchanged: "already installed",
  appended: "added to the existing hook",
};

export async function install(io: Io, args: ParsedArgs): Promise<number> {
  const p = printer(io);
  const skip = installSkipReason(io.env);
  if (skip) {
    if (args.json) p.json({ skipped: skip, hooks: [] });
    else p.line(`infraenv: ${skip}; git hooks not installed.`);
    return 0;
  }
  const repo = await repository(io.cwd);
  if (repo === null) {
    if (args.json) p.json({ skipped: "not a git repository", hooks: [] });
    else p.line("infraenv: not inside a Git repository; git hooks not installed.");
    return 0;
  }
  const targets = await hookTargets(io.cwd, repo.root, args.file);
  try {
    mkdirSync(repo.hooksDir, { recursive: true });
  } catch (error) {
    throw new Failure(
      `Could not create ${display(io.cwd, repo.hooksDir)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rows: Array<{
    hook: string;
    path: string;
    state: InfraenvHookState;
    change: InfraenvHookWrite | "skipped";
    reason?: string;
  }> = [];
  const warnings: string[] = [];
  for (const hook of INFRAENV_HOOKS) {
    const path = join(repo.hooksDir, hook);
    const before = readHook(io.cwd, path);
    const refused =
      before !== null && infraenvHookState(before) === "foreign"
        ? infraenvForeignHookProblem(before)
        : null;
    if (refused) {
      rows.push({ hook, path, state: "foreign", change: "skipped", reason: refused });
      continue;
    }
    const next = withInfraenvHook(before, infraenvHookBlock(hook, targets));
    try {
      if (next.change !== "unchanged") writeFileSync(path, next.text);
      const mode = before === null ? 0o755 : statSync(path).mode | 0o111;
      chmodSync(path, mode & 0o7777);
    } catch (error) {
      throw new Failure(
        `Could not write ${display(io.cwd, path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    rows.push({ hook, path, state: infraenvHookState(next.text), change: next.change });
    if (next.change === "appended" && before !== null && infraenvHookMayExitEarly(before)) {
      warnings.push(
        `warning: ${display(io.cwd, path)} has an exit before the end; move the infrawrench block above it if pull never runs.`,
      );
    }
  }

  if (args.json) {
    p.json({
      hooksDir: repo.hooksDir,
      infraenv: targets.file,
      output: targets.output,
      hooks: rows,
    });
  } else {
    const { c } = p;
    for (const row of rows) {
      p.line(
        `${row.hook.padEnd(width)}  ${
          row.change === "skipped"
            ? c.yellow(`skipped: ${row.reason}; add \`infraenv pull --quiet\` to it yourself`)
            : row.change === "unchanged"
              ? c.dim(CHANGE_TEXT[row.change])
              : c.green(CHANGE_TEXT[row.change])
        }`,
      );
    }
    p.line(
      c.dim(
        `${targets.file} is pulled into ${targets.output} after checkouts, merges, rebases and commits that change it.`,
      ),
    );
  }
  for (const warning of warnings) p.errLine(p.ec.yellow(warning));
  return 0;
}

export async function uninstall(io: Io, args: ParsedArgs): Promise<number> {
  const p = printer(io);
  const repo = await repository(io.cwd);
  if (repo === null) throw new Failure("Not inside a Git repository: the hooks are Git hooks.");
  const rows: Array<{ hook: string; path: string; change: "removed" | "restored" | "none" }> = [];
  for (const hook of INFRAENV_HOOKS) {
    const path = join(repo.hooksDir, hook);
    const before = readHook(io.cwd, path);
    const state = infraenvHookState(before);
    if (before === null || state === "absent" || state === "foreign") {
      rows.push({ hook, path, change: "none" });
      continue;
    }
    const rest = withoutInfraenvHook(before);
    try {
      if (rest === null) unlinkSync(path);
      else writeFileSync(path, rest);
    } catch (error) {
      throw new Failure(
        `Could not update ${display(io.cwd, path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    rows.push({ hook, path, change: rest === null ? "removed" : "restored" });
  }
  if (args.json) {
    p.json({ hooksDir: repo.hooksDir, hooks: rows });
    return 0;
  }
  for (const row of rows) {
    p.line(
      `${row.hook.padEnd(width)}  ${
        row.change === "removed"
          ? "removed"
          : row.change === "restored"
            ? "removed from the existing hook"
            : p.c.dim("not installed")
      }`,
    );
  }
  return 0;
}

const STATE_TEXT: Record<InfraenvHookState, (c: ReturnType<typeof printer>["c"]) => string> = {
  absent: (c) => c.dim("not installed"),
  foreign: (c) => c.dim("not installed (another hook is there)"),
  ours: (c) => c.green("installed"),
  shared: (c) => c.green("installed (inside an existing hook)"),
};

export async function status(io: Io, args: ParsedArgs): Promise<number> {
  const p = printer(io);
  const repo = await repository(io.cwd);
  if (repo === null) throw new Failure("Not inside a Git repository: the hooks are Git hooks.");
  const rows = INFRAENV_HOOKS.map((hook) => {
    const path = join(repo.hooksDir, hook);
    return { hook, path, state: infraenvHookState(readHook(io.cwd, path)) };
  });
  if (args.json) {
    p.json({ hooksDir: repo.hooksDir, hooks: rows });
    return 0;
  }
  for (const row of rows) p.line(`${row.hook.padEnd(width)}  ${STATE_TEXT[row.state](p.c)}`);
  p.line(p.c.dim(display(io.cwd, repo.hooksDir)));
  return 0;
}
