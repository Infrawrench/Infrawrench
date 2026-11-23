import { f, o, rt } from "@infrawrench/plugin-base";

export const MQBrokerResourceType = rt({
  name: "MQ Broker",
  id: "mq-broker",
  carbon: {
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      sizeFieldKey: "hostInstanceType",
      catalogueTypeId: "ec2-instance",
      catalogueFieldKey: "instanceType",
      stripPrefix: "mq.",
    },
  },
  description: "An Amazon MQ message broker (ActiveMQ or RabbitMQ)",
  fields: [
    f("brokerName", "Broker Name"),
    f("brokerId", "Broker ID"),
    f("engineType", "Engine", { kind: "enum", enumValues: ["ACTIVEMQ", "RABBITMQ"] }),
    f("engineVersion", "Engine Version", { showcase: true, required: false }),
    f("hostInstanceType", "Instance Type", { required: false }),
    f("deploymentMode", "Deployment Mode", { required: false }),
    f("status", "Status", {
      showcase: true,
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
  // `mqBrokerMetrics` charts ActiveMQ's `StorePercentUsage` (the broker
  // refuses messages at 100) as "Store Used", and RabbitMQ's
  // `RabbitMQMemUsed` over `RabbitMQMemLimit` (publishers are blocked past
  // it) as "Memory Used (of limit)":
  // https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/security-logging-monitoring-cloudwatch.html
  // and https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-logging-monitoring.html
  // (read 2026-11-23).
  capacityMetrics: [
    { seriesLabel: "Store Used", limit: { constant: 100 }, unit: "%", label: "Message Store" },
    {
      seriesLabel: "Memory Used (of limit)",
      limit: { constant: 100 },
      unit: "%",
      label: "Memory",
    },
  ],
  secretExportTemplates: [
    {
      id: "mq-connection",
      displayName: "MQ Console",
      description: "MQ broker console URL",
      entries: [{ envKey: "MQ_CONSOLE_URL", outputKey: "consoleUrl" }],
    },
  ],
});
