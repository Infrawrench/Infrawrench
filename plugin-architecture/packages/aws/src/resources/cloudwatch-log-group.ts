import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudWatchLogGroupResourceType = rt({
  name: "CloudWatch Log Group",
  id: "cloudwatch-log-group",
  description: "An Amazon CloudWatch Logs log group",
  fields: [
    f("logGroupName", "Log Group Name"),
    f("storedBytes", "Stored Bytes", { kind: "number", required: false }),
    f("retentionInDays", "Retention (days)", { kind: "number", required: false }),
    // 100 metric filters per log group, not adjustable:
    // https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html
    // (read 2026-11-23).
    f("metricFilterCount", "Metric Filters", {
      showcase: true,
      kind: "number",
      required: false,
      usage: { limit: { constant: 100 }, unit: "filters" },
    }),
    f("kmsKeyId", "KMS Key ID", { required: false }),
  ],
  outputs: [o("logGroupArn", "Log Group ARN")],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "log",
});
