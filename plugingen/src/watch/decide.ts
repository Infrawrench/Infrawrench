import type { CheckReport } from "../check.js";

export interface OpenPullRequest {
  number: number;
  url: string;
  plugin: string;
  body: string;
}

export interface OpenIssue {
  number: number;
  plugin: string;
  body: string;
}

type PullRequestPlan =
  | { kind: "none" }
  | { kind: "open" }
  | { kind: "refresh"; pullRequest: OpenPullRequest }
  | { kind: "close"; pullRequest: OpenPullRequest };

type IssuePlan =
  | { kind: "none" }
  | { kind: "open" }
  | { kind: "update"; issue: OpenIssue }
  | { kind: "close"; issue: OpenIssue };

export interface Plan {
  plugin: string;
  pullRequest: PullRequestPlan;
  issue: IssuePlan;
  /** A failure a retry tomorrow may clear: for the job summary, never an issue. */
  warning?: string;
}

/**
 * What to do about one plugin. Only a plain network failure is treated as no news:
 * nothing is known about the vendor's types today, so an open pull request or issue
 * stays exactly as it is rather than being closed on the strength of an outage.
 */
export function decide(
  report: CheckReport,
  pullRequest: OpenPullRequest | undefined,
  issue: OpenIssue | undefined,
  issueBody: string,
): Plan {
  const { plugin } = report;
  if (report.status === "could-not-check" && report.transient) {
    return {
      plugin,
      pullRequest: { kind: "none" },
      issue: { kind: "none" },
      warning: report.reason,
    };
  }
  if (report.status === "could-not-check") {
    if (!issue) return { plugin, pullRequest: { kind: "none" }, issue: { kind: "open" } };
    return {
      plugin,
      pullRequest: { kind: "none" },
      issue: sameBody(issue.body, issueBody) ? { kind: "none" } : { kind: "update", issue },
    };
  }
  const closeIssue: IssuePlan = issue ? { kind: "close", issue } : { kind: "none" };
  if (report.status === "changed") {
    return {
      plugin,
      pullRequest: pullRequest ? { kind: "refresh", pullRequest } : { kind: "open" },
      issue: closeIssue,
    };
  }
  return {
    plugin,
    pullRequest: pullRequest ? { kind: "close", pullRequest } : { kind: "none" },
    issue: closeIssue,
  };
}

function sameBody(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

export interface RefreshDecision {
  push: boolean;
  editBody: boolean;
}

/**
 * Pushing is decided from the generated files alone. A commit a person added on top of
 * the branch to fix the plugin survives until the vendor's output moves again, and an
 * unchanged output does not restart CI on the pull request every day.
 */
export function decideRefresh(
  branchFiles: ReadonlyMap<string, string> | undefined,
  freshFiles: ReadonlyMap<string, string>,
  currentBody: string,
  freshBody: string,
): RefreshDecision {
  const matches =
    branchFiles !== undefined &&
    [...freshFiles].every(([path, text]) => branchFiles.get(path) === text);
  return { push: !matches, editBody: !sameBody(currentBody, freshBody) };
}
