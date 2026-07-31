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
    f("dimensions", "Dimensions", {
      required: false,
      description: "The alarm's metric dimensions, as Name=Value pairs",
    }),
    f("instanceId", "Instance ID", { required: false }),
    f("dbInstanceId", "DB Instance ID", { required: false }),
    f("dbClusterId", "DB Cluster ID", { required: false }),
    f("functionName", "Function Name", { required: false }),
    f("bucketName", "Bucket Name", { required: false }),
    f("queueName", "Queue Name", { required: false }),
    f("tableName", "Table Name", { required: false }),
    f("autoScalingGroupName", "Auto Scaling Group", { required: false }),
    f("cacheClusterId", "Cache Cluster ID", { required: false }),
  ],
  outputs: [o("alarmArn", "Alarm ARN")],
  // One field per dimension name that identifies something we list — each holds
  // the dimension value verbatim, which is that resource type's external id.
  dependsOn: [
    { fieldKey: "instanceId", targetTypeId: "ec2-instance", label: "watches" },
    { fieldKey: "dbInstanceId", targetTypeId: "rds-instance", label: "watches" },
    { fieldKey: "dbClusterId", targetTypeId: "rds-cluster", label: "watches" },
    { fieldKey: "functionName", targetTypeId: "lambda-function", label: "watches" },
    { fieldKey: "bucketName", targetTypeId: "s3-bucket", label: "watches" },
    { fieldKey: "queueName", targetTypeId: "sqs-queue", label: "watches" },
    { fieldKey: "tableName", targetTypeId: "dynamodb-table", label: "watches" },
    { fieldKey: "autoScalingGroupName", targetTypeId: "auto-scaling-group", label: "watches" },
    { fieldKey: "cacheClusterId", targetTypeId: "elasticache-cluster", label: "watches" },
  ],
  iconKey: "alarm",
  supportsCreate: true,
});
