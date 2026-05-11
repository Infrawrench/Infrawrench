import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { eq, and } from "drizzle-orm";
import { workos, clientId } from "../auth/workos";
import { verifyWorkosAccessToken } from "../auth/api-auth";
import { db } from "../db/client";
import { organizations, users, organizationMembers } from "../db/schema";
import {
  type ResolvedRole,
  ensureSystemRoles,
  getSystemRole,
  resolveEffectivePermissions,
} from "@infrawrench/server-core/permissions";
import { v4 as uuid } from "uuid";

export interface AuthSession {
  userId: string;
  email: string;
}

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
    permissions: readonly string[];
    role: ResolvedRole | null;
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
      if (claims.org_id) {
        await ensureMembership(user.id, claims.org_id);
      }
      c.set("session", { userId: user.id, email: user.email });
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

/**
 * Populates `permissions` (and `role`, where applicable) on the Hono context
 * by resolving the current principal's effective permissions in the org.
 * Must run after sessionMiddleware + orgMiddleware on session-authed routes,
 * or be called manually for bearer-token endpoints.
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
    } catch {
      return null;
    }
  }
  if (!email) return null;

  await provisionUser({ id: userId, email, firstName, lastName });
  return { id: userId, email };
}

export async function provisionUser(user: {
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

export async function ensureMembership(userId: string, orgId: string) {
  await db
    .insert(organizations)
    .values({
      id: orgId,
      displayName: orgId,
    })
    .onConflictDoNothing();

  await ensureSystemRoles(orgId);
  const ownerRole = await getSystemRole(orgId, "owner");

  await db
    .insert(organizationMembers)
    .values({
      id: uuid(),
      userId,
      organizationId: orgId,
      role: "owner",
      roleId: ownerRole.id,
    })
    .onConflictDoNothing();

  // Backfill roleId for legacy memberships that predate this column.
  const existing = await db
    .select({
      id: organizationMembers.id,
      roleId: organizationMembers.roleId,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, orgId)),
    )
    .limit(1);
  const m = existing[0];
  if (m && !m.roleId) {
    const key = m.role === "owner" || m.role === "admin" ? m.role : "member";
    const role = await getSystemRole(orgId, key);
    await db
      .update(organizationMembers)
      .set({ roleId: role.id })
      .where(eq(organizationMembers.id, m.id));
  }
}
