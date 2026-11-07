import { PluginGenError } from "../errors.js";
import { run, type RunResult } from "../process.js";
import { oneLine } from "../text.js";
import type { OpenIssue, OpenPullRequest } from "./decide.js";
import { ISSUE_SEARCH, pluginOfBranch, pluginOfIssueTitle } from "./render.js";

const BASE_BRANCH = "main";

/** Everything the watcher does on GitHub, so that the logic above it can be tested. */
export interface GitHubPort {
  listPullRequests(): Promise<OpenPullRequest[]>;
  listIssues(): Promise<OpenIssue[]>;
  createPullRequest(branch: string, title: string, body: string): Promise<string>;
  editPullRequest(number: number, body: string): Promise<void>;
  closePullRequest(number: number, comment: string): Promise<void>;
  createIssue(title: string, body: string): Promise<string>;
  editIssue(number: number, body: string): Promise<void>;
  closeIssue(number: number, comment: string): Promise<void>;
}

const APP_HINT =
  "Check that the plugingen watcher's GitHub App is installed on this repository with contents, pull requests and issues write access.";

function explain(args: readonly string[], result: RunResult): string {
  const detail = oneLine(result.stderr || result.stdout);
  const denied = /HTTP 40[13]|Resource not accessible|Bad credentials|gh auth login/i.test(detail);
  return `gh ${args[0] ?? ""} ${args[1] ?? ""} failed: ${detail}${denied ? ` ${APP_HINT}` : ""}`;
}

async function gh(args: readonly string[], stdin?: string): Promise<string> {
  const result = await run("gh", args, stdin === undefined ? {} : { stdin }).catch(
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PluginGenError("generator", `gh could not be started: ${detail}`);
    },
  );
  if (result.code !== 0) throw new PluginGenError("generator", explain(args, result));
  return result.stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseList(text: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

const LIST_LIMIT = "1000";

/** Pure, so the filtering (forks, foreign branches, near-miss titles) can be tested. */
export function decodePullRequests(text: string): OpenPullRequest[] {
  const found: OpenPullRequest[] = [];
  for (const row of parseList(text)) {
    const { number, url, body, headRefName, isCrossRepository } = row;
    if (typeof number !== "number" || typeof url !== "string") continue;
    // Anyone can open a pull request from a fork's `plugingen/x`; that one is not ours.
    if (isCrossRepository !== false || typeof headRefName !== "string") continue;
    const plugin = pluginOfBranch(headRefName);
    if (plugin) found.push({ number, url, plugin, body: typeof body === "string" ? body : "" });
  }
  return found;
}

export function decodeIssues(text: string): OpenIssue[] {
  const found: OpenIssue[] = [];
  for (const row of parseList(text)) {
    const { number, title, body } = row;
    if (typeof number !== "number" || typeof title !== "string") continue;
    const plugin = pluginOfIssueTitle(title);
    if (plugin) found.push({ number, plugin, body: typeof body === "string" ? body : "" });
  }
  return found;
}

/**
 * Calls the real `gh`. Bodies travel over stdin and comments are fixed strings of ours.
 * Edits go through REST because `gh pr edit` also queries projects and teams, which a
 * token holding only what this job needs is refused.
 */
export const gitHubCli: GitHubPort = {
  listPullRequests: async () =>
    decodePullRequests(
      await gh([
        "pr",
        "list",
        "--state",
        "open",
        "--base",
        BASE_BRANCH,
        "--limit",
        LIST_LIMIT,
        "--json",
        "number,url,body,headRefName,isCrossRepository",
      ]),
    ),
  listIssues: async () =>
    decodeIssues(
      await gh([
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "bug",
        "--search",
        ISSUE_SEARCH,
        "--limit",
        LIST_LIMIT,
        "--json",
        "number,title,body",
      ]),
    ),
  createPullRequest: async (branch, title, body) =>
    (
      await gh(
        [
          "pr",
          "create",
          "--head",
          branch,
          "--base",
          BASE_BRANCH,
          "--title",
          title,
          "--body-file",
          "-",
        ],
        body,
      )
    ).trim(),
  editPullRequest: async (number, body) => {
    await gh(
      [
        "api",
        "--method",
        "PATCH",
        `repos/{owner}/{repo}/pulls/${number}`,
        "--input",
        "-",
        "--silent",
      ],
      JSON.stringify({ body }),
    );
  },
  closePullRequest: async (number, comment) => {
    await gh(["pr", "close", String(number), "--delete-branch", "--comment", comment]);
  },
  createIssue: async (title, body) =>
    (
      await gh(["issue", "create", "--title", title, "--label", "bug", "--body-file", "-"], body)
    ).trim(),
  editIssue: async (number, body) => {
    await gh(
      [
        "api",
        "--method",
        "PATCH",
        `repos/{owner}/{repo}/issues/${number}`,
        "--input",
        "-",
        "--silent",
      ],
      JSON.stringify({ body }),
    );
  },
  closeIssue: async (number, comment) => {
    await gh(["issue", "close", String(number), "--reason", "completed", "--comment", comment]);
  },
};
