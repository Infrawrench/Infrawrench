/**
 * Paging: `POST /api/org/:orgId/pages` and `DELETE /api/org/:orgId/pages`,
 * the endpoint definitions.
 *
 * The same alert a workflow raises with `infra.page(...)`, for code that runs
 * somewhere Infrawrench does not. Outside the org tree's auth chain: it
 * authenticates itself (`http/org-request-caller.ts`), because an unattended
 * server has nothing but an `iwk_` key, and its refusals keep their
 * published sentences.
 *
 * The body decodes what the route's validator accepted; `source` is any
 * string there, checked by the handler against the shared slug rule
 * (`SOURCE_NAME_HELP`), so it is documented as the slug it must be.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { DocumentedPermission, InvalidRequestMessage, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest } from "../../errors";
import { IsoDateTime, OrgParams } from "../../schemas/common";
import { documentedAs, requiredQuery } from "../../schemas/documented";

const MAX_MESSAGE_LENGTH = 2_000;

/** A day of cooldown is the most a single call may ask for. */
const MAX_COOLDOWN_MINUTES = 1_440;

const PageSource = Schema.String.check(maxLength(64)).annotate({
  examples: ["checkout-api"],
  description:
    "Stable name for the system raising the page: letters, digits, `.`, `_` and `-`. " +
    "It is the notification's sender, and it scopes the cooldown; two services paging under " +
    "the same key never throttle each other.",
});

export const PageRequest = Schema.Struct({
  source: documentedAs(PageSource),
  message: Schema.String.check(minLength(1), maxLength(MAX_MESSAGE_LENGTH)).annotate({
    description: "The alert text. Becomes the SMS and notification body.",
  }),
  title: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(200)).annotate({
      description: "Short headline for the notification. Defaults to `source`.",
    }),
  ),
  key: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(200)).annotate({
      examples: ["db-replica-lag"],
      description:
        "Throttle key, `default` when unset. Pages sharing a key are suppressed while that key " +
        "is in cooldown, so a per-object key (a host, a cluster id) alerts per object while the " +
        "default key alerts once for the whole source.",
    }),
  ),
  cooldownMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_COOLDOWN_MINUTES })).annotate({
      description:
        "Minutes to suppress repeat pages under the same key. Defaults to 60; `0` sends every time.",
    }),
  ),
  voice: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Also place a voice call to recipients who opted into voice. Off by default; reserve it " +
        "for things worth waking someone up for.",
    }),
  ),
}).annotate({ identifier: "PageRequest" });

export const PageResponse = Schema.Struct({
  delivered: Schema.Boolean.annotate({
    description: "True when at least one recipient was reached on any transport.",
  }),
  suppressed: Schema.Boolean.annotate({
    description: "True when the key was still in cooldown, so nothing was sent.",
  }),
  sms: Schema.Int.annotate({
    description: "Twilio deliveries (SMS + voice) that Twilio accepted.",
  }),
  push: Schema.Int.annotate({ description: "Push notifications accepted by Expo." }),
  slack: Schema.Int.annotate({ description: "Slack channel posts Slack accepted." }),
  msTeams: Schema.Int.annotate({ description: "Microsoft Teams webhook posts Teams accepted." }),
  retryAt: Schema.optionalKey(
    IsoDateTime.annotate({
      description: "When suppressed, the time at which this key can page again.",
    }),
  ),
}).annotate({ identifier: "PageResponse" });

export const PageClearResponse = Schema.Struct({
  cleared: Schema.Boolean.annotate({ description: "False when the key had no cooldown to clear." }),
}).annotate({ identifier: "PageClearResponse" });

export class PagesGroup extends HttpApiGroup.make("pages")
  .add(
    HttpApiEndpoint.post("raise", "/", {
      params: OrgParams,
      payload: PageRequest,
      success: PageResponse,
      error: [BadRequest],
    })
      .annotate(OpenApi.Summary, "Raise an alert to the organization's on-call transports")
      .annotate(
        OpenApi.Description,
        "Fans an alert out over whatever the org has configured (Twilio SMS (and voice on " +
          "request), mobile push, Slack channels, and Microsoft Teams webhooks) honouring each " +
          "recipient's opt-ins. This is the same alert a workflow raises with `infra.page(...)`, for " +
          "code that runs somewhere Infrawrench does not: a health check, a deploy script, a cron on " +
          "a box.\n\n" +
          "Repeat pages under the same `(source, key)` are **suppressed, not rejected**: a monitor " +
          "that fires every minute pages once and then gets `200` with `suppressed: true` and the " +
          "`retryAt` at which the key can page again. A page that reached nobody does not start a " +
          "cooldown, so the next call tries again.\n\n" +
          "Recipients opt in per channel under the same setting that covers workflow pages.",
      )
      .annotate(SuccessDescription, "Delivery outcome: check `suppressed` and `delivered`.")
      .annotate(InvalidRequestMessage, "Invalid body")
      .annotate(DocumentedPermission, "pages:write"),
  )
  .add(
    HttpApiEndpoint.delete("clear", "/", {
      params: OrgParams,
      query: {
        source: Schema.optionalKey(documentedAs(PageSource)),
        key: Schema.optionalKey(
          documentedAs(
            Schema.String.check(maxLength(200)).annotate({ description: "Defaults to `default`." }),
          ),
        ),
      },
      success: PageClearResponse,
      error: [BadRequest],
    })
      .annotate(OpenApi.Summary, "Clear a page key's cooldown")
      .annotate(
        OpenApi.Description,
        "Drops the cooldown for one `(source, key)` so the next page under it delivers immediately. " +
          "Call it when the condition you alerted on recovers; the workflow equivalent is " +
          "`infra.page.clear(key)`. Clearing a key that was never paged is not an error.",
      )
      .annotate(SuccessDescription, "Whether a cooldown was cleared")
      .annotate(OpenApi.Transform, requiredQuery(["source"]))
      .annotate(DocumentedPermission, "pages:write"),
  )
  .prefix("/api/org/:orgId/pages")
  .annotate(OpenApi.Title, "Pages") {}

export class PagesApi extends withApiDefaults(HttpApi.make("pages").add(PagesGroup)) {}
