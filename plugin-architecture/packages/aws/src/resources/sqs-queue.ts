import { f, o, rt } from "@infrawrench/plugin-base";

export const SQSQueueResourceType = rt({
  name: "SQS Queue",
  id: "sqs-queue",
  description: "An Amazon Simple Queue Service queue",
  fields: [
    f("queueName", "Queue Name"),
    f("queueUrl", "Queue URL"),
    f("approximateMessages", "Messages Available", { kind: "number", required: false }),
    f("approximateMessagesDelayed", "Messages Delayed", { kind: "number", required: false }),
    f("approximateMessagesNotVisible", "Messages In-Flight", { kind: "number", required: false }),
    f("isFifo", "FIFO", { kind: "boolean", required: false }),
  ],
  outputs: [o("queueArn", "Queue ARN")],
  iconKey: "queue",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "sqs-queue",
      displayName: "SQS Queue URL",
      description: "Queue URL and ARN for messaging",
      entries: [{ envKey: "SQS_QUEUE_ARN", outputKey: "queueArn", description: "Queue ARN" }],
    },
  ],
});
