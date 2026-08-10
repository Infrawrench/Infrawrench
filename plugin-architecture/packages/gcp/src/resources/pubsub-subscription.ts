import { f, rt } from "@infrawrench/plugin-base";

export const PubSubSubscriptionResourceType = rt({
  name: "Pub/Sub Subscription",
  pinnable: false,
  id: "pubsub-subscription",
  description: "A Google Cloud Pub/Sub subscription",
  fields: [
    f("name", "Name"),
    f("topic", "Topic", { required: false }),
    f("ackDeadlineSeconds", "Ack Deadline (s)", { kind: "number", required: false }),
    f("messageRetentionDuration", "Message Retention", { required: false }),
    f("filter", "Filter", { required: false }),
  ],
  outputs: [],
  // The lister keeps only the topic's short id, so match the topic's `name`
  // field — its externalId is the full `projects/<p>/topics/<name>` path.
  dependsOn: [
    { fieldKey: "topic", targetTypeId: "pubsub-topic", targetKey: "name", label: "subscribes to" },
  ],
  parentTypeId: "pubsub-topic",
  supportsCreate: true,
  supportsMetrics: true,
});
