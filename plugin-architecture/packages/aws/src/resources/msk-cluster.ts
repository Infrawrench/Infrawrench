import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MSKClusterResourceType: ResourceTypeDefinition = {
  id: "msk-cluster",
  displayName: "MSK Cluster",
  pluralDisplayName: "MSK Clusters",
  description: "An Amazon Managed Streaming for Apache Kafka cluster",
  fields: [
    { key: "clusterName", label: "Cluster Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
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
    },
    { key: "kafkaVersion", label: "Kafka Version", kind: "string", required: false },
    { key: "numberOfBrokerNodes", label: "Broker Nodes", kind: "number", required: false },
    { key: "instanceType", label: "Instance Type", kind: "string", required: false },
    { key: "storagePerBrokerGb", label: "Storage/Broker (GB)", kind: "number", required: false },
  ],
  outputs: [
    { key: "clusterArn", label: "Cluster ARN", sensitive: false },
    { key: "bootstrapBrokers", label: "Bootstrap Brokers", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "stream",
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
};
