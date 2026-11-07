import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginGenError } from "../errors.js";
import { run } from "../process.js";
import { oneLine } from "../text.js";

export interface GitPort {
  /** The named files on the branch, or `undefined` if there is no such branch. */
  readBranchFiles(
    branch: string,
    paths: readonly string[],
  ): Promise<Map<string, string> | undefined>;
  /** Replace the branch with one commit on top of the current HEAD. */
  pushBranch(branch: string, files: ReadonlyMap<string, string>, message: string): Promise<void>;
}

/** Never wait on a terminal: a push without credentials has to fail, not hang. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

const AUTHOR = {
  GIT_AUTHOR_NAME: "infrawrench-sdk-bot",
  GIT_AUTHOR_EMAIL: "noreply@infrawrench.com",
  GIT_COMMITTER_NAME: "infrawrench-sdk-bot",
  GIT_COMMITTER_EMAIL: "noreply@infrawrench.com",
};

/** The token stays in the environment: not on a command line, not in `.git/config`. */
const CREDENTIALS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
const WORKFLOW_REFUSAL = /refusing to allow a GitHub App to create or update workflow/i;

/**
 * Commits are built with plumbing and a throwaway index, so the working tree and HEAD
 * never move: one run handles many plugins, and no hook or checkout state is involved.
 */
export function createGitPort(root: string, remote = "origin"): GitPort {
  const git = async (
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; stdin?: string; allowFailure?: boolean } = {},
  ): Promise<{ code: number; stdout: string }> => {
    const result = await run("git", args, {
      cwd: root,
      env: { ...process.env, ...NO_PROMPT, ...options.env },
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });
    if (result.code !== 0 && !options.allowFailure) {
      throw new PluginGenError(
        "generator",
        `git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""} failed: ${oneLine(result.stderr)}`,
      );
    }
    return result;
  };

  const fetchTip = async (branch: string, depth: number): Promise<string> => {
    const ref = `refs/plugingen-watch/${branch}`;
    await git([
      ...CREDENTIALS,
      "fetch",
      "--no-tags",
      `--depth=${depth}`,
      remote,
      `+refs/heads/${branch}:${ref}`,
    ]);
    return ref;
  };

  const commitOn = async (
    parent: string,
    files: ReadonlyMap<string, string>,
    message: string,
  ): Promise<string> => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plugingen-index-"));
    const env = { GIT_INDEX_FILE: path.join(directory, "index") };
    try {
      await git(["read-tree", parent], { env });
      for (const [file, text] of files) {
        const blob = (await git(["hash-object", "-w", "--stdin"], { stdin: text })).stdout.trim();
        await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env });
      }
      const tree = (await git(["write-tree"], { env })).stdout.trim();
      const commit = await git(["commit-tree", tree, "-p", parent, "-m", message], { env: AUTHOR });
      return commit.stdout.trim();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };

  const push = (commit: string, branch: string) =>
    run("git", [...CREDENTIALS, "push", "--force", remote, `${commit}:refs/heads/${branch}`], {
      cwd: root,
      env: { ...process.env, ...NO_PROMPT },
    });

  return {
    async readBranchFiles(branch, paths) {
      const listed = await git([
        ...CREDENTIALS,
        "ls-remote",
        "--heads",
        remote,
        `refs/heads/${branch}`,
      ]);
      if (listed.stdout.trim() === "") return undefined;
      const ref = await fetchTip(branch, 1);
      const files = new Map<string, string>();
      for (const file of paths) {
        const shown = await git(["show", `${ref}:${file}`], { allowFailure: true });
        if (shown.code === 0) files.set(file, shown.stdout);
      }
      return files;
    },

    async pushBranch(branch, files, message) {
      const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
      const first = await push(await commitOn(head, files, message), branch);
      if (first.code === 0) return;
      if (!WORKFLOW_REFUSAL.test(first.stderr)) {
        throw new PluginGenError("generator", `git push failed: ${oneLine(first.stderr)}`);
      }
      // `main` changed a workflow since the branch was cut, so moving the branch to it
      // reads as this token editing a workflow, a permission it deliberately lacks.
      // Stay on the branch's old base: the change is only ever the generated files, and
      // the pull request's own CI runs on the merge with `main` either way.
      const ref = await fetchTip(branch, 2);
      const parent = (await git(["rev-parse", `${ref}^`])).stdout.trim();
      const second = await push(await commitOn(parent, files, message), branch);
      if (second.code !== 0) {
        throw new PluginGenError("generator", `git push failed: ${oneLine(second.stderr)}`);
      }
    },
  };
}
