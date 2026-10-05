/**
 * Ending one person's membership of one org, and everything that goes with it.
 *
 * Shared by the team page's "remove member" and by directory deprovisioning,
 * so a member the IdP removes leaves exactly the trail a member an owner
 * removes does: no cost scope left behind, every key they minted here revoked
 * on the record, and the seat released.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { apiKeys, costVisibilityScopes, organizationMembers } from "../db/schema";
import { releaseSeat } from "./seats";

export interface MemberRemovalResult {
  revokedApiKeyIds: string[];
}

export async function removeOrgMember(
  organizationId: string,
  userId: string,
): Promise<MemberRemovalResult> {
  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    );

  // Their member-level cost visibility scope goes with the membership, so a
  // later re-invite starts from whatever their new role says.
  await db
    .delete(costVisibilityScopes)
    .where(
      and(
        eq(costVisibilityScopes.organizationId, organizationId),
        eq(costVisibilityScopes.principalKind, "member"),
        eq(costVisibilityScopes.principalId, userId),
      ),
    );

  // Revoke the keys they minted in this org. `authenticateApiRequest` also
  // re-checks membership, so this is belt-and-braces, but it leaves an
  // accurate record rather than rows that merely happen to be unusable, and
  // the removed user can no longer reach the UI to revoke them.
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

  // Best-effort: the member is already out either way, and the seat can
  // still be dropped by hand in the Stripe portal if this fails. Recounts
  // members, so calling it when no row existed changes nothing.
  try {
    await releaseSeat(organizationId);
  } catch (err) {
    console.error(`[team] releasing a seat for org ${organizationId} failed:`, err);
  }

  return { revokedApiKeyIds: revoked.map((k) => k.id) };
}
