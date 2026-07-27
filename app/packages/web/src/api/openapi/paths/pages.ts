import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const PageSource = z
  .string()
  .max(64)
  .openapi({
    example: "checkout-api",
    description:
      "Stable name for the system raising the page: letters, digits, `.`, `_` and `-`. " +
      "It is the notification's sender, and it scopes the cooldown — two services paging under " +
      "the same key never throttle each other.",
  });

const PageRequest = strict({
  source: PageSource,
  message: z
    .string()
    .min(1)
    .max(2000)
    .describe("The alert text. Becomes the SMS and notification body."),
  title: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Short headline for the notification. Defaults to `source`."),
  key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      example: "db-replica-lag",
      description:
        "Throttle key, `default` when unset. Pages sharing a key are suppressed while that key " +
        "is in cooldown, so a per-object key (a host, a cluster id) alerts per object while the " +
        "default key alerts once for the whole source.",
    }),
  cooldownMinutes: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .optional()
    .describe(
      "Minutes to suppress repeat pages under the same key. Defaults to 60; `0` sends every time.",
    ),
  voice: z
    .boolean()
    .optional()
    .describe(
      "Also place a voice call to recipients who opted into voice. Off by default — reserve it " +
        "for things worth waking someone up for.",
    ),
}).openapi("PageRequest");

const PageResponse = strict({
  delivered: z.boolean().describe("True when at least one recipient was reached on any transport."),
  suppressed: z.boolean().describe("True when the key was still in cooldown, so nothing was sent."),
  sms: z.number().int().describe("Twilio deliveries (SMS + voice) that Twilio accepted."),
  push: z.number().int().describe("Push notifications accepted by Expo."),
  slack: z.number().int().describe("Slack channel posts Slack accepted."),
  msTeams: z.number().int().describe("Microsoft Teams webhook posts Teams accepted."),
  retryAt: IsoDateTime.optional().describe(
    "When suppressed, the time at which this key can page again.",
  ),
}).openapi("PageResponse");

const PageClearResponse = strict({
  cleared: z.boolean().describe("False when the key had no cooldown to clear."),
}).openapi("PageClearResponse");

export function registerPagePaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/pages",
    tags: ["Pages"],
    summary: "Raise an alert to the organization's on-call transports",
    description:
      "Fans an alert out over whatever the org has configured — Twilio SMS (and voice on " +
      "request), mobile push, Slack channels, and Microsoft Teams webhooks — honouring each " +
      "recipient's opt-ins. This is the same alert a workflow raises with `infra.page(...)`, for " +
      "code that runs somewhere Infrawrench does not: a health check, a deploy script, a cron on " +
      "a box.\n\n" +
      "Repeat pages under the same `(source, key)` are **suppressed, not rejected**: a monitor " +
      "that fires every minute pages once and then gets `200` with `suppressed: true` and the " +
      "`retryAt` at which the key can page again. A page that reached nobody does not start a " +
      "cooldown, so the next call tries again.\n\n" +
      "Recipients opt in per channel under the same setting that covers workflow pages.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: PageRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Delivery outcome — check `suppressed` and `delivered`.",
        content: { "application/json": { schema: PageResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/pages",
    tags: ["Pages"],
    summary: "Clear a page key's cooldown",
    description:
      "Drops the cooldown for one `(source, key)` so the next page under it delivers immediately. " +
      "Call it when the condition you alerted on recovers — the workflow equivalent is " +
      "`infra.page.clear(key)`. Clearing a key that was never paged is not an error.",
    request: {
      params: OrgIdParam,
      query: strict({
        source: PageSource,
        key: z.string().max(200).optional().describe("Defaults to `default`."),
      }),
    },
    responses: {
      200: {
        description: "Whether a cooldown was cleared",
        content: { "application/json": { schema: PageClearResponse } },
      },
      400: ErrorResponses[400],
    },
  });
}
