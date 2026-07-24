import { createMiddleware } from "hono/factory";

/**
 * Platform admins are deployment operators, not an org role. They are the
 * only principals allowed to hit /api/admin — currently used to grant or
 * revoke complimentary (never-billed, all paid perks) access for orgs.
 *
 * Membership comes from the INFRAWRENCH_PLATFORM_ADMIN_EMAILS env var:
 * a comma-separated, case-insensitive list of user emails. Unset means
 * nobody — the admin surface is disabled entirely.
 */
export function isPlatformAdmin(email: string): boolean {
  const raw = process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"];
  if (!raw) return false;
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

/** Must run after sessionMiddleware. 403s anyone not in the allowlist. */
export const platformAdminMiddleware = createMiddleware(async (c, next) => {
  const session = c.get("session");
  if (!session?.email || !isPlatformAdmin(session.email)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
});
