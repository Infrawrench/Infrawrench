import { createMiddleware } from "hono/factory";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { setCookie } from "hono/cookie";
import { Cause, Exit, Option, type Effect } from "effect";
import { eq, and } from "drizzle-orm";
import type { WorkosAccessTokenClaims } from "../auth/api-auth";
import { runWithAuditPrincipal } from "../services/audit-context";
import { db } from "../db/client";
import { organizationMembers, organizations } from "../db/schema";
import type { ResolvedRole, ActiveElevation } from "@infrawrench/server-core/permissions";
import {
  authenticateAgent,
  authenticateApiKey,
  authenticatePerson,
  ensureUserFromClaims,
  requireMembership,
  resolvePersonPermissions,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
  type OrgCaller,
} from "../http/auth";
import type { HttpFailure } from "../http/errors";
import { runFromLegacyExit } from "../http/legacy";

export interface AuthSession {
  userId: string;
  email: string;
  /**
   * WorkOS session (`sid`) this request authenticated with, when there is one.
   * Lets the account settings UI mark (and refuse to revoke) the session the
   * user is currently browsing from. Absent only if WorkOS ever hands us a
   * token without the claim.
   */
  sessionId?: string;
}

/**
 * The `iwk_` API key a request authenticated with, when it did.
 *
 * Its presence is what tells the rest of the org middleware stack to stand
 * down, and what tells a handler it is not talking to a person. Deliberately
 * *not* a place to look up authority: `permissions` already carries the key's
 * effective set, and a handler that reached into `scopes` here would be reading
 * the un-intersected ceiling rather than what the key may actually do.
 */
interface ApiKeyPrincipal {
  /** `api_keys.id`. Recorded on every audit row the request writes. */
  id: string;
  /** The key's stored scopes, before intersection with the owner's role. */
  scopes: readonly string[];
  /**
   * Set by `agentOrgMiddleware`: the principal is an agent, whose `scopes` are
   * already final and must not be intersected with its `users` row's role.
   */
  agentRegistrationId?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
    permissions: readonly string[];
    role: ResolvedRole | null;
    apiKey: ApiKeyPrincipal;
    /**
     * The verified claims of this request's bearer JWT (or null when the JWT
     * failed verification) stashed by `agentOrgMiddleware` so that
     * `sessionMiddleware`, running next on the same request, does not verify
     * the same signature a second time. Unset (`undefined`) on requests the
     * agent middleware never saw.
     */
    bearerClaims: WorkosAccessTokenClaims | null;
    /**
     * Live break-glass grants already folded into `permissions`. Kept separate
     * so a surface can say *why* the caller can do something: "until 14:32,
     * because you asked for it" is a different statement from "your role
     * grants this", and collapsing them quietly normalises elevation.
     */
    elevations: readonly ActiveElevation[];
  }
}

/**
 * The Hono side of the auth chain, while routes are still moving to HttpApi.
 *
 * Each middleware is an adapter over the matching Effect step in
 * `http/auth.ts`, which is the one implementation; the Effect middleware runs
 * the same steps for the routes already on HttpApi. Keep any change to who may
 * call the API in `http/auth.ts`.
 */
async function runStep<A>(
  c: Context,
  step: Effect.Effect<A, HttpFailure>,
): Promise<{ ok: true; value: A } | { ok: false; response: Response }> {
  const exit = await runFromLegacyExit(step);
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    return {
      ok: false,
      response: c.json(failure.value.body, failure.value.status as ContentfulStatusCode),
    };
  }
  throw Cause.squash(exit.cause);
}

function setRefreshedSession(c: Context, sealed: string | undefined): void {
  if (!sealed) return;
  setCookie(c, SESSION_COOKIE, sealed, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
}

function setOrgCaller(c: Context, caller: OrgCaller): void {
  c.set("session", caller.session);
  c.set("organizationId", caller.organizationId);
  c.set("permissions", caller.permissions);
  c.set("role", caller.role);
  c.set("elevations", caller.elevations);
  if (caller.apiKey) {
    const { id, scopes, agentRegistrationId } = caller.apiKey;
    c.set("apiKey", {
      id,
      scopes,
      ...(agentRegistrationId === undefined ? {} : { agentRegistrationId }),
    });
  }
}

/**
 * Validates WorkOS session cookie and auto-provisions users in the DB.
 * Does NOT resolve an organization: use orgMiddleware for org-scoped routes.
 */
export const sessionMiddleware = createMiddleware(async (c, next) => {
  const result = await runStep(
    c,
    authenticatePerson({ raw: c.req.raw, orgId: c.req.param("orgId") }, c.get("bearerClaims")),
  );
  if (!result.ok) return result.response;
  setRefreshedSession(c, result.value.refreshedSession);
  c.set("session", result.value.session);
  return next();
});

/**
 * Reads :orgId from the route path, validates the user is a member,
 * and sets organizationId on the context.
 * Must be used AFTER sessionMiddleware.
 */
export const orgMiddleware = createMiddleware(async (c, next) => {
  const result = await runStep(c, requireMembership(c.get("session").userId, c.req.param("orgId")));
  if (!result.ok) return result.response;
  c.set("organizationId", result.value);
  return next();
});

/**
 * Populates `permissions`, `role` and `elevations`: the principal's role in
 * the org **union any live break-glass grant**, which is what makes an
 * elevation reach every surface at once.
 */
export const permissionsMiddleware = createMiddleware(async (c, next) => {
  const result = await runStep(
    c,
    resolvePersonPermissions(c.get("session").userId, c.get("organizationId")),
  );
  if (!result.ok) return result.response;
  c.set("permissions", result.value.permissions);
  c.set("role", result.value.role);
  c.set("elevations", result.value.elevations);
  return next();
});

/**
 * Authenticate an `iwk_` API key against the org in the URL, leaving the
 * context in exactly the shape the three middlewares above would. A no-op for
 * any request not presenting an `iwk_` bearer token.
 */
export const apiKeyOrgMiddleware = createMiddleware(async (c, next) => {
  const result = await runStep(
    c,
    authenticateApiKey({ raw: c.req.raw, orgId: c.req.param("orgId") }),
  );
  if (!result.ok) return result.response;
  const caller = result.value;
  if (!caller) return next();
  setOrgCaller(c, caller);
  return caller.auditPrincipal ? runWithAuditPrincipal(caller.auditPrincipal, next) : next();
});

/**
 * Authenticate an agent credential against the org tree; same contract as the
 * key middleware, with its own pinning and denial table.
 */
export const agentOrgMiddleware = createMiddleware(async (c, next) => {
  const result = await runStep(
    c,
    authenticateAgent({ raw: c.req.raw, orgId: c.req.param("orgId") }),
  );
  if (!result.ok) return result.response;
  const step = result.value;
  if (step.kind === "pass") {
    if (step.bearerClaims !== undefined) c.set("bearerClaims", step.bearerClaims);
    return next();
  }
  setOrgCaller(c, step.caller);
  return step.caller.auditPrincipal
    ? runWithAuditPrincipal(step.caller.auditPrincipal, next)
    : next();
});

/**
 * Run `mw` only when {@link apiKeyOrgMiddleware} has not already authenticated
 * the request; a 401/403 Response from `mw` still short-circuits the chain.
 */
export function unlessApiKey(mw: MiddlewareHandler): MiddlewareHandler {
  return createMiddleware((c, next) => (c.get("apiKey") ? next() : mw(c, next)));
}

export { ensureUserFromClaims };

/**
 * Returns true if the user already has a membership row in the given org.
 * Never creates organizations or memberships: org creation is exclusively
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
 * that have no org in hand: notably MCP, where the OAuth token is not
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
