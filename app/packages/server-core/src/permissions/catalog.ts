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
