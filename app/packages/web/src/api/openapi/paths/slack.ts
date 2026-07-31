import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const SlackInstallation = strict({
  id: z.string().openapi({ description: "Infrawrench id for this workspace connection" }),
  teamId: z.string().openapi({ description: "Slack workspace id (T…)" }),
  teamName: z.string().nullable(),
}).openapi("SlackInstallation");

const SlackChannel = strict({
  id: z.string(),
  installationId: z.string(),
  channelId: z.string().openapi({ description: "Slack channel id (C…/G…)" }),
  channelName: z.string().openapi({ description: "Channel name without the leading #" }),
  isPrivate: z.boolean(),
  syncIncidents: z.boolean(),
  budgetAlerts: z.boolean(),
  anomalyAlerts: z
    .boolean()
    .openapi({ description: "Statistical spend-spike (cost anomaly) alerts" }),
  workflowPages: z
    .boolean()
    .openapi({ description: "Alerts raised by a workflow calling infra.page(...)" }),
  weeklyDigest: z.boolean().openapi({
    description:
      "The Monday-morning weekly digest. Only sends when the organization has enabled the digest (see /digest).",
  }),
}).openapi("SlackChannel");

const SlackStatus = strict({
  configured: z
    .boolean()
    .openapi({ description: "True when this deployment has a Slack app registered" }),
  installations: z.array(SlackInstallation),
  channels: z.array(SlackChannel),
}).openapi("SlackStatus");

const SlackAvailableChannel = strict({
  id: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
}).openapi("SlackAvailableChannel");

const SlackChannelCreate = strict({
  installationId: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  isPrivate: z.boolean().optional(),
  syncIncidents: z.boolean().optional(),
  budgetAlerts: z.boolean().optional(),
  anomalyAlerts: z.boolean().optional(),
  workflowPages: z.boolean().optional(),
  weeklyDigest: z.boolean().optional(),
}).openapi("SlackChannelCreate");

// Registered under its own name — `.partial()` on a registered schema would
// otherwise collapse back into the full $ref in the generated document.
const SlackChannelUpdate = strict({
  syncIncidents: z.boolean().optional(),
  budgetAlerts: z.boolean().optional(),
  anomalyAlerts: z.boolean().optional(),
  workflowPages: z.boolean().optional(),
  weeklyDigest: z.boolean().optional(),
}).openapi("SlackChannelUpdate");

export function registerSlackPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/slack/status",
    tags: ["Slack"],
    summary: "Get the organization's Slack connection",
    description:
      "Reports whether the server has a Slack app registered, which workspaces this organization has connected, and which channels alerts are routed to.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Connection status",
        content: { "application/json": { schema: SlackStatus } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/slack/install-url",
    tags: ["Slack"],
    summary: "Get the Add to Slack URL",
    description:
      "Returns a slack.com/oauth/v2/authorize URL carrying a signed `state` that binds the resulting install to this organization. Send the user's browser there; Slack redirects back to /api/slack/oauth/callback.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Authorize URL",
        content: { "application/json": { schema: strict({ url: z.string().url() }) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/slack/installations/{installationId}/available-channels",
    tags: ["Slack"],
    summary: "List channels the connected workspace can see",
    description:
      "Live call to Slack's conversations.list, for populating a channel picker. Returns non-archived public and private channels visible to the bot.",
    request: {
      params: OrgIdParam.extend({
        installationId: z.string().openapi({ param: { name: "installationId", in: "path" } }),
      }),
    },
    responses: {
      200: {
        description: "Channels",
        content: {
          "application/json": {
            schema: strict({ channels: z.array(SlackAvailableChannel) }),
          },
        },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/slack/installations/{installationId}",
    tags: ["Slack"],
    summary: "Disconnect a Slack workspace",
    description:
      "Stops all delivery to this workspace. The channel routing is retained, so re-installing restores it.",
    request: {
      params: OrgIdParam.extend({
        installationId: z.string().openapi({ param: { name: "installationId", in: "path" } }),
      }),
    },
    responses: {
      200: { description: "Disconnected", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/slack/channels",
    tags: ["Slack"],
    summary: "Route alerts to a Slack channel",
    description:
      "Adds a channel, or updates the trigger opt-ins of one already added. Each trigger defaults to enabled.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SlackChannelCreate } } },
    },
    responses: {
      200: {
        description: "The channel routing",
        content: { "application/json": { schema: SlackChannel } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/slack/channels/{id}",
    tags: ["Slack"],
    summary: "Change which alerts a channel receives",
    request: {
      params: OrgIdParam.extend({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: { content: { "application/json": { schema: SlackChannelUpdate } } },
    },
    responses: {
      200: {
        description: "The updated channel routing",
        content: { "application/json": { schema: SlackChannel } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/slack/channels/{id}",
    tags: ["Slack"],
    summary: "Stop routing alerts to a channel",
    request: {
      params: OrgIdParam.extend({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: {
      200: { description: "Removed", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/slack/test",
    tags: ["Slack"],
    summary: "Post a test message to every configured channel",
    description:
      "Ignores trigger opt-ins — every channel gets the test. Fails with the Slack error when nothing could be delivered (`not_in_channel` means the bot needs inviting to a private channel).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Delivery summary",
        content: {
          "application/json": {
            schema: strict({
              ok: z.boolean(),
              channelCount: z.number().int(),
              attempted: z.number().int(),
              succeeded: z.number().int(),
            }),
          },
        },
      },
      400: ErrorResponses[400],
    },
  });
}
