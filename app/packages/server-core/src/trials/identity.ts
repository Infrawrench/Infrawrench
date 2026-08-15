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
export function agentUserId(registrationId: string): string {
  return `agent_${registrationId}`;
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
