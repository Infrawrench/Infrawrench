/**
 * What a list of a commit's checks says: where each one's link goes, and the
 * one line that sums them up. Pure, so the popover on a commit and the
 * branch page's lists agree.
 */
import type { CommitStatus, StatusState } from "@infrawrench/git-contract";
import { paths, type RepoRef } from "./paths";
import { safeLinkUrl } from "./safe-url";

/**
 * Where a check's "Details" goes: the run's page here when Infrawrench CI
 * reported it, else the link the reporter gave, when it is one a page may
 * follow. Null when there is nowhere to go.
 */
export function checkHref(
  repo: RepoRef,
  check: { readonly runId?: string | null; readonly targetUrl: string | null },
): string | null {
  if (check.runId != null) return paths.ciRun(repo, check.runId);
  return safeLinkUrl(check.targetUrl);
}

export interface ChecksSummary {
  /** "3 checks". */
  readonly title: string;
  /** "1 failed, 1 running, 1 passed": only the states that occur, worst first. */
  readonly detail: string;
}

const COUNTED: ReadonlyArray<readonly [StatusState, string]> = [
  ["failure", "failed"],
  ["error", "errored"],
  ["pending", "running"],
  ["success", "passed"],
];

export function summarizeChecks(
  statuses: ReadonlyArray<Pick<CommitStatus, "state">>,
): ChecksSummary {
  const detail = COUNTED.map(([state, word]) => {
    const count = statuses.filter((status) => status.state === state).length;
    return count === 0 ? null : `${count} ${word}`;
  })
    .filter((part): part is string => part !== null)
    .join(", ");
  return {
    title: `${statuses.length} ${statuses.length === 1 ? "check" : "checks"}`,
    detail,
  };
}

const RANK: Record<StatusState, number> = { failure: 0, error: 0, pending: 1, success: 2 };

/** Failures first, then what is still running, then what passed; by name within each. */
export function sortChecks<S extends Pick<CommitStatus, "state" | "context">>(
  statuses: ReadonlyArray<S>,
): S[] {
  return [...statuses].sort(
    (a, b) => RANK[a.state] - RANK[b.state] || a.context.localeCompare(b.context),
  );
}
