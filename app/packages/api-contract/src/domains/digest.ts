/**
 * Weekly digest settings: `/api/org/:orgId/digest`, the endpoint definitions.
 *
 * The digest itself is composed and sent by the poller
 * (`server-core/src/digest/weekly.ts`); these endpoints carry the org-level
 * settings, the last-attempt bookkeeping, the email recipient list and a
 * "send now". Slack and Teams opt in through alert routing; email is a
 * digest-only transport, so its recipients live here. All `org:settings:write`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { optionalRequestBody } from "../http/schemas/documented";
import { IsoDateTime, OrgParams } from "../http/schemas/common";

const DigestStatus = Schema.Literals([
  "pending",
  "succeeded",
  "partial",
  "failed",
  "no_targets",
]).annotate({
  description:
    "Outcome of the most recent delivery attempt. `partial` (some destinations took it, some failed) is deliberately never retried automatically; a retry would post the digest twice where it already landed. `failed` (nothing landed) is retried a bounded number of times with backoff, then parked until the next week.",
});

const SendDay = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 }));
const SendHour = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 }));

export const DigestSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description:
      "Whether the weekly digest is enabled for this organization. Delivery targets are the Slack channels and Teams webhooks whose weeklyDigest trigger is on, plus the organization's digest email recipients.",
  }),
  lastSentWeekStart: Schema.NullOr(Schema.String).annotate({
    description:
      "Monday (ISO date, in the organization's timezone) of the last week a digest covered, or null when none has been sent.",
  }),
  lastSentAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When a digest last actually reached a destination, or null if none ever has.",
  }),
  timezone: Schema.String.annotate({
    description:
      "IANA time zone the schedule and the Monday-to-Sunday week boundary are expressed in. Defaults to UTC.",
    examples: ["Europe/Berlin"],
  }),
  sendDay: SendDay.annotate({
    description: "ISO day of week the digest is sent on: 1 = Monday … 7 = Sunday.",
  }),
  sendHour: SendHour.annotate({
    description: "Local hour (0–23) in `timezone` the digest is sent at.",
  }),
  narrativeEnabled: Schema.Boolean.annotate({
    description:
      "Whether an AI-written summary paragraph is placed above the deterministic content. Opt-in, default off. Failures are non-fatal: the digest still sends without the paragraph.",
  }),
  narrativeAvailable: Schema.Boolean.annotate({
    description:
      "Whether this deployment has an LLM API key configured. False means enabling the narrative has no effect.",
  }),
  emailAvailable: Schema.Boolean.annotate({
    description:
      "Whether this deployment has a mail provider configured. False means email recipients are never delivered to.",
  }),
  attemptCount: Schema.Int.annotate({
    description: "Delivery attempts made for lastSentWeekStart's window, including the first.",
  }),
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  lastStatus: Schema.NullOr(DigestStatus),
  lastError: Schema.NullOr(Schema.String).annotate({
    description: "Why the last attempt was not a clean success, for display in the settings UI.",
  }),
  nextAttemptAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the next automatic retry is due, or null when none is scheduled.",
  }),
}).annotate({ identifier: "DigestSettings" });

const DigestSettingsUpdate = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  timezone: Schema.optionalKey(
    Schema.String.annotate({
      description: "IANA time zone name. Rejected with 400 if the server does not know the zone.",
      examples: ["America/New_York"],
    }),
  ),
  sendDay: Schema.optionalKey(SendDay),
  sendHour: Schema.optionalKey(SendHour),
  narrativeEnabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "DigestSettingsUpdate" });

const DigestTransportResult = Schema.Struct({
  attempted: Schema.Int,
  succeeded: Schema.Int,
}).annotate({ identifier: "DigestTransportResult" });

export const DigestSendResult = Schema.Struct({
  ok: Schema.Boolean,
  attempted: Schema.Int.annotate({
    description: "Deliveries attempted across Slack channels, Teams webhooks and email recipients.",
  }),
  succeeded: Schema.Int,
  slack: DigestTransportResult,
  teams: DigestTransportResult,
  email: DigestTransportResult,
}).annotate({ identifier: "DigestSendResult" });

export const DigestEmailRecipient = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
}).annotate({ identifier: "DigestEmailRecipient" });

export const DigestEmailRecipientList = Schema.Struct({
  recipients: Schema.Array(DigestEmailRecipient),
}).annotate({ identifier: "DigestEmailRecipientList" });

const DigestEmailRecipientCreate = Schema.Struct({
  email: Schema.String.annotate({ examples: ["finance@example.com"] }),
}).annotate({ identifier: "DigestEmailRecipientCreate" });

export const DigestRemoved = Schema.Struct({ ok: Schema.Boolean });

export class DigestGroup extends HttpApiGroup.make("digest")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      success: DigestSettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's weekly digest settings")
      .annotate(
        OpenApi.Description,
        "The weekly digest is a summary of the last complete Monday-to-Sunday week's spend (with week-over-week movers), sync incidents, and resource churn, delivered to the Slack channels and Teams webhooks opted into the weeklyDigest trigger and to the organization's digest email recipients. The response also carries the outcome of the most recent delivery attempt so a silently failing digest is visible.",
      )
      .annotate(SuccessDescription, "Digest settings"),
    // Checked field by field, each refusal naming its field.
    HttpApiEndpoint.put("update", "/", {
      params: OrgParams,
      payload: DigestSettingsUpdate,
      success: DigestSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update the weekly digest settings")
      .annotate(
        OpenApi.Description,
        "Every field is optional. Enabling schedules the first digest for the next configured send time rather than sending immediately; use POST /digest/send for an immediate one. The week boundary follows `timezone`, so the reported window is always the organization's own local Monday-to-Sunday week. Changing the schedule clears any parked failure state but never replays a week that already went out.",
      )
      .annotate(SuccessDescription, "The updated settings")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("send", "/send", {
      params: OrgParams,
      success: DigestSendResult,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Compose and send last week's digest now")
      .annotate(
        OpenApi.Description,
        "Ignores the schedule and the enabled flag; composes the digest for the last complete week and sends it to every opted-in channel and email recipient. This is also the manual recovery for a partial delivery, which is never retried automatically. Fails when nothing is routed to receive the digest, or when every destination rejected it.",
      )
      .annotate(SuccessDescription, "Delivery summary, broken down per transport"),
    HttpApiEndpoint.get("recipients", "/recipients", {
      params: OrgParams,
      success: DigestEmailRecipientList,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List the organization's digest email recipients")
      .annotate(
        OpenApi.Description,
        "Email is a digest-only transport, so its destinations are an organization-level address list rather than a per-channel trigger. Addresses need not belong to Infrawrench users; a finance alias is a valid recipient.",
      )
      .annotate(SuccessDescription, "The recipient list"),
    HttpApiEndpoint.post("addRecipient", "/recipients", {
      params: OrgParams,
      payload: DigestEmailRecipientCreate,
      success: DigestEmailRecipient,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Add a digest email recipient")
      .annotate(
        OpenApi.Description,
        "Adding an address the organization already has is a no-op that returns the existing entry, so a double submit cannot double-deliver.",
      )
      .annotate(SuccessDescription, "The recipient")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("removeRecipient", "/recipients/:recipientId", {
      params: {
        ...OrgParams,
        recipientId: Schema.String.annotate({ description: "Recipient id" }),
      },
      success: DigestRemoved,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Remove a digest email recipient")
      .annotate(SuccessDescription, "Removed"),
  )
  .prefix("/api/org/:orgId/digest")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Weekly digest") {}

export class DigestApi extends withApiDefaults(HttpApi.make("digest").add(DigestGroup)) {}
