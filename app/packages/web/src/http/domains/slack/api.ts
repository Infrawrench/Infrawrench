/**
 * Slack connection and channel routing: `/api/org/:orgId/slack`, the endpoint
 * definitions.
 *
 * Connection status, the "Add to Slack" URL (a signed `state` binding the
 * install to this org and caller), the channel picker, and the channels alert
 * rules can name. All `org:settings:write`. The browser half of the install
 * (`/api/slack/oauth/start` and `/callback`) is outside the org tree, the
 * `slack-oauth` domain; the inbound Slack endpoints are `slack-inbound`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { optionalRequestBody } from "../../schemas/documented";
import { Ok, OrgParams } from "../../schemas/common";
import { isUrl } from "../../schemas/issue-status";

const SlackInstallation = Schema.Struct({
  id: Schema.String.annotate({ description: "Infrawrench id for this workspace connection" }),
  teamId: Schema.String.annotate({ description: "Slack workspace id (T…)" }),
  teamName: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SlackInstallation" });

export const SlackChannel = Schema.Struct({
  id: Schema.String,
  installationId: Schema.String,
  channelId: Schema.String.annotate({ description: "Slack channel id (C…/G…)" }),
  channelName: Schema.String.annotate({ description: "Channel name without the leading #" }),
  isPrivate: Schema.Boolean,
}).annotate({ identifier: "SlackChannel" });

export const SlackStatus = Schema.Struct({
  configured: Schema.Boolean.annotate({
    description: "True when this deployment has a Slack app registered",
  }),
  installations: Schema.Array(SlackInstallation),
  channels: Schema.Array(SlackChannel),
}).annotate({ identifier: "SlackStatus" });

const SlackAvailableChannel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isPrivate: Schema.Boolean,
}).annotate({ identifier: "SlackAvailableChannel" });

export const SlackAvailableChannels = Schema.Struct({
  channels: Schema.Array(SlackAvailableChannel),
});

const SlackChannelCreate = Schema.Struct({
  installationId: Schema.String,
  channelId: Schema.String,
  channelName: Schema.String,
  isPrivate: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "SlackChannelCreate" });

const SlackChannelUpdate = Schema.Struct({ channelName: Schema.String }).annotate({
  identifier: "SlackChannelUpdate",
});

export const SlackInstallUrl = Schema.Struct({ url: Schema.String.check(isUrl) });

export const SlackTestResult = Schema.Struct({
  ok: Schema.Boolean,
  channelCount: Schema.Int,
  attempted: Schema.Int,
  succeeded: Schema.Int,
});

const InstallationParams = { ...OrgParams, installationId: Schema.String } as const;
const ChannelParams = { ...OrgParams, id: Schema.String } as const;

export class SlackGroup extends HttpApiGroup.make("slack")
  .add(
    HttpApiEndpoint.get("status", "/status", {
      params: OrgParams,
      success: SlackStatus,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's Slack connection")
      .annotate(
        OpenApi.Description,
        "Reports whether the server has a Slack app registered, which workspaces this organization has connected, and which channels alerts are routed to.",
      )
      .annotate(SuccessDescription, "Connection status"),
    HttpApiEndpoint.get("installUrl", "/install-url", {
      params: OrgParams,
      success: SlackInstallUrl,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the Add to Slack URL")
      .annotate(
        OpenApi.Description,
        "Returns a URL on this server (/api/slack/oauth/start) carrying a signed `state` that binds the resulting install to this organization and to the calling user. Open it in that user's browser within 30 minutes: it asks them to sign in if needed, then redirects to Slack's approval screen, and Slack redirects back to /api/slack/oauth/callback. The install only completes in the browser that opened the link as that user.",
      )
      .annotate(SuccessDescription, "Authorize URL"),
    HttpApiEndpoint.get("availableChannels", "/installations/:installationId/available-channels", {
      params: InstallationParams,
      success: SlackAvailableChannels,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List channels the connected workspace can see")
      .annotate(
        OpenApi.Description,
        "Live call to Slack's conversations.list, for populating a channel picker. Returns non-archived public and private channels visible to the bot.",
      )
      .annotate(SuccessDescription, "Channels"),
    HttpApiEndpoint.delete("deleteInstallation", "/installations/:installationId", {
      params: InstallationParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Disconnect a Slack workspace")
      .annotate(
        OpenApi.Description,
        "Stops all delivery to this workspace. The channel routing is retained, so re-installing restores it.",
      )
      .annotate(SuccessDescription, "Disconnected"),
    // Checked by hand (`channelId is required`), as it always was.
    HttpApiEndpoint.post("addChannel", "/channels", {
      params: OrgParams,
      payload: SlackChannelCreate,
      success: SlackChannel,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Connect a Slack channel as an alert destination")
      .annotate(
        OpenApi.Description,
        "Adds a channel as a possible destination, or refreshes the cached name of one already added. Which alerts reach it is decided by /alert-rules; an organization with no rules falls back to the default (everything except drift, everywhere), so a freshly added channel starts receiving alerts without a second step.",
      )
      .annotate(SuccessDescription, "The channel routing")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.patch("renameChannel", "/channels/:id", {
      params: ChannelParams,
      payload: SlackChannelUpdate,
      success: SlackChannel,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Refresh a channel's cached name")
      .annotate(SuccessDescription, "The updated channel routing")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("deleteChannel", "/channels/:id", {
      params: ChannelParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Disconnect a channel")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.post("test", "/test", {
      params: OrgParams,
      success: SlackTestResult,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Post a test message to every configured channel")
      .annotate(
        OpenApi.Description,
        "Ignores routing rules; every channel gets the test. Fails with the Slack error when nothing could be delivered (`not_in_channel` means the bot needs inviting to a private channel).",
      )
      .annotate(SuccessDescription, "Delivery summary"),
  )
  .prefix("/api/org/:orgId/slack")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Slack") {}

export class SlackApi extends withApiDefaults(HttpApi.make("slack").add(SlackGroup)) {}
