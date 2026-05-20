import type { DashboardStat, MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { makeMetricsContext } from "./metrics/cw-helpers.js";
import {
  ec2InstanceMetrics,
  lambdaFunctionMetrics,
  autoScalingGroupMetrics,
  ebsVolumeMetrics,
  ecsServiceMetrics,
  appRunnerServiceMetrics,
} from "./metrics/compute-metrics.js";
import {
  rdsInstanceMetrics,
  rdsClusterMetrics,
  dynamoDbTableMetrics,
  elastiCacheClusterMetrics,
  redshiftClusterMetrics,
  openSearchDomainMetrics,
  documentDbClusterMetrics,
  neptuneClusterMetrics,
} from "./metrics/db-metrics.js";
import {
  albMetrics,
  targetGroupMetrics,
  cloudFrontDistributionMetrics,
  apiGatewayMetrics,
  natGatewayMetrics,
  route53HealthCheckMetrics,
} from "./metrics/networking-metrics.js";
import {
  sqsQueueMetrics,
  snsTopicMetrics,
  kinesisStreamMetrics,
  mskClusterMetrics,
  mqBrokerMetrics,
  stepFunctionMetrics,
} from "./metrics/messaging-metrics.js";
import {
  s3BucketMetrics,
  efsFileSystemMetrics,
  backupVaultMetrics,
} from "./metrics/storage-metrics.js";
import {
  sageMakerEndpointMetrics,
  codeBuildProjectMetrics,
  cloudWatchLogGroupMetrics,
  wafWebAclMetrics,
} from "./metrics/misc-metrics.js";

export function fetchDashboardStats(
  resource: ResourceInstance,
  resourceTypeId: string,
): DashboardStat[] {
  const f = resource.fields;
  const ro = resource.resolvedOutputs ?? {};

  switch (resourceTypeId) {
    case "ec2-instance": {
      const state = String(f.state ?? "unknown");
      const stats: DashboardStat[] = [
        {
          label: "State",
          value: state,
          variant:
            state === "running"
              ? "status-healthy"
              : state === "stopped" || state === "terminated"
                ? "status-error"
                : "status-degraded",
        },
        { label: "Instance Type", value: String(f.instanceType ?? "") },
        { label: "AZ", value: String(f.availabilityZone ?? "") },
      ];
      if (ro.publicIp) stats.push({ label: "Public IP", value: String(ro.publicIp) });
      return stats;
    }
    case "rds-instance": {
      const status = String(f.status ?? "unknown");
      return [
        {
          label: "Status",
          value: status,
          variant:
            status === "available"
              ? "status-healthy"
              : status === "stopped"
                ? "status-error"
                : "status-degraded",
        },
        { label: "Engine", value: `${f.engine ?? ""} ${f.engineVersion ?? ""}`.trim() },
        { label: "Instance Class", value: String(f.instanceClass ?? "") },
        { label: "Storage", value: `${f.allocatedStorage ?? 0} GB` },
      ];
    }
    case "lambda-function": {
      return [
        { label: "Runtime", value: String(f.runtime ?? "") },
        { label: "Memory", value: `${f.memorySize ?? 0} MB` },
        { label: "Timeout", value: `${f.timeout ?? 0}s` },
      ];
    }
    case "s3-bucket": {
      return [{ label: "Region", value: String(f.region ?? "") }];
    }
    case "eks-cluster": {
      const status = String(f.status ?? "unknown");
      return [
        { label: "Version", value: String(f.version ?? "") },
        {
          label: "Status",
          value: status,
          variant:
            status === "ACTIVE" || status === "active" ? "status-healthy" : "status-degraded",
        },
        { label: "Region", value: String(f.region ?? "") },
      ];
    }
    default: {
      // Generic fallback — show key fields from the resource
      const stats: DashboardStat[] = [];
      const statusVal = f.status ?? f.state ?? f.phase;
      if (statusVal != null) {
        const s = String(statusVal).toLowerCase();
        stats.push({
          label: "Status",
          value: String(statusVal),
          variant: [
            "running",
            "active",
            "available",
            "ready",
            "enabled",
            "healthy",
            "succeeded",
          ].some((v) => s.includes(v))
            ? "status-healthy"
            : ["error", "failed", "terminated", "deleted", "unhealthy"].some((v) => s.includes(v))
              ? "status-error"
              : ["pending", "creating", "updating", "stopping", "degraded", "warning"].some((v) =>
                    s.includes(v),
                  )
                ? "status-degraded"
                : "default",
        });
      }
      const typeVal =
        f.type ??
        f.kind ??
        f.engine ??
        f.instanceType ??
        f.tier ??
        f.machineType ??
        f.size ??
        f.flavor;
      if (typeVal != null) stats.push({ label: "Type", value: String(typeVal) });
      const regionVal = f.region ?? f.location ?? f.zone ?? f.availabilityZone;
      if (regionVal != null) stats.push({ label: "Region", value: String(regionVal) });
      return stats;
    }
  }
}

/**
 * Dispatch to a per-service CloudWatch metric handler. Each handler returns
 * the typed series we surface in the dashboard / resource detail metrics tab.
 * Adding a new resource type means a new entry here and a handler in one of
 * the `./metrics/*-metrics.ts` files.
 */
export async function fetchMetricSeries(
  creds: AwsCredentials,
  resource: ResourceInstance,
  resourceTypeId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const ctx = makeMetricsContext(creds, timeRange);

  switch (resourceTypeId) {
    case "ec2-instance":
      return ec2InstanceMetrics(ctx, resource);
    case "rds-instance":
      return rdsInstanceMetrics(ctx, resource);
    case "lambda-function":
      return lambdaFunctionMetrics(ctx, resource);
    case "alb":
      return albMetrics(ctx, resource);
    case "dynamodb-table":
      return dynamoDbTableMetrics(ctx, resource);
    case "sqs-queue":
      return sqsQueueMetrics(ctx, resource);
    case "ecs-service":
      return ecsServiceMetrics(ctx, resource);
    case "s3-bucket":
      return s3BucketMetrics(ctx, resource);
    case "auto-scaling-group":
      return autoScalingGroupMetrics(ctx, resource);
    case "elasticache-cluster":
      return elastiCacheClusterMetrics(ctx, resource);
    case "rds-cluster":
      return rdsClusterMetrics(ctx, resource);
    case "cloudfront-distribution":
      return cloudFrontDistributionMetrics(ctx, resource);
    case "api-gateway":
      return apiGatewayMetrics(ctx, resource);
    case "sns-topic":
      return snsTopicMetrics(ctx, resource);
    case "kinesis-stream":
      return kinesisStreamMetrics(ctx, resource);
    case "opensearch-domain":
      return openSearchDomainMetrics(ctx, resource);
    case "nat-gateway":
      return natGatewayMetrics(ctx, resource);
    case "ebs-volume":
      return ebsVolumeMetrics(ctx, resource);
    case "efs-file-system":
      return efsFileSystemMetrics(ctx, resource);
    case "step-function":
      return stepFunctionMetrics(ctx, resource);
    case "redshift-cluster":
      return redshiftClusterMetrics(ctx, resource);
    case "documentdb-cluster":
      return documentDbClusterMetrics(ctx, resource);
    case "neptune-cluster":
      return neptuneClusterMetrics(ctx, resource);
    case "mq-broker":
      return mqBrokerMetrics(ctx, resource);
    case "msk-cluster":
      return mskClusterMetrics(ctx, resource);
    case "sagemaker-endpoint":
      return sageMakerEndpointMetrics(ctx, resource);
    case "codebuild-project":
      return codeBuildProjectMetrics(ctx, resource);
    case "cloudwatch-log-group":
      return cloudWatchLogGroupMetrics(ctx, resource);
    case "waf-web-acl":
      return wafWebAclMetrics(ctx, resource);
    case "apprunner-service":
      return appRunnerServiceMetrics(ctx, resource);
    case "target-group":
      return targetGroupMetrics(ctx, resource);
    case "route53-health-check":
      return route53HealthCheckMetrics(ctx, resource);
    case "backup-vault":
      return backupVaultMetrics(ctx, resource);
    default:
      return [];
  }
}
