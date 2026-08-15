/**
 * Claiming a trial org.
 *
 * The claim ceremony itself happens at WorkOS; by the time anything here runs,
 * a real user has authenticated and been bound to the agent registration. This
 * module is what that binding *means* on our side, and the user picks between
 * two meanings at claim time:
 *
 *  - **adopt** — the trial org stops expiring and becomes theirs. One row
 *    update and a membership. Right for someone who has never used the product.
 *  - **merge** — the work moves into an org they already belong to and the
 *    trial is destroyed. Right for an existing customer, who does not want a
 *    second workspace.
 *
 * **Merge moves credentials, not derived state.** Only `accounts` rows are
 * re-parented. Resources, metrics, cost history and poll outcomes are all
 * reproducible from the account by the next poll, and re-parenting them would
 * mean a 76-table `UPDATE organization_id` in Postgres plus mutations across
 * eight ClickHouse tables — a large, mostly-unobservable migration whose
 * failure modes land in someone else's tenant. Moving the credential and
 * letting the poller rebuild is the same end state by a route that cannot
 * half-succeed.
 *
 * What that costs is honest to state: anything a trial *authored* rather than
 * discovered — dashboards, cost centres, saved queries — does not survive a
 * merge. In a 24-hour window that is a small set, and an adopt keeps all of it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  accounts,
  agentAuthRegistrations,
  organizationMembers,
  organizations,
} from "../db/schema.js";
import { ensureSystemRoles, getSystemRole } from "../permissions/resolver.js";
import { FREE_PLAN_LIMITS, PlanRequiredError, planAccess } from "../entitlements.js";
import { destroyOrganization, moveOrgClickHouseData } from "./destroy.js";
import { agentUserId } from "./identity.js";

export type ClaimMode = "adopt" | "merge";

export interface ClaimTrialOptions {
  /** The WorkOS agent registration id whose ceremony just completed. */
  registrationId: string;
  /**
   * The claiming user, from the completed ceremony's `act` claim. Never from a
   * token's `sub` — that is the registration id, not a person.
   */
  userId: string;
  mode: ClaimMode;
  /** Required for `merge`: the org the caller wants the work moved into. */
  targetOrganizationId?: string;
  /**
   * Merge only: also re-parent the trial's ClickHouse history (metrics, cost,
   * poll outcomes, network flows) onto the target org.
   *
   * Off by default because it is the more surprising outcome — a user merging
   * a trial into a long-lived org usually wants the *connection*, and silently
   * splicing a day of foreign history into their cost graphs is a change to
   * numbers they may already be reporting on. Opt-in, and worth labelling in
   * the UI as "keep the trial's history".
   */
  moveHistory?: boolean;
  now?: Date;
}

export interface ClaimTrialResult {
  mode: ClaimMode;
  /** The org the agent acts in from now on. */
  organizationId: string;
  /** Accounts re-parented by a merge. Zero for an adopt. */
  accountsMoved: number;
  /**
   * Whether ClickHouse history was moved. False for an adopt, where the rows
   * never needed to go anywhere — the org they belong to is the one being kept.
   */
  historyMoved: boolean;
}

export class TrialClaimError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "TrialClaimError";
  }
}

/**
 * Bind a completed claim ceremony to an organization.
 *
 * Idempotent on the registration: a second call for an already-claimed
 * registration throws rather than re-running, because the two modes are not
 * interchangeable and silently ignoring the second call would leave the caller
 * believing a merge happened when an adopt did.
 */
export async function claimTrialOrg(options: ClaimTrialOptions): Promise<ClaimTrialResult> {
  const now = options.now ?? new Date();

  const [registration] = await db
    .select()
    .from(agentAuthRegistrations)
    .where(eq(agentAuthRegistrations.id, options.registrationId))
    .limit(1);

  if (!registration) {
    throw new TrialClaimError("That agent registration is not known to this service.");
  }
  if (registration.revokedAt) {
    throw new TrialClaimError("That agent registration has been revoked and cannot be claimed.");
  }
  if (registration.claimedAt) {
    throw new TrialClaimError("That agent registration has already been claimed.");
  }

  const trialOrgId = registration.organizationId;

  if (options.mode === "adopt") {
    await adoptTrialOrg(trialOrgId, options.userId, now);
    await db
      .update(agentAuthRegistrations)
      .set({ claimedByUserId: options.userId, claimedAt: now })
      .where(eq(agentAuthRegistrations.id, options.registrationId));
    return { mode: "adopt", organizationId: trialOrgId, accountsMoved: 0, historyMoved: false };
  }

  const targetOrganizationId = options.targetOrganizationId;
  if (!targetOrganizationId) {
    throw new TrialClaimError("A merge needs a target organization.");
  }
  if (targetOrganizationId === trialOrgId) {
    throw new TrialClaimError("Cannot merge a trial organization into itself.");
  }

  // The claimer must already belong to the target. Without this check, a claim
  // ceremony would be a way to push cloud credentials into any org whose id you
  // can guess.
  const [membership] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, options.userId),
        eq(organizationMembers.organizationId, targetOrganizationId),
      ),
    )
    .limit(1);
  if (!membership) {
    throw new TrialClaimError("You are not a member of the organization you asked to merge into.");
  }

  const accountsMoved = await mergeTrialInto(trialOrgId, targetOrganizationId);

  // History moves before the destroy so the purge can be skipped entirely —
  // see `DestroyOrganizationOptions.skipClickHouse` for why "the mutation queue
  // is ordered" is not a good enough reason to issue both.
  let historyMoved = false;
  if (options.moveHistory) {
    await moveOrgClickHouseData(trialOrgId, targetOrganizationId);
    historyMoved = true;
  }

  // Record the claim against the registration *before* the trial org goes away:
  // the row cascades with the org, so it has to be re-pointed at the target
  // first or the agent would lose its binding along with its trial.
  await db
    .update(agentAuthRegistrations)
    .set({
      organizationId: targetOrganizationId,
      claimedByUserId: options.userId,
      claimedAt: now,
    })
    .where(eq(agentAuthRegistrations.id, options.registrationId));

  // The agent's own membership follows its registration into the target org,
  // or the agent would keep authenticating into an org it no longer belongs
  // to — its permissions resolve against membership, and the trial's row is
  // about to be cascaded away.
  await moveAgentMembership(options.registrationId, trialOrgId, targetOrganizationId);

  await destroyOrganization(trialOrgId, { skipClickHouse: historyMoved });

  return { mode: "merge", organizationId: targetOrganizationId, accountsMoved, historyMoved };
}

/**
 * Turn the trial org into a normal org owned by the claimer.
 *
 * Clearing `trialExpiresAt` drops the org from paid to free, which is the
 * conversion moment. Accounts already created above the free limit are left
 * alone deliberately: `FREE_PLAN_LIMITS` is enforced where accounts are
 * *created*, not on every read, so an org that arrives over the line keeps what
 * it has and simply cannot add more. Deleting a working cloud connection as a
 * consequence of claiming would be the worst possible welcome.
 *
 * The chat cap is left at zero. A claimed org is a free org, and the free tier
 * has its own AI allowance that the billing settings page can raise — but that
 * is a decision for its new owner to make knowingly, not something a claim
 * should hand over silently.
 */
async function adoptTrialOrg(organizationId: string, userId: string, now: Date): Promise<void> {
  await db
    .update(organizations)
    .set({ trialExpiresAt: null, claimedAt: now, updatedAt: now })
    .where(eq(organizations.id, organizationId));

  await ensureSystemRoles(organizationId);
  const ownerRole = await getSystemRole(organizationId, "owner");

  // The first membership row this org has ever had — trials run without one so
  // they never consume a seat (see `trials/create.ts`).
  await db
    .insert(organizationMembers)
    .values({
      id: randomUUID(),
      userId,
      organizationId,
      role: "owner",
      roleId: ownerRole.id,
    })
    .onConflictDoNothing();
}

/**
 * Re-parent the trial's cloud accounts into the target org.
 *
 * `nextPollAt` is nulled so the poller treats every moved account as due
 * immediately — that is what rebuilds resources, metrics and cost in the target
 * org, and it should start the moment the user finishes claiming rather than
 * whenever the old schedule happened to point.
 */
async function mergeTrialInto(trialOrgId: string, targetOrganizationId: string): Promise<number> {
  const moving = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.organizationId, trialOrgId));
  if (moving.length === 0) return 0;

  // A free target org has an account ceiling, and merging is a way to cross it.
  // Checked against the post-merge total rather than the current one: the
  // failure a user cares about is "this merge would put me over", and telling
  // them after the accounts have moved is not a check.
  const access = await planAccess(targetOrganizationId);
  if (!access.paid) {
    const [existing] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(accounts)
      .where(eq(accounts.organizationId, targetOrganizationId));
    const total = (existing?.count ?? 0) + moving.length;
    if (total > FREE_PLAN_LIMITS.accounts) {
      throw new PlanRequiredError(
        `Merging ${moving.length} account${moving.length === 1 ? "" : "s"} would put this ` +
          `organization at ${total}, over the free plan's limit of ${FREE_PLAN_LIMITS.accounts}. ` +
          `Upgrade under Settings → Billing, or claim the trial as its own organization instead.`,
      );
    }
  }

  await db
    .update(accounts)
    .set({ organizationId: targetOrganizationId, nextPollAt: null, costNextPollAt: null })
    .where(eq(accounts.organizationId, trialOrgId));

  return moving.length;
}

/**
 * Move the agent's membership row from the trial org to the merge target.
 *
 * Uses `onConflictDoNothing` on the insert side because the agent may already
 * be a member of the target from an earlier merge; the delete then removes the
 * trial-side row that is about to cascade away anyway, which keeps the state
 * correct even if the destroy is retried later.
 */
async function moveAgentMembership(
  registrationId: string,
  trialOrgId: string,
  targetOrganizationId: string,
): Promise<void> {
  const userId = agentUserId(registrationId);
  await ensureSystemRoles(targetOrganizationId);
  // Member, not owner: the agent is joining somebody else's organization now,
  // and the authority it acts with there is its claimer's, intersected down by
  // `resolveAgentPrincipal`. Landing as an owner in an established org would
  // grant the registration more than the claim ceremony ever conveyed.
  const memberRole = await getSystemRole(targetOrganizationId, "member");
  await db
    .insert(organizationMembers)
    .values({
      id: randomUUID(),
      userId,
      organizationId: targetOrganizationId,
      role: "member",
      roleId: memberRole.id,
    })
    .onConflictDoNothing();
  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, trialOrgId),
      ),
    );
}

/**
 * Trial orgs that were never claimed and are still inside their window, for the
 * agent to report and for the claim page to list.
 */
export async function pendingTrialForRegistration(
  registrationId: string,
): Promise<{ organizationId: string; trialExpiresAt: Date | null } | null> {
  const [row] = await db
    .select({
      organizationId: agentAuthRegistrations.organizationId,
      trialExpiresAt: organizations.trialExpiresAt,
    })
    .from(agentAuthRegistrations)
    .innerJoin(organizations, eq(organizations.id, agentAuthRegistrations.organizationId))
    .where(
      and(eq(agentAuthRegistrations.id, registrationId), isNull(agentAuthRegistrations.claimedAt)),
    )
    .limit(1);
  return row ?? null;
}
