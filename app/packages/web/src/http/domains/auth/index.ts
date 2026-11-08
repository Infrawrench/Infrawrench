/**
 * Browser sign-in and the session: `/api/auth`, the handlers.
 */
import { randomBytes } from "node:crypto";
import { Duration, Effect, Layer, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { organizationMembers, organizations, users } from "../../../db/schema";
import {
  OAUTH_COOKIE_MAX_AGE,
  OAUTH_STATE_COOKIE,
  RETURN_TO_COOKIE,
  safeReturnPath,
} from "../../../api/oauth-state";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { guardSessionPrefixes } from "../../prefix-guard";
import { SessionPrincipal } from "../../principal";
import { respond } from "../../response";
import { expireSessionCookie } from "../../session-cookie";
import { workosClient } from "../../workos";
import { AuthApi, OrgMembership, Session, SignedOut } from "./api";

/** The sign-in round trip's cookies, as Hono's `setCookie` wrote them. */
const oauthCookieOptions = () => ({
  httpOnly: true,
  secure: process.env["NODE_ENV"] === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: Duration.seconds(OAUTH_COOKIE_MAX_AGE),
});

const SignInHandlers = HttpApiBuilder.group(AuthApi, "signIn", (handlers) =>
  handlers.handle("signIn", ({ request }) =>
    Effect.map(workosClient, ({ clientId, workos }) => {
      const redirectUri = process.env["WORKOS_REDIRECT_URI"] ?? "http://localhost:3000/callback";
      // Per-request nonce. The callback verifies the cookie matches the returned
      // `state` parameter, blocking login CSRF.
      const state = randomBytes(32).toString("base64url");
      // Where to land afterwards. Used by the step-up flow so a user sent back to
      // sign-in mid-settings-change returns to the page they were on. Validated to
      // a same-origin path: an open redirect here would be a phishing primitive.
      const returnTo = safeReturnPath(
        new URL(request.url, "http://localhost").searchParams.get("return_to"),
      );
      const url = workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId,
        redirectUri,
        state,
      });
      const redirect = HttpServerResponse.setCookieUnsafe(
        HttpServerResponse.redirect(url),
        OAUTH_STATE_COOKIE,
        state,
        oauthCookieOptions(),
      );
      return returnTo
        ? HttpServerResponse.setCookieUnsafe(
            redirect,
            RETURN_TO_COOKIE,
            returnTo,
            oauthCookieOptions(),
          )
        : redirect;
    }),
  ),
);

const AuthHandlers = HttpApiBuilder.group(AuthApi, "auth", (handlers) =>
  handlers
    .handle("me", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const memberships = yield* legacy(() =>
          db
            .select({ organizationId: organizationMembers.organizationId })
            .from(organizationMembers)
            .where(eq(organizationMembers.userId, session.userId))
            .limit(1),
        );
        // Prefer the mirrored row over `session.email`: the sealed cookie caches the
        // user WorkOS handed us at sign-in, so after an email change it reports the
        // old address until the session next refreshes.
        const [row] = yield* legacy(() =>
          db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1),
        );
        return yield* respond(Session)({
          userId: session.userId,
          email: row?.email ?? session.email,
          needsOnboarding: memberships.length === 0,
        });
      }),
    )
    .handle("orgs", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        // Deliberately carries no trial deadline. A trial org has no human members:
        // an agent opens it alone, agents cannot invite, and claiming clears
        // `trialExpiresAt` in the same statement that precedes adding the claimer,
        // so this endpoint could only ever report null for it. The people who need
        // that deadline get it where they actually are: the agent, from
        // `trial_expires_in_ms` on every `/api/agent/identity` poll (and it is told
        // to pass it on), and the claimer, from the `/claim` page.
        const rows = yield* legacy(() =>
          db
            .select({
              id: organizations.id,
              displayName: organizations.displayName,
              role: organizationMembers.role,
            })
            .from(organizationMembers)
            .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
            .where(eq(organizationMembers.userId, session.userId)),
        );
        return yield* respond(Schema.Array(OrgMembership))(rows);
      }),
    )
    .handle("signOut", () => Effect.map(respond(SignedOut)({ ok: true }), expireSessionCookie)),
);

/**
 * Every other path under `/api/auth` needs a person's session first, as the
 * Hono mount's `use("/auth/*", sessionMiddleware)` did: a 401 without one,
 * the 404 with one. `sign-in` is an endpoint, so the guard never sees it.
 */
export const authDomain = guardSessionPrefixes(
  makeDomain("auth", AuthApi, Layer.mergeAll(SignInHandlers, AuthHandlers)),
  ["/api/auth"],
);
