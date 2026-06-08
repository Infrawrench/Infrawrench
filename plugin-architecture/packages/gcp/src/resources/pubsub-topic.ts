import { f, o, rt } from "@infrawrench/plugin-base";

export const PubSubTopicResourceType = rt({
  name: "Pub/Sub Topic",
  pinnable: false,
  id: "pubsub-topic",
  description: "A Google Cloud Pub/Sub topic",
  fields: [
    f("name", "Name"),
    f("kmsKeyName", "KMS Key", { required: false }),
    f("messageRetentionDuration", "Message Retention", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsMetrics: true,
});
