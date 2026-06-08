import { f, o, rt } from "@infrawrench/plugin-base";

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
  parentTypeId: "pubsub-topic",
  supportsCreate: true,
  supportsMetrics: true,
});
