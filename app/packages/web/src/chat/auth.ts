/**
 * Chat auth — accepts either:
 *  1. WorkOS session cookie (for the React UI)
 *  2. WorkOS Bearer access token (for browser-side fetch with access tokens)
 *  3. Infrawrench API key (iwk_*), programmatic.
 *
 * In all cases produces a {@link ChatAuthResult} pinned to the org in the URL,
 * and in all cases the caller must hold the required `chat:read` / `chat:write`
 * permission — see {@link denyUnlessPermitted}. Returns 401/403 helpers if auth
 * fails, the org doesn't match, or the permission is missing.
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and } from "drizzle-orm";
import { workos } from "../auth/workos";
import { effectivePermissions } from "../auth/effective-permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { authenticateApiRequest, requireScope, verifyWorkosAccessToken } from "../auth/api-auth";
import { db } from "../db/client";
import { users, organizationMembers } from "../db/schema";
import { ensureUserFromClaims } from "../api/auth-middleware";

interface ChatAuthResult {
  userId: string;
  organizationId: string;
  email?: string;
  apiKeyId?: string;
  /**
   * The API key's scopes, when authed via API key. Carried through to the tool
   * layer so a narrowly-scoped key can't act with its owner's full authority.
   */
  scopes?: readonly string[];
  /** "session" | "workos-bearer" | "api-key" */
  via: "session" | "workos-bearer" | "api-key";
}

/**
 * Enforce `requiredScope` against the principal's effective permissions.
 *
 * This runs for every auth path, not just API keys. `requireScope` only ever
 * looked at a key's stored scopes, so session and OAuth callers reached chat on
 * membership alone — the `chat:read` / `chat:write` permissions existed in the
 * catalog but were unenforceable for the UI, which is the surface that
 * actually matters.
 *
 * For key principals this also narrows by the owner's role, so `chat:write` on
 * a key held by someone without it no longer passes.
 */
async function denyUnlessPermitted(
  c: Context,
  principal: { userId: string; organizationId: string; scopes?: readonly string[] | undefined },
  requiredScope: string,
): Promise<Response | null> {
  const granted = await effectivePermissions(principal);
  if (!hasPermission(granted, requiredScope)) {
    return c.json({ error: `Missing required permission: ${requiredScope}` }, 403);
  }
  return null;
}

async function hasMembership(userId: string, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Authenticate the request and verify membership in `:orgId`. On failure
 * returns a Response that the caller should return directly.
 */
export async function authenticateChat(
  c: Context,
  pathOrgId: string,
  requiredScope: "chat:read" | "chat:write",
): Promise<ChatAuthResult | Response> {
  // 1) Bearer token — either iwk_ API key or WorkOS access token.
  const bearer = c.req.header("authorization");
  if (bearer?.startsWith("Bearer ")) {
    if (bearer.slice(7).startsWith("iwk_")) {
      const auth = await authenticateApiRequest(c.req.raw);
      if (!auth) return c.json({ error: "Unauthorized" }, 401);
      try {
        requireScope(auth, requiredScope);
      } catch {
        return c.json({ error: `Missing required scope: ${requiredScope}` }, 403);
      }
      if (auth.organizationId !== pathOrgId) {
        return c.json({ error: "API key belongs to a different organization" }, 403);
      }
      const denied = await denyUnlessPermitted(
        c,
        { userId: auth.userId, organizationId: auth.organizationId, scopes: auth.scopes ?? [] },
        requiredScope,
      );
      if (denied) return denied;
      const result: ChatAuthResult = {
        userId: auth.userId,
        organizationId: auth.organizationId,
        // Always set, even when empty: `scopes: []` means "this principal is a
        // key with no scopes", whereas `undefined` means "not a key at all"
        // and grants the user's full role permissions.
        scopes: auth.scopes ?? [],
        via: "api-key",
      };
      if (auth.email) result.email = auth.email;
      if (auth.apiKeyId) result.apiKeyId = auth.apiKeyId;
      return result;
    }
    // WorkOS access token (browser SPAs that send Bearer instead of cookie).
    const claims = await verifyWorkosAccessToken(bearer.slice(7));
    if (!claims?.sub) return c.json({ error: "Unauthorized" }, 401);
    const user = await ensureUserFromClaims(claims.sub, claims.email);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!(await hasMembership(user.id, pathOrgId))) {
      return c.json({ error: "Forbidden — not a member of this organization" }, 403);
    }
    const denied = await denyUnlessPermitted(
      c,
      { userId: user.id, organizationId: pathOrgId },
      requiredScope,
    );
    if (denied) return denied;
    const result: ChatAuthResult = {
      userId: user.id,
      organizationId: pathOrgId,
      via: "workos-bearer",
    };
    if (claims.email) result.email = claims.email;
    return result;
  }

  // 2) Session cookie (the React UI's path).
  const cookieValue = getCookie(c, "wos-session");
  if (!cookieValue) return c.json({ error: "Unauthorized" }, 401);

  const cookiePassword = process.env["WORKOS_COOKIE_PASSWORD"];
  if (!cookiePassword) {
    return c.json({ error: "Server misconfiguration" }, 500);
  }

  try {
    const session = workos.userManagement.loadSealedSession({
      sessionData: cookieValue,
      cookiePassword,
    });
    const authResult = await session.authenticate();
    if (!authResult.authenticated) return c.json({ error: "Unauthorized" }, 401);

    const userId = authResult.user.id;
    const email = authResult.user.email;
    // Ensure the local users row exists (mirrors api-auth-middleware).
    await db
      .insert(users)
      .values({ id: userId, email })
      .onConflictDoUpdate({ target: users.id, set: { email } });

    if (!(await hasMembership(userId, pathOrgId))) {
      return c.json({ error: "Forbidden — not a member of this organization" }, 403);
    }

    const denied = await denyUnlessPermitted(
      c,
      { userId, organizationId: pathOrgId },
      requiredScope,
    );
    if (denied) return denied;

    return {
      userId,
      organizationId: pathOrgId,
      email,
      via: "session",
    };
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
}
