/**
 * The API's authentication chain, in Effect.
 *
 * This is the single implementation of who may call the API. The Effect
 * middleware (`./middleware-live.ts`) runs it for every HttpApi group, and the
 * org tree's guard (`orgTreeGuard` in `./prefix-guard.ts`) runs the same
 * middleware for a path no domain routes, so that answer authenticates
 * exactly as the endpoints do.
 *
 * The steps run in a fixed order (`iwk_` key, then agent credential, then
 * person, then membership, then permissions), including the order of every
 * database read; each is named after the middleware it once was, which is
 * how the older auth tests and comments refer to them.
 */
import { Effect } from "effect";
import { Cookies } from "effect/http";
import { eq, and } from "drizzle-orm";
import { workos } from "../auth/workos";
import {
  agentAuthResult,
  authenticateApiRequest,
  verifyWorkosAccessToken,
  type ApiAuthResult,
  type WorkosAccessTokenClaims,
} from "../auth/api-auth";
import { effectivePermissions } from "../auth/effective-permissions";
import { agentRouteDenial, apiKeyRouteDenial } from "../auth/api-key-route-policy";
import { db } from "../db/client";
import { users, organizationMembers } from "../db/schema";
import {
  type ResolvedRole,
  type ActiveElevation,
  resolveEffectivePermissions,
} from "@infrawrench/server-core/permissions";
import { resolveAgentPrincipal } from "@infrawrench/server-core/trials/principal";
import { looksLikeAgentRegistrationId } from "@infrawrench/server-core/trials/identity";
import type { AuditPrincipal } from "../services/audit-context";
import type { AuthSession } from "../auth/users";
import { HttpFailure } from "./errors";
import { legacy } from "./legacy";
import { SESSION_COOKIE } from "./session-cookie";
import type { ApiKeyPrincipal } from "./principal";

/** What the chain reads from a request. */
export interface AuthInput {
  /** The raw request; `authenticateApiRequest` reads its headers. */
  readonly raw: Request;
  /** `:orgId` from the route, on the org tree. */
  readonly orgId: string | undefined;
}

export { SESSION_COOKIE, SESSION_COOKIE_MAX_AGE } from "./session-cookie";

const unauthorized = () => new HttpFailure(401, { error: "Unauthorized" });
const fail = (status: number, error: string) => Effect.fail(new HttpFailure(status, { error }));

function bearerToken(raw: Request): string | undefined {
  const header = raw.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function sessionCookie(raw: Request): string | undefined {
  const header = raw.headers.get("cookie");
  if (!header) return undefined;
  return Cookies.parseHeader(header)[SESSION_COOKIE];
}

function pathname(raw: Request): string {
  return new URL(raw.url).pathname;
}

/** A person, authenticated by session cookie or WorkOS bearer token. */
export interface PersonAuth {
  readonly session: AuthSession;
  /** A refreshed sealed session to set as the new cookie, when WorkOS refreshed it. */
  readonly refreshedSession: string | undefined;
}

/**
 * The person step (once `sessionMiddleware`): a WorkOS session cookie or access token, refused for an
 * agent's token. `stashedClaims` is the agent step's verification of the same
 * bearer (null = it failed verification), so the JWKS check runs once.
 */
export const authenticatePerson = Effect.fnUntraced(function* (
  input: AuthInput,
  stashedClaims?: WorkosAccessTokenClaims | null,
): Effect.fn.Return<PersonAuth, HttpFailure> {
  const cookieValue = sessionCookie(input.raw);
  if (!cookieValue) {
    const token = bearerToken(input.raw);
    if (token === undefined) return yield* Effect.fail(unauthorized());
    const claims =
      stashedClaims !== undefined
        ? stashedClaims
        : yield* legacy(() => verifyWorkosAccessToken(token));
    if (!claims?.sub) return yield* Effect.fail(unauthorized());
    const sub = claims.sub;
    // An agent-auth token's `sub` is a registration id; provisioning a person
    // keyed by it would mint a principal nobody created. The shape check runs
    // first and unconditionally because it is the only one that covers a
    // revoked or reaped registration, which `resolveAgentPrincipal` answers
    // null for.
    const agentShaped = looksLikeAgentRegistrationId(sub);
    const isAgent =
      agentShaped ||
      (stashedClaims === undefined &&
        !sub.startsWith("user_") &&
        Boolean(yield* legacy(() => resolveAgentPrincipal(sub))));
    if (isAgent) {
      return yield* fail(
        403,
        "Agent credentials cannot be used here. This endpoint acts on a person's account.",
      );
    }
    const user = yield* legacy(() => ensureUserFromClaims(sub, claims.email));
    if (!user) return yield* Effect.fail(unauthorized());
    return {
      session: {
        userId: user.id,
        email: user.email,
        ...(typeof claims.sid === "string" ? { sessionId: claims.sid } : {}),
      },
      refreshedSession: undefined,
    };
  }

  const cookiePassword = process.env["WORKOS_COOKIE_PASSWORD"];
  if (!cookiePassword) {
    return yield* Effect.die(new Error("WORKOS_COOKIE_PASSWORD is required"));
  }

  // Any WorkOS failure is a 401, as it always was: a sealed cookie that will
  // not open is an unauthenticated caller, not a server error.
  const outcome = yield* legacy(async () => {
    try {
      const session = workos.userManagement.loadSealedSession({
        sessionData: cookieValue,
        cookiePassword,
      });
      const authResult = await session.authenticate();
      if (authResult.authenticated) {
        await provisionUser(authResult.user);
        return {
          session: {
            userId: authResult.user.id,
            email: authResult.user.email,
            sessionId: authResult.sessionId,
          },
          refreshedSession: undefined,
        } satisfies PersonAuth;
      }
      const refreshResult = await session.refresh();
      if (!refreshResult.authenticated) return null;
      await provisionUser(refreshResult.user);
      return {
        session: {
          userId: refreshResult.user.id,
          email: refreshResult.user.email,
          sessionId: refreshResult.sessionId,
        },
        refreshedSession: refreshResult.sealedSession,
      } satisfies PersonAuth;
    } catch {
      return null;
    }
  });
  if (!outcome) return yield* Effect.fail(unauthorized());
  return outcome;
});

/** The org tree's principal, before cost visibility and sharing are resolved. */
export interface OrgCaller {
  readonly session: AuthSession;
  readonly organizationId: string;
  readonly permissions: readonly string[];
  readonly role: ResolvedRole | null;
  readonly elevations: readonly ActiveElevation[];
  readonly apiKey: ApiKeyPrincipal | undefined;
  /** Set for key and agent principals: who an audit row written by this request is attributed to. */
  readonly auditPrincipal: AuditPrincipal | undefined;
  readonly refreshedSession: string | undefined;
}

/**
 * The key step (once `apiKeyOrgMiddleware`): an `iwk_` key against the org in the URL. `undefined`
 * when the request is not presenting a key, so the next step runs.
 *
 * Org pinning is checked before the route policy, and both before any
 * permission resolution, so a key aimed at the wrong org learns nothing about
 * the org it aimed at.
 */
export const authenticateApiKey = Effect.fnUntraced(function* (
  input: AuthInput,
): Effect.fn.Return<OrgCaller | undefined, HttpFailure> {
  const token = bearerToken(input.raw);
  if (token === undefined || !token.startsWith("iwk_")) return undefined;

  const orgId = input.orgId;
  if (!orgId) return yield* fail(400, "Missing organization ID");

  const auth = yield* legacy(() => authenticateApiRequest(input.raw));
  if (!auth?.apiKeyId) return yield* Effect.fail(unauthorized());
  if (auth.organizationId !== orgId) {
    return yield* fail(403, "API key belongs to a different organization");
  }

  const denial = apiKeyRouteDenial(input.raw.method, pathname(input.raw));
  if (denial) return yield* fail(403, denial);

  const owner = yield* legacy(() => userEmail(auth.userId));
  if (!owner) return yield* Effect.fail(unauthorized());

  // Always an array: `[]` is a key holding no scopes and resolves to nothing,
  // whereas `undefined` would read as "not a key" and hand over the whole role.
  const scopes = auth.scopes ?? [];
  const permissions = yield* legacy(() =>
    effectivePermissions({ userId: auth.userId, organizationId: orgId, scopes }),
  );
  const apiKeyId = auth.apiKeyId;
  return {
    session: { userId: auth.userId, email: owner.email },
    organizationId: orgId,
    permissions,
    // A key holds no role, so every "is the caller an owner" check fails closed.
    role: null,
    // Break-glass never reaches a key.
    elevations: [],
    apiKey: { id: apiKeyId, scopes },
    auditPrincipal: { apiKeyId, userId: auth.userId },
    refreshedSession: undefined,
  };
});

/** What the agent step decided: a principal, or hand on to the person step. */
export type AgentStep =
  | { readonly kind: "principal"; readonly caller: OrgCaller }
  | {
      readonly kind: "pass";
      /** The bearer JWT's verification, for the person step to reuse; `undefined` if never verified. */
      readonly bearerClaims: WorkosAccessTokenClaims | null | undefined;
    };

/** The agent step (once `agentOrgMiddleware`): an `iwa_` credential or a WorkOS agent token. */
export const authenticateAgent = Effect.fnUntraced(function* (
  input: AuthInput,
): Effect.fn.Return<AgentStep, HttpFailure> {
  const pass = (bearerClaims?: WorkosAccessTokenClaims | null): AgentStep => ({
    kind: "pass",
    bearerClaims,
  });
  const token = bearerToken(input.raw);
  if (token === undefined || token.startsWith("iwk_")) return pass();
  const orgId = input.orgId;
  if (!orgId) return pass();

  let auth: ApiAuthResult | null;
  let bearerClaims: WorkosAccessTokenClaims | null | undefined;
  if (token.startsWith("iwa_")) {
    auth = yield* legacy(() => authenticateApiRequest(input.raw));
    if (!auth?.agentRegistrationId) return yield* Effect.fail(unauthorized());
  } else {
    const claims = yield* legacy(() => verifyWorkosAccessToken(token));
    bearerClaims = claims ?? null;
    const sub = claims?.sub;
    if (!sub || sub.startsWith("user_")) return pass(bearerClaims);
    auth = yield* legacy(() => agentAuthResult(sub, claims.act?.sub));
    if (!auth) {
      // A registration-shaped sub resolving to nothing is a revoked or reaped
      // agent with a still-valid token; falling through would provision a person.
      if (looksLikeAgentRegistrationId(sub)) return yield* Effect.fail(unauthorized());
      return pass(bearerClaims);
    }
  }
  const registrationId = auth.agentRegistrationId;
  if (!registrationId) return pass(bearerClaims);

  if (auth.organizationId !== orgId) {
    return yield* fail(403, "This agent belongs to a different organization");
  }
  const denial = agentRouteDenial(input.raw.method, pathname(input.raw));
  if (denial) return yield* fail(403, denial);

  const userId = auth.userId;
  const actor = yield* legacy(() => userEmail(userId));
  if (!actor) return yield* Effect.fail(unauthorized());

  const scopes = auth.scopes ?? [];
  return {
    kind: "principal",
    caller: {
      session: { userId, email: actor.email },
      organizationId: orgId,
      // Already final: intersected with the claimer's role and the agent ceiling.
      permissions: scopes,
      role: null,
      elevations: [],
      apiKey: { id: registrationId, scopes, agentRegistrationId: registrationId },
      auditPrincipal: { apiKeyId: registrationId, userId },
      refreshedSession: undefined,
    },
  };
});

/** The membership step (once `orgMiddleware`): the person must already be a member of the org in the URL. */
export const requireMembership = Effect.fnUntraced(function* (
  userId: string,
  orgId: string | undefined,
): Effect.fn.Return<string, HttpFailure> {
  if (!orgId) return yield* fail(400, "Missing organization ID");
  const member = yield* legacy(() => membershipRole(userId, orgId));
  if (!member) return yield* fail(403, "Forbidden");
  return orgId;
});

/**
 * The permissions step (once `permissionsMiddleware`): the person's role in the org, union any live
 * break-glass grant, which is what makes an elevation reach every surface.
 */
export const resolvePersonPermissions = (userId: string, organizationId: string) =>
  legacy(() => resolveEffectivePermissions(organizationId, { kind: "user", userId }));

/** The whole org-tree chain, every step in order. */
export const authenticateOrgCaller = Effect.fnUntraced(function* (
  input: AuthInput,
): Effect.fn.Return<OrgCaller, HttpFailure> {
  const keyCaller = yield* authenticateApiKey(input);
  if (keyCaller) return keyCaller;
  const agent = yield* authenticateAgent(input);
  if (agent.kind === "principal") return agent.caller;
  const person = yield* authenticatePerson(input, agent.bearerClaims);
  const organizationId = yield* requireMembership(person.session.userId, input.orgId);
  const access = yield* resolvePersonPermissions(person.session.userId, organizationId);
  return {
    session: person.session,
    organizationId,
    permissions: access.permissions,
    role: access.role,
    elevations: access.elevations,
    apiKey: undefined,
    auditPrincipal: undefined,
    refreshedSession: person.refreshedSession,
  };
});

async function userEmail(userId: string): Promise<{ email: string } | undefined> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

async function membershipRole(
  userId: string,
  orgId: string,
): Promise<{ role: string } | undefined> {
  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, orgId)),
    )
    .limit(1);
  return row;
}

/**
 * The `users` row for a WorkOS subject, provisioning it on first sight. Access
 * tokens may omit the email, so a new row falls back to the WorkOS user endpoint.
 */
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
}): Promise<void> {
  await db
    .insert(users)
    .values({
      id: user.id,
      email: user.email,
      displayName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
    })
    .onConflictDoNothing();
}
