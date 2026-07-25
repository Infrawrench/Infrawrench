import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { organizations, organizationMembers } from "../../db/schema";
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

  return c.json({
    userId: session.userId,
    email: session.email,
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
