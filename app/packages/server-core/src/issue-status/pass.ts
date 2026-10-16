/**
 * The poll half of issue status sync: the fallback for every link whose
 * tracker has no webhook set up, and the safety net for the ones that do (a
 * webhook an admin deleted, a delivery that never arrived).
 *
 * Each tick claims a bounded batch of due links per tracker across all orgs
 * (`claimDue*Links`: never checked, an unfinished issue not checked for 30
 * minutes, a finished one not checked for a day), groups them by org and reads
 * them in the tracker's batch shape: Jira bulkfetch (100 per call), Linear one
 * `issues(filter: {id: {in}})` query, GitHub one request per issue (so GitHub
 * gets the smallest batch). A tracker failure for one org (revoked token,
 * missing permission) is logged and leaves that org's links stamped, so a
 * broken integration costs one attempt per interval rather than one per tick.
 */
import {
  claimDueGithubLinks,
  claimDueJiraLinks,
  claimDueLinearLinks,
  syncGithubLinks,
  syncJiraLinks,
  syncLinearLinks,
} from "./sync";

export interface IssueStatusPassLimits {
  jira?: number;
  linear?: number;
  github?: number;
}

export interface IssueStatusPassResult {
  checked: number;
  changed: number;
  failedOrgs: number;
}

function byOrg<T extends { organizationId: string }>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(row.organizationId);
    if (list) list.push(row);
    else groups.set(row.organizationId, [row]);
  }
  return groups;
}

async function runGroups<T extends { organizationId: string }>(
  label: string,
  rows: readonly T[],
  sync: (organizationId: string, rows: T[]) => Promise<{ checked: number; changed: number }>,
  result: IssueStatusPassResult,
): Promise<void> {
  for (const [organizationId, group] of byOrg(rows)) {
    try {
      const r = await sync(organizationId, group);
      result.checked += r.checked;
      result.changed += r.changed;
    } catch (err) {
      result.failedOrgs += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[issue-status] ${label} sync failed for org ${organizationId}: ${message}`);
    }
  }
}

/** One tick of the poll. Never throws past a claim failure (the caller guards that). */
export async function runIssueStatusPass(
  limits: IssueStatusPassLimits = {},
): Promise<IssueStatusPassResult> {
  const result: IssueStatusPassResult = { checked: 0, changed: 0, failedOrgs: 0 };
  await runGroups("Jira", await claimDueJiraLinks(limits.jira ?? 200), syncJiraLinks, result);
  await runGroups(
    "Linear",
    await claimDueLinearLinks(limits.linear ?? 200),
    syncLinearLinks,
    result,
  );
  await runGroups(
    "GitHub",
    await claimDueGithubLinks(limits.github ?? 40),
    syncGithubLinks,
    result,
  );
  return result;
}

/** How often the pass runs at most. The per-link intervals do the real pacing. */
export const ISSUE_STATUS_PASS_INTERVAL_MS = 5 * 60_000;
