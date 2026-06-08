import { f, o, rt } from "@infrawrench/plugin-base";

export const SNSTopicResourceType = rt({
  name: "SNS Topic",
  id: "sns-topic",
  description: "An Amazon Simple Notification Service topic",
  fields: [
    f("topicName", "Topic Name"),
    f("topicArn", "ARN"),
    f("subscriptionCount", "Subscriptions", { kind: "number", required: false }),
    f("isFifo", "FIFO", { kind: "boolean", required: false }),
  ],
  outputs: [o("topicArn", "Topic ARN")],
  iconKey: "topic",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "sns-topic",
      displayName: "SNS Topic ARN",
      description: "Topic ARN for publishing messages",
      entries: [{ envKey: "SNS_TOPIC_ARN", outputKey: "topicArn", description: "Topic ARN" }],
    },
  ],
});
