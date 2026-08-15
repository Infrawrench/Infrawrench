/**
 * Resolving an agent credential to a principal.
 *
 * An agent token's `sub` is a **registration id, not a user id**. That single
 * fact is the whole reason this module exists: everything else in the auth
 * stack reads `sub` as a WorkOS user and provisions one on sight, which for an
 * agent token would mint a junk `users` row keyed by a registration id. The
 * lookup here is what tells the two apart, and it is authoritative — it asks
 * our own table rather than trusting the shape of claims we cannot control.
 *
 * Post-claim the token also carries an RFC 8693 `act` claim naming the user
 * behind the agent. We record the same fact ourselves during the ceremony, and
 * `claimedByUserId` is what this module trusts: it was written by a flow we ran,
 * whereas `act` is an assertion arriving with the request. `act` is still worth
 * cross-checking, and {@link resolveAgentPrincipal} says when the two disagree.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { agentAuthRegistrations, organizations } from "../db/schema.js";
import { ALL_PERMISSIONS, intersectPermissions } from "../permissions/catalog.js";
import { resolveEffectivePermissions } from "../permissions/resolver.js";
import { agentUserId } from "./identity.js";

/**
 * Permissions no agent credential ever holds, claimed or not.
 *
 * The reasoning is `auth/api-key-route-policy.ts`'s, applied to a principal
 * that is even less attended than an API key:
 *
 * - **`apikeys:*`** — a credential that can mint credentials outlives its own
 *   revocation, which turns "revoke that agent" from a decision into a race.
 * - **`billing:*`** — a trial has no card by definition, and an agent that can
 *   start a subscription can commit its claimer to a bill they never agreed to.
 * - **`org:settings:write`** — includes org deletion. An agent should not be
 *   able to destroy the tenant a human just claimed.
 */
export const AGENT_DENIED_PERMISSIONS: readonly string[] = [
  "apikeys:read",
  "apikeys:write",
  "billing:read",
  "billing:write",
  "org:settings:write",
];

/**
 * Additionally withheld while a registration is unclaimed.
 *
 * `team:invite` sends email, from our domain, to an address the caller chooses.
 * Behind an anonymous registration that is a spam relay with no accountable
 * human on the other end — the one capability where "it is only their own org"
 * stops being a sufficient answer, because the blast radius is other people's
 * inboxes and our sending reputation. It comes back the moment a real user
 * completes the ceremony.
 */
export const AGENT_PRECLAIM_DENIED_PERMISSIONS: readonly string[] = ["team:invite"];

function withoutDenied(
  permissions: readonly string[],
  denied: readonly string[],
): readonly string[] {
  return permissions.filter((p) => !denied.includes(p));
}

export interface AgentPrincipal {
  registrationId: string;
  organizationId: string;
  /**
   * The `users.id` to act as. The agent's own user row while unclaimed; still
   * the agent's own row after a claim — the claim binds *accountability* to a
   * person, it does not turn the agent into them.
   */
  userId: string;
  /** The human who claimed this registration, or null while unclaimed. */
  claimedByUserId: string | null;
  claimed: boolean;
  /** Fully resolved, already intersected. Hand straight to the tool layer. */
  permissions: readonly string[];
  /** Milliseconds until the trial org is destroyed; null once claimed. */
  trialExpiresInMs: number | null;
}

export interface ResolveAgentOptions {
  /** The token's `act.sub`, when it carried one. Cross-checked, never trusted. */
  actorUserId?: string | undefined;
  now?: Date;
}

/**
 * Resolve an agent registration id to the principal it authenticates as, or
 * null when the id is unknown or revoked.
 *
 * Returning null for a revoked registration is what makes revocation immediate:
 * the token stays cryptographically valid until it expires, so the only thing
 * that can end its access before then is a check like this one.
 */
export async function resolveAgentPrincipal(
  registrationId: string,
  options: ResolveAgentOptions = {},
): Promise<AgentPrincipal | null> {
  const now = options.now ?? new Date();

  const [row] = await db
    .select({
      organizationId: agentAuthRegistrations.organizationId,
      claimedByUserId: agentAuthRegistrations.claimedByUserId,
      claimedAt: agentAuthRegistrations.claimedAt,
      revokedAt: agentAuthRegistrations.revokedAt,
      trialExpiresAt: organizations.trialExpiresAt,
    })
    .from(agentAuthRegistrations)
    .innerJoin(organizations, eq(organizations.id, agentAuthRegistrations.organizationId))
    .where(eq(agentAuthRegistrations.id, registrationId))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt) return null;

  const claimed = row.claimedAt !== null;

  // A disagreement here means the token asserts a different actor than the
  // ceremony recorded. It is not fatal — our record wins either way — but it is
  // the signature of a token minted against a registration that was re-claimed,
  // and silence would make that invisible.
  if (options.actorUserId && row.claimedByUserId && options.actorUserId !== row.claimedByUserId) {
    console.warn(
      `[agent-auth] registration ${registrationId} presented act.sub=${options.actorUserId} ` +
        `but was claimed by ${row.claimedByUserId}; using the recorded claimer`,
    );
  }

  const denied = claimed
    ? AGENT_DENIED_PERMISSIONS
    : [...AGENT_DENIED_PERMISSIONS, ...AGENT_PRECLAIM_DENIED_PERMISSIONS];

  let permissions: readonly string[];
  if (claimed && row.claimedByUserId) {
    // Mirrors how an API key is scored: the agent may do what its claimer may
    // do, and never more. If the claimer is demoted, the agent narrows with
    // them on the next call — which is why nothing here is memoized.
    const access = await resolveEffectivePermissions(
      row.organizationId,
      { kind: "user", userId: row.claimedByUserId },
      // No break-glass. An elevation is authority handed to a person for a
      // bounded window on a stated reason; letting it flow into an unattended
      // agent is exactly the supervision the feature exists to preserve.
      { includeElevation: false },
    );
    permissions = intersectPermissions(access.permissions, withoutDenied(ALL_PERMISSIONS, denied));
  } else {
    // Unclaimed: the agent is alone in a tenant it opened, so there is nobody
    // to escalate against. The ceiling is the catalog minus the denials above.
    permissions = withoutDenied(ALL_PERMISSIONS, denied);
  }

  return {
    registrationId,
    organizationId: row.organizationId,
    userId: agentUserId(registrationId),
    claimedByUserId: row.claimedByUserId,
    claimed,
    permissions,
    trialExpiresInMs: row.trialExpiresAt
      ? Math.max(0, row.trialExpiresAt.getTime() - now.getTime())
      : null,
  };
}

/**
 * How often `lastSeenAt` is actually written. The settings list renders it as
 * "5 minutes ago", so per-request precision buys nothing — and agents poll
 * `GET /api/agent/identity` every few seconds, which would otherwise turn
 * read-only authentication into a row write per request.
 */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/** Test hook: forget the throttle so a suite can observe consecutive writes. */
export function resetAgentTouchThrottle(): void {
  lastTouched.clear();
}

/**
 * Record that a registration was used, for the settings list's "last seen".
 *
 * Never throws. Both call sites fire-and-forget this (`void touch(...)`), so a
 * rejection here — a pool blip, or the row being cascaded away by the trial
 * reaper mid-request — would be an unhandled promise rejection, and under
 * Node's default `--unhandled-rejections=throw` that takes the whole server
 * down over bookkeeping. Auth must not fail because "last seen" didn't write.
 */
export async function touchAgentRegistration(
  registrationId: string,
  now = new Date(),
): Promise<void> {
  const previous = lastTouched.get(registrationId);
  if (previous !== undefined && now.getTime() - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(registrationId, now.getTime());
  // Unbounded only in theory — one entry per registration this process has
  // seen. The clear is a cheap backstop against a pathological credential scan.
  if (lastTouched.size > 10_000) lastTouched.clear();
  try {
    await db
      .update(agentAuthRegistrations)
      .set({ lastSeenAt: now })
      .where(eq(agentAuthRegistrations.id, registrationId));
  } catch (e) {
    console.warn(`[agent-auth] could not record lastSeenAt for ${registrationId}:`, e);
  }
}
