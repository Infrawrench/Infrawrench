/**
 * The git hooks that keep a working copy's `.env` in step with `.infraenv`.
 *
 * Two installers write them: the desktop CLI (`infrawrench env hooks`) and
 * the npm package (`@infrawrench/infraenv`, Husky style, from a `prepare`
 * script). Both write exactly this block, so either recognises, updates and
 * removes the other's, and the block itself prefers whichever puller is
 * cheapest to start:
 *
 * 1. the project's own `node_modules/.bin/infraenv` (plain Node, no Electron),
 * 2. an `infraenv` on PATH,
 * 3. `infrawrench env pull` (the desktop app's CLI, which boots Electron).
 *
 * The block decides in `sh` whether there is anything to do before starting
 * any of them: it pulls only when the `.infraenv` differs between the two
 * commits the hook is about, or when the output file is missing. A checkout
 * that does not touch the file costs one `git diff --quiet`. When it does
 * pull, it pulls in the background (output to `<git dir>/infraenv.log`) so
 * the git command returns at once; `INFRAENV_HOOK_FOREGROUND=1` waits instead.
 * Nothing in it can fail the git command.
 *
 * Everything here is pure text in and text out; the installers do the I/O.
 */

/** The hooks installed, in the order `status` lists them. */
export const INFRAENV_HOOKS = [
  "post-checkout",
  "post-merge",
  "post-rewrite",
  "post-commit",
] as const;
export type InfraenvHook = (typeof INFRAENV_HOOKS)[number];

export const INFRAENV_HOOK_BEGIN = "# >>> infrawrench env >>>";
export const INFRAENV_HOOK_END = "# <<< infrawrench env <<<";

/** The log a background pull writes, in the repository's git directory. */
export const INFRAENV_HOOK_LOG = "infraenv.log";

const SHEBANG = "#!/bin/sh";

/** `value` as one single-quoted sh word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The two commits a hook compares, as sh expressions, and when it runs at all.
 * post-checkout: a branch checkout only (`$3 = 1`), `$1` to `$2`. post-merge
 * and a rebase's post-rewrite: `ORIG_HEAD` to `HEAD` (not an amend: the
 * commit hook covers that). post-commit: the new commit against its parent,
 * or always on a first commit.
 */
const HOOK_RANGE: Record<InfraenvHook, { when: string; from: string; to: string }> = {
  "post-checkout": { when: '[ "$3" = "1" ]', from: '"$1"', to: '"$2"' },
  "post-merge": { when: "true", from: "ORIG_HEAD", to: "HEAD" },
  "post-rewrite": { when: '[ "$1" = "rebase" ]', from: "ORIG_HEAD", to: "HEAD" },
  "post-commit": { when: "true", from: "HEAD~1", to: "HEAD" },
};

export interface InfraenvHookOptions {
  /** The `.infraenv` path relative to the repository root, where git runs hooks. */
  readonly file: string;
  /** The output path relative to the repository root (for the "missing" check). */
  readonly output: string;
}

/**
 * The managed block for one hook. Its body is the same for every installer;
 * only the paths differ.
 */
export function infraenvHookBlock(hook: InfraenvHook, options: InfraenvHookOptions): string {
  const file = shellQuote(options.file);
  const output = shellQuote(options.output);
  const range = HOOK_RANGE[hook];
  const when = range.when === "true" ? "" : `${range.when} && `;
  return [
    INFRAENV_HOOK_BEGIN,
    "# Regenerates .env from .infraenv when a commit changes it. Managed by",
    "# `infraenv install` or `infrawrench env hooks`; their uninstall removes it.",
    `if ${when}[ -f ${file} ]; then`,
    `  if [ ! -f ${output} ] || ! git rev-parse -q --verify ${range.from} >/dev/null 2>&1 || ! git diff --quiet ${range.from} ${range.to} -- ${file} 2>/dev/null; then`,
    "    iw_env_pull() {",
    "      if [ -x node_modules/.bin/infraenv ]; then",
    `        node_modules/.bin/infraenv pull --quiet -f ${file}`,
    "      elif command -v infraenv >/dev/null 2>&1; then",
    `        infraenv pull --quiet -f ${file}`,
    "      elif command -v infrawrench >/dev/null 2>&1; then",
    `        infrawrench env pull --quiet -f ${file}`,
    "      fi",
    "    }",
    '    if [ -n "$INFRAENV_HOOK_FOREGROUND" ]; then',
    "      iw_env_pull || true",
    "    else",
    `      iw_env_log="$(git rev-parse --git-dir 2>/dev/null)/${INFRAENV_HOOK_LOG}"`,
    '      (iw_env_pull </dev/null >"$iw_env_log" 2>&1 &) || true',
    "    fi",
    "  fi",
    "fi",
    INFRAENV_HOOK_END,
  ].join("\n");
}

/** Where the managed block sits in a hook's text: [start, end) including its newline. */
function blockRange(text: string): [number, number] | null {
  const begin = text.search(/^# >>> infrawrench env >>>$/m);
  if (begin < 0) return null;
  const endMarker = text.indexOf(INFRAENV_HOOK_END, begin);
  if (endMarker < 0) return null;
  let end = endMarker + INFRAENV_HOOK_END.length;
  if (text[end] === "\n") end++;
  return [begin, end];
}

/** A hook file holding nothing but a shebang and blank lines once the block is out. */
function isBare(text: string): boolean {
  return text
    .split("\n")
    .every((line, index) => line.trim() === "" || (index === 0 && line.startsWith("#!")));
}

export type InfraenvHookState =
  /** No hook file. */
  | "absent"
  /** A hook someone else wrote, without our block. */
  | "foreign"
  /** A hook file that is only our block. */
  | "ours"
  /** Someone else's hook with our block appended. */
  | "shared";

export function infraenvHookState(text: string | null): InfraenvHookState {
  if (text === null) return "absent";
  const range = blockRange(text);
  if (!range) return "foreign";
  return isBare(text.slice(0, range[0]) + text.slice(range[1])) ? "ours" : "shared";
}

/**
 * Why a hook someone else wrote cannot take the block, or null when it can:
 * the block is POSIX sh, so the hook's interpreter must read it.
 */
export function infraenvForeignHookProblem(text: string): string | null {
  const first = text.split("\n")[0] ?? "";
  if (!first.startsWith("#!")) return null;
  return /\b(sh|bash|dash|zsh|ksh|ash)\b/.test(first)
    ? null
    : `it runs under ${first.slice(2).trim() || "another interpreter"}, not a shell`;
}

/** True when a hook someone else wrote may exit before an appended block runs. */
export function infraenvHookMayExitEarly(text: string): boolean {
  return /^\s*exit\b/m.test(text);
}

export type InfraenvHookWrite = "created" | "updated" | "unchanged" | "appended";

/** `text` (null: no file yet) with `block` installed, and what that did. */
export function withInfraenvHook(
  text: string | null,
  block: string,
): { text: string; change: InfraenvHookWrite } {
  if (text === null) return { text: `${SHEBANG}\n${block}\n`, change: "created" };
  const range = blockRange(text);
  if (range) {
    const next = `${text.slice(0, range[0])}${block}\n${text.slice(range[1])}`;
    return { text: next, change: next === text ? "unchanged" : "updated" };
  }
  // One blank line between the hook and the block; `withoutInfraenvHook` takes it back out.
  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${text}${separator}${block}\n`, change: "appended" };
}

/**
 * `text` with the block taken out: null when nothing else is left (the file
 * was ours, so it goes), the original hook otherwise.
 */
export function withoutInfraenvHook(text: string): string | null {
  const range = blockRange(text);
  if (!range) return text;
  let before = text.slice(0, range[0]);
  const after = text.slice(range[1]);
  if (after === "" && before.endsWith("\n\n")) before = before.slice(0, -1);
  const rest = before + after;
  return isBare(rest) ? null : rest;
}
