import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { timingSafeEqual } from "node:crypto";
import { workos, clientId } from "../../auth/workos";
import { OAUTH_STATE_COOKIE, RETURN_TO_COOKIE, safeReturnPath } from "../oauth-state";

const app = new Hono();

/** Constant-time string comparison; returns false if lengths differ. */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
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
  // Always clear the cookie regardless of outcome — it is single-use.
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
  if (!cookieState || !queryState || !constantTimeEqual(cookieState, queryState)) {
    return c.text("Invalid OAuth state", 400);
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

  // Re-validate on the way out as well as on the way in: the cookie is ours and
  // httpOnly, but the redirect target is worth checking at the point of use.
  const returnTo = safeReturnPath(getCookie(c, RETURN_TO_COOKIE));
  deleteCookie(c, RETURN_TO_COOKIE, { path: "/" });

  return c.redirect(returnTo ?? "/");
});

export { app as callbackRoutes };
