/**
 * How an agent registration maps to a user identity.
 *
 * A leaf module with no imports, on purpose. Creation, destruction and
 * principal resolution all need this mapping, and putting it beside any one of
 * them would make the other two import that module's whole dependency chain —
 * `destroy.ts` would pull in the permission resolver to derive a string.
 */

/**
 * The `users.id` an agent registration acts as.
 *
 * Prefixed so it can never collide with a WorkOS user id and so a human reading
 * an audit row, a member list or a `user_id` column can tell at a glance that
 * the actor was an agent. Everything downstream — audit rows, permission
 * resolution, `invitations.invitedByUserId` — takes a real user id and would
 * otherwise have to grow a null case at 70-odd call sites.
 */
export const AGENT_USER_ID_PREFIX = "agent_";

/**
 * The same prefix as a `LIKE` pattern, underscore escaped (in `LIKE`, a bare
 * `_` matches any character). For queries that must count or exclude agent
 * memberships in SQL — seat accounting being the case that forced it: an agent
 * is not a person and must never occupy, hold down, or block a paid seat.
 */
export const AGENT_USER_ID_LIKE_PATTERN = "agent\\_%";

export function agentUserId(registrationId: string): string {
  return `${AGENT_USER_ID_PREFIX}${registrationId}`;
}

/** Whether a `users.id` denotes an agent rather than a person. */
export function isAgentUserId(userId: string): boolean {
  return userId.startsWith(AGENT_USER_ID_PREFIX);
}

/** 8-4-4-4-12 hex. Deliberately not pinned to v4 — this guard fails closed. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a token's `sub` has the shape of an agent registration id rather than
 * a person's WorkOS user id.
 *
 * Free, and deliberately **shape-based rather than a table lookup**, because the
 * cases that matter most are the ones no lookup can answer: a registration that
 * has been revoked, or one the trial reaper has already deleted. Asking the
 * table "is this a live agent?" answers *no* for both, and a person-only surface
 * that reads that as "so it must be a person" will hand the token to
 * `ensureUserFromClaims` and mint a `users` row keyed by a registration id —
 * a principal nobody created, holding whatever that row's memberships grant.
 *
 * Registration ids are `randomUUID()`; WorkOS user ids are `user_`-prefixed and
 * never bare UUIDs, so this cannot refuse a person.
 */
export function looksLikeAgentRegistrationId(sub: string): boolean {
  return UUID_SHAPE.test(sub);
}

/**
 * The address on the agent's user row.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so this satisfies
 * the `users.email` NOT NULL + unique index without creating an address that
 * could receive mail or collide with a person's. An agent must never be
 * reachable by email — it is not a person, and anything that tries to notify it
 * should fail visibly rather than deliver somewhere unexpected.
 */
export function agentUserEmail(registrationId: string): string {
  return `${registrationId}@agent.invalid`;
}
