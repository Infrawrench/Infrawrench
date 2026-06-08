import { f, o, rt } from "@infrawrench/plugin-base";

export const MQBrokerResourceType = rt({
  name: "MQ Broker",
  id: "mq-broker",
  description: "An Amazon MQ message broker (ActiveMQ or RabbitMQ)",
  fields: [
    f("brokerName", "Broker Name"),
    f("brokerId", "Broker ID"),
    f("engineType", "Engine", { kind: "enum", enumValues: ["ACTIVEMQ", "RABBITMQ"] }),
    f("engineVersion", "Engine Version", { required: false }),
    f("hostInstanceType", "Instance Type", { required: false }),
    f("deploymentMode", "Deployment Mode", { required: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "CREATION_IN_PROGRESS",
        "CREATION_FAILED",
        "DELETION_IN_PROGRESS",
        "RUNNING",
        "REBOOT_IN_PROGRESS",
        "CRITICAL_ACTION_REQUIRED",
      ],
    }),
  ],
  outputs: [o("brokerArn", "Broker ARN"), o("consoleUrl", "Console URL")],
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
});
