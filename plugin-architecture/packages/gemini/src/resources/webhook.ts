import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A webhook the Gemini API calls when a long-running job finishes: batches,
 * background interactions and video generation.
 *
 * Verified: https://ai.google.dev/api/webhooks (Beta, `/v1beta/webhooks`)
 * `GET /v1beta/webhooks?page_size=&page_token=` →
 * `{ webhooks: [...], next_page_token }`. Fields are **snake_case** on this
 * surface, unlike the camelCase of the older Generative Language resources.
 *
 * The signing secret is returned once, on create or rotation, which is why
 * rotation is a credential export rather than a field.
 */
export const WebhookResourceType = rt({
  name: "Webhook",
  id: "webhook",
  description:
    "An HTTPS endpoint the Gemini API notifies when a batch, background interaction or video generation finishes",
  fields: [
    f("displayName", "Name", { required: false }),
    f("uri", "URI"),
    f("subscribedEvents", "Events", {
      description:
        "Comma-separated: batch.succeeded, batch.expired, batch.failed, interaction.requires_action, interaction.completed, interaction.failed, video.generated.",
    }),
    f("state", "State", {
      kind: "enum",
      enumValues: ["enabled", "disabled", "disabled_due_to_failed_deliveries"],
    }),
    f("signingSecrets", "Signing Secrets", { required: false, editable: false }),
    f("createTime", "Created", { required: false, editable: false }),
    f("updateTime", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("webhookId", "Webhook ID"), o("uri", "URI")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "webhook",
  credentialFormats: [
    {
      id: "signing-secret",
      label: "Rotate Signing Secret",
      description:
        "Generates a new signing secret for verifying deliveries. Previous secrets keep working for 24 hours. The new secret is shown once.",
      mediaType: "text",
      filenameTemplate: "gemini-{resource}-webhook-secret.txt",
    },
  ],
});
