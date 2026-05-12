import type { DashboardStat, MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { jsonCall } from "./client-transport.js";

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

export async function fetchMetricSeries(
  creds: AwsCredentials,
  resource: ResourceInstance,
  resourceTypeId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const f = resource.fields;
  const now = Date.now();
  const start = timeRange?.startMs ?? now - 3600_000;
  const end = timeRange?.endMs ?? now;
  const period = Math.max(60, Math.floor((end - start) / 60));

  const fetchCw = async (
    namespace: string,
    metricName: string,
    dimensions: Array<{ Name: string; Value: string }>,
    stat = "Average",
  ): Promise<MetricSeries> => {
    const data = await jsonCall<Record<string, unknown>>(
      creds,
      "monitoring",
      "GraniteServiceVersion20100801.GetMetricStatistics",
      {
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: dimensions,
        StartTime: new Date(start).toISOString(),
        EndTime: new Date(end).toISOString(),
        Period: period,
        Statistics: [stat],
      },
    );
    const datapoints = (data["Datapoints"] as Array<Record<string, unknown>>) ?? [];
    return {
      label: metricName,
      unit: String(data["Label"] ?? ""),
      points: datapoints
        .map((dp) => ({
          timestamp: new Date(String(dp["Timestamp"])).getTime(),
          value: Number(dp[stat] ?? 0),
        }))
        .sort((a, b) => a.timestamp - b.timestamp),
    };
  };

  switch (resourceTypeId) {
    case "ec2-instance": {
      const instanceId = resource.externalId ?? "";
      const dims = [{ Name: "InstanceId", Value: instanceId }];
      const [cpu, netIn, netOut] = await Promise.all([
        fetchCw("AWS/EC2", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/EC2", "NetworkIn", dims).catch(() => null),
        fetchCw("AWS/EC2", "NetworkOut", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
      if (netIn && netIn.points.length > 0)
        results.push({ ...netIn, label: "Network In", unit: " bytes" });
      if (netOut && netOut.points.length > 0)
        results.push({ ...netOut, label: "Network Out", unit: " bytes" });
      return results;
    }
    case "rds-instance": {
      const dbId = resource.externalId ?? "";
      const dims = [{ Name: "DBInstanceIdentifier", Value: dbId }];
      const [cpu, conns, freeStorage] = await Promise.all([
        fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
        fetchCw("AWS/RDS", "FreeStorageSpace", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (freeStorage && freeStorage.points.length > 0)
        results.push({ ...freeStorage, label: "Free Storage", unit: " bytes" });
      return results;
    }
    case "lambda-function": {
      const fnName = resource.externalId ?? "";
      const dims = [{ Name: "FunctionName", Value: fnName }];
      const [invocations, duration, errors] = await Promise.all([
        fetchCw("AWS/Lambda", "Invocations", dims, "Sum").catch(() => null),
        fetchCw("AWS/Lambda", "Duration", dims).catch(() => null),
        fetchCw("AWS/Lambda", "Errors", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (invocations && invocations.points.length > 0)
        results.push({ ...invocations, label: "Invocations" });
      if (duration && duration.points.length > 0)
        results.push({ ...duration, label: "Duration", unit: "ms" });
      if (errors && errors.points.length > 0) results.push({ ...errors, label: "Errors" });
      return results;
    }
    case "alb": {
      // ALB dimension wants the trailing portion of the ARN (e.g. `app/my-lb/abc123`).
      const arn = String(resource.resolvedOutputs?.["loadBalancerArn"] ?? "");
      const dim = arn.split(":loadbalancer/").pop() ?? "";
      if (!dim) return [];
      const dims = [{ Name: "LoadBalancer", Value: dim }];
      const [reqs, active, latency, http5xx, http4xx] = await Promise.all([
        fetchCw("AWS/ApplicationELB", "RequestCount", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "ActiveConnectionCount", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "TargetResponseTime", dims).catch(() => null),
        fetchCw("AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (reqs && reqs.points.length > 0) results.push({ ...reqs, label: "Requests" });
      if (active && active.points.length > 0)
        results.push({ ...active, label: "Active Connections" });
      if (latency && latency.points.length > 0)
        results.push({ ...latency, label: "Target Response Time", unit: "s" });
      if (http5xx && http5xx.points.length > 0)
        results.push({ ...http5xx, label: "5xx Errors (target)" });
      if (http4xx && http4xx.points.length > 0)
        results.push({ ...http4xx, label: "4xx Errors (target)" });
      return results;
    }
    case "dynamodb-table": {
      const tableName = String(f.tableName ?? resource.externalId ?? "");
      const dims = [{ Name: "TableName", Value: tableName }];
      const [readCap, writeCap, throttled, sysErrors] = await Promise.all([
        fetchCw("AWS/DynamoDB", "ConsumedReadCapacityUnits", dims, "Sum").catch(() => null),
        fetchCw("AWS/DynamoDB", "ConsumedWriteCapacityUnits", dims, "Sum").catch(() => null),
        fetchCw("AWS/DynamoDB", "ThrottledRequests", dims, "Sum").catch(() => null),
        fetchCw("AWS/DynamoDB", "SystemErrors", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (readCap && readCap.points.length > 0)
        results.push({ ...readCap, label: "Consumed Read Capacity" });
      if (writeCap && writeCap.points.length > 0)
        results.push({ ...writeCap, label: "Consumed Write Capacity" });
      if (throttled && throttled.points.length > 0)
        results.push({ ...throttled, label: "Throttled Requests" });
      if (sysErrors && sysErrors.points.length > 0)
        results.push({ ...sysErrors, label: "System Errors" });
      return results;
    }
    case "sqs-queue": {
      // SQS dimension is the queue NAME (last segment of the queue URL), not ARN.
      const queueUrl = String(f.queueUrl ?? "");
      const queueName = String(f.queueName ?? queueUrl.split("/").pop() ?? "");
      if (!queueName) return [];
      const dims = [{ Name: "QueueName", Value: queueName }];
      const [visible, age, sent, received] = await Promise.all([
        fetchCw("AWS/SQS", "ApproximateNumberOfMessagesVisible", dims).catch(() => null),
        fetchCw("AWS/SQS", "ApproximateAgeOfOldestMessage", dims).catch(() => null),
        fetchCw("AWS/SQS", "NumberOfMessagesSent", dims, "Sum").catch(() => null),
        fetchCw("AWS/SQS", "NumberOfMessagesReceived", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (visible && visible.points.length > 0)
        results.push({ ...visible, label: "Messages Visible" });
      if (age && age.points.length > 0)
        results.push({ ...age, label: "Age of Oldest Message", unit: "s" });
      if (sent && sent.points.length > 0) results.push({ ...sent, label: "Messages Sent" });
      if (received && received.points.length > 0)
        results.push({ ...received, label: "Messages Received" });
      return results;
    }
    case "ecs-service": {
      const clusterName = String(f.clusterName ?? "");
      const serviceName = String(f.serviceName ?? resource.externalId ?? "");
      if (!clusterName || !serviceName) return [];
      const dims = [
        { Name: "ClusterName", Value: clusterName },
        { Name: "ServiceName", Value: serviceName },
      ];
      const [cpu, mem] = await Promise.all([
        fetchCw("AWS/ECS", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/ECS", "MemoryUtilization", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (mem && mem.points.length > 0)
        results.push({ ...mem, label: "Memory Utilization", unit: "%" });
      return results;
    }
    case "s3-bucket": {
      // Bucket size/object count emit daily, so widen the period and request the
      // standard storage type. These are the only two CloudWatch metrics S3
      // returns without request-metrics opt-in.
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
      const widerStart = Math.min(start, end - 3 * 86_400_000);
      const widerPeriod = 86_400;
      const fetchSize = async (
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
            EndTime: new Date(end).toISOString(),
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
        fetchSize("AWS/S3", "BucketSizeBytes", dimsSize).catch(() => null),
        fetchSize("AWS/S3", "NumberOfObjects", dimsObjects).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (size && size.points.length > 0)
        results.push({ ...size, label: "Bucket Size", unit: "bytes" });
      if (objects && objects.points.length > 0) results.push({ ...objects, label: "Object Count" });
      return results;
    }
    case "auto-scaling-group": {
      const asgName = String(f.name ?? resource.externalId ?? "");
      if (!asgName) return [];
      const dims = [{ Name: "AutoScalingGroupName", Value: asgName }];
      const [inService, desired, total] = await Promise.all([
        fetchCw("AWS/AutoScaling", "GroupInServiceInstances", dims).catch(() => null),
        fetchCw("AWS/AutoScaling", "GroupDesiredCapacity", dims).catch(() => null),
        fetchCw("AWS/AutoScaling", "GroupTotalInstances", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (inService && inService.points.length > 0)
        results.push({ ...inService, label: "In-Service Instances" });
      if (desired && desired.points.length > 0)
        results.push({ ...desired, label: "Desired Capacity" });
      if (total && total.points.length > 0) results.push({ ...total, label: "Total Instances" });
      return results;
    }
    case "elasticache-cluster": {
      // ElastiCache CloudWatch dim is CacheClusterId; for replication groups the
      // metric is published per-node. Fall back to the cluster externalId.
      const clusterId = String(f.clusterId ?? f.cacheClusterId ?? resource.externalId ?? "");
      if (!clusterId) return [];
      const dims = [{ Name: "CacheClusterId", Value: clusterId }];
      const [cpu, conns, bytesUsed, hits, misses] = await Promise.all([
        fetchCw("AWS/ElastiCache", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/ElastiCache", "CurrConnections", dims).catch(() => null),
        fetchCw("AWS/ElastiCache", "BytesUsedForCache", dims).catch(() => null),
        fetchCw("AWS/ElastiCache", "CacheHits", dims, "Sum").catch(() => null),
        fetchCw("AWS/ElastiCache", "CacheMisses", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0)
        results.push({ ...conns, label: "Current Connections" });
      if (bytesUsed && bytesUsed.points.length > 0)
        results.push({ ...bytesUsed, label: "Bytes Used", unit: "bytes" });
      if (hits && hits.points.length > 0) results.push({ ...hits, label: "Cache Hits" });
      if (misses && misses.points.length > 0) results.push({ ...misses, label: "Cache Misses" });
      return results;
    }
    case "rds-cluster": {
      const clusterId = String(
        f.clusterIdentifier ?? f.dbClusterIdentifier ?? resource.externalId ?? "",
      );
      if (!clusterId) return [];
      const dims = [{ Name: "DBClusterIdentifier", Value: clusterId }];
      const [cpu, conns, readLat, writeLat] = await Promise.all([
        fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
        fetchCw("AWS/RDS", "ReadLatency", dims).catch(() => null),
        fetchCw("AWS/RDS", "WriteLatency", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (readLat && readLat.points.length > 0)
        results.push({ ...readLat, label: "Read Latency", unit: "s" });
      if (writeLat && writeLat.points.length > 0)
        results.push({ ...writeLat, label: "Write Latency", unit: "s" });
      return results;
    }
    case "cloudfront-distribution": {
      // CloudFront metrics are only published in us-east-1. The dim is the
      // distribution Id (externalId). If creds are signed for another region
      // CloudWatch will still answer for global metrics.
      const distId = String(resource.externalId ?? "");
      if (!distId) return [];
      const dims = [
        { Name: "DistributionId", Value: distId },
        { Name: "Region", Value: "Global" },
      ];
      const [reqs, bytesDown, errorRate] = await Promise.all([
        fetchCw("AWS/CloudFront", "Requests", dims, "Sum").catch(() => null),
        fetchCw("AWS/CloudFront", "BytesDownloaded", dims, "Sum").catch(() => null),
        fetchCw("AWS/CloudFront", "TotalErrorRate", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (reqs && reqs.points.length > 0) results.push({ ...reqs, label: "Requests" });
      if (bytesDown && bytesDown.points.length > 0)
        results.push({ ...bytesDown, label: "Bytes Downloaded", unit: "bytes" });
      if (errorRate && errorRate.points.length > 0)
        results.push({ ...errorRate, label: "Error Rate", unit: "%" });
      return results;
    }
    case "api-gateway": {
      const apiName = String(f.name ?? resource.externalId ?? "");
      if (!apiName) return [];
      const dims = [{ Name: "ApiName", Value: apiName }];
      const [count, latency, errors5xx, errors4xx] = await Promise.all([
        fetchCw("AWS/ApiGateway", "Count", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApiGateway", "Latency", dims).catch(() => null),
        fetchCw("AWS/ApiGateway", "5XXError", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApiGateway", "4XXError", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (count && count.points.length > 0) results.push({ ...count, label: "Request Count" });
      if (latency && latency.points.length > 0)
        results.push({ ...latency, label: "Latency", unit: "ms" });
      if (errors5xx && errors5xx.points.length > 0)
        results.push({ ...errors5xx, label: "5xx Errors" });
      if (errors4xx && errors4xx.points.length > 0)
        results.push({ ...errors4xx, label: "4xx Errors" });
      return results;
    }
    case "sns-topic": {
      // SNS dimension is TopicName (last segment of ARN).
      const arn = String(resource.resolvedOutputs?.["topicArn"] ?? resource.externalId ?? "");
      const topicName = arn.split(":").pop() ?? "";
      if (!topicName) return [];
      const dims = [{ Name: "TopicName", Value: topicName }];
      const [published, delivered, failed] = await Promise.all([
        fetchCw("AWS/SNS", "NumberOfMessagesPublished", dims, "Sum").catch(() => null),
        fetchCw("AWS/SNS", "NumberOfNotificationsDelivered", dims, "Sum").catch(() => null),
        fetchCw("AWS/SNS", "NumberOfNotificationsFailed", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (published && published.points.length > 0)
        results.push({ ...published, label: "Messages Published" });
      if (delivered && delivered.points.length > 0)
        results.push({ ...delivered, label: "Notifications Delivered" });
      if (failed && failed.points.length > 0)
        results.push({ ...failed, label: "Notifications Failed" });
      return results;
    }
    case "kinesis-stream": {
      const streamName = String(f.streamName ?? resource.externalId ?? "");
      if (!streamName) return [];
      const dims = [{ Name: "StreamName", Value: streamName }];
      const [incomingBytes, incomingRecords, getBytes, putBytes] = await Promise.all([
        fetchCw("AWS/Kinesis", "IncomingBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "IncomingRecords", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "GetRecords.Bytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "PutRecord.Bytes", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (incomingBytes && incomingBytes.points.length > 0)
        results.push({ ...incomingBytes, label: "Incoming Bytes", unit: "bytes" });
      if (incomingRecords && incomingRecords.points.length > 0)
        results.push({ ...incomingRecords, label: "Incoming Records" });
      if (getBytes && getBytes.points.length > 0)
        results.push({ ...getBytes, label: "GetRecords Bytes", unit: "bytes" });
      if (putBytes && putBytes.points.length > 0)
        results.push({ ...putBytes, label: "PutRecord Bytes", unit: "bytes" });
      return results;
    }
    case "opensearch-domain": {
      const domainName = String(f.domainName ?? resource.externalId ?? "");
      if (!domainName) return [];
      // OpenSearch requires both DomainName and the AWS account/principal as
      // the ClientId. Use the principal-derived AccountId in dimensions only if
      // we can — otherwise fall back to single-dim query (works for most cases).
      const dims = [{ Name: "DomainName", Value: domainName }];
      const [cpu, jvm, storage, searches] = await Promise.all([
        fetchCw("AWS/ES", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/ES", "JVMMemoryPressure", dims).catch(() => null),
        fetchCw("AWS/ES", "FreeStorageSpace", dims).catch(() => null),
        fetchCw("AWS/ES", "SearchRate", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (jvm && jvm.points.length > 0)
        results.push({ ...jvm, label: "JVM Memory Pressure", unit: "%" });
      if (storage && storage.points.length > 0)
        results.push({ ...storage, label: "Free Storage", unit: "MB" });
      if (searches && searches.points.length > 0)
        results.push({ ...searches, label: "Search Rate" });
      return results;
    }
    case "nat-gateway": {
      const natId = String(resource.externalId ?? "");
      if (!natId) return [];
      const dims = [{ Name: "NatGatewayId", Value: natId }];
      const [bytesOut, bytesIn, conns] = await Promise.all([
        fetchCw("AWS/NATGateway", "BytesOutToDestination", dims, "Sum").catch(() => null),
        fetchCw("AWS/NATGateway", "BytesInFromDestination", dims, "Sum").catch(() => null),
        fetchCw("AWS/NATGateway", "ActiveConnectionCount", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (bytesOut && bytesOut.points.length > 0)
        results.push({ ...bytesOut, label: "Bytes Out", unit: "bytes" });
      if (bytesIn && bytesIn.points.length > 0)
        results.push({ ...bytesIn, label: "Bytes In", unit: "bytes" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Active Connections" });
      return results;
    }
    default:
      return [];
  }
}
