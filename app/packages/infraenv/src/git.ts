/**
 * Git plumbing: where the repository is, where its hooks live, and whether a
 * path is ignored. Git runs through `node:child_process` with an explicit
 * working directory; a git that is missing or fails reads as "not a
 * repository", which every caller has an answer for.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

interface GitResult {
  /** Exit code; -1 when git could not be run at all. */
  readonly code: number;
  readonly stdout: string;
}

function git(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((done) => {
    execFile("git", [...args], { cwd, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (!error) return done({ code: 0, stdout });
      done({ code: typeof error.code === "number" ? error.code : -1, stdout: stdout ?? "" });
    });
  });
}

/** The worktree's top directory (a real path), or null outside a repository. */
export async function gitRoot(cwd: string): Promise<string | null> {
  const result = await git(["rev-parse", "--show-toplevel"], cwd);
  const root = result.stdout.trim();
  return result.code === 0 && root !== "" ? realpathOr(resolve(cwd, root)) : null;
}

/**
 * The directory git runs hooks from, as git resolves it (`core.hooksPath`
 * honoured), absolute; null outside a repository.
 */
export async function gitHooksDir(cwd: string): Promise<string | null> {
  const result = await git(["rev-parse", "--git-path", "hooks"], cwd);
  const path = result.stdout.trim();
  if (result.code !== 0 || path === "") return null;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export type IgnoreState = "ignored" | "not-ignored" | "no-repo";

/** Whether git would ignore `path` (which need not exist; its directory must). */
export async function ignoreState(path: string): Promise<IgnoreState> {
  const result = await git(["check-ignore", "-q", "--", basename(path)], dirname(path));
  if (result.code === 0) return "ignored";
  if (result.code === 1) return "not-ignored";
  return "no-repo";
}

export function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
