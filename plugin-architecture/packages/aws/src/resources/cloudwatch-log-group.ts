import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudWatchLogGroupResourceType = rt({
  name: "CloudWatch Log Group",
  id: "cloudwatch-log-group",
  description: "An Amazon CloudWatch Logs log group",
  fields: [
    f("logGroupName", "Log Group Name"),
    f("storedBytes", "Stored Bytes", { kind: "number", required: false }),
    f("retentionInDays", "Retention (days)", { kind: "number", required: false }),
    f("metricFilterCount", "Metric Filters", { kind: "number", required: false }),
    f("kmsKeyId", "KMS Key ID", { required: false }),
  ],
  outputs: [o("logGroupArn", "Log Group ARN")],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "log",
});
