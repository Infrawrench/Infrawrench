/**
 * Auth for org-scoped routes that must serve both the UI and machines.
 *
 * Accepts any of:
 *  1. WorkOS session cookie (the React UI)
 *  2. WorkOS Bearer access token (browser fetch with access tokens)
 *  3. Infrawrench API key (`iwk_*`), programmatic.
 *
 * In all cases it produces a principal pinned to the org in the URL, and in all
 * cases that principal must hold `requiredScope` — see
 * {@link denyUnlessPermitted}. Returns a 401/403 `Response` the caller should
 * return directly when auth fails, the org doesn't match, or the permission is
 * missing.
 *
 * The org tree now accepts `iwk_` keys too, through `apiKeyOrgMiddleware` in
 * `api/auth-middleware.ts` — the same `authenticateApiRequest` and the same
 * `effectivePermissions` intersection, so there is one rule about what a key
 * may do, not two. This function stays for the four routers that sit *outside*
 * that tree on purpose (chat, cost ingest, paging): they are mounted ahead of
 * it, they authenticate per-handler rather than per-request, and their failure
 * responses are part of a published contract. Folding them in would change the
 * order the checks run in and the wording of three error bodies for no gain —
 * see the note on {@link authenticateOrgRequest}.
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { workos } from "./workos";
import { effectivePermissions } from "./effective-permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { looksLikeAgentRegistrationId } from "@infrawrench/server-core/trials/identity";
import { authenticateApiRequest, requireScope, verifyWorkosAccessToken } from "./api-auth";
import { db } from "../db/client";
import { users } from "../db/schema";
import { ensureUserFromClaims, hasMembership } from "../api/auth-middleware";

export interface OrgAuthResult {
  userId: string;
  organizationId: string;
  email?: string;
  apiKeyId?: string;
  /**
   * The API key's scopes, when authed via API key. Carried through to callers
   * (notably the tool layer) so a narrowly-scoped key can't act with its
   * owner's full authority.
   */
  scopes?: readonly string[];
  /** "session" | "workos-bearer" | "api-key" */
  via: "session" | "workos-bearer" | "api-key";
}

/**
 * Enforce `requiredScope` against the principal's effective permissions.
 *
 * This runs for every auth path, not just API keys. `requireScope` only ever
 * looked at a key's stored scopes, so session and OAuth callers would reach
 * these routes on membership alone — the permissions exist in the catalog but
 * would be unenforceable for the UI, which is the surface that actually
 * matters.
 *
 * For key principals this also narrows by the owner's role, so a scope on a key
 * held by someone whose role lacks it no longer passes.
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

/**
 * Authenticate the request and verify membership in `:orgId`. On failure
 * returns a Response that the caller should return directly.
 *
 * Deliberately **not** collapsed into `apiKeyOrgMiddleware` + `requirePermission`,
 * even though the two now agree on every authorization question. The observable
 * behaviour differs in three ways, each of which some caller depends on:
 *
 *  - It checks `requireScope` against the key's raw scopes *before* comparing
 *    orgs, so a key aimed at another org with the wrong scope answers "missing
 *    scope"; the middleware pins the org first. Neither order is wrong; they
 *    are not the same order.
 *  - The 403 bodies read `Missing required scope:` / `Missing required
 *    permission:`, where `requirePermission` says `Missing permission:`.
 *  - The session branch upserts the user's email (`onConflictDoUpdate`), where
 *    `sessionMiddleware` inserts and leaves an existing row alone.
 *
 * The duplication that mattered — a second answer to "what may this key do" —
 * is already gone: both paths resolve through {@link effectivePermissions}.
 */
export async function authenticateOrgRequest(
  c: Context,
  pathOrgId: string,
  requiredScope: string,
): Promise<OrgAuthResult | Response> {
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
      const result: OrgAuthResult = {
        userId: auth.userId,
        organizationId: auth.organizationId,
        // Always set, even when empty: `scopes: []` means "this principal is a
        // key with no scopes", whereas `undefined` means "not a key at all"
        // and grants the user's full role permissions.
        scopes: auth.scopes ?? [],
        via: "api-key",
      };
      if (auth.email) result.email = auth.email;
      // Carried, not established: `AsyncLocalStorage.enterWith` only reaches
      // the current execution's descendants, and this function is awaited by
      // its callers — a store entered here is gone by the time the handler
      // resumes. Callers that go on to write audit rows call
      // `enterAuditPrincipal` themselves; see `api/routes/chat.ts`.
      if (auth.apiKeyId) result.apiKeyId = auth.apiKeyId;
      return result;
    }
    // WorkOS access token (browser SPAs that send Bearer instead of cookie).
    const claims = await verifyWorkosAccessToken(bearer.slice(7));
    if (!claims?.sub) return c.json({ error: "Unauthorized" }, 401);
    // An agent token's `sub` is a registration id, not a user id. These routes
    // resolve a person and provision one on sight, so an agent reaching here
    // would mint a `users` row keyed by that registration — including a
    // revoked or already-reaped one, which no table lookup can rule out. See
    // `looksLikeAgentRegistrationId`.
    if (looksLikeAgentRegistrationId(claims.sub)) {
      return c.json({ error: "Agent credentials cannot be used on this endpoint." }, 403);
    }
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
    const result: OrgAuthResult = {
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
