/**
 * The `wos-session` cookie, as the API writes it.
 *
 * Light on purpose (no auth chain, no database): the session-only domains
 * import it to clear the cookie on sign-out and account deletion, and the
 * auth middleware (`./middleware-live.ts`) to set the refreshed session.
 */
import { Duration, Effect, Option } from "effect";
import { Cookies, HttpEffect, HttpServerResponse } from "effect/http";

/** The session cookie the WorkOS session is sealed into. */
export const SESSION_COOKIE = "wos-session";

/** Lifetime of a refreshed session cookie in seconds, matching the callback's. */
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

/** The options a refreshed session cookie is set with; `maxAge` in seconds. */
export const sessionCookieOptions = () =>
  ({
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  }) as const;

/**
 * Keep a session WorkOS refreshed during authentication: every response to
 * this request sets it, success or refusal, as the Hono middleware did by
 * setting it before calling `next()`. Registered as a pre-response handler
 * because an endpoint's declared errors are encoded after the middleware has
 * returned, so mapping the middleware's own response would miss them, and a
 * refresh token WorkOS has already rotated is not one the browser can use
 * again.
 *
 * A response that already sets the cookie (sign-out, account deletion clear
 * it) keeps its own: the Hono handler's `deleteCookie` came after the
 * middleware's `setCookie`, so the clearing won there too.
 */
export const keepRefreshedSession = (sealed: string | undefined) =>
  sealed === undefined
    ? Effect.void
    : HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(
          Option.isSome(Cookies.get(response.cookies, SESSION_COOKIE))
            ? response
            : HttpServerResponse.setCookieUnsafe(response, SESSION_COOKIE, sealed, {
                ...sessionCookieOptions(),
                // A bare number is milliseconds to Effect's cookie encoder.
                maxAge: Duration.seconds(SESSION_COOKIE_MAX_AGE),
              }),
        ),
      );

/**
 * Clear the session cookie, byte for byte as Hono's
 * `deleteCookie(c, "wos-session", { path: "/" })` did (`Max-Age=0`, no
 * `Expires`, which Effect's `expireCookie` would add).
 */
export const expireSessionCookie = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setCookieUnsafe(response, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
