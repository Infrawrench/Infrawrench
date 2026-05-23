import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KafkaClusterResourceType: ResourceTypeDefinition = {
  id: "kafka-cluster",
  displayName: "Kafka Cluster",
  pluralDisplayName: "Kafka Clusters",
  description: "An Apache Kafka cluster — browse topics and consumer groups",
  fields: [
    { key: "name", label: "Display Name", kind: "string", required: true },
    {
      key: "connectionString",
      label: "Connection URL",
      kind: "secret",
      required: true,
      allowLiteral: true,
      description:
        "kafka:// URL with bootstrap brokers and optional SASL/SSL params (see plugin docs).",
      resolvableOutputKeys: ["connectionString"],
    },
  ],
  outputs: [
    { key: "connectionString", label: "Connection URL", sensitive: true },
    { key: "bootstrapServers", label: "Bootstrap Servers", sensitive: false },
    { key: "clusterId", label: "Cluster ID", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsMetrics: true,
  iconKey: "kafka",
};
