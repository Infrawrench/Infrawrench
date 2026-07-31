/**
 * The viewer's effective permissions in an organization, for Bearer hosts.
 *
 * Server contract: `GET /api/org/:orgId/team/me` (web `api/routes/team.ts`),
 * which every member may call — it reports the caller's own role and the
 * permission strings that role resolves to.
 *
 * The matcher below mirrors `hasPermission` in server-core's permission
 * catalog **by value, not by import**: server-core is a Node package (Drizzle,
 * `pg`, `node:crypto`) that a React Native bundle cannot load, and the web app
 * imports the original directly. The rule it implements is small and frozen —
 * split both sides on `:`, every granted segment must equal the required one or
 * be `*`, and a bare `*` matches everything — so keeping a copy here is
 * cheaper than making mobile depend on the server. If the rule ever changes,
 * both copies change together; `__tests__/permissions.test.ts` pins the
 * semantics on this side.
 *
 * Client-side permission checks are a UI affordance only. Every route enforces
 * its own permission server-side, so a stale or spoofed answer here can hide a
 * button but cannot grant anything.
 */
import type { CloudFetch } from "./fetch";

export interface OrgRoleSummary {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  systemKey: string | null;
}

/** Shape of `GET /api/org/:orgId/team/me`. */
export interface OrgMembership {
  userId: string;
  email: string | null;
  role: OrgRoleSummary | null;
  permissions: string[];
}

const EMPTY_MEMBERSHIP: OrgMembership = {
  userId: "",
  email: null,
  role: null,
  permissions: [],
};

/**
 * Does `granted` satisfy `required`? Wildcards may appear at any segment of a
 * granted entry (`team:*`), and a bare `*` grants everything.
 */
export function hasPermission(granted: readonly string[] | undefined, required: string): boolean {
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

export async function fetchOrgPermissions(api: CloudFetch, orgId: string): Promise<OrgMembership> {
  return (await api.org<OrgMembership>(orgId, "/team/me")) ?? EMPTY_MEMBERSHIP;
}
