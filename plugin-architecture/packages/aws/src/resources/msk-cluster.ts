import { f, o, rt } from "@infrawrench/plugin-base";

export const MSKClusterResourceType = rt({
  name: "MSK Cluster",
  id: "msk-cluster",
  description: "An Amazon Managed Streaming for Apache Kafka cluster",
  fields: [
    f("clusterName", "Cluster Name"),
    f("state", "State", {
      kind: "enum",
      enumValues: [
        "ACTIVE",
        "CREATING",
        "DELETING",
        "FAILED",
        "HEALING",
        "MAINTENANCE",
        "REBOOTING_BROKER",
        "UPDATING",
      ],
    }),
    f("kafkaVersion", "Kafka Version", { required: false }),
    f("numberOfBrokerNodes", "Broker Nodes", { kind: "number", required: false }),
    f("instanceType", "Instance Type", { required: false }),
    f("storagePerBrokerGb", "Storage/Broker (GB)", { kind: "number", required: false }),
    f("subnetIds", "Client Subnets", {
      required: false,
      description: "Comma-separated subnet IDs the broker ENIs live in",
    }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated security group IDs applied to the broker ENIs",
    }),
  ],
  outputs: [o("clusterArn", "Cluster ARN"), o("bootstrapBrokers", "Bootstrap Brokers")],
  dependsOn: [
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
  iconKey: "stream",
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "kafka-connection",
      displayName: "Kafka Connection",
      description: "Bootstrap broker endpoints for Kafka clients",
      entries: [
        {
          envKey: "KAFKA_BROKERS",
          outputKey: "bootstrapBrokers",
          description: "Comma-separated broker endpoints",
        },
      ],
    },
  ],
});
