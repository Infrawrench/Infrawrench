/**
 * The one rule for "is this membership an owner?".
 *
 * A member's role comes from two places: the newer `roles` row pointed at by
 * `organization_members.role_id` (whose `systemKey` is the authority when it
 * exists), and the legacy `organization_members.role` text column for rows that
 * predate custom roles. Getting this wrong in either direction is a real
 * incident — miscounting owners is what the last-owner guards stand on, and
 * account deletion now stands on it too.
 */
export function isOwnerRole(
  systemKey: string | null | undefined,
  legacyRole: string | null | undefined,
): boolean {
  if (systemKey) return systemKey === "owner";
  return legacyRole === "owner";
}
