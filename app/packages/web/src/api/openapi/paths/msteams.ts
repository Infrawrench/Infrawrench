import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const MsTeamsWebhook = strict({
  id: z.string(),
  label: z.string().openapi({ description: "Display name for the channel, e.g. #alerts" }),
  urlHint: z.string().openapi({
    description:
      "Non-secret hint at the stored webhook URL (host and last four characters). The URL itself is never returned.",
  }),
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
}).openapi("MsTeamsWebhook");

const MsTeamsStatus = strict({
  webhooks: z.array(MsTeamsWebhook),
}).openapi("MsTeamsStatus");

const MsTeamsWebhookCreate = strict({
  label: z.string(),
  url: z.string().url().openapi({
    description:
      "The webhook URL from a Teams 'Workflows' automation. Must be https and on a Microsoft-operated host (*.api.powerautomate.com, *.api.powerplatform.com, *.logic.azure.com, *.flow.microsoft.com, or a legacy *.webhook.office.com connector).",
  }),
  syncIncidents: z.boolean().optional(),
  budgetAlerts: z.boolean().optional(),
  anomalyAlerts: z.boolean().optional(),
  resourceDrift: z.boolean().optional(),
  workflowPages: z.boolean().optional(),
  providerIncidents: z.boolean().optional(),
  expiryAlerts: z.boolean().optional(),
  logMatchAlerts: z.boolean().optional(),
  weeklyDigest: z.boolean().optional(),
}).openapi("MsTeamsWebhookCreate");

// Registered under its own name — `.partial()` on a registered schema would
// otherwise collapse back into the full $ref in the generated document.
const MsTeamsWebhookUpdate = strict({
  label: z.string().optional(),
  syncIncidents: z.boolean().optional(),
  budgetAlerts: z.boolean().optional(),
  anomalyAlerts: z.boolean().optional(),
  resourceDrift: z.boolean().optional(),
  workflowPages: z.boolean().optional(),
  providerIncidents: z.boolean().optional(),
  expiryAlerts: z.boolean().optional(),
  logMatchAlerts: z.boolean().optional(),
  weeklyDigest: z.boolean().optional(),
}).openapi("MsTeamsWebhookUpdate");

export function registerMsTeamsPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/msteams/status",
    tags: ["Microsoft Teams"],
    summary: "List the organization's Teams channels",
    description:
      "Returns the Teams channels alerts are routed to and which triggers each takes. Webhook URLs are never included.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Routed channels",
        content: { "application/json": { schema: MsTeamsStatus } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/msteams/webhooks",
    tags: ["Microsoft Teams"],
    summary: "Route alerts to a Teams channel",
    description:
      "Adds a channel by webhook URL, or updates the one already holding that URL. Each trigger defaults to enabled. Responds 400 when the URL is not https or its host is not Microsoft-operated.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: MsTeamsWebhookCreate } } },
    },
    responses: {
      200: {
        description: "The channel routing",
        content: { "application/json": { schema: MsTeamsWebhook } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/msteams/webhooks/{id}",
    tags: ["Microsoft Teams"],
    summary: "Rename a Teams channel or change which alerts it receives",
    description: "The webhook URL is immutable — remove the channel and re-add it to change it.",
    request: {
      params: OrgIdParam.extend({
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: { content: { "application/json": { schema: MsTeamsWebhookUpdate } } },
    },
    responses: {
      200: {
        description: "The updated channel routing",
        content: { "application/json": { schema: MsTeamsWebhook } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/msteams/webhooks/{id}",
    tags: ["Microsoft Teams"],
    summary: "Stop routing alerts to a Teams channel",
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
    path: "/api/org/{orgId}/msteams/test",
    tags: ["Microsoft Teams"],
    summary: "Post a test card to every configured Teams channel",
    description:
      "Ignores trigger opt-ins — every channel gets the test. Fails with the error Microsoft returned when nothing could be delivered (HTTP 404 usually means the Workflow was deleted or turned off).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Delivery summary",
        content: {
          "application/json": {
            schema: strict({
              ok: z.boolean(),
              webhookCount: z.number().int(),
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
