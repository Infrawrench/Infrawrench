/**
 * Inbound tracker webhooks for live issue status, the handlers.
 *
 * The Jira and Linear tokens identify the org (they are random, 43
 * characters, and unique), and an unknown token or a bad signature both
 * answer 404/401 without saying which part was wrong. The body is read as raw
 * text before anything parses it: every signature here is over the exact
 * bytes sent, and re-serialized JSON would not match.
 *
 * Deliberately served on the edge (not in `edge/gateway-routes.ts`): the work
 * is an HMAC, a few indexed Postgres reads and writes, and at most one HTTPS
 * read from the tracker's own API, and Linear gives a receiver five seconds
 * before it counts a delivery failed (and disables a webhook that keeps
 * failing). A Lambda cold start would spend most of that.
 *
 * Answers 202 once applied; a processing failure is a 500 so the tracker
 * retries (Jira up to five times, Linear three, GitHub not at all, which the
 * poll covers). A body past {@link MAX_WEBHOOK_BYTES} is a 413.
 */
import { Effect, Layer, Predicate } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { findJiraWebhookByToken, touchJiraWebhookDelivery } from "@infrawrench/server-core/jira";
import {
  findLinearWebhookByToken,
  touchLinearWebhookDelivery,
} from "@infrawrench/server-core/linear";
import {
  parseGithubWebhook,
  parseJiraWebhook,
  parseLinearWebhook,
  verifyHubSignature,
  verifyLinearSignature,
} from "@infrawrench/server-core/issue-status/readings";
import {
  applyGithubWebhook,
  applyJiraWebhook,
  applyLinearWebhook,
} from "@infrawrench/server-core/issue-status/sync";
import {
  InternalServerError,
  IssueWebhooksApi,
  notFound,
  PingAcknowledged,
  Unauthorized,
} from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy, legacyTry } from "../../legacy";
import { json } from "../../middleware";
import { respond } from "../../response";

/** Bodies past this are not a tracker webhook; refuse before hashing them. */
const MAX_WEBHOOK_BYTES = 2_000_000;

const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const invalidSignature = () => new Unauthorized({ error: "Invalid signature" });

/** The 413 for a body too large to be a tracker's delivery. */
const payloadTooLarge = () => json({ error: "Payload too large" }, 413);

/**
 * Run the apply step; any failure is logged and answered 500, which makes the
 * tracker retry.
 */
const applying = (tracker: string, apply: () => Promise<unknown>) =>
  legacyTry(apply, (err) => {
    console.error(`[issue-status] ${tracker} webhook failed:`, err);
    return new InternalServerError({ error: "Webhook processing failed" });
  }).pipe(Effect.as(HttpServerResponse.empty({ status: 202 })));

const JiraHandlers = HttpApiBuilder.group(IssueWebhooksApi, "jiraIssueWebhook", (handlers) =>
  handlers.handleRaw("receive", ({ request, params }) =>
    Effect.gen(function* () {
      const { token } = params;
      if (!TOKEN.test(token)) return yield* notFound();
      const body = yield* Effect.orDie(request.text);
      if (body.length > MAX_WEBHOOK_BYTES) return payloadTooLarge();
      const hook = yield* legacy(() => findJiraWebhookByToken(token));
      if (!hook) return yield* notFound();
      if (!verifyHubSignature(hook.secret, body, request.headers["x-hub-signature"])) {
        return yield* invalidSignature();
      }
      return yield* applying("Jira", async () => {
        await touchJiraWebhookDelivery(hook.organizationId);
        await applyJiraWebhook(hook.organizationId, parseJiraWebhook(parseJson(body)));
      });
    }),
  ),
);

const LinearHandlers = HttpApiBuilder.group(IssueWebhooksApi, "linearIssueWebhook", (handlers) =>
  handlers.handleRaw("receive", ({ request, params }) =>
    Effect.gen(function* () {
      const { token } = params;
      if (!TOKEN.test(token)) return yield* notFound();
      const body = yield* Effect.orDie(request.text);
      if (body.length > MAX_WEBHOOK_BYTES) return payloadTooLarge();
      const hook = yield* legacy(() => findLinearWebhookByToken(token));
      if (!hook) return yield* notFound();
      const parsed = parseJson(body);
      // The replay window: the signature check refuses a timestamp more than a
      // minute away, so a captured delivery cannot be sent again later.
      const timestamp = Predicate.hasProperty(parsed, "webhookTimestamp")
        ? parsed.webhookTimestamp
        : undefined;
      if (
        !verifyLinearSignature(hook.secret, body, request.headers["linear-signature"], timestamp)
      ) {
        return yield* invalidSignature();
      }
      return yield* applying("Linear", async () => {
        await touchLinearWebhookDelivery(hook.organizationId);
        await applyLinearWebhook(hook.organizationId, parseLinearWebhook(parsed));
      });
    }),
  ),
);

const GithubHandlers = HttpApiBuilder.group(IssueWebhooksApi, "githubIssueWebhook", (handlers) =>
  handlers.handleRaw("receive", ({ request }) =>
    Effect.gen(function* () {
      const secret = process.env["GITHUB_APP_WEBHOOK_SECRET"];
      // Without a secret there is nothing to verify against, and an unverified
      // delivery could rewrite any org's issue status.
      if (!secret) return yield* notFound();
      const body = yield* Effect.orDie(request.text);
      if (body.length > MAX_WEBHOOK_BYTES) return payloadTooLarge();
      if (!verifyHubSignature(secret, body, request.headers["x-hub-signature-256"])) {
        return yield* invalidSignature();
      }
      const event = request.headers["x-github-event"];
      // GitHub sends `ping` when the webhook is saved; answering it keeps the
      // App's delivery log green.
      if (event === "ping") return yield* respond(PingAcknowledged)({ ok: true });
      return yield* applying("GitHub", () =>
        applyGithubWebhook(parseGithubWebhook(event, parseJson(body))),
      );
    }),
  ),
);

export const issueWebhooksDomain = makeDomain(
  "issueWebhooks",
  IssueWebhooksApi,
  Layer.mergeAll(JiraHandlers, LinearHandlers, GithubHandlers),
);
