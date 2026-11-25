/**
 * The three browser routes of sign-in (`urls.ts` `AUTH_PATHS` in the
 * contract). Each takes the request and answers a `Response`; the worker's
 * router only has to send `/auth/sign-in`, `/auth/callback` and
 * `/auth/sign-out` here.
 *
 * 1. `/auth/sign-in?returnTo=/acme/infra` redirects to WorkOS AuthKit. It
 *    sets a short-lived nonce cookie and sends a sealed `state` carrying the
 *    same nonce and where to go afterwards.
 * 2. `/auth/callback?code=&state=` checks the state against the nonce cookie
 *    (a sign-in someone else started cannot be finished in this browser),
 *    exchanges the code, provisions the person, sets the session cookie and
 *    redirects to `returnTo`.
 * 3. `/auth/sign-out` (POST) clears the cookie and redirects to WorkOS's
 *    logout, which ends the AuthKit session and comes back to the site.
 */
import type { Env } from "../env";
import { siteOrigin } from "../env";
import { randomBytes, timingSafeEqualText, toBase64Url } from "./encoding";
import { sessionFromTokens } from "./session";
import {
  clearSessionCookie,
  clearStateCookie,
  isSecureRequest,
  parseCookies,
  seal,
  sealSession,
  sessionCookieName,
  setSessionCookie,
  setStateCookie,
  stateCookieName,
  unseal,
  unsealSession,
} from "./session-cookie";
import {
  type WorkosConfig,
  WorkosError,
  type WorkosUser,
  authorizationUrl,
  exchangeCode,
  logoutUrl,
  workosConfig,
} from "./workos";

/** The parts of a `Request` these routes read; structural, so tests pass plain objects. */
export interface IncomingRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: { get(name: string): string | null };
}

export interface SignInDeps {
  /** Provision the person's `users` and `git_users` rows: `db/users.ts` `provisionSignedInUser`. */
  readonly provision: (user: WorkosUser) => Promise<void>;
  readonly fetcher?: typeof fetch;
  /** For tests; `workosConfig(env)` otherwise. */
  readonly config?: WorkosConfig;
}

type AuthEnv = Pick<
  Env,
  | "WORKOS_API_KEY"
  | "WORKOS_CLIENT_ID"
  | "WORKOS_COOKIE_PASSWORD"
  | "WORKOS_API_HOSTNAME"
  | "SITE_ORIGIN"
>;

/**
 * Where to go after signing in: a path on this site, or the home page. A
 * `returnTo` that is anything else (another origin, a scheme-relative
 * `//host`, a backslash trick) is dropped, so sign-in is never an open
 * redirect.
 */
export const safeReturnTo = (value: string | null | undefined): string => {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || /[\u0000-\u001f]/.test(value)) return "/";
  // Never back into the sign-in routes themselves.
  if (value === "/auth" || value.startsWith("/auth/")) return "/";
  return value;
};

interface SignInState {
  readonly nonce: string;
  readonly returnTo: string;
}

const isSignInState = (value: unknown): value is SignInState =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>)["nonce"] === "string" &&
  typeof (value as Record<string, unknown>)["returnTo"] === "string";

const redirect = (location: string, cookies: readonly string[] = []): Response => {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
};

/** `GET /auth/sign-in`. */
export const handleSignIn = async (
  request: IncomingRequest,
  env: AuthEnv,
  deps: Pick<SignInDeps, "config"> = {},
): Promise<Response> => {
  const config = deps.config ?? workosConfig(env);
  const secure = isSecureRequest(request);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  const nonce = toBase64Url(randomBytes(24));
  const state = await seal({ nonce, returnTo } satisfies SignInState, env.WORKOS_COOKIE_PASSWORD);
  return redirect(authorizationUrl(config, state), [setStateCookie(nonce, secure)]);
};

/** Where a failed sign-in lands: the home page, saying so. Never echoes what WorkOS sent. */
const failed = (reason: "denied" | "state" | "exchange", secure: boolean): Response =>
  redirect(`/?auth_error=${reason}`, [clearStateCookie(secure)]);

/** `GET /auth/callback`. */
export const handleCallback = async (
  request: IncomingRequest,
  env: AuthEnv,
  deps: SignInDeps,
): Promise<Response> => {
  const config = deps.config ?? workosConfig(env);
  const secure = isSecureRequest(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const sealedState = params.get("state");
  if (params.get("error") !== null || !code) return failed("denied", secure);

  const nonce = parseCookies(request.headers.get("cookie")).get(stateCookieName(secure));
  const state = sealedState ? await unseal(sealedState, env.WORKOS_COOKIE_PASSWORD) : null;
  if (!nonce || !isSignInState(state) || !timingSafeEqualText(state.nonce, nonce)) {
    return failed("state", secure);
  }

  let tokens;
  try {
    tokens = await exchangeCode(
      config,
      code,
      {
        ipAddress: request.headers.get("cf-connecting-ip"),
        userAgent: request.headers.get("user-agent"),
      },
      deps.fetcher,
    );
  } catch (error) {
    if (error instanceof WorkosError && error.status < 500) return failed("exchange", secure);
    throw error;
  }

  await deps.provision(tokens.user);
  const session = sessionFromTokens(tokens.user, tokens.accessToken, tokens.refreshToken);
  const sealed = await sealSession(session, env.WORKOS_COOKIE_PASSWORD);
  return redirect(safeReturnTo(state.returnTo), [
    setSessionCookie(sealed, secure),
    clearStateCookie(secure),
  ]);
};

export interface SignedOut {
  /** The `Set-Cookie` line that clears the session. */
  readonly cookie: string;
  /** Where to send the browser next: WorkOS's logout when there was a session, else the home page. */
  readonly redirectTo: string;
}

/**
 * End the session: what both `POST /auth/sign-out` and the API's
 * `session.signOut` do. Idempotent; a request with no session just gets the
 * home page.
 */
export const signOut = async (
  request: IncomingRequest,
  env: AuthEnv,
  deps: Pick<SignInDeps, "config"> = {},
): Promise<SignedOut> => {
  const secure = isSecureRequest(request);
  const sealed = parseCookies(request.headers.get("cookie")).get(sessionCookieName(secure));
  const session = sealed ? await unsealSession(sealed, env.WORKOS_COOKIE_PASSWORD) : null;
  const config = deps.config ?? workosConfig(env);
  return {
    cookie: clearSessionCookie(secure),
    redirectTo: session?.sessionId
      ? logoutUrl(config, session.sessionId, `${siteOrigin(env)}/`)
      : "/",
  };
};

/**
 * Whether a state-changing request that rides on the cookie came from this
 * site. `SameSite=Lax` already keeps the cookie off cross-site POSTs; this is
 * the second lock, and the one that still holds for a browser that sends the
 * cookie anyway. A request with no `Origin` (curl, older clients) passes: it
 * carries no ambient cookie a page could abuse.
 */
export const isSameOrigin = (request: IncomingRequest, env: Pick<Env, "SITE_ORIGIN">): boolean => {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return true;
  }
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return origin === siteOrigin(env) || origin === new URL(request.url).origin;
};

/** `POST /auth/sign-out`. */
export const handleSignOut = async (
  request: IncomingRequest,
  env: AuthEnv,
  deps: Pick<SignInDeps, "config"> = {},
): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (!isSameOrigin(request, env)) return new Response("Forbidden", { status: 403 });
  const { cookie, redirectTo } = await signOut(request, env, deps);
  const headers = new Headers({ location: redirectTo, "cache-control": "no-store" });
  headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
};
