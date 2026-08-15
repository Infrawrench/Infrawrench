/**
 * Opening a trial org for an anonymous agent registration.
 *
 * The org is a *real* org, not a sandbox: real tables, real plugin accounts,
 * real syncing. That is what makes the trial worth anything, and it is safe
 * precisely because the agent gets its **own** tenant — there is no other
 * customer's data inside the boundary for a broad pre-claim scope to reach.
 *
 * Two things separate it from an org a person creates:
 *
 *  - `trialExpiresAt` is set, which grants the paid plan with no card (see
 *    `entitlements.ts`) and starts the 24-hour clock the reaper watches.
 *  - `chatMonthlyCapMicros` is **0**, which is not a limit but a prohibition.
 *    An anonymous caller must not be able to spend our inference budget; an
 *    agent arriving over MCP already has a model of its own, and that is the
 *    one that should be paying for its own tokens.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  agentAuthRegistrations,
  dashboards,
  organizationMembers,
  organizations,
  users,
} from "../db/schema.js";
import { ensureSystemRoles, getSystemRole } from "../permissions/resolver.js";
import { agentUserId, agentUserEmail } from "./identity.js";

/** How long an unclaimed trial org lives. */
export const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Trial orgs get a zero AI budget rather than a small one.
 *
 * `getAiSpendStatus` computes `exceeded` as `monthToDate >= cap`, so a cap of 0
 * is `exceeded` from the first request with no special case anywhere in the
 * chat path — the existing cap error is raised, and it already tells the reader
 * where the setting lives. A *small* budget would have been worse than either
 * extreme: enough to be worth farming, not enough to be useful.
 */
export const TRIAL_CHAT_CAP_MICROS = 0;

export interface CreateTrialOrgOptions {
  /** The WorkOS agent registration id. Becomes `agent_auth_registrations.id`. */
  registrationId: string;
  /** Label the agent supplied, shown in the claim UI and settings list. */
  label?: string;
  /** "anonymous" | "service_auth" */
  kind?: string;
  /** Fixed clock for tests. */
  now?: Date;
}

export interface TrialOrg {
  organizationId: string;
  displayName: string;
  trialExpiresAt: Date;
  /** The `users.id` the agent acts as. See {@link agentUserId}. */
  agentUserId: string;
}

export { agentUserId, agentUserEmail } from "./identity.js";

/**
 * Create the org, its system roles, its default dashboard, the agent's own user
 * and membership, and the registration row binding it all together.
 *
 * **The agent gets a real user row**, created explicitly here and nowhere else.
 * That is what makes the JIT-provisioning hazard closable: `ensureUserFromClaims`
 * can refuse every agent token outright (see `auth/api-auth.ts`) precisely
 * because the only path that ever creates an agent user is this one, where the
 * registration is known and the org is being created around it.
 *
 * It costs no seat. Seat capacity comes from a subscription or a capacity slot,
 * and a trial has neither — `checkSeatAvailability` reads a capacity of 0 as
 * "invite freely" and never counts members at all. The membership only starts
 * mattering if the org is later adopted and subscribes, by which point a human
 * owns it and can remove the agent.
 */
export async function createTrialOrg(options: CreateTrialOrgOptions): Promise<TrialOrg> {
  const now = options.now ?? new Date();
  const trialExpiresAt = new Date(now.getTime() + TRIAL_DURATION_MS);
  const organizationId = randomUUID();
  const displayName = options.label?.trim() || "Trial workspace";

  await db.insert(organizations).values({
    id: organizationId,
    displayName,
    trialExpiresAt,
    chatMonthlyCapMicros: TRIAL_CHAT_CAP_MICROS,
  });

  await ensureSystemRoles(organizationId);

  // The agent's own identity. `onConflictDoNothing` because a registration that
  // is retried after a partial failure must not fail on the user row it already
  // created — the id is derived from the registration, so a second attempt is
  // the same agent, not a different one.
  const userId = agentUserId(options.registrationId);
  await db
    .insert(users)
    .values({
      id: userId,
      email: agentUserEmail(options.registrationId),
      displayName: options.label?.trim() || "Trial agent",
    })
    .onConflictDoNothing();

  const ownerRole = await getSystemRole(organizationId, "owner");
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

  await db.insert(dashboards).values({
    id: randomUUID(),
    organizationId,
    name: "Home",
    isDefault: true,
  });

  await db.insert(agentAuthRegistrations).values({
    id: options.registrationId,
    organizationId,
    kind: options.kind ?? "anonymous",
    ...(options.label ? { label: options.label } : {}),
  });

  return { organizationId, displayName, trialExpiresAt, agentUserId: userId };
}

/** Milliseconds left on a trial org's clock, or null if it isn't a trial. */
export async function trialTimeRemainingMs(
  organizationId: string,
  now = new Date(),
): Promise<number | null> {
  const [org] = await db
    .select({ trialExpiresAt: organizations.trialExpiresAt })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org?.trialExpiresAt) return null;
  return Math.max(0, org.trialExpiresAt.getTime() - now.getTime());
}
