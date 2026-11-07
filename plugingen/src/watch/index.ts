import type { CheckOutcome } from "../check.js";
import { failureOf } from "../errors.js";
import { generatedPath } from "../output.js";
import { oneLine } from "../text.js";
import { decide, decideRefresh, type Plan } from "./decide.js";
import type { GitPort } from "./git.js";
import type { GitHubPort } from "./github.js";
import {
  branchFor,
  CLOSE_ISSUE_COMMENT,
  CLOSE_PULL_REQUEST_COMMENT,
  COMMIT_MESSAGE,
  issueTitle,
  pullRequestTitle,
  renderIssueBody,
  renderPullRequestBody,
} from "./render.js";
import type { Typecheck } from "./typecheck.js";

export interface WatchPorts {
  github: GitHubPort;
  git: GitPort;
  typecheck: Typecheck;
}

export interface WatchEntry {
  plugin: string;
  status: string;
  /** What was done, or with no `--apply` what would be. */
  actions: string[];
  warning?: string;
  error?: string;
}

function describePlan(plan: Plan, outcome: CheckOutcome): string[] {
  const actions: string[] = [];
  const branch = branchFor(plan.plugin);
  const operations = outcome.report.operations ?? [];
  const affecting =
    operations.length > 0 ? `, ${operations.length} operation(s): ${operations.join(", ")}` : "";
  switch (plan.pullRequest.kind) {
    case "open":
      actions.push(`open a pull request from ${branch}${affecting}`);
      break;
    case "refresh":
      actions.push(
        `update pull request #${plan.pullRequest.pullRequest.number} on ${branch} if its output or description differ${affecting}`,
      );
      break;
    case "close":
      actions.push(
        `close pull request #${plan.pullRequest.pullRequest.number} and delete ${branch}: the output matches main`,
      );
      break;
    case "none":
      break;
  }
  switch (plan.issue.kind) {
    case "open":
      actions.push(`open an issue: "${issueTitle(plan.plugin)}": ${outcome.report.reason}`);
      break;
    case "update":
      actions.push(`update issue #${plan.issue.issue.number}: ${outcome.report.reason}`);
      break;
    case "close":
      actions.push(`close issue #${plan.issue.issue.number}: the check passes`);
      break;
    case "none":
      break;
  }
  return actions;
}

async function applyPlan(plan: Plan, outcome: CheckOutcome, ports: WatchPorts): Promise<string[]> {
  const { report, changedFiles } = outcome;
  const { plugin } = plan;
  const branch = branchFor(plugin);
  const done: string[] = [];
  const files = new Map(
    changedFiles.map((file) => [generatedPath(plugin, file.fileName), file.text]),
  );

  if (plan.pullRequest.kind === "open") {
    const typecheck = await ports.typecheck(plugin, changedFiles);
    await ports.git.pushBranch(branch, files, COMMIT_MESSAGE(plugin));
    const url = await ports.github.createPullRequest(
      branch,
      pullRequestTitle(plugin),
      renderPullRequestBody(report, typecheck),
    );
    done.push(`opened ${url} (typecheck ${typecheck.state})`);
  } else if (plan.pullRequest.kind === "refresh") {
    const { pullRequest } = plan.pullRequest;
    const typecheck = await ports.typecheck(plugin, changedFiles);
    const body = renderPullRequestBody(report, typecheck);
    const branchFiles = await ports.git.readBranchFiles(branch, [...files.keys()]);
    const refresh = decideRefresh(branchFiles, files, pullRequest.body, body);
    if (refresh.push) await ports.git.pushBranch(branch, files, COMMIT_MESSAGE(plugin));
    if (refresh.editBody) await ports.github.editPullRequest(pullRequest.number, body);
    done.push(
      refresh.push || refresh.editBody
        ? `updated ${pullRequest.url} (${refresh.push ? "pushed" : "same output"}, typecheck ${typecheck.state})`
        : `${pullRequest.url} is already current`,
    );
  } else if (plan.pullRequest.kind === "close") {
    const { pullRequest } = plan.pullRequest;
    await ports.github.closePullRequest(pullRequest.number, CLOSE_PULL_REQUEST_COMMENT);
    done.push(`closed ${pullRequest.url}`);
  }

  if (plan.issue.kind === "open") {
    const url = await ports.github.createIssue(issueTitle(plugin), renderIssueBody(report));
    done.push(`opened ${url}`);
  } else if (plan.issue.kind === "update") {
    await ports.github.editIssue(plan.issue.issue.number, renderIssueBody(report));
    done.push(`updated issue #${plan.issue.issue.number}`);
  } else if (plan.issue.kind === "close") {
    await ports.github.closeIssue(plan.issue.issue.number, CLOSE_ISSUE_COMMENT);
    done.push(`closed issue #${plan.issue.issue.number}`);
  }
  return done;
}

/**
 * One plugin's failure to act never stops the rest. In series: type checks are heavy and
 * rewrite files, and a burst of writes is what GitHub's secondary rate limit punishes.
 */
export async function runWatch(
  outcomes: readonly CheckOutcome[],
  ports: WatchPorts,
  options: { apply: boolean },
): Promise<WatchEntry[]> {
  const [pullRequests, issues] = await Promise.all([
    ports.github.listPullRequests(),
    ports.github.listIssues(),
  ]);
  const entries: WatchEntry[] = [];
  for (const outcome of outcomes) {
    const { report } = outcome;
    const pullRequest = pullRequests.find((candidate) => candidate.plugin === report.plugin);
    const issue = issues
      .filter((candidate) => candidate.plugin === report.plugin)
      .sort((a, b) => a.number - b.number)[0];
    const plan = decide(report, pullRequest, issue, renderIssueBody(report));
    const entry: WatchEntry = {
      plugin: report.plugin,
      status: report.status,
      actions: options.apply ? [] : describePlan(plan, outcome),
      ...(plan.warning ? { warning: oneLine(plan.warning) } : {}),
    };
    if (options.apply) {
      try {
        entry.actions = await applyPlan(plan, outcome, ports);
      } catch (error) {
        entry.error = oneLine(failureOf(error).message, 1000);
      }
    }
    entries.push(entry);
  }
  return entries;
}

export function renderSummary(entries: readonly WatchEntry[], apply: boolean): string {
  const cell = (text: string): string => oneLine(text, 400).replaceAll("|", "\\|");
  const rows = entries.map((entry) => {
    const notes = [
      ...entry.actions,
      ...(entry.warning ? [`warning: ${entry.warning}`] : []),
      ...(entry.error ? [`error: ${entry.error}`] : []),
    ];
    return `| ${entry.plugin} | ${entry.status} | ${notes.map(cell).join("<br>") || "nothing to do"} |`;
  });
  return [
    `### plugingen watch${apply ? "" : " (dry run)"}`,
    "",
    "| Plugin | Check | Actions |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
