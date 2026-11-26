/**
 * What a push may do to which ref. The front Worker reads the rules from
 * Postgres and sends them along with the push; the Durable Object applies
 * them here, because only it knows whether an update is a fast-forward.
 * Pure: no database, no bindings.
 */
import type { ReceiveUpdate } from "@infrawrench/git-protocol";
import { type ProtectedBranchRule, protectionFor } from "../../db/policy-rules";

export interface PushPolicy {
  /** The repository's `git_protected_branches` rows. */
  readonly rules: readonly ProtectedBranchRule[];
  /** The person pushing. Null for a deploy key, an API key or a job. */
  readonly userId: string | null;
  /** The pusher administers the repository. Rules bind them only when `enforceAdmins`. */
  readonly admin: boolean;
  /**
   * Why nothing may be added to this repository right now, when that is so:
   * its owner's private storage is over the plan's quota (server-core
   * `git/quota.ts`, read by the front Worker like the rules). Deleting a ref
   * is still allowed. Absent or null when pushes are welcome.
   */
  readonly quotaRefusal?: string | null;
}

/** Refs the forge writes itself: a pull request's head and merge preview. */
const RESERVED_PREFIXES = ["refs/pull/", "refs/infrawrench/"];

const BRANCH_PREFIX = "refs/heads/";

/** The reason a push may not make this update, or null when it may. */
export function refusal(policy: PushPolicy, update: ReceiveUpdate): string | null {
  if (RESERVED_PREFIXES.some((prefix) => update.name.startsWith(prefix))) {
    return "this ref is managed by the server";
  }
  if (policy.quotaRefusal && update.kind !== "delete") return policy.quotaRefusal;
  if (!update.name.startsWith(BRANCH_PREFIX)) return null;
  const branch = update.name.slice(BRANCH_PREFIX.length);
  const protection = protectionFor(policy.rules, branch);
  if (!protection) return null;
  if (policy.admin && !protection.enforceAdmins) return null;
  if (update.kind === "delete") {
    return protection.allowDeletion ? null : "protected branch: deletion is not allowed";
  }
  if (protection.restrictPushers) {
    if (policy.userId === null || !protection.pusherUserIds.includes(policy.userId)) {
      return "protected branch: you are not allowed to push to it";
    }
  }
  // Reviews and checks happen on a pull request, so requiring either means requiring one.
  if (
    protection.requirePullRequest ||
    protection.requiredApprovals > 0 ||
    protection.requiredStatusContexts.length > 0
  ) {
    return "protected branch: changes must be made through a pull request";
  }
  if (update.forced && !protection.allowForcePush) {
    return "protected branch: force pushes are not allowed";
  }
  return null;
}

export function checkPush(
  policy: PushPolicy,
  updates: readonly ReceiveUpdate[],
): Map<string, string> {
  const refused = new Map<string, string>();
  for (const update of updates) {
    const reason = refusal(policy, update);
    if (reason !== null) refused.set(update.name, reason);
  }
  return refused;
}
