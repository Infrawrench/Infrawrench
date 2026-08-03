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
  resourceDrift: z.boolean().openapi({
    description:
      "Batched resource-drift digests from the change timeline. Defaults to false when a channel is added — drift is continuous where the other triggers are exceptional.",
  }),
  workflowPages: z.boolean().openapi({
    description:
      "Pages and approval requests raised by a workflow (infra.page / infra.waitForApproval) or by POST /pages",
  }),
  providerIncidents: z.boolean().openapi({
    description: "A provider status-page incident overlaps resources you hold.",
  }),
  expiryAlerts: z.boolean().openapi({
    description:
      "Daily digests of approaching resource deadlines — expiring certificates, domains, tokens and keys past their rotation budget.",
  }),
  logMatchAlerts: z.boolean().openapi({
    description: "A saved log-workspace query with alerting enabled found matching log lines.",
  }),
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
  resourceDrift: z.boolean().optional(),
  workflowPages: z.boolean().optional(),
  providerIncidents: z.boolean().optional(),
  expiryAlerts: z.boolean().optional(),
  logMatchAlerts: z.boolean().optional(),
  weeklyDigest: z.boolean().optional(),
}).openapi("SlackChannelCreate");

// Registered under its own name — `.partial()` on a registered schema would
// otherwise collapse back into the full $ref in the generated document.
const SlackChannelUpdate = strict({
  syncIncidents: z.boolean().optional(),
  budgetAlerts: z.boolean().optional(),
  anomalyAlerts: z.boolean().optional(),
  resourceDrift: z.boolean().optional(),
  workflowPages: z.boolean().optional(),
  providerIncidents: z.boolean().optional(),
  expiryAlerts: z.boolean().optional(),
  logMatchAlerts: z.boolean().optional(),
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

  // --- Inbound Slack (public, signature-verified; internal in the published
  // spec — these are called by Slack and the browser, never by API clients).

  const slackSignatureHeaders = strict({
    "x-slack-signature": z
      .string()
      .openapi({ description: "v0=<hex HMAC-SHA256 of `v0:<timestamp>:<raw body>`>" }),
    "x-slack-request-timestamp": z
      .string()
      .openapi({ description: "Unix seconds; requests older than 5 minutes are rejected" }),
  });

  registry.registerPath({
    method: "post",
    path: "/api/slack/commands",
    tags: ["Slack"],
    summary: "Slack slash-command endpoint (/infrawrench)",
    description:
      "Public; verified against the app's signing secret. Handles `costs`, `status <resource>`, `link`, `unlink` and `help`, replying with an ephemeral message. The Slack user must have linked their account (`/infrawrench link`) and hold the same permission the equivalent web surface requires (`costs:read`, `resources:read`).",
    security: [],
    request: {
      headers: slackSignatureHeaders,
      body: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: z.unknown().openapi({ description: "Slack's slash-command form payload" }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Slack message payload (rendered ephemerally to the invoker)",
        content: { "application/json": { schema: z.unknown() } },
      },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/slack/interactions",
    tags: ["Slack"],
    summary: "Slack interactivity endpoint (Approve/Deny buttons)",
    description:
      "Public; verified against the app's signing secret. Receives `block_actions` payloads from the Approve/Deny buttons on approval messages and the status disambiguation picker. Button decisions resolve through the same code path as the web UI — the linked member needs `workflows:approve` (workflow approvals) or must own the conversation and hold `chat:write` (chat agent tool approvals).",
    security: [],
    request: {
      headers: slackSignatureHeaders,
      body: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: z
              .unknown()
              .openapi({ description: "`payload=<JSON>` interaction envelope from Slack" }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: { description: "Acknowledged; feedback rides response_url and message updates" },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/slack/link",
    tags: ["Slack"],
    summary: "Link a Slack user to the signed-in member (browser redirect)",
    description:
      "Landing for the signed link URL the slash-command endpoints hand to unknown Slack users. Requires a browser session (bounces through sign-in), verifies the short-lived token, requires membership of the token's organization, then stores the Slack-user ↔ member mapping and redirects to the notification settings page.",
    security: [],
    request: {
      query: strict({
        token: z.string().openapi({ description: "Signed link token from Slack (15-minute TTL)" }),
      }),
    },
    responses: {
      302: { description: "Redirect to the settings page (or sign-in / an error toast)" },
      401: ErrorResponses[401],
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
