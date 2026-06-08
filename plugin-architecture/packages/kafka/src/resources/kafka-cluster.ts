import { f, o, rt } from "@infrawrench/plugin-base";

export const KafkaClusterResourceType = rt({
  name: "Kafka Cluster",
  id: "kafka-cluster",
  description: "An Apache Kafka cluster — browse topics and consumer groups",
  fields: [
    f("name", "Display Name"),
    f("connectionString", "Connection URL", {
      kind: "secret",
      allowLiteral: true,
      description:
        "kafka:// URL with bootstrap brokers and optional SASL/SSL params (see plugin docs).",
      resolvableOutputKeys: ["connectionString"],
    }),
  ],
  outputs: [
    o("connectionString", "Connection URL", { sensitive: true }),
    o("bootstrapServers", "Bootstrap Servers"),
    o("clusterId", "Cluster ID"),
  ],
  supportsMetrics: true,
  iconKey: "kafka",
});
