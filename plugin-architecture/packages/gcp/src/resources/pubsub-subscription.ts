import { f, rt } from "@infrawrench/plugin-base";

export const PubSubSubscriptionResourceType = rt({
  name: "Pub/Sub Subscription",
  pinnable: false,
  id: "pubsub-subscription",
  iconKey: "inbox",
  description: "A Google Cloud Pub/Sub subscription",
  fields: [
    f("name", "Name"),
    f("topic", "Topic", { required: false }),
    f("ackDeadlineSeconds", "Ack Deadline (s)", { kind: "number", required: false }),
    f("messageRetentionDuration", "Message Retention", { required: false }),
    f("messageRetentionSeconds", "Message Retention (s)", {
      kind: "number",
      required: false,
      editable: false,
      description: "How long an unacknowledged message is kept before it is discarded",
    }),
    f("filter", "Filter", { required: false }),
  ],
  outputs: [],
  // The lister keeps only the topic's short id, so match the topic's `name`
  // field: its externalId is the full `projects/<p>/topics/<name>` path.
  dependsOn: [
    { fieldKey: "topic", targetTypeId: "pubsub-topic", targetKey: "name", label: "subscribes to" },
  ],
  parentTypeId: "pubsub-topic",
  supportsCreate: true,
  supportsMetrics: true,
  // `subscription/oldest_unacked_message_age` ("Age (in seconds) of the
  // oldest unacknowledged message"), against the retention after which an
  // unacknowledged message is dropped:
  // https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z, read 2026-11-23
  capacityMetrics: [
    {
      seriesLabel: "Oldest Unacked Age",
      limit: { field: "messageRetentionSeconds" },
      unit: "s",
      label: "Backlog Age",
    },
  ],
});
