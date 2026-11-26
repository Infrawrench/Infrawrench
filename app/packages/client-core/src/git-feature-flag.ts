/**
 * git-feature-flag: Git is on for an organisation only once a platform admin
 * turns it on. Temporary; every line that reads it carries the marker
 * `git-feature-flag` (KNOWLEDGE.md "Git feature flag" has the removal steps).
 *
 * `/team/me` says `gitEnabled: false` for an organisation without it, and a
 * client's permission check then answers no for every `git:` permission, so
 * whatever is already gated on `git:read` (Settings > Git, the sidebar's Git
 * entry, the command palette, the mobile row) hides with no flag check of its
 * own. Absent (a server before the flag, or after it is removed) means on.
 * The server refuses the routes itself; this is presentation only.
 */
export function gitFeatureHides(
  permission: string,
  membership: { readonly gitEnabled?: boolean | undefined } | null | undefined,
): boolean {
  return membership?.gitEnabled === false && permission.startsWith("git:");
}
