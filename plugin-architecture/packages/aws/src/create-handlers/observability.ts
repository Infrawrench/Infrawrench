import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../auth.js";
import { AWS_REGIONS } from "../constants.js";
import type { AwsCreateContext } from "./shared.js";

export async function observabilityGetCreateConfig(
  ctx: AwsCreateContext,
  typeId: string,
  _parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "cloudwatch-log-group") {
    return {
      fields: [
        {
          key: "logGroupName",
          label: "Log Group Name",
          kind: "text",
          required: true,
          description: "e.g. /aws/lambda/my-function",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "retentionInDays",
          label: "Retention (days)",
          kind: "select",
          required: false,
          options: [
            { id: "0", label: "Never expire" },
            { id: "1", label: "1 day" },
            { id: "7", label: "7 days" },
            { id: "14", label: "14 days" },
            { id: "30", label: "30 days" },
            { id: "60", label: "60 days" },
            { id: "90", label: "90 days" },
            { id: "180", label: "6 months" },
            { id: "365", label: "1 year" },
          ],
          defaultValue: "0",
        },
      ],
    };
  }
  if (typeId === "cloudwatch-alarm") {
    return {
      fields: [
        { key: "alarmName", label: "Alarm Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "namespace",
          label: "Namespace",
          kind: "text",
          required: true,
          description: "e.g. AWS/EC2",
        },
        {
          key: "metricName",
          label: "Metric Name",
          kind: "text",
          required: true,
          description: "e.g. CPUUtilization",
        },
        {
          key: "comparisonOperator",
          label: "Comparison Operator",
          kind: "select",
          required: true,
          options: [
            { id: "GreaterThanThreshold", label: "> Threshold" },
            { id: "GreaterThanOrEqualToThreshold", label: ">= Threshold" },
            { id: "LessThanThreshold", label: "< Threshold" },
            { id: "LessThanOrEqualToThreshold", label: "<= Threshold" },
          ],
          defaultValue: "GreaterThanThreshold",
        },
        {
          key: "threshold",
          label: "Threshold",
          kind: "number",
          required: true,
          defaultValue: "80",
        },
        {
          key: "period",
          label: "Period (seconds)",
          kind: "number",
          required: true,
          defaultValue: "300",
          minValue: 10,
        },
        {
          key: "evaluationPeriods",
          label: "Evaluation Periods",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
        },
        {
          key: "statistic",
          label: "Statistic",
          kind: "select",
          required: true,
          options: [
            { id: "Average", label: "Average" },
            { id: "Sum", label: "Sum" },
            { id: "Minimum", label: "Minimum" },
            { id: "Maximum", label: "Maximum" },
            { id: "SampleCount", label: "Sample Count" },
          ],
          defaultValue: "Average",
        },
      ],
    };
  }
  if (typeId === "cloudtrail-trail") {
    // Fetch S3 buckets for the bucket selector
    const bucketsData = await ctx
      .xmlGet<Record<string, unknown>>("s3", "/")
      .catch(() => ({}) as Record<string, unknown>);
    const bucketsContainer = bucketsData["Buckets"] as Record<string, unknown> | undefined;
    const bucketList = ensureArray(bucketsContainer?.["Bucket"]) as Record<string, unknown>[];
    const bucketOptions = bucketList.map((b) => ({
      id: String(b["Name"] ?? ""),
      label: String(b["Name"] ?? ""),
    }));
    return {
      fields: [
        { key: "name", label: "Trail Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "s3BucketName",
          label: "S3 Bucket",
          kind: "select",
          required: true,
          options: bucketOptions,
          description: "S3 bucket for log file delivery",
        },
        {
          key: "isMultiRegion",
          label: "Multi-Region",
          kind: "select",
          required: false,
          options: [
            { id: "true", label: "Yes" },
            { id: "false", label: "No" },
          ],
          defaultValue: "true",
        },
        {
          key: "includeGlobalServiceEvents",
          label: "Include Global Events",
          kind: "select",
          required: false,
          options: [
            { id: "true", label: "Yes" },
            { id: "false", label: "No" },
          ],
          defaultValue: "true",
        },
      ],
    };
  }
  return null;
}

export async function observabilityCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  _parentResourceId?: string,
): Promise<ResourceInstance | null> {
  if (typeId === "cloudwatch-log-group") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const logGroupName = fields["logGroupName"] ?? "";
    const body: Record<string, unknown> = { logGroupName };
    await rctx.json<Record<string, unknown>>("logs", "Logs_20140328.CreateLogGroup", body);
    const retention = Number(fields["retentionInDays"] ?? "0");
    if (retention > 0) {
      await rctx.json<Record<string, unknown>>("logs", "Logs_20140328.PutRetentionPolicy", {
        logGroupName,
        retentionInDays: retention,
      });
    }
    return {
      id: ctx.makeId(accountId, "cloudwatch-log-group", logGroupName),
      pluginId: "aws",
      resourceTypeId: "cloudwatch-log-group",
      accountId,
      displayName: logGroupName,
      fields: {
        logGroupName,
        region,
        storedBytes: 0,
        retentionInDays: retention,
        metricFilterCount: 0,
        kmsKeyId: "",
      },
      resolvedOutputs: {
        logGroupArn: "",
      },
      secretStates: [],
      externalId: logGroupName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "cloudwatch-alarm") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const alarmName = fields["alarmName"] ?? "";
    // CloudWatch speaks awsQuery, not JSON-RPC — the JSON form returns 404.
    await rctx.queryPost<Record<string, unknown>>("monitoring", "PutMetricAlarm", "2010-08-01", {
      AlarmName: alarmName,
      Namespace: fields["namespace"] ?? "",
      MetricName: fields["metricName"] ?? "",
      ComparisonOperator: fields["comparisonOperator"] ?? "GreaterThanThreshold",
      Threshold: String(Number(fields["threshold"] ?? "80")),
      Period: String(Number(fields["period"] ?? "300")),
      EvaluationPeriods: String(Number(fields["evaluationPeriods"] ?? "1")),
      Statistic: fields["statistic"] ?? "Average",
    });
    return {
      id: ctx.makeId(accountId, "cloudwatch-alarm", alarmName),
      pluginId: "aws",
      resourceTypeId: "cloudwatch-alarm",
      accountId,
      displayName: alarmName,
      fields: {
        alarmName,
        region,
        state: "INSUFFICIENT_DATA",
        metricName: fields["metricName"] ?? "",
        namespace: fields["namespace"] ?? "",
        comparisonOperator: fields["comparisonOperator"] ?? "GreaterThanThreshold",
        threshold: Number(fields["threshold"] ?? "80"),
        period: Number(fields["period"] ?? "300"),
        actionsEnabled: true,
      },
      resolvedOutputs: {
        alarmArn: "",
      },
      secretStates: [],
      externalId: alarmName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "cloudtrail-trail") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const name = fields["name"] ?? "";
    const s3BucketName = fields["s3BucketName"] ?? "";
    await rctx.json(
      "cloudtrail",
      "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.CreateTrail",
      {
        Name: name,
        S3BucketName: s3BucketName,
        IsMultiRegionTrail: fields["isMultiRegion"] === "true",
        IncludeGlobalServiceEvents: fields["includeGlobalServiceEvents"] !== "false",
      },
    );
    const now = new Date().toISOString();
    return {
      id: ctx.makeId(accountId, "cloudtrail-trail", name),
      pluginId: "aws",
      resourceTypeId: "cloudtrail-trail",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        s3BucketName,
        isMultiRegion: fields["isMultiRegion"] === "true",
        isOrganizationTrail: false,
        logFileValidationEnabled: false,
        includeGlobalServiceEvents: fields["includeGlobalServiceEvents"] !== "false",
        status: true,
      },
      resolvedOutputs: { trailArn: "" },
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }
  return null;
}
