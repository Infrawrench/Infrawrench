import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../auth.js";
import type { ListerContext } from "../resource-listers.js";

export async function listCloudWatchAlarms(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // CloudWatch (signing name `monitoring`) speaks the AWS Query protocol,
  // not JSON-RPC. The JSON form returns 404 from the endpoint.
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "monitoring",
    "DescribeAlarms",
    "2010-08-01",
  );
  const result = data["DescribeAlarmsResult"] as Record<string, unknown> | undefined;
  const metricAlarms = ensureArray(
    (result?.["MetricAlarms"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];

  return metricAlarms.map((a) => {
    const alarmName = String(a["AlarmName"] ?? "");
    return {
      id: ctx.id(accountId, "cloudwatch-alarm", alarmName),
      pluginId: "aws",
      resourceTypeId: "cloudwatch-alarm",
      accountId,
      displayName: alarmName,
      fields: {
        alarmName,
        region: ctx.region,
        state: String(a["StateValue"] ?? ""),
        metricName: String(a["MetricName"] ?? ""),
        namespace: String(a["Namespace"] ?? ""),
        comparisonOperator: String(a["ComparisonOperator"] ?? ""),
        threshold: Number(a["Threshold"] ?? 0),
        period: Number(a["Period"] ?? 0),
        actionsEnabled: a["ActionsEnabled"] === true || a["ActionsEnabled"] === "true",
      },
      resolvedOutputs: {
        alarmArn: String(a["AlarmArn"] ?? ""),
      },
      secretStates: [],
      externalId: alarmName,
      createdAt: String(a["AlarmConfigurationUpdatedTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudWatchLogGroups(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ logGroups?: Record<string, unknown>[] }>(
    "logs",
    "Logs_20140328.DescribeLogGroups",
    {},
  );
  const logGroups = data.logGroups ?? [];

  return logGroups.map((lg) => {
    const logGroupName = String(lg["logGroupName"] ?? "");
    return {
      id: ctx.id(accountId, "cloudwatch-log-group", logGroupName),
      pluginId: "aws",
      resourceTypeId: "cloudwatch-log-group",
      accountId,
      displayName: logGroupName,
      fields: {
        logGroupName,
        region: ctx.region,
        storedBytes: Number(lg["storedBytes"] ?? 0),
        retentionInDays: Number(lg["retentionInDays"] ?? 0),
        metricFilterCount: Number(lg["metricFilterCount"] ?? 0),
        kmsKeyId: String(lg["kmsKeyId"] ?? ""),
      },
      resolvedOutputs: {
        logGroupArn: String(lg["arn"] ?? ""),
      },
      secretStates: [],
      externalId: logGroupName,
      createdAt: lg["creationTime"]
        ? new Date(Number(lg["creationTime"])).toISOString()
        : ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudTrailTrails(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ trailList?: Record<string, unknown>[] }>(
    "cloudtrail",
    "CloudTrail_20131101.DescribeTrails",
    {},
  );
  const trails = data.trailList ?? [];
  return trails.map((t) => {
    const name = String(t["Name"] ?? "");
    return {
      id: ctx.id(accountId, "cloudtrail-trail", name),
      pluginId: "aws",
      resourceTypeId: "cloudtrail-trail",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        s3BucketName: String(t["S3BucketName"] ?? ""),
        isMultiRegion: t["IsMultiRegionTrail"] === true,
        isOrganizationTrail: t["IsOrganizationTrail"] === true,
        logFileValidationEnabled: t["LogFileValidationEnabled"] === true,
        includeGlobalServiceEvents: t["IncludeGlobalServiceEvents"] === true,
        status: true,
      },
      resolvedOutputs: {
        trailArn: String(t["TrailARN"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listBackupVaults(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.restJson<{
    BackupVaultList?: Array<Record<string, unknown>>;
  }>("backup", "/backup-vaults", {}, "GET");
  const vaults = data.BackupVaultList ?? [];
  return vaults.map((v) => {
    const vaultName = String(v["BackupVaultName"] ?? "");
    return {
      id: ctx.id(accountId, "backup-vault", vaultName),
      pluginId: "aws",
      resourceTypeId: "backup-vault",
      accountId,
      displayName: vaultName,
      fields: {
        backupVaultName: vaultName,
        numberOfRecoveryPoints: Number(v["NumberOfRecoveryPoints"] ?? 0),
        encryptionKeyArn: String(v["EncryptionKeyArn"] ?? ""),
        creationDate: String(v["CreationDate"] ?? ""),
      },
      resolvedOutputs: {
        backupVaultArn: String(v["BackupVaultArn"] ?? ""),
      },
      secretStates: [],
      externalId: vaultName,
      createdAt: String(v["CreationDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
