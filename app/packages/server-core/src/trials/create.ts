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
import { eq, sql } from "drizzle-orm";

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
 * chain — the existing cap error is raised, and it already tells the reader
 * where the setting lives. A *small* budget would have been worse than either
 * extreme: enough to be worth farming, not enough to be useful.
 */
export const TRIAL_CHAT_CAP_MICROS = 0;

/**
 * The transaction handle the reservation step runs on. Exposed so the rate
 * limiter in `ceremony.ts` can type its callback without importing Drizzle's
 * transaction machinery itself.
 */
export type TrialCreateTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreateTrialOrgOptions {
  /** The WorkOS registration id. Becomes `agent_auth_registrations.id`. */
  registrationId: string;
  /** Label the agent supplied, shown in the claim UI and settings list. */
  label?: string;
  /** "anonymous" | "service_auth" */
  kind?: string;
  /**
   * The credential the registration authenticates with, written on the row in
   * the same statement that creates it. Written here rather than backfilled
   * after the fact: a registration that exists without its credential hash is
   * an org nobody can ever authenticate to or claim, and a row the per-IP rate
   * limiter cannot yet see.
   */
  credential?: { hashed: string; prefix: string };
  /** Source address of the registration request, for the per-IP limit. */
  createdFromIp?: string | null;
  /**
   * Veto hook, run *inside* the same transaction — and behind the same
   * advisory lock — that inserts the org and registration rows. This is what
   * makes a count-based rate limit race-free: concurrent registrations
   * serialise on the lock, so every count sees every row a rival committed.
   */
  assertAllowed?: (tx: TrialCreateTx) => Promise<void>;
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
 * Create the org, the registration row binding it, its system roles, its
 * default dashboard, and the agent's own user and membership.
 *
 * **The org and registration rows commit together, first, behind an advisory
 * lock.** The registration is the row the rate limiter counts and the row the
 * credential resolves against, so it must become visible — complete, with its
 * credential hash and source IP — the moment anything else about this
 * registration exists. The provisioning that follows (roles, user, membership,
 * dashboard) is retried-or-reaped territory: if it fails, the committed rows
 * still count against the caller's rate limit and the reaper deletes the org
 * when its clock runs out.
 *
 * **The agent gets a real user row**, created explicitly here and nowhere else.
 * That is what makes the JIT-provisioning hazard closable: `ensureUserFromClaims`
 * can refuse every agent token outright (see `auth/api-auth.ts`) precisely
 * because the only path that ever creates an agent user is this one, where the
 * registration is known and the org is being created around it.
 *
 * The membership is a **member, not an owner**, and costs no seat. The agent's
 * authority never comes from this row — `resolveAgentPrincipal` derives it from
 * the registration — so the role only exists to be read by people-shaped code:
 * the last-owner guard on member removal, seat accounting, the team list. Every
 * one of those must see "not an owner, not a person", or a claimed org's sole
 * human owner could remove themselves because the agent still "owned" it.
 */
export async function createTrialOrg(options: CreateTrialOrgOptions): Promise<TrialOrg> {
  const now = options.now ?? new Date();
  const trialExpiresAt = new Date(now.getTime() + TRIAL_DURATION_MS);
  const organizationId = randomUUID();
  const displayName = options.label?.trim() || "Trial workspace";

  await db.transaction(async (tx) => {
    // One global lock for all trial registrations, not per-IP: the global
    // ceiling needs it too, and registrations are rare enough (hundreds per
    // hour at the ceiling) that serialising them costs nothing measurable.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('infrawrench:agent-registration'::text, 0))`,
    );

    if (options.assertAllowed) await options.assertAllowed(tx);

    await tx.insert(organizations).values({
      id: organizationId,
      displayName,
      trialExpiresAt,
      chatMonthlyCapMicros: TRIAL_CHAT_CAP_MICROS,
    });

    await tx.insert(agentAuthRegistrations).values({
      id: options.registrationId,
      organizationId,
      kind: options.kind ?? "anonymous",
      ...(options.label ? { label: options.label } : {}),
      ...(options.credential
        ? {
            hashedCredential: options.credential.hashed,
            credentialPrefix: options.credential.prefix,
          }
        : {}),
      createdFromIp: options.createdFromIp ?? null,
    });
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

  const memberRole = await getSystemRole(organizationId, "member");
  await db
    .insert(organizationMembers)
    .values({
      id: randomUUID(),
      userId,
      organizationId,
      role: "member",
      roleId: memberRole.id,
    })
    .onConflictDoNothing();

  await db.insert(dashboards).values({
    id: randomUUID(),
    organizationId,
    name: "Home",
    isDefault: true,
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
