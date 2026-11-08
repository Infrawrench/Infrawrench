/**
 * The browser half of the Slack install (`/api/slack/oauth/*`), outside the
 * org tree. The org-scoped half (status, the "Add to Slack" URL, the channel
 * picker and channel routing) is on HttpApi in `http/domains/slack`, whose
 * `install-url` mints the signed `state` these hops check:
 *  - `start`: the URL `install-url` hands back. Requires the web session of
 *    the user who asked for it (bouncing through sign-in when the browser has
 *    none, as it won't when desktop or mobile opens the system browser), drops
 *    the state's nonce into an HttpOnly cookie, and redirects to Slack.
 *  - `callback`: Slack redirects here after approval; it needs both a valid,
 *    unexpired signed state and that browser's matching nonce cookie before it
 *    exchanges the code for a bot token.
 * A signed state alone is not enough, or an admin of one org could send an
 * install link to another company's Slack admin and collect their workspace's
 * bot token under their own org.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  exchangeSlackCode,
  recordSlackInstall,
  SLACK_STATE_TTL_MS,
  slackAuthorizeUrl,
  slackStateNonceMatches,
  verifySlackState,
} from "@infrawrench/server-core/slack";
import { sessionMiddleware, type AuthSession } from "../auth-middleware";
import { safeReturnPath } from "../oauth-state";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

function appUrl(): string {
  return process.env["APP_URL"] ?? "http://localhost:3000";
}

/**
 * The redirect target registered in the Slack app config. Slack requires the
 * value sent to `oauth.v2.access` to match the one sent to `authorize`, so both
 * sides derive it here.
 */
function redirectUri(): string {
  return `${appUrl().replace(/\/$/, "")}/api/slack/oauth/callback`;
}

/**
 * Holds the install nonce in the browser that started the install. Scoped to
 * the two OAuth hops so it rides nothing else; Lax so it survives Slack's
 * top-level redirect back to the callback.
 */
const SLACK_OAUTH_COOKIE = "iw_slack_oauth";
const SLACK_OAUTH_COOKIE_PATH = "/api/slack/oauth";

export const slackOauthRoute = new Hono();

/**
 * First browser hop of an install. Only the user the state was minted for may
 * pass: anyone else holding the link (because it was forwarded to them) gets
 * the error toast, and never the nonce cookie the callback insists on.
 */
slackOauthRoute.get("/slack/oauth/start", async (c) => {
  const state = c.req.query("state") ?? "";
  const verified = verifySlackState(state);
  if (!verified) return c.redirect(`${appUrl()}/?slack=error`);

  // Signed out (typical when desktop or mobile opened the system browser):
  // sign in, then land back here with the same state.
  if (!getCookie(c, "wos-session")) {
    const returnTo = safeReturnPath(`/api/slack/oauth/start?state=${encodeURIComponent(state)}`);
    return c.redirect(`/api/auth/sign-in?return_to=${encodeURIComponent(returnTo ?? "/")}`);
  }
  const denied = await sessionMiddleware(c, async () => {});
  if (denied instanceof Response) return denied;
  if (c.get("session")?.userId !== verified.userId) {
    console.warn(
      `[slack] install link for org ${verified.organizationId} opened by a different user; refused`,
    );
    return c.redirect(`${appUrl()}/?slack=error`);
  }

  setCookie(c, SLACK_OAUTH_COOKIE, verified.nonce, {
    path: SLACK_OAUTH_COOKIE_PATH,
    httpOnly: true,
    sameSite: "Lax",
    secure: appUrl().startsWith("https://"),
    maxAge: SLACK_STATE_TTL_MS / 1000,
  });
  return c.redirect(slackAuthorizeUrl(state, redirectUri()));
});

/**
 * OAuth callback. Slack sends `code` and our signed `state` here after the user
 * approves the install (or `error=access_denied` if they cancel). The nonce
 * cookie is consumed whatever the outcome, so a state completes at most once
 * per browser.
 */
slackOauthRoute.get("/slack/oauth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const verified = verifySlackState(state);
  const denied = c.req.query("error");
  const code = c.req.query("code");
  const nonce = getCookie(c, SLACK_OAUTH_COOKIE);
  deleteCookie(c, SLACK_OAUTH_COOKIE, { path: SLACK_OAUTH_COOKIE_PATH });

  if (!verified || !slackStateNonceMatches(verified, nonce)) {
    // Expired, forged, or finished in a browser that did not start it. Without
    // a trustworthy state the root is the best we can do; the root layout
    // surfaces the `slack` param as a toast.
    if (verified) {
      console.warn(
        `[slack] install callback for org ${verified.organizationId} without the starting browser's nonce; refused`,
      );
    }
    return c.redirect(`${appUrl()}/?slack=error`);
  }

  const { organizationId, userId } = verified;
  const returnUrl = (result: string) =>
    `${appUrl()}/org/${organizationId}/settings/paging?slack=${result}`;

  if (denied || !code) {
    console.log(`[slack] install cancelled for org ${organizationId}: ${denied ?? "no code"}`);
    return c.redirect(returnUrl("cancelled"));
  }

  try {
    const install = await exchangeSlackCode(code, redirectUri());
    await recordSlackInstall(organizationId, userId, install);
    console.log(
      `[slack] connected workspace ${install.teamName ?? install.teamId} to org ${organizationId}`,
    );
    return c.redirect(returnUrl("connected"));
  } catch (err) {
    console.error("[slack] install failed:", err);
    return c.redirect(returnUrl("error"));
  }
});
