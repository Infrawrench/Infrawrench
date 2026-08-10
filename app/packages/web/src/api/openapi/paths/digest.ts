import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const DigestStatus = z.enum(["pending", "succeeded", "partial", "failed", "no_targets"]).openapi({
  description:
    "Outcome of the most recent delivery attempt. `partial` (some destinations took it, some failed) is deliberately never retried automatically — a retry would post the digest twice where it already landed. `failed` (nothing landed) is retried a bounded number of times with backoff, then parked until the next week.",
});

const DigestSettings = strict({
  enabled: z.boolean().openapi({
    description:
      "Whether the weekly digest is enabled for this organization. Delivery targets are the Slack channels and Teams webhooks whose weeklyDigest trigger is on, plus the organization's digest email recipients.",
  }),
  lastSentWeekStart: z.string().nullable().openapi({
    description:
      "Monday (ISO date, in the organization's timezone) of the last week a digest covered, or null when none has been sent.",
  }),
  lastSentAt: z.string().datetime().nullable().openapi({
    description: "When a digest last actually reached a destination, or null if none ever has.",
  }),
  timezone: z.string().openapi({
    description:
      "IANA time zone the schedule and the Monday-to-Sunday week boundary are expressed in. Defaults to UTC.",
    example: "Europe/Berlin",
  }),
  sendDay: z.number().int().min(1).max(7).openapi({
    description: "ISO day of week the digest is sent on: 1 = Monday … 7 = Sunday.",
  }),
  sendHour: z.number().int().min(0).max(23).openapi({
    description: "Local hour (0–23) in `timezone` the digest is sent at.",
  }),
  narrativeEnabled: z.boolean().openapi({
    description:
      "Whether an AI-written summary paragraph is placed above the deterministic content. Opt-in, default off. Failures are non-fatal: the digest still sends without the paragraph.",
  }),
  narrativeAvailable: z.boolean().openapi({
    description:
      "Whether this deployment has an LLM API key configured. False means enabling the narrative has no effect.",
  }),
  emailAvailable: z.boolean().openapi({
    description:
      "Whether this deployment has a mail provider configured. False means email recipients are never delivered to.",
  }),
  attemptCount: z.number().int().openapi({
    description: "Delivery attempts made for lastSentWeekStart's window, including the first.",
  }),
  lastAttemptAt: z.string().datetime().nullable(),
  lastStatus: DigestStatus.nullable(),
  lastError: z.string().nullable().openapi({
    description: "Why the last attempt was not a clean success, for display in the settings UI.",
  }),
  nextAttemptAt: z.string().datetime().nullable().openapi({
    description: "When the next automatic retry is due, or null when none is scheduled.",
  }),
}).openapi("DigestSettings");

const DigestSettingsUpdate = strict({
  enabled: z.boolean().optional(),
  timezone: z.string().optional().openapi({
    description: "IANA time zone name. Rejected with 400 if the server does not know the zone.",
    example: "America/New_York",
  }),
  sendDay: z.number().int().min(1).max(7).optional(),
  sendHour: z.number().int().min(0).max(23).optional(),
  narrativeEnabled: z.boolean().optional(),
}).openapi("DigestSettingsUpdate");

const DigestTransportResult = strict({
  attempted: z.number().int(),
  succeeded: z.number().int(),
}).openapi("DigestTransportResult");

const DigestSendResult = strict({
  ok: z.boolean(),
  attempted: z.number().int().openapi({
    description: "Deliveries attempted across Slack channels, Teams webhooks and email recipients.",
  }),
  succeeded: z.number().int(),
  slack: DigestTransportResult,
  teams: DigestTransportResult,
  email: DigestTransportResult,
}).openapi("DigestSendResult");

const DigestEmailRecipient = strict({
  id: z.string(),
  email: z.string(),
}).openapi("DigestEmailRecipient");

const DigestEmailRecipientList = strict({
  recipients: z.array(DigestEmailRecipient),
}).openapi("DigestEmailRecipientList");

const DigestEmailRecipientCreate = strict({
  email: z.string().openapi({ example: "finance@example.com" }),
}).openapi("DigestEmailRecipientCreate");

export function registerDigestPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/digest",
    tags: ["Weekly digest"],
    summary: "Get the organization's weekly digest settings",
    description:
      "The weekly digest is a summary of the last complete Monday-to-Sunday week's spend (with week-over-week movers), sync incidents, and resource churn, delivered to the Slack channels and Teams webhooks opted into the weeklyDigest trigger and to the organization's digest email recipients. The response also carries the outcome of the most recent delivery attempt so a silently failing digest is visible.",
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
    summary: "Update the weekly digest settings",
    description:
      "Every field is optional. Enabling schedules the first digest for the next configured send time rather than sending immediately — use POST /digest/send for an immediate one. The week boundary follows `timezone`, so the reported window is always the organization's own local Monday-to-Sunday week. Changing the schedule clears any parked failure state but never replays a week that already went out.",
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
      "Ignores the schedule and the enabled flag — composes the digest for the last complete week and sends it to every opted-in channel and email recipient. This is also the manual recovery for a partial delivery, which is never retried automatically. Fails when nothing is routed to receive the digest, or when every destination rejected it.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Delivery summary, broken down per transport",
        content: { "application/json": { schema: DigestSendResult } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/digest/recipients",
    tags: ["Weekly digest"],
    summary: "List the organization's digest email recipients",
    description:
      "Email is a digest-only transport, so its destinations are an organization-level address list rather than a per-channel trigger. Addresses need not belong to Infrawrench users — a finance alias is a valid recipient.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The recipient list",
        content: { "application/json": { schema: DigestEmailRecipientList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/digest/recipients",
    tags: ["Weekly digest"],
    summary: "Add a digest email recipient",
    description:
      "Adding an address the organization already has is a no-op that returns the existing entry, so a double submit cannot double-deliver.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DigestEmailRecipientCreate } } },
    },
    responses: {
      200: {
        description: "The recipient",
        content: { "application/json": { schema: DigestEmailRecipient } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/digest/recipients/{recipientId}",
    tags: ["Weekly digest"],
    summary: "Remove a digest email recipient",
    request: {
      params: OrgIdParam.extend({
        recipientId: z
          .string()
          .openapi({ param: { name: "recipientId", in: "path" }, description: "Recipient id" }),
      }),
    },
    responses: {
      200: {
        description: "Removed",
        content: { "application/json": { schema: strict({ ok: z.boolean() }) } },
      },
      404: ErrorResponses[404],
    },
  });
}
