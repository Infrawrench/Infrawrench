/**
 * Platform admins are deployment operators, not an org role. They are the
 * only principals allowed to hit /api/admin: currently used to grant or
 * revoke complimentary (never-billed, all paid perks) access for orgs.
 *
 * Membership comes from the INFRAWRENCH_PLATFORM_ADMIN_EMAILS env var:
 * a comma-separated, case-insensitive list of user emails. Unset means
 * nobody: the admin surface is disabled entirely.
 *
 * The admin domain (`http/domains/admin`) checks it on every request under
 * `/api/admin`, after the session and before anything else.
 */
export function isPlatformAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const raw = process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"];
  if (!raw) return false;
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}
