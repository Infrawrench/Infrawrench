import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PubSubTopicResourceType: ResourceTypeDefinition = {
  id: "pubsub-topic",
  displayName: "Pub/Sub Topic",
  pluralDisplayName: "Pub/Sub Topics",
  description: "A Google Cloud Pub/Sub topic",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "kmsKeyName", label: "KMS Key", kind: "string", required: false },
    {
      key: "messageRetentionDuration",
      label: "Message Retention",
      kind: "string",
      required: false,
    },
  ],
  outputs: [],
  dashboardPinnable: false,
};
