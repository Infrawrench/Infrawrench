/**
 * Turning the session cookie into a signed-in person, and keeping it alive.
 *
 * The cookie holds a WorkOS access token (a JWT that lives a few minutes) and
 * a refresh token. Each request verifies the access token against the
 * client's JWKS; once it has expired, the refresh token is exchanged for a
 * new pair and the new sealed session is handed back to be set on the
 * response. That is what the app's `authenticatePerson` does through the
 * SDK's sealed session, step for step.
 */
import { type Jwk, unverifiedClaims, verifyJwt } from "./jwt";
import { type SessionData, sealSession, unsealSession } from "./session-cookie";
import {
  type RequestContext,
  type WorkosConfig,
  WorkosError,
  type WorkosUser,
  refreshTokens,
} from "./workos";

export interface SessionDeps {
  readonly config: WorkosConfig;
  /** `WORKOS_COOKIE_PASSWORD`. */
  readonly password: string;
  /** The client's key set: `remoteKeySet(jwksUrl(config))`. */
  readonly keys: (kid: string | undefined) => Promise<Jwk | null>;
  /** Called with the user WorkOS returns on a refresh, to provision or update their row. */
  readonly provision: (user: WorkosUser) => Promise<void>;
  readonly context?: RequestContext;
  readonly fetcher?: typeof fetch;
  /** Seconds since the epoch. */
  readonly now?: number;
}

export type SessionOutcome =
  /** Signed in. `refreshed` is a new sealed session to set as the cookie, when WorkOS rotated it. */
  | { readonly kind: "valid"; readonly session: SessionData; readonly refreshed: string | null }
  /** Not a cookie this worker sealed: anonymous, and the cookie should be cleared. */
  | { readonly kind: "garbage" }
  /**
   * A real session WorkOS will no longer refresh: anonymous. The cookie is
   * left alone on purpose. A refresh token is single use, so of two requests
   * that race to refresh, the loser lands here; clearing the cookie on its
   * response could delete the session the winner just set.
   */
  | { readonly kind: "stale" };

/** The session a sign-in or a refresh starts: WorkOS's answer, with the `sid` read off its own token. */
export const sessionFromTokens = (
  user: WorkosUser,
  accessToken: string,
  refreshToken: string,
): SessionData => {
  const sid = unverifiedClaims(accessToken)?.sid;
  return {
    userId: user.id,
    email: user.email,
    accessToken,
    refreshToken,
    sessionId: typeof sid === "string" ? sid : null,
  };
};

export const authenticateSession = async (
  sealed: string,
  deps: SessionDeps,
): Promise<SessionOutcome> => {
  const session = await unsealSession(sealed, deps.password);
  if (!session) return { kind: "garbage" };

  const verified = await verifyJwt(session.accessToken, deps.keys, deps.now);
  if (verified.ok) {
    // The cookie is ours, so the two always agree; a mismatch means a cookie
    // assembled from parts, which sealing rules out. Refuse it all the same.
    if (verified.claims.sub !== session.userId) return { kind: "garbage" };
    return { kind: "valid", session, refreshed: null };
  }

  // Expired, or signed by a key the set no longer has: WorkOS decides.
  let tokens;
  try {
    tokens = await refreshTokens(deps.config, session.refreshToken, deps.context, deps.fetcher);
  } catch (error) {
    // WorkOS refusing the token (4xx) ends the session. WorkOS being down
    // does not: that is a failed request, not a signed-out person.
    if (error instanceof WorkosError && error.status >= 400 && error.status < 500) {
      return { kind: "stale" };
    }
    throw error;
  }
  if (tokens.user.id !== session.userId) return { kind: "stale" };
  await deps.provision(tokens.user);
  const next = sessionFromTokens(tokens.user, tokens.accessToken, tokens.refreshToken);
  return { kind: "valid", session: next, refreshed: await sealSession(next, deps.password) };
};
