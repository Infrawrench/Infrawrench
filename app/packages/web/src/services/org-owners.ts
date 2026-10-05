/**
 * Owner counting for the "a person must always remain who can administer the
 * org" guards: team removal and role changes, and directory deprovisioning,
 * which must refuse to remove the last owner just as an owner would be refused.
 */
import { and, eq } from "drizzle-orm";
import { isAgentUserId } from "@infrawrench/server-core/trials/identity";
import { db } from "../db/client";
import { organizationMembers, roles } from "../db/schema";
import { isOwnerRole } from "./org-roles";

// Counts both new (role.systemKey === "owner") and legacy (text role) owners.
// Used by the "last owner" guard on member delete / role change.
//
// Agent memberships never count, whatever role their row carries: the guard
// exists so a *person* always remains who can administer the org, and an agent
// cannot; its permission ceiling excludes team and settings mutations. A
// claimed org whose agent still counted as an owner would let the only human
// owner remove themselves.
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

/** Returns true if the membership row for (userId, orgId) is an owner. */
export async function isMemberOwner(organizationId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
    })
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
