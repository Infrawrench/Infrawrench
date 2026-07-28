import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { timingSafeEqual } from "node:crypto";
import { workos, clientId } from "../../auth/workos";
import {
  OAUTH_STATE_COOKIE,
  RETURN_TO_COOKIE,
  OAUTH_RETRY_COOKIE,
  OAUTH_COOKIE_MAX_AGE,
  safeReturnPath,
} from "../oauth-state";

const app = new Hono();

/** Constant-time string comparison; returns false if lengths differ. */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Terminal page for a sign-in that could not be recovered automatically. Plain
 * text would leave the user stranded on a blank 400 with no way back, which is
 * exactly the trap this route used to be, so give them a link.
 */
function signInFailedPage(): string {
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
  <p>
    Your browser did not send back the one-time token this sign-in started with.
    This usually means the sign-in was finished in a different browser than it
    was started in, or that cookies are blocked for this site.
  </p>
  <a href="/api/auth/sign-in"><span>Try signing in again</span></a>
</main>
</body>
</html>`;
}

/** GET /callback — WorkOS OAuth callback */
app.get("/", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing code parameter", 400);
  }

  // Verify the OAuth `state` nonce matches the cookie set on sign-in.
  // Prevents login CSRF (forcing a victim to sign in as the attacker).
  const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
  const queryState = c.req.query("state");
  const alreadyRetried = getCookie(c, OAUTH_RETRY_COOKIE) !== undefined;
  // Always clear the cookie regardless of outcome — it is single-use.
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
  if (!cookieState || !queryState || !constantTimeEqual(cookieState, queryState)) {
    // A mismatch is usually not an attack — it is a state cookie that expired
    // or never arrived. Restart the flow once with a fresh nonce, which is what
    // the user would do by hand; the unverified `code` is simply dropped, so
    // this concedes nothing to the CSRF check it is recovering from. The retry
    // marker keeps a browser that can't hold the cookie from looping forever.
    if (!alreadyRetried) {
      setCookie(c, OAUTH_RETRY_COOKIE, "1", {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        sameSite: "lax",
        path: "/",
        maxAge: OAUTH_COOKIE_MAX_AGE,
      });
      // Carry the original destination across the restart. It came from our own
      // httpOnly cookie and is re-validated by the sign-in route, so round
      // -tripping it through the query string opens nothing new.
      const pending = safeReturnPath(getCookie(c, RETURN_TO_COOKIE));
      const signIn = pending
        ? `/api/auth/sign-in?return_to=${encodeURIComponent(pending)}`
        : "/api/auth/sign-in";
      return c.redirect(signIn);
    }
    deleteCookie(c, OAUTH_RETRY_COOKIE, { path: "/" });
    deleteCookie(c, RETURN_TO_COOKIE, { path: "/" });
    return c.html(signInFailedPage(), 400);
  }

  const cookiePassword = process.env["WORKOS_COOKIE_PASSWORD"];
  if (!cookiePassword) {
    throw new Error("WORKOS_COOKIE_PASSWORD is required");
  }

  const { sealedSession } = await workos.userManagement.authenticateWithCode({
    code,
    clientId,
    session: { sealSession: true, cookiePassword },
  });

  if (!sealedSession) {
    return c.text("Failed to seal session", 500);
  }

  setCookie(c, "wos-session", sealedSession, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 400, // ~13 months
  });

  // The flow completed, so the one-shot retry budget resets for next time.
  deleteCookie(c, OAUTH_RETRY_COOKIE, { path: "/" });

  // Re-validate on the way out as well as on the way in: the cookie is ours and
  // httpOnly, but the redirect target is worth checking at the point of use.
  const returnTo = safeReturnPath(getCookie(c, RETURN_TO_COOKIE));
  deleteCookie(c, RETURN_TO_COOKIE, { path: "/" });

  return c.redirect(returnTo ?? "/");
});

export { app as callbackRoutes };
