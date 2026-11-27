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

/** Deleting a branch, for a target whose API does not do it when it closes something. */
export interface BranchRemover {
  /** Delete the branch on the remote. Nothing happens when it is not there. */
  deleteBranch(branch: string): Promise<void>;
}

export interface GitPortOptions {
  /** The `-c` arguments that give `git` its credentials. GitHub's, through `gh`, by default. */
  credentials?: readonly string[];
  /** Throws for a branch this port must not touch. Every branch is accepted by default. */
  checkBranch?: (branch: string) => void;
  /** Values that must never appear in an error, whatever `git` or the remote printed. */
  secrets?: readonly string[];
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
const GITHUB_CREDENTIALS = [
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
];
const WORKFLOW_REFUSAL = /refusing to allow a GitHub App to create or update workflow/i;

/**
 * Commits are built with plumbing and a throwaway index, so the working tree and HEAD
 * never move: one run handles many plugins, and no hook or checkout state is involved.
 * `remote` is a remote's name or a URL; either way nothing is written to `.git/config`.
 */
export function createGitPort(
  root: string,
  remote = "origin",
  options: GitPortOptions = {},
): GitPort & BranchRemover {
  const credentials = options.credentials ?? GITHUB_CREDENTIALS;
  const checkBranch = options.checkBranch ?? (() => {});
  const secrets = (options.secrets ?? []).filter((secret) => secret !== "");
  /** What `git` printed, on one line, with no credential in it. */
  const said = (text: string): string =>
    oneLine(secrets.reduce((clean, secret) => clean.replaceAll(secret, "***"), text));

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
        `git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""} failed: ${said(result.stderr)}`,
      );
    }
    return result;
  };

  const fetchTip = async (branch: string, depth: number): Promise<string> => {
    const ref = `refs/plugingen-watch/${branch}`;
    await git([
      ...credentials,
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

  /** One ref and no other: `source` is a commit, or empty to delete the branch. */
  const push = (source: string, branch: string) =>
    run("git", [...credentials, "push", "--force", remote, `${source}:refs/heads/${branch}`], {
      cwd: root,
      env: { ...process.env, ...NO_PROMPT },
    });

  const exists = async (branch: string): Promise<boolean> => {
    const listed = await git([
      ...credentials,
      "ls-remote",
      "--heads",
      remote,
      `refs/heads/${branch}`,
    ]);
    return listed.stdout.trim() !== "";
  };

  return {
    async readBranchFiles(branch, paths) {
      checkBranch(branch);
      if (!(await exists(branch))) return undefined;
      const ref = await fetchTip(branch, 1);
      const files = new Map<string, string>();
      for (const file of paths) {
        const shown = await git(["show", `${ref}:${file}`], { allowFailure: true });
        if (shown.code === 0) files.set(file, shown.stdout);
      }
      return files;
    },

    async pushBranch(branch, files, message) {
      checkBranch(branch);
      const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
      const first = await push(await commitOn(head, files, message), branch);
      if (first.code === 0) return;
      if (!WORKFLOW_REFUSAL.test(first.stderr)) {
        throw new PluginGenError("generator", `git push failed: ${said(first.stderr)}`);
      }
      // `main` changed a workflow since the branch was cut, so moving the branch to it
      // reads as this token editing a workflow, a permission it deliberately lacks.
      // Stay on the branch's old base: the change is only ever the generated files, and
      // the pull request's own CI runs on the merge with `main` either way.
      const ref = await fetchTip(branch, 2);
      const parent = (await git(["rev-parse", `${ref}^`])).stdout.trim();
      const second = await push(await commitOn(parent, files, message), branch);
      if (second.code !== 0) {
        throw new PluginGenError("generator", `git push failed: ${said(second.stderr)}`);
      }
    },

    async deleteBranch(branch) {
      checkBranch(branch);
      // Deleting a ref the remote does not have is an error to `git`, and not one here.
      if (!(await exists(branch))) return;
      const deleted = await push("", branch);
      if (deleted.code !== 0) {
        throw new PluginGenError("generator", `git push failed: ${said(deleted.stderr)}`);
      }
    },
  };
}
