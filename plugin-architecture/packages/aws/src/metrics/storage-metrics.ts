import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "../auth.js";
import { jsonCall } from "../client-transport.js";
import type { MetricsContext } from "./cw-helpers.js";

/**
 * Storage / backup metric handlers — S3, EFS, AWS Backup.
 *
 * S3 metrics use a wider window than the shared `MetricsContext.fetchCw`
 * because BucketSizeBytes / NumberOfObjects only emit once per day.
 */

export async function s3BucketMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Bucket size/object count emit daily, so widen the period and request the
  // standard storage type. These are the only two CloudWatch metrics S3
  // returns without request-metrics opt-in.
  const f = resource.fields;
  const bucketName = String(f.name ?? resource.externalId ?? "");
  if (!bucketName) return [];
  const dimsSize = [
    { Name: "BucketName", Value: bucketName },
    { Name: "StorageType", Value: "StandardStorage" },
  ];
  const dimsObjects = [
    { Name: "BucketName", Value: bucketName },
    { Name: "StorageType", Value: "AllStorageTypes" },
  ];
  // S3 daily metrics need a wider window — back-fill 3 days minimum.
  const widerStart = Math.min(ctx.start, ctx.end - 3 * 86_400_000);
  const widerPeriod = 86_400;
  const fetchSize = async (
    creds: AwsCredentials,
    ns: string,
    m: string,
    d: typeof dimsSize,
  ): Promise<MetricSeries> => {
    const data = await jsonCall<Record<string, unknown>>(
      creds,
      "monitoring",
      "GraniteServiceVersion20100801.GetMetricStatistics",
      {
        Namespace: ns,
        MetricName: m,
        Dimensions: d,
        StartTime: new Date(widerStart).toISOString(),
        EndTime: new Date(ctx.end).toISOString(),
        Period: widerPeriod,
        Statistics: ["Average"],
      },
    );
    const datapoints = (data["Datapoints"] as Array<Record<string, unknown>>) ?? [];
    return {
      label: m,
      unit: String(data["Label"] ?? ""),
      points: datapoints
        .map((dp) => ({
          timestamp: new Date(String(dp["Timestamp"])).getTime(),
          value: Number(dp["Average"] ?? 0),
        }))
        .sort((a, b) => a.timestamp - b.timestamp),
    };
  };
  const [size, objects] = await Promise.all([
    fetchSize(ctx.creds, "AWS/S3", "BucketSizeBytes", dimsSize).catch(() => null),
    fetchSize(ctx.creds, "AWS/S3", "NumberOfObjects", dimsObjects).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (size && size.points.length > 0)
    results.push({ ...size, label: "Bucket Size", unit: "bytes" });
  if (objects && objects.points.length > 0) results.push({ ...objects, label: "Object Count" });
  return results;
}

export async function efsFileSystemMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // EFS dimension is the file system id (`fs-...`), matches externalId.
  const f = resource.fields;
  const fsId = String(f.fileSystemId ?? resource.externalId ?? "");
  if (!fsId) return [];
  const dims = [{ Name: "FileSystemId", Value: fsId }];
  const [readIo, writeIo, clientConns, percentIoLimit] = await Promise.all([
    ctx.fetchCw("AWS/EFS", "DataReadIOBytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EFS", "DataWriteIOBytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EFS", "ClientConnections", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EFS", "PercentIOLimit", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (readIo && readIo.points.length > 0)
    results.push({ ...readIo, label: "Read I/O", unit: "bytes" });
  if (writeIo && writeIo.points.length > 0)
    results.push({ ...writeIo, label: "Write I/O", unit: "bytes" });
  if (clientConns && clientConns.points.length > 0)
    results.push({ ...clientConns, label: "Client Connections" });
  if (percentIoLimit && percentIoLimit.points.length > 0)
    results.push({ ...percentIoLimit, label: "% I/O Limit", unit: "%" });
  return results;
}

export async function backupVaultMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified: https://docs.aws.amazon.com/aws-backup/latest/devguide/cloudwatch.html
  const f = resource.fields;
  const vaultName = String(f.backupVaultName ?? resource.externalId ?? "");
  if (!vaultName) return [];
  const dims = [{ Name: "BackupVaultName", Value: vaultName }];
  const [jobsCompleted, jobsFailed, jobsRunning, restoreCompleted, restoreFailed] =
    await Promise.all([
      ctx.fetchCw("AWS/Backup", "NumberOfBackupJobsCompleted", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/Backup", "NumberOfBackupJobsFailed", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/Backup", "NumberOfBackupJobsRunning", dims).catch(() => null),
      ctx.fetchCw("AWS/Backup", "NumberOfRestoreJobsCompleted", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/Backup", "NumberOfRestoreJobsFailed", dims, "Sum").catch(() => null),
    ]);
  const results: MetricSeries[] = [];
  if (jobsCompleted && jobsCompleted.points.length > 0)
    results.push({ ...jobsCompleted, label: "Backups Completed" });
  if (jobsFailed && jobsFailed.points.length > 0)
    results.push({ ...jobsFailed, label: "Backups Failed" });
  if (jobsRunning && jobsRunning.points.length > 0)
    results.push({ ...jobsRunning, label: "Backups Running" });
  if (restoreCompleted && restoreCompleted.points.length > 0)
    results.push({ ...restoreCompleted, label: "Restores Completed" });
  if (restoreFailed && restoreFailed.points.length > 0)
    results.push({ ...restoreFailed, label: "Restores Failed" });
  return results;
}
