/**
 * Inbound Slack, the handlers. What a command or a button does is promise
 * code in `./operations.ts`; this is the wire.
 *
 * The two Slack endpoints refuse everything without a signing secret (503),
 * then verify Slack's signature over the body exactly as it arrived (401)
 * before anything parses it. The body reaches the verifier byte for byte: it
 * is read here with `request.text`, a UTF-8 decode of the untouched stream,
 * which is what Hono's `c.req.text()` was. `http/server.ts` rewrites a
 * form-encoded request's content type to JSON for HttpApi's decoder, but only
 * the header: the body stream is carried over unread, and a raw handler
 * decodes nothing.
 *
 * Both acknowledge inside Slack's 3-second window with an empty 200 and do the
 * work in the background (`keepAlive`, started before the response is sent);
 * every reply rides `response_url`.
 *
 * The link landing authenticates the person in the handler, by running
 * {@link SessionAuth} itself, after its signed-out bounce (GET) or its CSRF
 * check (POST), the order the Hono route checked them in.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Effect } from "effect";
import { HttpServerResponse, type HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import {
  isSlackInboundConfigured,
  postToSlackResponseUrl,
  verifySlackRequestSignature,
} from "@infrawrench/server-core/slack";
import { SessionAuth, SlackInboundApi } from "@infrawrench/api-contract";
import { safeReturnPath } from "../../../api/oauth-state";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { json } from "../../middleware";
import { SessionPrincipal } from "../../principal";
import { SESSION_COOKIE } from "../../session-cookie";
import {
  deleteCookie,
  htmlPage,
  queryParam,
  redirect,
  requestCookie,
  requestHeader,
  setCookie,
  withSteps,
} from "../raw-responses";
import {
  appUrl,
  blockActionsPayload,
  ephemeral,
  handleBlockAction,
  handleSlashCommand,
  linkRequestFor,
  renderLinkPage,
  storeSlackLink,
  type SlackReply,
} from "./operations";

/** Double-submit CSRF cookie for the link confirmation form. */
const SLACK_LINK_CSRF_COOKIE = "slack_link_csrf";
const SLACK_LINK_PATH = "/api/slack/link";

function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `c.body(null, 200)`: Slack's acknowledgement, an empty 200. */
const acknowledged = () => HttpServerResponse.empty({ status: 200 });

const slackError = () => redirect(`${appUrl()}/?slack=error`);

const SlackInboundHandlers = HttpApiBuilder.group(
  SlackInboundApi,
  "slackInbound",
  Effect.fnUntraced(function* (handlers) {
    const sessionAuth = yield* SessionAuth;

    /** The shared preamble: refuse unconfigured, then verify the signature on the raw body. */
    const verifiedRawBody = (
      request: HttpServerRequest.HttpServerRequest,
    ): Effect.Effect<
      { readonly rawBody: string } | { readonly refusal: HttpServerResponse.HttpServerResponse }
    > =>
      Effect.gen(function* () {
        if (!isSlackInboundConfigured()) {
          return {
            refusal: json(
              {
                error: "Slack slash commands and interactivity are not configured on this server.",
              },
              503,
            ),
          };
        }
        const rawBody = yield* Effect.orDie(request.text);
        const verified = verifySlackRequestSignature({
          rawBody,
          timestamp: requestHeader(request, "x-slack-request-timestamp"),
          signature: requestHeader(request, "x-slack-signature"),
        });
        if (!verified) return { refusal: json({ error: "Invalid Slack signature" }, 401) };
        return { rawBody };
      });

    return (
      handlers
        .handleRaw("commands", ({ request }) =>
          Effect.gen(function* () {
            const pre = yield* verifiedRawBody(request);
            if ("refusal" in pre) return pre.refusal;
            const params = new URLSearchParams(pre.rawBody);
            const teamId = params.get("team_id") ?? "";
            const slackUserId = params.get("user_id") ?? "";
            const responseUrl = params.get("response_url") ?? "";
            const text = params.get("text") ?? "";
            if (!teamId || !slackUserId || !responseUrl) {
              return json({ error: "Malformed command payload" }, 400);
            }
            // Acknowledge inside Slack's 3-second window *before* doing any real work
            // (a cost query or resource search can blow that budget) and deliver the
            // actual reply through response_url, which stays valid for 30 minutes.
            yield* fireAndForget(() =>
              keepAlive(
                (async () => {
                  let reply: SlackReply;
                  try {
                    reply = await handleSlashCommand({ teamId, slackUserId, text });
                  } catch (err) {
                    console.error("[slack] slash command failed:", err);
                    reply = ephemeral(
                      "Something went wrong running that command. Try again shortly.",
                    );
                  }
                  try {
                    await postToSlackResponseUrl(responseUrl, reply);
                  } catch (err) {
                    console.error("[slack] response_url post failed:", err);
                  }
                })(),
              ),
            );
            return acknowledged();
          }),
        )
        .handleRaw("interactions", ({ request }) =>
          Effect.gen(function* () {
            const pre = yield* verifiedRawBody(request);
            if ("refusal" in pre) return pre.refusal;
            const params = new URLSearchParams(pre.rawBody);
            const parsed = yield* Effect.result(
              Effect.try({
                try: (): unknown => JSON.parse(params.get("payload") ?? "null"),
                catch: () => "malformed",
              }),
            );
            if (parsed._tag === "Failure") {
              return json({ error: "Malformed interaction payload" }, 400);
            }
            const payload = blockActionsPayload(parsed.success);
            if (!payload) return acknowledged();
            // Same shape as /slack/commands: acknowledge now, work in the background.
            // All feedback rides response_url, chat.update, and threads.
            yield* fireAndForget(() =>
              keepAlive(handleBlockAction(payload)).catch((err: unknown) => {
                console.error("[slack] interaction failed:", err);
              }),
            );
            return acknowledged();
          }),
        )
        /**
         * Browser half of account linking. The Slack side handed the user a
         * signed token asserting "this Slack user in this workspace"; the session
         * here asserts the Infrawrench account. Membership of the token's org is
         * required before the pair is stored.
         *
         * The GET only *renders* a confirmation naming the Slack user and the
         * org: a state-changing write must not ride a URL that link unfurlers,
         * prefetchers and mail scanners follow. The write happens in the POST,
         * guarded by a double-submit CSRF pair: a cookie bound to this browser
         * session plus the same value echoed by the form. A cross-site page can
         * post the token, but it can neither read nor set that cookie.
         */
        .handleRaw("linkPage", ({ request, endpoint, group }) =>
          Effect.gen(function* () {
            const token = queryParam(request, "token") ?? "";
            // Signed out: bounce through sign-in and come back here.
            if (
              !requestCookie(request, SESSION_COOKIE) &&
              !requestHeader(request, "authorization")
            ) {
              const returnTo = safeReturnPath(`/api/slack/link?token=${encodeURIComponent(token)}`);
              return redirect(`/api/auth/sign-in?return_to=${encodeURIComponent(returnTo ?? "/")}`);
            }
            return yield* sessionAuth(
              Effect.gen(function* () {
                const session = yield* SessionPrincipal;
                if (!session.userId) return json({ error: "Unauthorized" }, 401);
                const verified = yield* legacy(() => linkRequestFor(session.userId, token));
                if (!verified) return slackError();
                const csrf = randomUUID();
                const page = yield* legacy(() => renderLinkPage(verified, token, csrf));
                return withSteps(htmlPage(page), [
                  setCookie(SLACK_LINK_CSRF_COOKIE, csrf, {
                    path: SLACK_LINK_PATH,
                    httpOnly: true,
                    sameSite: "lax",
                    secure: appUrl().startsWith("https://"),
                    maxAge: 15 * 60,
                  }),
                ]);
              }),
              { endpoint, group },
            ).pipe(Effect.orDie);
          }),
        )
        /** The confirmation form's target: validates the CSRF pair, then writes the link. */
        .handleRaw("link", ({ request, endpoint, group }) =>
          Effect.gen(function* () {
            const form = new URLSearchParams(yield* request.text);
            const token = form.get("token") ?? "";
            const formCsrf = form.get("csrf") ?? "";
            const cookieCsrf = requestCookie(request, SLACK_LINK_CSRF_COOKIE) ?? "";
            if (!formCsrf || !cookieCsrf || !timingSafeEqualStrings(formCsrf, cookieCsrf)) {
              return slackError();
            }
            return yield* sessionAuth(
              Effect.gen(function* () {
                const session = yield* SessionPrincipal;
                if (!session.userId) return json({ error: "Unauthorized" }, 401);
                const userId = session.userId;
                const verified = yield* legacy(() => linkRequestFor(userId, token));
                if (!verified) return slackError();
                yield* legacy(() => storeSlackLink(userId, verified));
                return withSteps(
                  redirect(
                    `${appUrl()}/org/${verified.organizationId}/settings/paging?slack=linked`,
                  ),
                  [deleteCookie(SLACK_LINK_CSRF_COOKIE, SLACK_LINK_PATH)],
                );
              }),
              { endpoint, group },
            );
          }).pipe(Effect.orDie),
        )
    );
  }),
);

export const slackInboundDomain = makeDomain("slackInbound", SlackInboundApi, SlackInboundHandlers);
