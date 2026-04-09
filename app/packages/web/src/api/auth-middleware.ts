import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { workos, clientId } from "../auth/workos";
import { db } from "../db/client";
import { organizations, users } from "../db/schema";

export interface AuthSession {
  userId: string;
  organizationId: string;
  email: string;
}

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Hono middleware that validates WorkOS session cookies and auto-provisions
 * users/orgs in the DB — direct replacement for the old
 * `@workos-inc/authkit-nextjs` `withAuth({ ensureSignedIn: true })` pattern.
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
      // Try refreshing the session
      try {
        const refreshResult = await session.refresh();
        if (!refreshResult.authenticated) {
          return c.json({ error: "Unauthorized" }, 401);
        }
        // Update the cookie with refreshed session data
        if (refreshResult.sealedSession) {
          setCookie(c, "wos-session", refreshResult.sealedSession, {
            httpOnly: true,
            secure: process.env["NODE_ENV"] === "production",
            sameSite: "lax",
            path: "/",
            maxAge: 60 * 60 * 24 * 400, // ~13 months
          });
        }
        const user = refreshResult.user;
        const orgId = refreshResult.organizationId ?? `personal:${user.id}`;
        await provisionUserAndOrg(user, orgId);
        c.set("session", { userId: user.id, organizationId: orgId, email: user.email });
        return next();
      } catch {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    const user = authResult.user;
    const orgId = authResult.organizationId ?? `personal:${user.id}`;
    await provisionUserAndOrg(user, orgId);
    c.set("session", { userId: user.id, organizationId: orgId, email: user.email });
    return next();
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
});

async function provisionUserAndOrg(
  user: { id: string; email: string; firstName?: string | null; lastName?: string | null },
  orgId: string,
) {
  await db
    .insert(organizations)
    .values({
      id: orgId,
      displayName: orgId.startsWith("personal:") ? `${user.email}'s workspace` : orgId,
    })
    .onConflictDoNothing();

  await db
    .insert(users)
    .values({
      id: user.id,
      organizationId: orgId,
      email: user.email,
      displayName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
    })
    .onConflictDoNothing();
}
