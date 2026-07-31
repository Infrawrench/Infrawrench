import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const DigestSettings = strict({
  enabled: z.boolean().openapi({
    description:
      "Whether the weekly digest is enabled for this organization. Delivery targets are the Slack channels and Teams webhooks whose weeklyDigest trigger is on.",
  }),
  lastSentWeekStart: z.string().nullable().openapi({
    description:
      "Monday (ISO date, UTC) of the last week a digest covered, or null when none has been sent.",
  }),
  lastSentAt: z.string().datetime().nullable().openapi({
    description: "When the last digest was sent, or null when none has been sent.",
  }),
}).openapi("DigestSettings");

const DigestSettingsUpdate = strict({
  enabled: z.boolean(),
}).openapi("DigestSettingsUpdate");

const DigestSendResult = strict({
  ok: z.boolean(),
  attempted: z.number().int().openapi({
    description: "Deliveries attempted across Slack channels and Teams webhooks.",
  }),
  succeeded: z.number().int(),
}).openapi("DigestSendResult");

export function registerDigestPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/digest",
    tags: ["Weekly digest"],
    summary: "Get the organization's weekly digest settings",
    description:
      "The weekly digest is a Monday-morning summary of last week's spend (with week-over-week movers), sync incidents, and resource churn, delivered to the Slack channels and Teams webhooks opted into the weeklyDigest trigger.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Digest settings",
        content: { "application/json": { schema: DigestSettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/digest",
    tags: ["Weekly digest"],
    summary: "Enable or disable the weekly digest",
    description:
      "Enabling schedules the first digest for next Monday morning (07:00 UTC) rather than sending immediately — use POST /digest/send for an immediate one.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DigestSettingsUpdate } } },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: DigestSettings } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/digest/send",
    tags: ["Weekly digest"],
    summary: "Compose and send last week's digest now",
    description:
      "Ignores the schedule and the enabled flag — composes the digest for the last complete week and posts it to every opted-in channel. Fails when no Slack channel or Teams webhook has the weeklyDigest trigger on.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Delivery summary",
        content: { "application/json": { schema: DigestSendResult } },
      },
      400: ErrorResponses[400],
    },
  });
}
