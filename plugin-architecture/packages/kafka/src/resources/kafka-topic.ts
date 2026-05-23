import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KafkaTopicResourceType: ResourceTypeDefinition = {
  id: "kafka-topic",
  displayName: "Topic",
  pluralDisplayName: "Topics",
  description: "A Kafka topic",
  parentTypeId: "kafka-cluster",
  showInSidebar: true,
  fields: [
    { key: "name", label: "Topic Name", kind: "string", required: true },
    {
      key: "partitions",
      label: "Partitions",
      kind: "number",
      required: false,
      description: "Number of partitions for the topic.",
    },
    {
      key: "replicationFactor",
      label: "Replication Factor",
      kind: "number",
      required: false,
      description: "Replication factor — must be ≤ number of brokers in the cluster.",
    },
  ],
  outputs: [
    { key: "name", label: "Topic Name", sensitive: false },
    { key: "partitionCount", label: "Partition Count", sensitive: false },
  ],
  dashboardPinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "kafka",
};
