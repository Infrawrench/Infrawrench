// Git plumbing for `infrawrench env`: where the repository is, whether a path
// is ignored, where hooks live, and reading and writing hook files.
//
// Git runs through `node:child_process` (no new dependencies), always with an
// explicit working directory, and a git that is missing or fails reads as
// "not a repository" rather than an error: every caller has a sensible answer
// for that case. The hook block itself is client-core's `infraenv-hooks.ts`
// (pure text, shared with the npm package's installer); this module only does
// the I/O around it.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

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

export interface GitRepository {
  /** The worktree's top directory, where git runs hooks. */
  readonly root: string;
  /** The hooks directory, absolute. */
  readonly hooksDir: string;
}

/** The repository `dir` is in, or null outside one. */
export async function gitRepository(dir: string): Promise<GitRepository | null> {
  const [root, hooks] = await Promise.all([gitRoot(dir), gitHooksPath(dir)]);
  if (root === null || hooks === null) return null;
  return { root, hooksDir: isAbsolute(hooks) ? hooks : resolve(dir, hooks) };
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
// Hook files
// ---------------------------------------------------------------------------

/** A hook's text, or null when there is no hook file. */
export function readHookFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Write a hook (when `changed`) and make sure it is executable: a new file
 * gets 0755, an existing one keeps its mode plus the execute bits.
 */
export function writeHookFile(path: string, text: string, existed: boolean, changed: boolean) {
  if (changed) writeFileSync(path, text);
  const mode = existed ? statSync(path).mode | 0o111 : 0o755;
  chmodSync(path, mode & 0o7777);
}

/** Replace a hook's text, or delete the file when `text` is null. */
export function replaceHookFile(path: string, text: string | null): void {
  if (text === null) unlinkSync(path);
  else writeFileSync(path, text);
}
