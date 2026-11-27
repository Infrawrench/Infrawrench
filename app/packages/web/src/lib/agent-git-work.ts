/**
 * The branch a link from git.infrawrench.com asks the Agents tab to start a
 * session on: `/org/{orgId}/agents?git={owner}/{repo}&branch={key}`, the key
 * being the branch page's (client-core's `git-branch-key.ts`) ("Start work
 * with Infrawrench").
 *
 * The route reads the two search parameters and leaves them here; the Agents
 * panel (which renders in the workspace viewport, not in the route) shows the
 * work and sends it with the next session it creates. A small store rather
 * than tab state: the work is a one-off hand-over, not something the tab
 * should remember or restore, and the tab's URL drops it once it is taken.
 */
import { useSyncExternalStore } from "react";
import { parseGitBranchKey } from "@infrawrench/client-core";
import type { AgentGitWorkRequest } from "@infrawrench/ui";

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** The server's bound on a key (`AgentGitWork.branch`). */
const MAX_BRANCH_KEY_LENGTH = 512;

export interface AgentsSearch {
  git?: string;
  branch?: string;
}

/**
 * `validateSearch` of `/org/$orgId/agents`: `git` as `owner/repo` and
 * `branch` as a branch page's key. The router reads a value that parses as
 * JSON as JSON, so a branch named `123` or `true` arrives as a number or a
 * boolean and is turned back into its name. Anything else is dropped.
 */
export function validateAgentsSearch(search: Record<string, unknown>): AgentsSearch {
  const out: AgentsSearch = {};
  const git = search["git"];
  if (typeof git === "string") {
    const [owner, repo, ...rest] = git.split("/");
    if (rest.length === 0 && owner && repo && NAME.test(owner) && NAME.test(repo)) out.git = git;
  }
  const raw = search["branch"];
  const branch =
    typeof raw === "string"
      ? raw
      : (typeof raw === "number" && Number.isFinite(raw)) || typeof raw === "boolean"
        ? String(raw)
        : undefined;
  if (
    branch !== undefined &&
    branch.length <= MAX_BRANCH_KEY_LENGTH &&
    parseGitBranchKey(branch) !== null
  ) {
    out.branch = branch;
  }
  return out;
}

/** The work a validated search names, or null when it does not name both halves. */
export function agentGitWorkFromSearch(search: AgentsSearch): AgentGitWorkRequest | null {
  if (!search.git || search.branch === undefined) return null;
  const [owner, repo] = search.git.split("/");
  if (!owner || !repo) return null;
  return { owner, repo, branch: search.branch };
}

interface Pending {
  readonly orgId: string;
  readonly work: AgentGitWorkRequest;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/** Leave the work for the organisation's Agents panel. */
export function setPendingAgentGitWork(orgId: string, work: AgentGitWorkRequest): void {
  const current = pending;
  if (
    current &&
    current.orgId === orgId &&
    current.work.owner === work.owner &&
    current.work.repo === work.repo &&
    current.work.branch === work.branch
  ) {
    return;
  }
  pending = { orgId, work };
  emit();
}

/** The work was started or dismissed. */
export function clearPendingAgentGitWork(): void {
  if (!pending) return;
  pending = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => pending;

/** The work waiting for this organisation's Agents panel, or null. */
export function usePendingAgentGitWork(orgId: string): AgentGitWorkRequest | null {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return current && current.orgId === orgId ? current.work : null;
}
