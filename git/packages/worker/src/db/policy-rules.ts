/**
 * The rules of protected branches and commit statuses that need no database:
 * which rule matches a branch, what several rules add up to, and what several
 * statuses add up to. Pure, so the push hook, merge and the tests all read
 * the same answers.
 */
import type { GitStatusState } from "@infrawrench/server-core/db/schema";

/** The settings of a `git_protected_branches` row the rules read. */
export interface ProtectedBranchRule {
  readonly pattern: string;
  readonly requirePullRequest: boolean;
  readonly requiredApprovals: number;
  readonly dismissStaleApprovals: boolean;
  readonly requiredStatusContexts: readonly string[];
  readonly allowForcePush: boolean;
  readonly allowDeletion: boolean;
  readonly restrictPushers: boolean;
  readonly pusherUserIds: readonly string[];
  readonly enforceAdmins: boolean;
}

/**
 * Whether a rule's pattern matches a branch name. `*` matches within a path
 * segment, `**` across segments; everything else is literal.
 */
export const matchesBranchPattern = (pattern: string, branch: string): boolean => {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else {
      source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`).test(branch);
};

/** What applies to a branch once every matching rule is combined. */
export interface BranchProtection {
  /** The patterns that matched, most specific (longest) first. */
  readonly patterns: readonly string[];
  readonly requirePullRequest: boolean;
  readonly requiredApprovals: number;
  readonly dismissStaleApprovals: boolean;
  readonly requiredStatusContexts: readonly string[];
  readonly allowForcePush: boolean;
  readonly allowDeletion: boolean;
  readonly restrictPushers: boolean;
  readonly pusherUserIds: readonly string[];
  readonly enforceAdmins: boolean;
}

/**
 * The protection of a branch: null when no rule matches, otherwise the
 * strictest of each setting across the rules that do. Requirements add up
 * (the higher approval count, every required context); permissions must be
 * granted by every rule (force push only if all allow it; a pusher must be
 * listed by every rule that restricts).
 */
export const protectionFor = (
  rules: readonly ProtectedBranchRule[],
  branch: string,
): BranchProtection | null => {
  const matching = rules
    .filter((rule) => matchesBranchPattern(rule.pattern, branch))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  if (matching.length === 0) return null;
  const restricting = matching.filter((rule) => rule.restrictPushers);
  return {
    patterns: matching.map((rule) => rule.pattern),
    requirePullRequest: matching.some((rule) => rule.requirePullRequest),
    requiredApprovals: Math.max(...matching.map((rule) => rule.requiredApprovals)),
    dismissStaleApprovals: matching.some((rule) => rule.dismissStaleApprovals),
    requiredStatusContexts: [...new Set(matching.flatMap((rule) => rule.requiredStatusContexts))],
    allowForcePush: matching.every((rule) => rule.allowForcePush),
    allowDeletion: matching.every((rule) => rule.allowDeletion),
    restrictPushers: restricting.length > 0,
    pusherUserIds:
      restricting.length === 0
        ? []
        : restricting
            .map((rule) => rule.pusherUserIds)
            .reduce((allowed, ids) => allowed.filter((id) => ids.includes(id))),
    enforceAdmins: matching.some((rule) => rule.enforceAdmins),
  };
};

/**
 * What a set of statuses adds up to: `failure` if any failed or errored,
 * else `pending` if any is pending, else `success`. Null for none.
 */
export const combinedState = (states: readonly GitStatusState[]): GitStatusState | null => {
  if (states.length === 0) return null;
  if (states.some((state) => state === "failure" || state === "error")) return "failure";
  if (states.some((state) => state === "pending")) return "pending";
  return "success";
};
