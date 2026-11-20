// Git plumbing for `infrawrench env`: where the repository is, whether a path
// is ignored, where hooks live, and the hook block `env hooks` manages.
//
// Git runs through `node:child_process` (no new dependencies), always with an
// explicit working directory, and a git that is missing or fails reads as
// "not a repository" rather than an error: every caller has a sensible answer
// for that case. The hook text functions are pure so the tests can pin them.
import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";

interface GitResult {
  /** Exit code; -1 when git could not be run at all. */
  readonly code: number;
  readonly stdout: string;
}

function git(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout });
      resolve({ code: typeof error.code === "number" ? error.code : -1, stdout: stdout ?? "" });
    });
  });
}

/** The worktree's top directory (a real path), or null outside a repository. */
export async function gitRoot(cwd: string): Promise<string | null> {
  const result = await git(["rev-parse", "--show-toplevel"], cwd);
  const root = result.stdout.trim();
  return result.code === 0 && root !== "" ? root : null;
}

/**
 * The directory git runs hooks from, as git resolves it (`core.hooksPath`
 * honoured), relative to `cwd` or absolute; null outside a repository.
 */
export async function gitHooksPath(cwd: string): Promise<string | null> {
  const result = await git(["rev-parse", "--git-path", "hooks"], cwd);
  const path = result.stdout.trim();
  return result.code === 0 && path !== "" ? path : null;
}

export type IgnoreState = "ignored" | "not-ignored" | "no-repo";

/** Whether git would ignore `path` (which need not exist; its directory must). */
export async function ignoreState(path: string): Promise<IgnoreState> {
  const result = await git(["check-ignore", "-q", "--", basename(path)], dirname(path));
  if (result.code === 0) return "ignored";
  if (result.code === 1) return "not-ignored";
  return "no-repo";
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const ENV_HOOKS = ["post-checkout", "post-merge", "post-rewrite"] as const;
export type EnvHook = (typeof ENV_HOOKS)[number];

export const HOOK_BEGIN = "# >>> infrawrench env >>>";
export const HOOK_END = "# <<< infrawrench env <<<";

const SHEBANG = "#!/bin/sh";

/** When each hook pulls: a branch checkout, any merge, a rebase (not an amend). */
const HOOK_CONDITION: Record<EnvHook, string> = {
  "post-checkout": '[ "$3" = "1" ]',
  "post-merge": "true",
  "post-rewrite": '[ "$1" = "rebase" ]',
};

/** `value` as one single-quoted sh word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The managed block for one hook. `infraenv` is the file's path relative to
 * the repository root, where git runs hooks. Nothing in it can fail the git
 * operation: a missing CLI, a branch without the file or a failed pull all
 * end the block with status 0.
 */
export function hookBlock(hook: EnvHook, infraenv: string): string {
  const file = shellQuote(infraenv);
  const condition = HOOK_CONDITION[hook] === "true" ? "" : `${HOOK_CONDITION[hook]} && `;
  return [
    HOOK_BEGIN,
    "# Regenerates .env from .infraenv when the checkout changes.",
    "# Managed by `infrawrench env hooks`; `infrawrench env hooks uninstall` removes it.",
    `if ${condition}[ -f ${file} ] && command -v infrawrench >/dev/null 2>&1; then`,
    `  infrawrench env pull --quiet -f ${file} || true`,
    "fi",
    HOOK_END,
  ].join("\n");
}

/** Where the managed block sits in a hook's text: [start, end) including its newline. */
function blockRange(text: string): [number, number] | null {
  const begin = text.search(/^# >>> infrawrench env >>>$/m);
  if (begin < 0) return null;
  const endMarker = text.indexOf(HOOK_END, begin);
  if (endMarker < 0) return null;
  let end = endMarker + HOOK_END.length;
  if (text[end] === "\n") end++;
  return [begin, end];
}

/** A hook file holding nothing but a shebang and blank lines once the block is out. */
function isBare(text: string): boolean {
  return text
    .split("\n")
    .every((line, index) => line.trim() === "" || (index === 0 && line.startsWith("#!")));
}

export type HookState =
  /** No hook file. */
  | "absent"
  /** A hook someone else wrote, without our block. */
  | "foreign"
  /** A hook file that is only our block. */
  | "ours"
  /** Someone else's hook with our block appended. */
  | "shared";

export function hookState(text: string | null): HookState {
  if (text === null) return "absent";
  const range = blockRange(text);
  if (!range) return "foreign";
  return isBare(text.slice(0, range[0]) + text.slice(range[1])) ? "ours" : "shared";
}

/**
 * Why a hook someone else wrote cannot take the block, or null when it can:
 * the block is POSIX sh, so the hook's interpreter must read it.
 */
export function foreignHookProblem(text: string): string | null {
  const first = text.split("\n")[0] ?? "";
  if (!first.startsWith("#!")) return null;
  return /\b(sh|bash|dash|zsh|ksh|ash)\b/.test(first)
    ? null
    : `it runs under ${first.slice(2).trim() || "another interpreter"}, not a shell`;
}

/** True when a hook someone else wrote may exit before an appended block runs. */
export function mayExitEarly(text: string): boolean {
  return /^\s*exit\b/m.test(text);
}

export type HookWrite = "created" | "updated" | "unchanged" | "appended";

/** `text` (null: no file yet) with `block` installed, and what that did. */
export function withBlock(text: string | null, block: string): { text: string; change: HookWrite } {
  if (text === null) return { text: `${SHEBANG}\n${block}\n`, change: "created" };
  const range = blockRange(text);
  if (range) {
    const next = `${text.slice(0, range[0])}${block}\n${text.slice(range[1])}`;
    return { text: next, change: next === text ? "unchanged" : "updated" };
  }
  // One blank line between the hook and the block; `withoutBlock` takes it back out.
  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${text}${separator}${block}\n`, change: "appended" };
}

/**
 * `text` with the block taken out: null when nothing else is left (the file
 * was ours, so it goes), the original hook otherwise.
 */
export function withoutBlock(text: string): string | null {
  const range = blockRange(text);
  if (!range) return text;
  let before = text.slice(0, range[0]);
  const after = text.slice(range[1]);
  if (after === "" && before.endsWith("\n\n")) before = before.slice(0, -1);
  const rest = before + after;
  return isBare(rest) ? null : rest;
}
