/**
 * The browser half of the Slack install, `/api/slack/oauth/*`, the handlers.
 *
 *  - `start`: the URL `install-url` hands back. Requires the web session of
 *    the user who asked for it (bouncing through sign-in when the browser has
 *    none, as it won't when desktop or mobile opens the system browser), drops
 *    the state's nonce into an HttpOnly cookie, and redirects to Slack.
 *  - `callback`: Slack redirects here after approval; it needs both a valid,
 *    unexpired signed state and that browser's matching nonce cookie before it
 *    exchanges the code for a bot token.
 *
 * A signed state alone is not enough, or an admin of one org could send an
 * install link to another company's Slack admin and collect their workspace's
 * bot token under their own org.
 *
 * `start` authenticates the person in the handler, after the state check and
 * the signed-out bounce, by running {@link SessionAuth} itself: the same
 * middleware the session-only routes run, so a refused session is the same
 * 401 and a refreshed one is written back on the redirect.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  exchangeSlackCode,
  recordSlackInstall,
  SLACK_STATE_TTL_MS,
  slackAuthorizeUrl,
  slackStateNonceMatches,
  verifySlackState,
} from "@infrawrench/server-core/slack";
import { SessionAuth, SlackOAuthApi } from "@infrawrench/api-contract";
import { safeReturnPath } from "../../../api/oauth-state";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { SessionPrincipal } from "../../principal";
import { SESSION_COOKIE } from "../../session-cookie";
import {
  deleteCookie,
  queryParam,
  redirect,
  requestCookie,
  setCookie,
  withSteps,
} from "../raw-responses";

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

const SlackOAuthHandlers = HttpApiBuilder.group(
  SlackOAuthApi,
  "slackOAuth",
  Effect.fnUntraced(function* (handlers) {
    const sessionAuth = yield* SessionAuth;
    return handlers
      .handleRaw("start", ({ request, endpoint, group }) =>
        Effect.gen(function* () {
          // First browser hop of an install. Only the user the state was minted
          // for may pass: anyone else holding the link (because it was forwarded
          // to them) gets the error toast, and never the nonce cookie the
          // callback insists on.
          const state = queryParam(request, "state") ?? "";
          const verified = verifySlackState(state);
          if (!verified) return redirect(`${appUrl()}/?slack=error`);

          // Signed out (typical when desktop or mobile opened the system browser):
          // sign in, then land back here with the same state.
          if (!requestCookie(request, SESSION_COOKIE)) {
            const returnTo = safeReturnPath(
              `/api/slack/oauth/start?state=${encodeURIComponent(state)}`,
            );
            return redirect(`/api/auth/sign-in?return_to=${encodeURIComponent(returnTo ?? "/")}`);
          }
          return yield* sessionAuth(
            Effect.gen(function* () {
              const session = yield* SessionPrincipal;
              if (session.userId !== verified.userId) {
                console.warn(
                  `[slack] install link for org ${verified.organizationId} opened by a different user; refused`,
                );
                return redirect(`${appUrl()}/?slack=error`);
              }
              return withSteps(redirect(slackAuthorizeUrl(state, redirectUri())), [
                setCookie(SLACK_OAUTH_COOKIE, verified.nonce, {
                  path: SLACK_OAUTH_COOKIE_PATH,
                  httpOnly: true,
                  sameSite: "lax",
                  secure: appUrl().startsWith("https://"),
                  maxAge: SLACK_STATE_TTL_MS / 1000,
                }),
              ]);
            }),
            { endpoint, group },
          ).pipe(Effect.orDie);
        }),
      )
      .handleRaw("callback", ({ request }) =>
        Effect.gen(function* () {
          // Slack sends `code` and our signed `state` here after the user approves
          // the install (or `error=access_denied` if they cancel). The nonce cookie
          // is consumed whatever the outcome, so a state completes at most once
          // per browser.
          const state = queryParam(request, "state") ?? "";
          const verified = verifySlackState(state);
          const denied = queryParam(request, "error");
          const code = queryParam(request, "code");
          const nonce = requestCookie(request, SLACK_OAUTH_COOKIE);
          const consumeNonce = deleteCookie(SLACK_OAUTH_COOKIE, SLACK_OAUTH_COOKIE_PATH);

          if (!verified || !slackStateNonceMatches(verified, nonce)) {
            // Expired, forged, or finished in a browser that did not start it.
            // Without a trustworthy state the root is the best we can do; the
            // root layout surfaces the `slack` param as a toast.
            if (verified) {
              console.warn(
                `[slack] install callback for org ${verified.organizationId} without the starting browser's nonce; refused`,
              );
            }
            return withSteps(redirect(`${appUrl()}/?slack=error`), [consumeNonce]);
          }

          const { organizationId, userId } = verified;
          const returnUrl = (result: string) =>
            `${appUrl()}/org/${organizationId}/settings/paging?slack=${result}`;

          if (denied || !code) {
            console.log(
              `[slack] install cancelled for org ${organizationId}: ${denied ?? "no code"}`,
            );
            return withSteps(redirect(returnUrl("cancelled")), [consumeNonce]);
          }

          const result = yield* legacy(async () => {
            try {
              const install = await exchangeSlackCode(code, redirectUri());
              await recordSlackInstall(organizationId, userId, install);
              console.log(
                `[slack] connected workspace ${install.teamName ?? install.teamId} to org ${organizationId}`,
              );
              return "connected";
            } catch (err) {
              console.error("[slack] install failed:", err);
              return "error";
            }
          });
          return withSteps(redirect(returnUrl(result)), [consumeNonce]);
        }),
      );
  }),
);

export const slackOAuthDomain = makeDomain("slackOAuth", SlackOAuthApi, SlackOAuthHandlers);
