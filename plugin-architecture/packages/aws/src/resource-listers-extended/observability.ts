import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../xml.js";
import type { ListerContext } from "../resource-listers.js";
import { collectPages, queryString, tokenParam } from "../paginate.js";

export async function listCloudWatchAlarms(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // CloudWatch (signing name `monitoring`) speaks the AWS Query protocol,
  // not JSON-RPC. The JSON form returns 404 from the endpoint.
  const metricAlarms = await collectPages(async (nextToken) => {
    const data = await ctx.ec2Query<Record<string, unknown>>(
      "monitoring",
      "DescribeAlarms",
      "2010-08-01",
      { MaxRecords: "100", ...tokenParam("NextToken", nextToken) },
    );
    const result = data["DescribeAlarmsResult"] as Record<string, unknown> | undefined;
    return {
      items: ensureArray(
        (result?.["MetricAlarms"] as Record<string, unknown> | undefined)?.["member"],
      ) as Record<string, unknown>[],
      next: result?.["NextToken"],
    };
  });

  return metricAlarms.map((a) => {
    const alarmName = String(a["AlarmName"] ?? "");
    // The alarm's dimensions say what it watches (InstanceId, QueueName, …).
    // Keep the readable summary and pull out the dimension names that name a
    // resource type we list, so the graph can point the alarm at its subject.
    const dimensions = ensureArray(
      (a["Dimensions"] as Record<string, unknown> | undefined)?.["member"],
    ) as Record<string, unknown>[];
    const byName = new Map<string, string>();
    for (const d of dimensions) {
      const name = String(d["Name"] ?? "");
      if (name) byName.set(name, String(d["Value"] ?? ""));
    }
    const dim = (name: string): string => byName.get(name) ?? "";
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
        dimensions: Array.from(byName, ([name, value]) => `${name}=${value}`).join(", "),
        instanceId: dim("InstanceId"),
        dbInstanceId: dim("DBInstanceIdentifier"),
        dbClusterId: dim("DBClusterIdentifier"),
        functionName: dim("FunctionName"),
        bucketName: dim("BucketName"),
        queueName: dim("QueueName"),
        tableName: dim("TableName"),
        autoScalingGroupName: dim("AutoScalingGroupName"),
        cacheClusterId: dim("CacheClusterId"),
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
  // DescribeLogGroups caps a page at 50.
  const logGroups = await collectPages(async (nextToken) => {
    const data = await ctx.json<{ logGroups?: Record<string, unknown>[]; nextToken?: string }>(
      "logs",
      "Logs_20140328.DescribeLogGroups",
      { limit: 50, ...tokenParam("nextToken", nextToken) },
    );
    return { items: data.logGroups ?? [], next: data.nextToken };
  });

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
  // Query params are camelCase, the response is PascalCase (`NextToken`).
  const vaults = await collectPages(async (nextToken) => {
    const data = await ctx.restJson<{
      BackupVaultList?: Array<Record<string, unknown>>;
      NextToken?: string | null;
    }>("backup", `/backup-vaults${queryString({ maxResults: 1000, nextToken })}`, {}, "GET");
    return { items: data.BackupVaultList ?? [], next: data.NextToken };
  });
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
