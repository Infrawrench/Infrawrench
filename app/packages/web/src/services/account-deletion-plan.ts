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

import { isOwnerRole } from "./org-roles";

/**
 * An organization the caller must hand over before they can delete. The wire
 * shape is the client contract; client-core (`profile.ts`) owns it.
 */
export type { OwnershipBlocker };

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
    const members = rows.filter((r) => r.organizationId === orgId);
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
