import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MQBrokerResourceType: ResourceTypeDefinition = {
  id: "mq-broker",
  displayName: "MQ Broker",
  pluralDisplayName: "MQ Brokers",
  description: "An Amazon MQ message broker (ActiveMQ or RabbitMQ)",
  fields: [
    { key: "brokerName", label: "Broker Name", kind: "string", required: true },
    { key: "brokerId", label: "Broker ID", kind: "string", required: true },
    {
      key: "engineType",
      label: "Engine",
      kind: "enum",
      required: true,
      enumValues: ["ACTIVEMQ", "RABBITMQ"],
    },
    { key: "engineVersion", label: "Engine Version", kind: "string", required: false },
    { key: "hostInstanceType", label: "Instance Type", kind: "string", required: false },
    { key: "deploymentMode", label: "Deployment Mode", kind: "string", required: false },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
      enumValues: [
        "CREATION_IN_PROGRESS",
        "CREATION_FAILED",
        "DELETION_IN_PROGRESS",
        "RUNNING",
        "REBOOT_IN_PROGRESS",
        "CRITICAL_ACTION_REQUIRED",
      ],
    },
  ],
  outputs: [
    { key: "brokerArn", label: "Broker ARN", sensitive: false },
    { key: "consoleUrl", label: "Console URL", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "queue",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "mq-connection",
      displayName: "MQ Console",
      description: "MQ broker console URL",
      entries: [{ envKey: "MQ_CONSOLE_URL", outputKey: "consoleUrl" }],
    },
  ],
};
