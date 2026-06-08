import { f, o, rt } from "@infrawrench/plugin-base";

export const KafkaTopicResourceType = rt({
  name: "Topic",
  pinnable: false,
  id: "kafka-topic",
  description: "A Kafka topic",
  parentTypeId: "kafka-cluster",
  showInSidebar: true,
  fields: [
    f("name", "Topic Name"),
    f("partitions", "Partitions", {
      kind: "number",
      required: false,
      description: "Number of partitions for the topic.",
    }),
    f("replicationFactor", "Replication Factor", {
      kind: "number",
      required: false,
      description: "Replication factor — must be ≤ number of brokers in the cluster.",
    }),
  ],
  outputs: [o("name", "Topic Name"), o("partitionCount", "Partition Count")],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "kafka",
});
