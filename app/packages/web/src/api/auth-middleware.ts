import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { eq, and } from "drizzle-orm";
import { workos, clientId } from "../auth/workos";
import { db } from "../db/client";
import { organizations, users, organizationMembers } from "../db/schema";
import { v4 as uuid } from "uuid";

export interface AuthSession {
  userId: string;
  email: string;
}

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
  }
}

/**
 * Validates WorkOS session cookie and auto-provisions users in the DB.
 * Does NOT resolve an organization — use orgMiddleware for org-scoped routes.
 */
export const sessionMiddleware = createMiddleware(async (c, next) => {
  const cookieValue = getCookie(c, "wos-session");
  if (!cookieValue) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const cookiePassword = process.env["WORKOS_COOKIE_PASSWORD"];
  if (!cookiePassword) {
    throw new Error("WORKOS_COOKIE_PASSWORD is required");
  }

  try {
    const session = workos.userManagement.loadSealedSession({
      sessionData: cookieValue,
      cookiePassword,
    });

    const authResult = await session.authenticate();

    if (!authResult.authenticated) {
      try {
        const refreshResult = await session.refresh();
        if (!refreshResult.authenticated) {
          return c.json({ error: "Unauthorized" }, 401);
        }
        if (refreshResult.sealedSession) {
          setCookie(c, "wos-session", refreshResult.sealedSession, {
            httpOnly: true,
            secure: process.env["NODE_ENV"] === "production",
            sameSite: "lax",
            path: "/",
            maxAge: 60 * 60 * 24 * 400,
          });
        }
        const user = refreshResult.user;
        await provisionUser(user);
        if (refreshResult.organizationId) {
          await ensureMembership(user.id, refreshResult.organizationId);
        }
        c.set("session", { userId: user.id, email: user.email });
        return next();
      } catch {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    const user = authResult.user;
    await provisionUser(user);
    if (authResult.organizationId) {
      await ensureMembership(user.id, authResult.organizationId);
    }
    c.set("session", { userId: user.id, email: user.email });
    return next();
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
});

/**
 * Reads :orgId from the route path, validates the user is a member,
 * and sets organizationId on the context.
 * Must be used AFTER sessionMiddleware.
 */
export const orgMiddleware = createMiddleware(async (c, next) => {
  const orgId = c.req.param("orgId");
  if (!orgId) {
    return c.json({ error: "Missing organization ID" }, 400);
  }

  const session = c.get("session");
  const membership = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, session.userId),
        eq(organizationMembers.organizationId, orgId),
      ),
    )
    .limit(1);

  if (membership.length === 0) {
    return c.json({ error: "Forbidden" }, 403);
  }

  c.set("organizationId", orgId);
  return next();
});

async function provisionUser(
  user: { id: string; email: string; firstName?: string | null; lastName?: string | null },
) {
  await db
    .insert(users)
    .values({
      id: user.id,
      email: user.email,
      displayName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
    })
    .onConflictDoNothing();
}

async function ensureMembership(userId: string, orgId: string) {
  await db
    .insert(organizations)
    .values({
      id: orgId,
      displayName: orgId,
    })
    .onConflictDoNothing();

  await db
    .insert(organizationMembers)
    .values({
      id: uuid(),
      userId,
      organizationId: orgId,
      role: "owner",
    })
    .onConflictDoNothing();
}
