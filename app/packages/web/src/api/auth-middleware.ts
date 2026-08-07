import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { eq, and } from "drizzle-orm";
import { workos } from "../auth/workos";
import { verifyWorkosAccessToken } from "../auth/api-auth";
import { db } from "../db/client";
import { users, organizationMembers, organizations } from "../db/schema";
import {
  type ResolvedRole,
  type ActiveElevation,
  resolveEffectivePermissions,
} from "@infrawrench/server-core/permissions";

export interface AuthSession {
  userId: string;
  email: string;
  /**
   * WorkOS session (`sid`) this request authenticated with, when there is one.
   * Lets the account settings UI mark — and refuse to revoke — the session the
   * user is currently browsing from. Absent only if WorkOS ever hands us a
   * token without the claim.
   */
  sessionId?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
    permissions: readonly string[];
    role: ResolvedRole | null;
    /**
     * Live break-glass grants already folded into `permissions`. Kept separate
     * so a surface can say *why* the caller can do something — "until 14:32,
     * because you asked for it" is a different statement from "your role
     * grants this", and collapsing them quietly normalises elevation.
     */
    elevations: readonly ActiveElevation[];
  }
}

/**
 * Validates WorkOS session cookie and auto-provisions users in the DB.
 * Does NOT resolve an organization — use orgMiddleware for org-scoped routes.
 */
export const sessionMiddleware = createMiddleware(async (c, next) => {
  const cookieValue = getCookie(c, "wos-session");
  if (!cookieValue) {
    const bearer = c.req.header("authorization");
    if (bearer?.startsWith("Bearer ")) {
      const claims = await verifyWorkosAccessToken(bearer.slice(7));
      if (!claims?.sub) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const user = await ensureUserFromClaims(claims.sub, claims.email);
      if (!user) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      c.set("session", {
        userId: user.id,
        email: user.email,
        ...(typeof claims.sid === "string" ? { sessionId: claims.sid } : {}),
      });
      return next();
    }
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
        c.set("session", {
          userId: user.id,
          email: user.email,
          sessionId: refreshResult.sessionId,
        });
        return next();
      } catch {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    const user = authResult.user;
    await provisionUser(user);
    c.set("session", {
      userId: user.id,
      email: user.email,
      sessionId: authResult.sessionId,
    });
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

/**
 * Populates `permissions` (and `role`, where applicable) on the Hono context
 * by resolving the current principal's effective permissions in the org.
 * Must run after sessionMiddleware + orgMiddleware on session-authed routes,
 * or be called manually for bearer-token endpoints.
 *
 * `permissions` here is the caller's role **union any live break-glass grant**
 * — the resolver folds those in for session principals. That is what makes an
 * elevation reach every surface at once (HTTP, the WebSocket gateway through
 * `POST /ws-token`, chat, MCP tools) instead of each having to remember.
 */
export const permissionsMiddleware = createMiddleware(async (c, next) => {
  const session = c.get("session");
  const orgId = c.get("organizationId");
  const access = await resolveEffectivePermissions(orgId, {
    kind: "user",
    userId: session.userId,
  });
  c.set("permissions", access.permissions);
  c.set("role", access.role);
  c.set("elevations", access.elevations);
  return next();
});

export async function ensureUserFromClaims(
  userId: string,
  claimEmail: string | undefined,
): Promise<{ id: string; email: string } | null> {
  const existing = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (existing[0]) return existing[0];

  // Access-token JWTs may not include email — fall back to the WorkOS user
  // endpoint so we can provision a new row.
  let email = claimEmail;
  let firstName: string | null = null;
  let lastName: string | null = null;
  if (!email) {
    try {
      const u = await workos.userManagement.getUser(userId);
      email = u.email;
      firstName = u.firstName ?? null;
      lastName = u.lastName ?? null;
    } catch (err) {
      console.error(`[auth] WorkOS getUser failed for ${userId}:`, err);
      return null;
    }
  }
  if (!email) return null;

  await provisionUser({ id: userId, email, firstName, lastName });
  return { id: userId, email };
}

async function provisionUser(user: {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}) {
  await db
    .insert(users)
    .values({
      id: user.id,
      email: user.email,
      displayName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
    })
    .onConflictDoNothing();
}

/**
 * Returns true if the user already has a membership row in the given org.
 * Never creates organizations or memberships — org creation is exclusively
 * handled by `POST /api/orgs`, and memberships by explicit invites.
 */
export async function hasMembership(userId: string, orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, orgId)),
    )
    .limit(1);
  return rows.length > 0;
}

export interface UserOrganization {
  id: string;
  displayName: string;
  role: string;
}

/**
 * The organizations a user belongs to, oldest membership first. Used by callers
 * that have no org in hand — notably MCP, where the OAuth token is not
 * guaranteed to carry an `org_id` claim and there is no UI to pick one.
 * Read-only: it can only ever return orgs the user is already a member of.
 */
export async function listUserOrganizations(userId: string): Promise<UserOrganization[]> {
  return await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(organizationMembers.createdAt);
}
