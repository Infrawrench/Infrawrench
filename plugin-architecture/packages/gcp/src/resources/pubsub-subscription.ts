import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PubSubSubscriptionResourceType: ResourceTypeDefinition = {
  id: "pubsub-subscription",
  displayName: "Pub/Sub Subscription",
  pluralDisplayName: "Pub/Sub Subscriptions",
  description: "A Google Cloud Pub/Sub subscription",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "topic", label: "Topic", kind: "string", required: false },
    { key: "ackDeadlineSeconds", label: "Ack Deadline (s)", kind: "number", required: false },
    {
      key: "messageRetentionDuration",
      label: "Message Retention",
      kind: "string",
      required: false,
    },
    { key: "filter", label: "Filter", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
};
