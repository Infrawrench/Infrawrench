/**
 * A person's effective permissions in an Infrawrench organisation, from the
 * rows that decide them. Pure: `db/organizations.ts` reads the rows.
 *
 * This is the app's rule (`server-core/src/permissions/resolver.ts`
 * `resolveEffectivePermissions`), restated rather than imported. The resolver
 * reaches break-glass's request and notification code, and through it most
 * of the server (Slack, email, the SSH client and its native addons), which
 * a Worker that serves `git clone` cannot carry. What it decides is small and
 * is all here, built from the same parts: the system roles' permission sets
 * come from server-core's `system-roles.ts`, and a grant is live by the same
 * test as `isGrantLive` in `access/break-glass.ts`.
 *
 * **If the app's resolver changes what a role or a grant means, this file
 * changes with it.** Its tests pin each rule by name.
 */
import {
  isSystemRoleKey,
  systemRolePermissions,
} from "@infrawrench/server-core/permissions/system-roles";

/** The `organization_members` row, as much as the rule reads. Null for a non-member. */
export interface MembershipFacts {
  readonly roleId: string | null;
  /** The legacy text role column, kept as a fallback while `roleId` is backfilled. */
  readonly legacyRole: string | null;
}

/** The `roles` row the membership points at, when it exists. */
export interface RoleFacts {
  readonly isSystem: boolean;
  readonly systemKey: string | null;
  readonly permissions: readonly string[] | null;
}

/** An `access_requests` row: a break-glass grant, live or not. */
export interface GrantFacts {
  readonly status: string;
  readonly revokedAt: Date | null;
  readonly grantedAt: Date | null;
  readonly grantExpiresAt: Date | null;
  readonly permissions: readonly string[] | null;
}

/** A role's permissions: a system role's come from code, a custom role's are its stored list. */
export const rolePermissions = (role: RoleFacts): readonly string[] => {
  if (role.isSystem && isSystemRoleKey(role.systemKey)) {
    return systemRolePermissions(role.systemKey) ?? [];
  }
  return role.permissions ?? [];
};

/** Whether a grant is granting permissions at `now`. */
export const isGrantLive = (grant: GrantFacts, now: number): boolean => {
  if (grant.status !== "approved") return false;
  if (grant.revokedAt) return false;
  if (!grant.grantedAt || !grant.grantExpiresAt) return false;
  return grant.grantedAt.getTime() <= now && now < grant.grantExpiresAt.getTime();
};

/**
 * The effective permissions: the role's, union every live grant's.
 *
 * - A non-member has none, whatever grants exist: a grant is scoped to a
 *   membership.
 * - A membership whose role row is missing falls back to the legacy text
 *   role when that names a system role, and to nothing otherwise.
 */
export const effectivePermissions = (
  membership: MembershipFacts | null,
  role: RoleFacts | null,
  grants: readonly GrantFacts[],
  now: Date = new Date(),
): readonly string[] => {
  if (!membership) return [];
  const base: readonly string[] = role
    ? rolePermissions(role)
    : isSystemRoleKey(membership.legacyRole)
      ? (systemRolePermissions(membership.legacyRole) ?? [])
      : [];
  const live = grants.filter((grant) => isGrantLive(grant, now.getTime()));
  if (live.length === 0) return base;
  const out = [...base];
  for (const grant of live) {
    for (const permission of grant.permissions ?? []) {
      if (!out.includes(permission)) out.push(permission);
    }
  }
  return out;
};
