/**
 * Deleting a personal account, and everything that has to go with it.
 *
 * Apple requires an app that can create an account to be able to delete one
 * (App Store guideline 5.1.1(v)), so this is reachable from every surface that
 * signs a user in — it can't be a support ticket.
 *
 * The hard part is not the user row, it's the organizations hanging off it.
 * `organization_members.user_id` cascades, so a naive delete silently bypasses
 * the last-owner guards in `routes/team.ts` and can leave an ownerless — or
 * memberless — organization with a live Stripe subscription still billing. So
 * every membership is classified first:
 *
 * - **only member** → the organization is effectively theirs. It is deleted
 *   and its subscription cancelled.
 * - **only owner, but other people are in it** → refused. Handing a team's
 *   organization to nobody is not ours to do, and promoting another owner is
 *   already possible in Settings → Team, so this is a detour rather than a
 *   dead end.
 * - **anything else** → they just leave; the membership row cascades.
 *
 * Ordering matters as much as the classification — see {@link deleteAccount}.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import {
  auditLogs,
  organizationMembers,
  organizations,
  roles,
  subscriptions,
  users,
} from "../db/schema";
import { workos } from "../auth/workos";
import { getStripe } from "./stripe";
import { releaseSeat } from "./seats";
import { logAudit } from "./audit";
import { classifyMemberships, type AccountDeletionPlan } from "./account-deletion-plan";

export type { AccountDeletionPlan, MembershipRow, OwnershipBlocker } from "./account-deletion-plan";

export class AccountDeletionError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 502,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AccountDeletionError";
  }
}

/**
 * Work out what deleting `userId` would do, without doing any of it. Exported
 * so the UI can warn before the user commits rather than only on refusal.
 */
export async function planAccountDeletion(userId: string): Promise<AccountDeletionPlan> {
  const mine = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));

  const orgIds = [...new Set(mine.map((m) => m.organizationId))];
  if (orgIds.length === 0) {
    return { organizationIdsToDelete: [], organizationIdsToLeave: [], blockers: [] };
  }

  // Every member of every organization the caller is in, so member counts and
  // owner counts come from one round trip rather than two per organization.
  const rows = await db
    .select({
      organizationId: organizationMembers.organizationId,
      organizationName: organizations.displayName,
      userId: organizationMembers.userId,
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(inArray(organizationMembers.organizationId, orgIds));

  return classifyMemberships(rows, orgIds, userId);
}

/**
 * Delete the account. Throws {@link AccountDeletionError} rather than deleting
 * anything when the caller still solely owns a shared organization.
 *
 * The order below is deliberate and each step depends on the one before it:
 *
 * 1. **Plan and refuse early** — nothing is touched until we know the whole
 *    deletion can go through.
 * 2. **Audit the organizations being left** — the row is org-scoped and
 *    FK-cascades, so it has to be written while the membership still exists.
 *    Organizations being deleted are skipped: their audit log goes with them.
 * 3. **Cancel Stripe subscriptions** for the organizations about to be deleted.
 *    A failure here aborts: deleting the organization while its subscription
 *    keeps charging is the one outcome with no recovery path from the user's
 *    side, and they can always cancel in Billing and retry.
 * 4. **Revoke every WorkOS session.** `sessionMiddleware` calls `provisionUser`
 *    on every authenticated request — an `insert().onConflictDoNothing()` —
 *    so a request in flight after step 5 would quietly re-create the row we
 *    just deleted. Cutting the sessions first closes that window.
 * 5. **Delete the local rows in one transaction** — organizations first, then
 *    the user, so a failure leaves the account intact rather than half-gone.
 * 6. **Delete the WorkOS user last.** If this is what fails, the local data is
 *    already gone and the user can sign in (getting a fresh empty account) and
 *    retry. The reverse order fails into "can't sign in, data still here",
 *    which needs an operator.
 */
export async function deleteAccount(userId: string): Promise<{ organizationsDeleted: number }> {
  const plan = await planAccountDeletion(userId);

  if (plan.blockers.length > 0) {
    throw new AccountDeletionError(
      "Transfer ownership of your organizations before deleting your account.",
      409,
      "transfer_ownership_required",
      { organizations: plan.blockers },
    );
  }

  for (const organizationId of plan.organizationIdsToLeave) {
    await logAudit({
      organizationId,
      userId,
      action: "user.delete",
      entityType: "user",
      entityId: userId,
      metadata: { leftOrganization: true },
    });
  }

  await cancelSubscriptionsFor(plan.organizationIdsToDelete);

  await revokeAllSessions(userId);

  await db.transaction(async (tx) => {
    if (plan.organizationIdsToDelete.length > 0) {
      // The audit rows for these organizations would cascade away a statement
      // later anyway; dropping them explicitly keeps the intent visible.
      await tx
        .delete(auditLogs)
        .where(inArray(auditLogs.organizationId, plan.organizationIdsToDelete));
      await tx.delete(organizations).where(inArray(organizations.id, plan.organizationIdsToDelete));
    }
    await tx.delete(users).where(eq(users.id, userId));
  });

  // The membership rows for the organizations being left just cascaded away
  // with the user row, so each of those orgs now has one seat nobody fills.
  // Best-effort: the account is gone either way, and a surviving owner can
  // still drop the seat in the Stripe portal.
  for (const organizationId of plan.organizationIdsToLeave) {
    try {
      await releaseSeat(organizationId);
    } catch (err) {
      console.error(`[account-deletion] releasing a seat for org ${organizationId} failed:`, err);
    }
  }

  try {
    await workos.userManagement.deleteUser(userId);
  } catch (err) {
    // The data is already gone, which is what the user asked for and what the
    // regulation cares about. Signing in again would mint a fresh empty
    // account, so this is loud in the logs rather than fatal to the request.
    console.error(`[account-deletion] WorkOS deleteUser failed for ${userId}:`, err);
  }

  return { organizationsDeleted: plan.organizationIdsToDelete.length };
}

/**
 * Stop billing for organizations that are about to stop existing. Aborts the
 * deletion on failure — see step 3 above.
 */
async function cancelSubscriptionsFor(organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;

  const rows = await db
    .select({
      organizationId: subscriptions.organizationId,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      status: subscriptions.status,
    })
    .from(subscriptions)
    .where(inArray(subscriptions.organizationId, organizationIds));

  const live = rows.filter((r) => r.stripeSubscriptionId && r.status !== "canceled");
  // Never construct the Stripe client when there is nothing to cancel: it
  // throws without STRIPE_SECRET_KEY, and a self-hosted deployment has none.
  if (live.length === 0) return;

  const stripe = getStripe();
  for (const row of live) {
    try {
      await stripe.subscriptions.cancel(row.stripeSubscriptionId!);
    } catch (err) {
      console.error(
        `[account-deletion] cancelling subscription ${row.stripeSubscriptionId} failed:`,
        err,
      );
      throw new AccountDeletionError(
        "We couldn't cancel the subscription for one of your organizations, so nothing was deleted. Cancel it in Billing and try again.",
        502,
        "subscription_cancel_failed",
        { organizationId: row.organizationId },
      );
    }
  }
}

/** Cut every sign-in, including the one making this request. */
async function revokeAllSessions(userId: string): Promise<void> {
  try {
    const list = await workos.userManagement.listSessions(userId);
    for (const session of list.data.filter((s) => s.status === "active")) {
      await workos.userManagement.revokeSession({ sessionId: session.id });
    }
  } catch (err) {
    // Best effort: the WorkOS user is deleted at the end regardless, which
    // invalidates everything. This only narrows the re-provisioning window.
    console.error(`[account-deletion] revoking sessions failed for ${userId}:`, err);
  }
}
