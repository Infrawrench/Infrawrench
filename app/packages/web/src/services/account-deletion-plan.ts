/**
 * What deleting an account does to each organization the user belongs to.
 *
 * Kept separate from `account-deletion.ts` — which reaches the database, WorkOS
 * and Stripe — because this decision is the part that must not be wrong, and a
 * pure function over rows can be tested exhaustively without any of that.
 *
 * `organization_members.user_id` cascades unconditionally, so nothing else
 * stands between a deletion and an ownerless (or memberless) organization with
 * a live subscription still billing.
 */
import type { OwnershipBlocker } from "@infrawrench/client-core";
import { isAgentUserId } from "@infrawrench/server-core/trials/identity";

import { isOwnerRole } from "./org-roles";

export interface AccountDeletionPlan {
  /** Deleted with the account — the caller is their only member. */
  organizationIdsToDelete: string[];
  /** Survive; the caller's membership is removed. */
  organizationIdsToLeave: string[];
  /** Non-empty means the deletion must be refused. */
  blockers: OwnershipBlocker[];
}

/** One `organization_members` row joined to its org name and resolved role. */
export interface MembershipRow {
  organizationId: string;
  organizationName: string;
  userId: string;
  legacyRole: string | null;
  systemKey: string | null;
}

export function classifyMemberships(
  rows: MembershipRow[],
  organizationIds: string[],
  userId: string,
): AccountDeletionPlan {
  const plan: AccountDeletionPlan = {
    organizationIdsToDelete: [],
    organizationIdsToLeave: [],
    blockers: [],
  };

  for (const orgId of organizationIds) {
    const orgRows = rows.filter((r) => r.organizationId === orgId);
    if (orgRows.length === 0) continue;
    // People only. An agent registration holds a real `organization_members`
    // row (see `server-core/trials/create.ts`), and counting it as a member
    // turns "you are alone in this org" into "you solely own a shared org" —
    // refusing the deletion over a principal that cannot own anything, and
    // that the user has no obvious way to remove. An org whose only other
    // member is an agent is an org with nobody else in it.
    const members = orgRows.filter((m) => !isAgentUserId(m.userId));
    if (members.length === 0) continue;
    const owners = members.filter((m) => isOwnerRole(m.systemKey, m.legacyRole));
    const callerIsOwner = owners.some((o) => o.userId === userId);

    if (members.length === 1) {
      // Nobody else is in it. Whether or not the role column says "owner", an
      // organization whose last member is leaving has no one left to own it.
      plan.organizationIdsToDelete.push(orgId);
    } else if (callerIsOwner && owners.length === 1) {
      plan.blockers.push({
        id: orgId,
        name: members[0]!.organizationName,
        memberCount: members.length,
      });
    } else {
      plan.organizationIdsToLeave.push(orgId);
    }
  }

  return plan;
}
