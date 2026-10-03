import { f, o, rt } from "@infrawrench/plugin-base";

export const VercelWebhookResourceType = rt({
  name: "Webhook",
  pinnable: false,
  id: "vercel-webhook",
  description: "An account webhook that POSTs deployment, project, and domain events to a URL",
  fields: [
    f("url", "URL"),
    f("events", "Events", { required: false }),
    f("projects", "Projects", {
      required: false,
      description: "Projects the webhook is limited to; empty means every project",
    }),
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
  ],
  outputs: [
    o("webhookId", "Webhook ID"),
    o("secret", "Signing Secret", {
      sensitive: true,
      description:
        "Verifies the x-vercel-signature header. Returned only when the webhook is created.",
    }),
  ],
  supportsCreate: true,
  iconKey: "hook",
  secretExportTemplates: [
    {
      id: "vercel-webhook-secret",
      displayName: "Vercel Webhook Secret",
      description: "Signing secret for verifying Vercel webhook payloads",
      entries: [{ envKey: "VERCEL_WEBHOOK_SECRET", outputKey: "secret" }],
    },
  ],
});
