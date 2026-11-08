/**
 * The WorkOS sign-in callback, `GET /callback`, the handler.
 *
 * Every answer is the one the Hono route gave a browser: the same pages, the
 * same redirects, and the same cookies set and cleared in the same order. The
 * state cookie is cleared on every answer past the code check, a failure
 * after that point included, so a defect here renders as the API's errors do
 * with that `Set-Cookie` still on it, as Hono's `onError` sent it.
 *
 * The WorkOS client is imported when a code is exchanged, not with the
 * module: it refuses to load without its environment, and `DOMAINS` is
 * imported by the spec build.
 */
import { timingSafeEqual } from "node:crypto";
import { Cause, Effect } from "effect";
import type { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  OAUTH_COOKIE_MAX_AGE,
  OAUTH_RETRY_COOKIE,
  OAUTH_STATE_COOKIE,
  RETURN_TO_COOKIE,
  safeReturnPath,
} from "../../../api/oauth-state";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { renderDefect } from "../../middleware";
import { SESSION_COOKIE, sessionCookieOptions } from "../../session-cookie";
import {
  deleteCookie,
  htmlPage,
  plainText,
  queryParam,
  redirect,
  requestCookie,
  setCookie,
  withSteps,
} from "../raw-responses";
import { CallbackApi } from "./api";

/** Constant-time string comparison; returns false if lengths differ. */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Minimal HTML escape for provider-controlled strings rendered into the page. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Terminal page for a sign-in that could not be recovered automatically. Plain
 * text would leave the user stranded on a blank 400 with no way back, which is
 * exactly the trap this route used to be, so give them a link.
 *
 * `message` must already be HTML-safe; the default covers the missing-state
 * case this page was built for.
 */
function signInFailedPage(message?: string): string {
  const detail =
    message ??
    `Your browser did not send back the one-time token this sign-in started with.
    This usually means the sign-in was finished in a different browser than it
    was started in, or that cookies are blocked for this site.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in failed</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
  }
  main { max-width: 32rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1.5rem; opacity: 0.8; }
  a {
    display: inline-block; padding: 0.6rem 1.2rem; border-radius: 6px;
    background: currentColor; text-decoration: none;
  }
  a span { color: Canvas; }
</style>
</head>
<body>
<main>
  <h1>Sign-in could not be completed</h1>
  <p>${detail}</p>
  <a href="/api/auth/sign-in"><span>Try signing in again</span></a>
</main>
</body>
</html>`;
}

/** The sign-in round trip's cookies, as the sign-in route sets them. */
const oauthCookieOptions = () =>
  ({
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_COOKIE_MAX_AGE,
  }) as const;

const CallbackHandlers = HttpApiBuilder.group(CallbackApi, "callback", (handlers) =>
  handlers.handleRaw("callback", ({ request }) =>
    Effect.gen(function* () {
      const code = queryParam(request, "code");
      if (!code) {
        // WorkOS redirects back with `error` (and sometimes `error_description`)
        // instead of a code when sign-in fails on its side: an unknown user on
        // the dev emulator, a cancelled flow, a misconfigured connection. Surface
        // the reason; a bare 400 here reads like our bug instead of theirs.
        const providerError = queryParam(request, "error");
        if (providerError) {
          const description = queryParam(request, "error_description");
          const reason = escapeHtml(
            description ? `${providerError}: ${description}` : providerError,
          );
          return htmlPage(
            signInFailedPage(
              `The sign-in provider returned an error instead of completing sign-in:
          <strong>${reason}</strong>.`,
            ),
            400,
          );
        }
        return plainText("Missing code parameter", 400);
      }

      // Verify the OAuth `state` nonce matches the cookie set on sign-in.
      // Prevents login CSRF (forcing a victim to sign in as the attacker).
      const cookieState = requestCookie(request, OAUTH_STATE_COOKIE);
      const queryState = queryParam(request, "state");
      const alreadyRetried = requestCookie(request, OAUTH_RETRY_COOKIE) !== undefined;
      // Always clear the cookie regardless of outcome: it is single-use.
      const clearState = deleteCookie(OAUTH_STATE_COOKIE, "/");
      if (!cookieState || !queryState || !constantTimeEqual(cookieState, queryState)) {
        // A mismatch is usually not an attack: it is a state cookie that expired
        // or never arrived. Restart the flow once with a fresh nonce, which is what
        // the user would do by hand; the unverified `code` is simply dropped, so
        // this concedes nothing to the CSRF check it is recovering from. The retry
        // marker keeps a browser that can't hold the cookie from looping forever.
        if (!alreadyRetried) {
          // Carry the original destination across the restart. It came from our own
          // httpOnly cookie and is re-validated by the sign-in route, so round
          // -tripping it through the query string opens nothing new.
          const pending = safeReturnPath(requestCookie(request, RETURN_TO_COOKIE));
          const signIn = pending
            ? `/api/auth/sign-in?return_to=${encodeURIComponent(pending)}`
            : "/api/auth/sign-in";
          return withSteps(redirect(signIn), [
            clearState,
            setCookie(OAUTH_RETRY_COOKIE, "1", oauthCookieOptions()),
          ]);
        }
        return withSteps(htmlPage(signInFailedPage(), 400), [
          clearState,
          deleteCookie(OAUTH_RETRY_COOKIE, "/"),
          deleteCookie(RETURN_TO_COOKIE, "/"),
        ]);
      }

      const exchanged: Effect.Effect<HttpServerResponse.HttpServerResponse> = Effect.gen(
        function* () {
          const cookiePassword = process.env["WORKOS_COOKIE_PASSWORD"];
          if (!cookiePassword) {
            return yield* Effect.die(new Error("WORKOS_COOKIE_PASSWORD is required"));
          }

          const { sealedSession } = yield* legacy(async () => {
            const { workos, clientId } = await import("../../../auth/workos");
            return workos.userManagement.authenticateWithCode({
              code,
              clientId,
              session: { sealSession: true, cookiePassword },
            });
          });

          if (!sealedSession) {
            return withSteps(plainText("Failed to seal session", 500), [clearState]);
          }

          // Re-validate on the way out as well as on the way in: the cookie is ours and
          // httpOnly, but the redirect target is worth checking at the point of use.
          const returnTo = safeReturnPath(requestCookie(request, RETURN_TO_COOKIE));
          return withSteps(redirect(returnTo ?? "/"), [
            clearState,
            setCookie(SESSION_COOKIE, sealedSession, sessionCookieOptions()),
            // The flow completed, so the one-shot retry budget resets for next time.
            deleteCookie(OAUTH_RETRY_COOKIE, "/"),
            deleteCookie(RETURN_TO_COOKIE, "/"),
          ]);
        },
      );

      // A failure past this point (WorkOS refusing the code, a missing cookie
      // password) is rendered as the API's errors are, keeping the cookie
      // deletion already made (as Hono's `onError` did while it served this).
      return yield* exchanged.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.succeed(withSteps(renderDefect(Cause.squash(cause)), [clearState])),
        ),
      );
    }),
  ),
);

export const callbackDomain = makeDomain("callback", CallbackApi, CallbackHandlers);
