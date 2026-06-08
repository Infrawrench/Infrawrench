import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudWatchAlarmResourceType = rt({
  name: "CloudWatch Alarm",
  id: "cloudwatch-alarm",
  description: "An Amazon CloudWatch metric alarm",
  fields: [
    f("alarmName", "Alarm Name"),
    f("state", "State", { kind: "enum", enumValues: ["OK", "ALARM", "INSUFFICIENT_DATA"] }),
    f("metricName", "Metric", { required: false }),
    f("namespace", "Namespace", { required: false }),
    f("comparisonOperator", "Comparison", { required: false }),
    f("threshold", "Threshold", { kind: "number", required: false }),
    f("period", "Period (s)", { kind: "number", required: false }),
    f("actionsEnabled", "Actions Enabled", { kind: "boolean", required: false }),
  ],
  outputs: [o("alarmArn", "Alarm ARN")],
  iconKey: "alarm",
  supportsCreate: true,
});
