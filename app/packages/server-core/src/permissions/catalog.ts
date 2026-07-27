/**
 * Permission strings used throughout the app. Hierarchical, colon-separated.
 * Wildcards (`*`) may appear at any segment of a granted permission.
 *
 * Match rule (see {@link hasPermission}): split both granted and required on
 * `:`. A granted entry matches if every segment equals the required segment
 * or is `*`. A bare `*` (length 1) matches everything.
 */
export const ALL_PERMISSIONS = [
  "accounts:read",
  "accounts:write",
  "accounts:delete",
  "resources:read",
  "resources:write",
  "resources:delete",
  "resources:execute",
  "secrets:read",
  "secrets:write",
  "storage:read",
  "storage:write",
  "dashboards:read",
  "dashboards:write",
  "costs:read",
  "costs:write",
  "budgets:read",
  "budgets:write",
  "audit:read",
  "team:read",
  "team:invite",
  "team:role:write",
  "team:remove",
  "apikeys:read",
  "apikeys:write",
  "billing:read",
  "billing:write",
  "ssh-keys:read",
  "ssh-keys:write",
  "bastions:read",
  "bastions:write",
  "chat:read",
  "chat:write",
  "pages:write",
  "org:settings:write",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number] | (string & {});

export function hasPermission(granted: readonly string[], required: string): boolean {
  if (!granted || granted.length === 0) return false;
  const requiredParts = required.split(":");
  for (const entry of granted) {
    if (entry === "*") return true;
    const grantedParts = entry.split(":");
    if (grantedParts.length !== requiredParts.length) continue;
    let ok = true;
    for (let i = 0; i < grantedParts.length; i++) {
      const g = grantedParts[i];
      if (g !== "*" && g !== requiredParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Expand a wildcard permission entry against the full catalog. `*` expands to
 * every permission; `team:*` expands to every permission starting with `team:`
 * (matching segment-by-segment). Non-wildcard entries pass through unchanged
 * (even if not in the catalog — unknown strings are simply themselves).
 *
 * Exported for {@link intersectPermissions}.
 */
export function expandPermission(entry: string): string[] {
  if (entry === "*") return [...ALL_PERMISSIONS];
  if (!entry.includes("*")) return [entry];
  const entryParts = entry.split(":");
  const matches: string[] = [];
  for (const perm of ALL_PERMISSIONS) {
    const permParts = perm.split(":");
    if (permParts.length !== entryParts.length) continue;
    let ok = true;
    for (let i = 0; i < entryParts.length; i++) {
      const e = entryParts[i];
      if (e !== "*" && e !== permParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(perm);
  }
  return matches;
}

/**
 * Narrow `base` by `limit`, returning the concrete permissions implied by both.
 * Wildcards on either side are expanded against the catalog first, so
 * `intersect(["*"], ["resources:*"])` yields every `resources:` permission.
 *
 * Used to confine an API key to its stored scopes: the key's holder can never
 * exceed the scopes it was minted with, nor the permissions of the role the
 * owning user currently has — whichever is narrower wins on each entry.
 */
export function intersectPermissions(base: readonly string[], limit: readonly string[]): string[] {
  const allowed = new Set(limit.flatMap((entry) => expandPermission(entry)));
  const out: string[] = [];
  for (const entry of base) {
    for (const permission of expandPermission(entry)) {
      if (allowed.has(permission) && !out.includes(permission)) out.push(permission);
    }
  }
  return out;
}

/**
 * Returns true if every permission implied by `target` is also implied by
 * `caller`. Handles wildcards on both sides: `target=["*"]` requires the caller
 * to also hold `*` (or the full catalog); `target=["team:*"]` requires the
 * caller to hold every `team:*` permission. Used to enforce the "you can only
 * grant permissions you already have" rule on role creation/edit/assignment.
 */
export function isSubsetOfCallerPerms(
  target: readonly string[],
  caller: readonly string[],
): boolean {
  if (!target || target.length === 0) return true;
  // Fast path: caller has full wildcard.
  if (caller.includes("*")) return true;
  for (const entry of target) {
    const expanded = expandPermission(entry);
    for (const required of expanded) {
      if (!hasPermission(caller, required)) return false;
    }
  }
  return true;
}
