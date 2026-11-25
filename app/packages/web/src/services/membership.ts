/**
 * Organization membership removal, shared by the team page's Remove and the
 * offboarding checklist's "Remove from organization", so both apply the same
 * owner guards and revoke the same things.
 */
import { and, eq, isNull } from "drizzle-orm";
import { isAgentUserId } from "@infrawrench/server-core/trials/identity";
import { stopLendingKeysOf } from "@infrawrench/server-core/ci/access";
import { db } from "../db/client";
import { apiKeys, costVisibilityScopes, organizationMembers, roles } from "../db/schema";
import { isOwnerRole } from "./org-roles";

// Counts both new (role.systemKey === "owner") and legacy (text role) owners,
// for the "last owner" guard on member delete and role change.
//
// Agent memberships never count, whatever role their row carries: the guard
// exists so a *person* always remains who can administer the org, and an agent
// cannot. A claimed org whose agent still counted as an owner would let the
// only human owner remove themselves.
export async function countOwners(organizationId: string): Promise<number> {
  const rows = await db
    .select({
      userId: organizationMembers.userId,
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
    })
    .from(organizationMembers)
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(eq(organizationMembers.organizationId, organizationId));
  let count = 0;
  for (const r of rows) {
    if (isAgentUserId(r.userId)) continue;
    if (isOwnerRole(r.systemKey, r.legacyRole)) count++;
  }
  return count;
}

/** True if the membership row for (userId, orgId) is an owner. */
export async function isMemberOwner(organizationId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ legacyRole: organizationMembers.role, systemKey: roles.systemKey })
    .from(organizationMembers)
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) return false;
  return isOwnerRole(row.systemKey, row.legacyRole);
}

/**
 * Remove a membership, its member-level cost visibility scope (a later
 * re-invite starts from whatever the new role says) and revoke the keys they
 * minted here. The auth chain re-checks membership, so the revocation is
 * belt-and-braces, but it leaves an accurate record, and the removed user can
 * no longer reach the UI to revoke them. Returns the revoked key ids.
 */
export async function removeMembership(organizationId: string, userId: string) {
  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    );
  await db
    .delete(costVisibilityScopes)
    .where(
      and(
        eq(costVisibilityScopes.organizationId, organizationId),
        eq(costVisibilityScopes.principalKind, "member"),
        eq(costVisibilityScopes.principalId, userId),
      ),
    );
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.organizationId, organizationId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  // Their SSH keys stop being lent to CI jobs: a key lent by someone who has
  // left must not keep reaching every trusted run.
  await stopLendingKeysOf(organizationId, userId);
  return revoked.map((k) => k.id);
}
