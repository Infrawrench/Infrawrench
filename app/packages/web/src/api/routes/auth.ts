import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { organizations, organizationMembers, users } from "../../db/schema";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/auth/me — return current session + onboarding status */
app.get("/me", async (c) => {
  const session = c.get("session");

  const memberships = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, session.userId))
    .limit(1);

  // Prefer the mirrored row over `session.email`: the sealed cookie caches the
  // user WorkOS handed us at sign-in, so after an email change it reports the
  // old address until the session next refreshes.
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  return c.json({
    userId: session.userId,
    email: row?.email ?? session.email,
    needsOnboarding: memberships.length === 0,
  });
});

/** GET /api/auth/orgs — list all orgs the user belongs to */
app.get("/orgs", async (c) => {
  const session = c.get("session");

  const rows = await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(eq(organizationMembers.userId, session.userId));

  return c.json(rows);
});

/** POST /api/auth/sign-out — clear the session cookie */
app.post("/sign-out", async (c) => {
  deleteCookie(c, "wos-session", { path: "/" });
  return c.json({ ok: true });
});

export { app as authRoutes };
