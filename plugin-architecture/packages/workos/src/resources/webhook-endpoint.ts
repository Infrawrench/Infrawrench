import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A webhook endpoint receiving WorkOS event notifications (user.created,
 * dsync.*, connection.*, …). Full CRUD via /webhook_endpoints.
 * Docs: https://workos.com/docs/reference/webhooks
 */
export const WebhookEndpointResourceType = rt({
  name: "Webhook Endpoint",
  id: "webhook-endpoint",
  description:
    "An HTTPS endpoint subscribed to WorkOS events (authentication, memberships, Directory Sync, SSO connections, …). The signing secret is exposed as a sensitive output.",
  fields: [
    f("endpointUrl", "Endpoint URL"),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: ["enabled", "disabled"],
    }),
    f("events", "Events", {
      required: false,
      editable: false,
      description: "Subscribed event types, comma-separated.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("webhookEndpointId", "Webhook Endpoint ID"),
    o("signingSecret", "Signing Secret", {
      sensitive: true,
      description: "The whsec_… secret used to verify webhook payload signatures.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "webhook",
});
