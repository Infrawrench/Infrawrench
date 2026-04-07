import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SQSQueueResourceType: ResourceTypeDefinition = {
  id: "sqs-queue",
  displayName: "SQS Queue",
  pluralDisplayName: "SQS Queues",
  description: "An Amazon Simple Queue Service queue",
  fields: [
    { key: "queueName", label: "Queue Name", kind: "string", required: true },
    { key: "queueUrl", label: "Queue URL", kind: "string", required: true },
    { key: "approximateMessages", label: "Messages Available", kind: "number", required: false },
    { key: "approximateMessagesDelayed", label: "Messages Delayed", kind: "number", required: false },
    { key: "approximateMessagesNotVisible", label: "Messages In-Flight", kind: "number", required: false },
    { key: "isFifo", label: "FIFO", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "queueArn", label: "Queue ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "queue",
};
