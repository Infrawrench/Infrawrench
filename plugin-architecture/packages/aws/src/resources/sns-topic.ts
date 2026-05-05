import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SNSTopicResourceType: ResourceTypeDefinition = {
  id: "sns-topic",
  displayName: "SNS Topic",
  pluralDisplayName: "SNS Topics",
  description: "An Amazon Simple Notification Service topic",
  fields: [
    { key: "topicName", label: "Topic Name", kind: "string", required: true },
    { key: "topicArn", label: "ARN", kind: "string", required: true },
    { key: "subscriptionCount", label: "Subscriptions", kind: "number", required: false },
    { key: "isFifo", label: "FIFO", kind: "boolean", required: false },
  ],
  outputs: [{ key: "topicArn", label: "Topic ARN", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "topic",
  supportsCreate: true,
  secretExportTemplates: [
    {
      id: "sns-topic",
      displayName: "SNS Topic ARN",
      description: "Topic ARN for publishing messages",
      entries: [{ envKey: "SNS_TOPIC_ARN", outputKey: "topicArn", description: "Topic ARN" }],
    },
  ],
};
