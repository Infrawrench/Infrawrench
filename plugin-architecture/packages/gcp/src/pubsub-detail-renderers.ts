/**
 * Detail renderers for Pub/Sub topics and subscriptions.
 */
import type { DetailViewSchema, ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpDetailContext } from "./detail-context.js";

/** Apply the Pub/Sub topic renderer to `base`. */
export function renderPubsubTopic(_resource: ResourceInstance, base: DetailViewSchema): void {
  // Pub/Sub topics have no lifecycle state in the GCP API — if the resource
  // exists, it's active. Give them a healthy dot so the UI doesn't fall
  // through to "unknown" grey.
  base.subtitle = "Pub/Sub Topic";
  base.status = { kind: "status-dot", status: "healthy", label: "Active" };
}

/** Apply the Pub/Sub subscription renderer to `base`. */
export function renderPubsubSubscription(
  ctx: GcpDetailContext,
  resource: ResourceInstance,
  base: DetailViewSchema,
): void {
  const fields = resource.fields;
  base.subtitle = "Pub/Sub Subscription";
  base.status = { kind: "status-dot", status: "healthy", label: "Active" };
  // Link back to the source topic. parentResourceId is set by the lister
  // when the topic is in the same project; otherwise reconstruct from the
  // short topic field under the current project.
  const topicResourceId =
    resource.parentResourceId ??
    (fields["topic"]
      ? ctx.id(
          resource.accountId,
          "pubsub-topic",
          `projects/${ctx.project}/topics/${String(fields["topic"])}`,
        )
      : "");
  if (topicResourceId) {
    base.headerActions = [
      {
        kind: "action",
        label: `View topic: ${String(fields["topic"] ?? "")}`,
        action: {
          type: "navigate-to-resource",
          pluginId: "gcp",
          resourceTypeId: "pubsub-topic",
          resourceId: topicResourceId,
        },
      },
      ...(base.headerActions ?? []),
    ];
  }
}
