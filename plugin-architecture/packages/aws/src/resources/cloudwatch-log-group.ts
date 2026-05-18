import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudWatchLogGroupResourceType: ResourceTypeDefinition = {
  id: "cloudwatch-log-group",
  displayName: "CloudWatch Log Group",
  pluralDisplayName: "CloudWatch Log Groups",
  description: "An Amazon CloudWatch Logs log group",
  fields: [
    { key: "logGroupName", label: "Log Group Name", kind: "string", required: true },
    { key: "storedBytes", label: "Stored Bytes", kind: "number", required: false },
    { key: "retentionInDays", label: "Retention (days)", kind: "number", required: false },
    { key: "metricFilterCount", label: "Metric Filters", kind: "number", required: false },
    { key: "kmsKeyId", label: "KMS Key ID", kind: "string", required: false },
  ],
  outputs: [{ key: "logGroupArn", label: "Log Group ARN", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "log",
};
