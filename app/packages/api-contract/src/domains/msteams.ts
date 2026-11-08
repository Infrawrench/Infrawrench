/**
 * Microsoft Teams channel routing: `/api/org/:orgId/msteams`, the endpoint
 * definitions.
 *
 * Mounted at `msteams` rather than `teams` because `/api/org/:orgId/team`
 * already means the org's members. The webhook URL is a bearer credential and
 * no response carries it: clients only ever see `urlHint`. Everything is
 * `org:settings:write`, the alert-routing stance.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { optionalRequestBody } from "../http/schemas/documented";
import { Ok, OrgParams } from "../http/schemas/common";
import { isUrl } from "../http/schemas/issue-status";

export const MsTeamsWebhook = Schema.Struct({
  id: Schema.String,
  label: Schema.String.annotate({ description: "Display name for the channel, e.g. #alerts" }),
  urlHint: Schema.String.annotate({
    description:
      "Non-secret hint at the stored webhook URL (host and last four characters). The URL itself is never returned.",
  }),
}).annotate({ identifier: "MsTeamsWebhook" });

export const MsTeamsStatus = Schema.Struct({
  webhooks: Schema.Array(MsTeamsWebhook),
}).annotate({ identifier: "MsTeamsStatus" });

const MsTeamsWebhookCreate = Schema.Struct({
  label: Schema.String,
  url: Schema.String.check(isUrl).annotate({
    description:
      "The webhook URL from a Teams 'Workflows' automation. Must be https and on a Microsoft-operated host (*.api.powerautomate.com, *.api.powerplatform.com, *.logic.azure.com, *.flow.microsoft.com, or a legacy *.webhook.office.com connector).",
  }),
}).annotate({ identifier: "MsTeamsWebhookCreate" });

const MsTeamsWebhookUpdate = Schema.Struct({ label: Schema.String }).annotate({
  identifier: "MsTeamsWebhookUpdate",
});

export const MsTeamsTestResult = Schema.Struct({
  ok: Schema.Boolean,
  webhookCount: Schema.Int,
  attempted: Schema.Int,
  succeeded: Schema.Int,
});

const WebhookParams = { ...OrgParams, id: Schema.String } as const;

export class MsTeamsGroup extends HttpApiGroup.make("msteams")
  .add(
    HttpApiEndpoint.get("status", "/status", {
      params: OrgParams,
      success: MsTeamsStatus,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List the organization's Teams channels")
      .annotate(
        OpenApi.Description,
        "Returns the Teams channels alerts can be routed to. Which alerts reach each one is decided by /alert-rules. Webhook URLs are never included.",
      )
      .annotate(SuccessDescription, "Routed channels"),
    // The body is checked by hand (`label is required`), as it always was.
    HttpApiEndpoint.post("addWebhook", "/webhooks", {
      params: OrgParams,
      payload: MsTeamsWebhookCreate,
      success: MsTeamsWebhook,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Connect a Teams channel as an alert destination")
      .annotate(
        OpenApi.Description,
        "Adds a channel by webhook URL, or updates the one already holding that URL. Which alerts reach it is decided by /alert-rules; connecting a channel routes nothing to it on its own. Responds 400 when the URL is not https or its host is not Microsoft-operated.",
      )
      .annotate(SuccessDescription, "The channel routing")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.patch("renameWebhook", "/webhooks/:id", {
      params: WebhookParams,
      payload: MsTeamsWebhookUpdate,
      success: MsTeamsWebhook,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Rename a Teams channel")
      .annotate(
        OpenApi.Description,
        "The webhook URL is immutable; remove the channel and re-add it to change it.",
      )
      .annotate(SuccessDescription, "The updated channel routing")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("deleteWebhook", "/webhooks/:id", {
      params: WebhookParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Disconnect a Teams channel")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.post("test", "/test", {
      params: OrgParams,
      success: MsTeamsTestResult,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Post a test card to every configured Teams channel")
      .annotate(
        OpenApi.Description,
        "Ignores routing rules; every channel gets the test. Fails with the error Microsoft returned when nothing could be delivered (HTTP 404 usually means the Workflow was deleted or turned off).",
      )
      .annotate(SuccessDescription, "Delivery summary"),
  )
  .prefix("/api/org/:orgId/msteams")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Microsoft Teams") {}

export class MsTeamsApi extends withApiDefaults(HttpApi.make("msteams").add(MsTeamsGroup)) {}
