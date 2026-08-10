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
}).openapi("MsTeamsWebhookCreate");

// Registered under its own name — `.partial()` on a registered schema would
// otherwise collapse back into the full $ref in the generated document.
const MsTeamsWebhookUpdate = strict({
  label: z.string(),
}).openapi("MsTeamsWebhookUpdate");

export function registerMsTeamsPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/msteams/status",
    tags: ["Microsoft Teams"],
    summary: "List the organization's Teams channels",
    description:
      "Returns the Teams channels alerts can be routed to. Which alerts reach each one is decided by /alert-rules. Webhook URLs are never included.",
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
    summary: "Connect a Teams channel as an alert destination",
    description:
      "Adds a channel by webhook URL, or updates the one already holding that URL. Which alerts reach it is decided by /alert-rules — connecting a channel routes nothing to it on its own. Responds 400 when the URL is not https or its host is not Microsoft-operated.",
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
    summary: "Rename a Teams channel",
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
    summary: "Disconnect a Teams channel",
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
      "Ignores routing rules — every channel gets the test. Fails with the error Microsoft returned when nothing could be delivered (HTTP 404 usually means the Workflow was deleted or turned off).",
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
