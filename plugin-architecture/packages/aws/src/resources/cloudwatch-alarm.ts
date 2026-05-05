import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudWatchAlarmResourceType: ResourceTypeDefinition = {
  id: "cloudwatch-alarm",
  displayName: "CloudWatch Alarm",
  pluralDisplayName: "CloudWatch Alarms",
  description: "An Amazon CloudWatch metric alarm",
  fields: [
    { key: "alarmName", label: "Alarm Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["OK", "ALARM", "INSUFFICIENT_DATA"],
    },
    { key: "metricName", label: "Metric", kind: "string", required: false },
    { key: "namespace", label: "Namespace", kind: "string", required: false },
    { key: "comparisonOperator", label: "Comparison", kind: "string", required: false },
    { key: "threshold", label: "Threshold", kind: "number", required: false },
    { key: "period", label: "Period (s)", kind: "number", required: false },
    { key: "actionsEnabled", label: "Actions Enabled", kind: "boolean", required: false },
  ],
  outputs: [{ key: "alarmArn", label: "Alarm ARN", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "alarm",
  supportsCreate: true,
};
