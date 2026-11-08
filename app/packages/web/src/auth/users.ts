/**
 * The signed-in person and the organizations they belong to: the session
 * shape every authenticated surface carries, and the membership reads the
 * surfaces outside the org tree (MCP, the agent link, org-request auth) make
 * for themselves. The org tree's own chain is `http/auth.ts`.
 */
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { organizationMembers, organizations } from "../db/schema";

export interface AuthSession {
  userId: string;
  email: string;
  /**
   * WorkOS session (`sid`) this request authenticated with, when there is one.
   * Lets the account settings UI mark (and refuse to revoke) the session the
   * user is currently browsing from. Absent only if WorkOS ever hands us a
   * token without the claim.
   */
  sessionId?: string;
}

export { ensureUserFromClaims } from "../http/auth";

/**
 * Returns true if the user already has a membership row in the given org.
 * Never creates organizations or memberships: org creation is exclusively
 * handled by `POST /api/orgs`, and memberships by explicit invites.
 */
export async function hasMembership(userId: string, orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, orgId)),
    )
    .limit(1);
  return rows.length > 0;
}

export interface UserOrganization {
  id: string;
  displayName: string;
  role: string;
}

/**
 * The organizations a user belongs to, oldest membership first. Used by callers
 * that have no org in hand: notably MCP, where the OAuth token is not
 * guaranteed to carry an `org_id` claim and there is no UI to pick one.
 * Read-only: it can only ever return orgs the user is already a member of.
 */
export async function listUserOrganizations(userId: string): Promise<UserOrganization[]> {
  return await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(organizationMembers.createdAt);
}
