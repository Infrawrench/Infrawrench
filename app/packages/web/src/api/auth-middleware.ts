import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { eq, and } from "drizzle-orm";
import { workos } from "../auth/workos";
import { authenticateApiRequest, verifyWorkosAccessToken } from "../auth/api-auth";
import { effectivePermissions } from "../auth/effective-permissions";
import { apiKeyRouteDenial } from "../auth/api-key-route-policy";
import { runWithAuditPrincipal } from "../services/audit-context";
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

/**
 * The `iwk_` API key a request authenticated with, when it did.
 *
 * Its presence is what tells the rest of the org middleware stack to stand
 * down — and what tells a handler it is not talking to a person. Deliberately
 * *not* a place to look up authority: `permissions` already carries the key's
 * effective set, and a handler that reached into `scopes` here would be reading
 * the un-intersected ceiling rather than what the key may actually do.
 */
interface ApiKeyPrincipal {
  /** `api_keys.id`. Recorded on every audit row the request writes. */
  id: string;
  /** The key's stored scopes, before intersection with the owner's role. */
  scopes: readonly string[];
}

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
    permissions: readonly string[];
    role: ResolvedRole | null;
    apiKey: ApiKeyPrincipal;
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

/**
 * Authenticate an `iwk_` API key against the org in the URL, and leave the
 * context in exactly the shape the three middlewares above would have left it.
 *
 * This is the whole of the widening. It changes *who may present credentials*
 * to the org tree and nothing else: every route keeps the `requirePermission`
 * call it already had, and the `permissions` this sets are the key's scopes
 * intersected with its owner's role right now, so a key can never do something
 * its holder could not do while signed in. See `auth/effective-permissions.ts`.
 *
 * A no-op — straight through to `sessionMiddleware` — for any request that
 * isn't presenting an `iwk_` bearer token. Session cookies and WorkOS access
 * tokens take the identical path they take today.
 *
 * Order matters and is deliberate: org pinning is checked before the route
 * policy, and both before any permission resolution, so a key aimed at the
 * wrong org learns nothing about the org it aimed at.
 */
export const apiKeyOrgMiddleware = createMiddleware(async (c, next) => {
  const bearer = c.req.header("authorization");
  if (!bearer?.startsWith("Bearer ") || !bearer.slice(7).startsWith("iwk_")) return next();

  const orgId = c.req.param("orgId");
  if (!orgId) return c.json({ error: "Missing organization ID" }, 400);

  // Fails closed for an unknown, revoked, expired or past-sunset key, and for
  // one whose owner no longer has a membership row in the key's own org.
  const auth = await authenticateApiRequest(c.req.raw);
  if (!auth?.apiKeyId) return c.json({ error: "Unauthorized" }, 401);

  // A key is pinned to the org it was minted in. Presenting it against another
  // org's URL is a 403 whatever the key holds — there is no cross-org key.
  if (auth.organizationId !== orgId) {
    return c.json({ error: "API key belongs to a different organization" }, 403);
  }

  const denial = apiKeyRouteDenial(c.req.method, new URL(c.req.url).pathname);
  if (denial) return c.json({ error: denial }, 403);

  // The owner's `users` row, which is also what `AuthSession.email` needs. A
  // deleted user cascades away their keys and memberships, so this is belt and
  // braces — but it is the belt that is actually checked, rather than a
  // property of a foreign key three tables away.
  const [owner] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);
  if (!owner) return c.json({ error: "Unauthorized" }, 401);

  // Always an array, never `undefined`: `[]` means "a key holding no scopes"
  // and resolves to no permissions, whereas `undefined` would mean "not a key"
  // and would hand over the owner's whole role.
  const scopes = auth.scopes ?? [];
  const permissions = await effectivePermissions({
    userId: auth.userId,
    organizationId: orgId,
    scopes,
  });

  c.set("session", { userId: auth.userId, email: owner.email });
  c.set("organizationId", orgId);
  c.set("permissions", permissions);
  // A key holds no role. `role` exists so a handler can ask "is the caller an
  // owner" (routes/team.ts does, for owner-only mutations); answering `null`
  // makes those fail closed. The routes that ask are denied to keys anyway —
  // this is the second lock on the same door.
  c.set("role", null);
  // Break-glass never reaches a key; `effectivePermissions` resolves key
  // principals with `includeElevation: false`, so there is nothing to report.
  c.set("elevations", []);
  c.set("apiKey", { id: auth.apiKeyId, scopes });

  return runWithAuditPrincipal({ apiKeyId: auth.apiKeyId, userId: auth.userId }, next);
});

/**
 * Run `mw` only when {@link apiKeyOrgMiddleware} has not already authenticated
 * the request.
 *
 * Wrapping rather than editing the three middlewares keeps the existing path
 * byte-identical: for a cookie or WorkOS-bearer request `c.get("apiKey")` is
 * undefined and `mw` is invoked with the same context and the same `next`, in
 * the same order Hono would have invoked it directly. The wrapper returns `mw`'s
 * result untouched, so a 401/403 Response still short-circuits the chain.
 */
export function unlessApiKey(mw: MiddlewareHandler): MiddlewareHandler {
  return createMiddleware((c, next) => (c.get("apiKey") ? next() : mw(c, next)));
}

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
