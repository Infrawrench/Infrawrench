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
      const [cpu, netIn, netOut, statusFailed, diskRead, diskWrite] = await Promise.all([
        fetchCw("AWS/EC2", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/EC2", "NetworkIn", dims).catch(() => null),
        fetchCw("AWS/EC2", "NetworkOut", dims).catch(() => null),
        fetchCw("AWS/EC2", "StatusCheckFailed", dims, "Maximum").catch(() => null),
        fetchCw("AWS/EC2", "DiskReadOps", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "DiskWriteOps", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
      if (netIn && netIn.points.length > 0)
        results.push({ ...netIn, label: "Network In", unit: " bytes" });
      if (netOut && netOut.points.length > 0)
        results.push({ ...netOut, label: "Network Out", unit: " bytes" });
      if (statusFailed && statusFailed.points.length > 0)
        results.push({ ...statusFailed, label: "Status Check Failed" });
      if (diskRead && diskRead.points.length > 0)
        results.push({ ...diskRead, label: "Disk Read Ops" });
      if (diskWrite && diskWrite.points.length > 0)
        results.push({ ...diskWrite, label: "Disk Write Ops" });
      return results;
    }
    case "rds-instance": {
      const dbId = String(f.dbInstanceId ?? resource.externalId ?? "");
      if (!dbId) return [];
      const dims = [{ Name: "DBInstanceIdentifier", Value: dbId }];
      const [cpu, conns, freeStorage, readIops, writeIops] = await Promise.all([
        fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
        fetchCw("AWS/RDS", "FreeStorageSpace", dims).catch(() => null),
        fetchCw("AWS/RDS", "ReadIOPS", dims).catch(() => null),
        fetchCw("AWS/RDS", "WriteIOPS", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (freeStorage && freeStorage.points.length > 0)
        results.push({ ...freeStorage, label: "Free Storage", unit: " bytes" });
      if (readIops && readIops.points.length > 0) results.push({ ...readIops, label: "Read IOPS" });
      if (writeIops && writeIops.points.length > 0)
        results.push({ ...writeIops, label: "Write IOPS" });
      return results;
    }
    case "lambda-function": {
      const fnName = String(f.name ?? resource.externalId ?? "");
      if (!fnName) return [];
      const dims = [{ Name: "FunctionName", Value: fnName }];
      const [invocations, duration, errors, throttles, concurrent] = await Promise.all([
        fetchCw("AWS/Lambda", "Invocations", dims, "Sum").catch(() => null),
        fetchCw("AWS/Lambda", "Duration", dims).catch(() => null),
        fetchCw("AWS/Lambda", "Errors", dims, "Sum").catch(() => null),
        fetchCw("AWS/Lambda", "Throttles", dims, "Sum").catch(() => null),
        fetchCw("AWS/Lambda", "ConcurrentExecutions", dims, "Maximum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (invocations && invocations.points.length > 0)
        results.push({ ...invocations, label: "Invocations" });
      if (duration && duration.points.length > 0)
        results.push({ ...duration, label: "Duration", unit: "ms" });
      if (errors && errors.points.length > 0) results.push({ ...errors, label: "Errors" });
      if (throttles && throttles.points.length > 0)
        results.push({ ...throttles, label: "Throttles" });
      if (concurrent && concurrent.points.length > 0)
        results.push({ ...concurrent, label: "Concurrent Executions" });
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
      const [cpu, conns, readLat, writeLat, readIops, writeIops] = await Promise.all([
        fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
        fetchCw("AWS/RDS", "ReadLatency", dims).catch(() => null),
        fetchCw("AWS/RDS", "WriteLatency", dims).catch(() => null),
        fetchCw("AWS/RDS", "ReadIOPS", dims).catch(() => null),
        fetchCw("AWS/RDS", "WriteIOPS", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (readLat && readLat.points.length > 0)
        results.push({ ...readLat, label: "Read Latency", unit: "s" });
      if (writeLat && writeLat.points.length > 0)
        results.push({ ...writeLat, label: "Write Latency", unit: "s" });
      if (readIops && readIops.points.length > 0) results.push({ ...readIops, label: "Read IOPS" });
      if (writeIops && writeIops.points.length > 0)
        results.push({ ...writeIops, label: "Write IOPS" });
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
      // v1 REST APIs publish metrics keyed on `ApiName`; v2 (HTTP/WebSocket)
      // APIs publish on `ApiId`. The lister sets `protocolType` to "REST" for
      // v1 and "HTTP"/"WEBSOCKET" for v2, so branch on that.
      const protocolType = String(f.protocolType ?? "").toUpperCase();
      const apiId = String(f.apiId ?? resource.externalId ?? "");
      const apiName = String(f.name ?? "");
      const dims =
        protocolType === "REST" && apiName
          ? [{ Name: "ApiName", Value: apiName }]
          : apiId
            ? [{ Name: "ApiId", Value: apiId }]
            : null;
      if (!dims) return [];
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
      const [incomingBytes, incomingRecords, getBytes, putBytes, writeThrottle, readThrottle] =
        await Promise.all([
          fetchCw("AWS/Kinesis", "IncomingBytes", dims, "Sum").catch(() => null),
          fetchCw("AWS/Kinesis", "IncomingRecords", dims, "Sum").catch(() => null),
          fetchCw("AWS/Kinesis", "GetRecords.Bytes", dims, "Sum").catch(() => null),
          fetchCw("AWS/Kinesis", "PutRecord.Bytes", dims, "Sum").catch(() => null),
          fetchCw("AWS/Kinesis", "WriteProvisionedThroughputExceeded", dims, "Sum").catch(
            () => null,
          ),
          fetchCw("AWS/Kinesis", "ReadProvisionedThroughputExceeded", dims, "Sum").catch(
            () => null,
          ),
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
      if (writeThrottle && writeThrottle.points.length > 0)
        results.push({ ...writeThrottle, label: "Write Throttles" });
      if (readThrottle && readThrottle.points.length > 0)
        results.push({ ...readThrottle, label: "Read Throttles" });
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
    case "ebs-volume": {
      // EBS dimension is the volume id (`vol-...`), which matches externalId.
      const volumeId = String(f.volumeId ?? resource.externalId ?? "");
      if (!volumeId) return [];
      const dims = [{ Name: "VolumeId", Value: volumeId }];
      const [readBytes, writeBytes, readOps, writeOps, queueLen] = await Promise.all([
        fetchCw("AWS/EBS", "VolumeReadBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/EBS", "VolumeWriteBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/EBS", "VolumeReadOps", dims, "Sum").catch(() => null),
        fetchCw("AWS/EBS", "VolumeWriteOps", dims, "Sum").catch(() => null),
        fetchCw("AWS/EBS", "VolumeQueueLength", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (readBytes && readBytes.points.length > 0)
        results.push({ ...readBytes, label: "Read Bytes", unit: "bytes" });
      if (writeBytes && writeBytes.points.length > 0)
        results.push({ ...writeBytes, label: "Write Bytes", unit: "bytes" });
      if (readOps && readOps.points.length > 0) results.push({ ...readOps, label: "Read Ops" });
      if (writeOps && writeOps.points.length > 0) results.push({ ...writeOps, label: "Write Ops" });
      if (queueLen && queueLen.points.length > 0)
        results.push({ ...queueLen, label: "Queue Length" });
      return results;
    }
    case "efs-file-system": {
      // EFS dimension is the file system id (`fs-...`), matches externalId.
      const fsId = String(f.fileSystemId ?? resource.externalId ?? "");
      if (!fsId) return [];
      const dims = [{ Name: "FileSystemId", Value: fsId }];
      const [readIo, writeIo, clientConns, percentIoLimit] = await Promise.all([
        fetchCw("AWS/EFS", "DataReadIOBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/EFS", "DataWriteIOBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/EFS", "ClientConnections", dims, "Sum").catch(() => null),
        fetchCw("AWS/EFS", "PercentIOLimit", dims).catch(() => null),
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
    case "step-function": {
      // States dimension is the full state machine ARN; externalId is the ARN.
      // AWS Step Functions docs (https://docs.aws.amazon.com/step-functions/latest/dg/procedure-cw-metrics.html)
      // recommend `ExecutionsStarted` + `ExecutionsTimedOut` as the baseline.
      const smArn = String(
        resource.resolvedOutputs?.["stateMachineArn"] ?? resource.externalId ?? "",
      );
      if (!smArn) return [];
      const dims = [{ Name: "StateMachineArn", Value: smArn }];
      const [started, succeeded, failed, timedOut, throttled, aborted, time] = await Promise.all([
        fetchCw("AWS/States", "ExecutionsStarted", dims, "Sum").catch(() => null),
        fetchCw("AWS/States", "ExecutionsSucceeded", dims, "Sum").catch(() => null),
        fetchCw("AWS/States", "ExecutionsFailed", dims, "Sum").catch(() => null),
        fetchCw("AWS/States", "ExecutionsTimedOut", dims, "Sum").catch(() => null),
        fetchCw("AWS/States", "ExecutionThrottled", dims, "Sum").catch(() => null),
        fetchCw("AWS/States", "ExecutionsAborted", dims, "Sum").catch(() => null),
        fetchCw("AWS/States", "ExecutionTime", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (started && started.points.length > 0)
        results.push({ ...started, label: "Executions Started" });
      if (succeeded && succeeded.points.length > 0)
        results.push({ ...succeeded, label: "Executions Succeeded" });
      if (failed && failed.points.length > 0)
        results.push({ ...failed, label: "Executions Failed" });
      if (timedOut && timedOut.points.length > 0)
        results.push({ ...timedOut, label: "Executions Timed Out" });
      if (aborted && aborted.points.length > 0)
        results.push({ ...aborted, label: "Executions Aborted" });
      if (throttled && throttled.points.length > 0)
        results.push({ ...throttled, label: "Throttled" });
      if (time && time.points.length > 0)
        results.push({ ...time, label: "Execution Time", unit: "ms" });
      return results;
    }
    case "redshift-cluster": {
      // Redshift dimension is the cluster identifier (the name), not the ARN.
      const clusterId = String(f.clusterIdentifier ?? resource.externalId ?? "");
      if (!clusterId) return [];
      const dims = [{ Name: "ClusterIdentifier", Value: clusterId }];
      const [cpu, conns, diskPct, healthStatus] = await Promise.all([
        fetchCw("AWS/Redshift", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/Redshift", "DatabaseConnections", dims).catch(() => null),
        fetchCw("AWS/Redshift", "PercentageDiskSpaceUsed", dims).catch(() => null),
        fetchCw("AWS/Redshift", "HealthStatus", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (diskPct && diskPct.points.length > 0)
        results.push({ ...diskPct, label: "% Disk Used", unit: "%" });
      if (healthStatus && healthStatus.points.length > 0)
        results.push({ ...healthStatus, label: "Health Status" });
      return results;
    }
    case "documentdb-cluster": {
      // DocumentDB shares the DocDB namespace; dim is the cluster identifier name.
      const clusterId = String(f.clusterIdentifier ?? resource.externalId ?? "");
      if (!clusterId) return [];
      const dims = [{ Name: "DBClusterIdentifier", Value: clusterId }];
      const [cpu, conns, bufHit, readLat] = await Promise.all([
        fetchCw("AWS/DocDB", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/DocDB", "DatabaseConnections", dims).catch(() => null),
        fetchCw("AWS/DocDB", "BufferCacheHitRatio", dims).catch(() => null),
        fetchCw("AWS/DocDB", "ReadLatency", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (bufHit && bufHit.points.length > 0)
        results.push({ ...bufHit, label: "Buffer Cache Hit Ratio", unit: "%" });
      if (readLat && readLat.points.length > 0)
        results.push({ ...readLat, label: "Read Latency", unit: "ms" });
      return results;
    }
    case "neptune-cluster": {
      const clusterId = String(f.clusterIdentifier ?? resource.externalId ?? "");
      if (!clusterId) return [];
      const dims = [{ Name: "DBClusterIdentifier", Value: clusterId }];
      const [cpu, conns, bufHit, gremlinReq] = await Promise.all([
        fetchCw("AWS/Neptune", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/Neptune", "MainRequestQueuePendingRequests", dims).catch(() => null),
        fetchCw("AWS/Neptune", "BufferCacheHitRatio", dims).catch(() => null),
        fetchCw("AWS/Neptune", "GremlinRequestsPerSec", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Pending Requests" });
      if (bufHit && bufHit.points.length > 0)
        results.push({ ...bufHit, label: "Buffer Cache Hit Ratio", unit: "%" });
      if (gremlinReq && gremlinReq.points.length > 0)
        results.push({ ...gremlinReq, label: "Gremlin Requests/sec" });
      return results;
    }
    case "mq-broker": {
      // MQ dimension is the broker name; the externalId is the broker id, so prefer field.
      const brokerName = String(f.brokerName ?? "");
      if (!brokerName) return [];
      const dims = [{ Name: "Broker", Value: brokerName }];
      const [cpu, conns, heap] = await Promise.all([
        fetchCw("AWS/AmazonMQ", "CpuUtilization", dims).catch(() => null),
        fetchCw("AWS/AmazonMQ", "CurrentConnectionsCount", dims).catch(() => null),
        fetchCw("AWS/AmazonMQ", "HeapUsage", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (heap && heap.points.length > 0) results.push({ ...heap, label: "Heap Usage", unit: "%" });
      return results;
    }
    case "msk-cluster": {
      // Kafka dimension is "Cluster Name" (with the space).
      const clusterName = String(f.clusterName ?? "");
      if (!clusterName) return [];
      const dims = [{ Name: "Cluster Name", Value: clusterName }];
      const [cpuUser, memUsed, diskUsed, activeConns] = await Promise.all([
        fetchCw("AWS/Kafka", "CpuUser", dims).catch(() => null),
        fetchCw("AWS/Kafka", "MemoryUsed", dims).catch(() => null),
        fetchCw("AWS/Kafka", "KafkaDataLogsDiskUsed", dims).catch(() => null),
        fetchCw("AWS/Kafka", "ActiveControllerCount", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpuUser && cpuUser.points.length > 0)
        results.push({ ...cpuUser, label: "CPU (User)", unit: "%" });
      if (memUsed && memUsed.points.length > 0)
        results.push({ ...memUsed, label: "Memory Used", unit: "bytes" });
      if (diskUsed && diskUsed.points.length > 0)
        results.push({ ...diskUsed, label: "Data Log Disk Used", unit: "%" });
      if (activeConns && activeConns.points.length > 0)
        results.push({ ...activeConns, label: "Active Controllers" });
      return results;
    }
    case "sagemaker-endpoint": {
      // SageMaker requires both EndpointName and VariantName. Default variant is AllTraffic.
      const endpointName = String(f.endpointName ?? resource.externalId ?? "");
      if (!endpointName) return [];
      const dims = [
        { Name: "EndpointName", Value: endpointName },
        { Name: "VariantName", Value: "AllTraffic" },
      ];
      const [invocations, latency, errors4xx, errors5xx] = await Promise.all([
        fetchCw("AWS/SageMaker", "Invocations", dims, "Sum").catch(() => null),
        fetchCw("AWS/SageMaker", "ModelLatency", dims).catch(() => null),
        fetchCw("AWS/SageMaker", "Invocation4XXErrors", dims, "Sum").catch(() => null),
        fetchCw("AWS/SageMaker", "Invocation5XXErrors", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (invocations && invocations.points.length > 0)
        results.push({ ...invocations, label: "Invocations" });
      if (latency && latency.points.length > 0)
        results.push({ ...latency, label: "Model Latency", unit: "μs" });
      if (errors4xx && errors4xx.points.length > 0)
        results.push({ ...errors4xx, label: "4xx Errors" });
      if (errors5xx && errors5xx.points.length > 0)
        results.push({ ...errors5xx, label: "5xx Errors" });
      return results;
    }
    case "codebuild-project": {
      const projectName = String(f.name ?? resource.externalId ?? "");
      if (!projectName) return [];
      const dims = [{ Name: "ProjectName", Value: projectName }];
      const [builds, duration, succeeded, failed] = await Promise.all([
        fetchCw("AWS/CodeBuild", "Builds", dims, "Sum").catch(() => null),
        fetchCw("AWS/CodeBuild", "Duration", dims).catch(() => null),
        fetchCw("AWS/CodeBuild", "SucceededBuilds", dims, "Sum").catch(() => null),
        fetchCw("AWS/CodeBuild", "FailedBuilds", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (builds && builds.points.length > 0) results.push({ ...builds, label: "Builds" });
      if (duration && duration.points.length > 0)
        results.push({ ...duration, label: "Build Duration", unit: "s" });
      if (succeeded && succeeded.points.length > 0)
        results.push({ ...succeeded, label: "Succeeded" });
      if (failed && failed.points.length > 0) results.push({ ...failed, label: "Failed" });
      return results;
    }
    case "cloudwatch-log-group": {
      // AWS/Logs dimension is LogGroupName, externalId is typically the name.
      const logGroupName = String(f.logGroupName ?? resource.externalId ?? "");
      if (!logGroupName) return [];
      const dims = [{ Name: "LogGroupName", Value: logGroupName }];
      const [incomingBytes, incomingEvents] = await Promise.all([
        fetchCw("AWS/Logs", "IncomingBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/Logs", "IncomingLogEvents", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (incomingBytes && incomingBytes.points.length > 0)
        results.push({ ...incomingBytes, label: "Incoming Bytes", unit: "bytes" });
      if (incomingEvents && incomingEvents.points.length > 0)
        results.push({ ...incomingEvents, label: "Incoming Log Events" });
      return results;
    }
    case "waf-web-acl": {
      // WAFv2 requires WebACL + Rule (ALL) + Region. CloudFront-scoped uses Region "CloudFront".
      const aclName = String(f.name ?? "");
      if (!aclName) return [];
      const scope = String(f.scope ?? "REGIONAL");
      const region = scope === "CLOUDFRONT" ? "CloudFront" : String(f.region ?? creds.region ?? "");
      const dims = [
        { Name: "WebACL", Value: aclName },
        { Name: "Rule", Value: "ALL" },
        { Name: "Region", Value: region },
      ];
      const [allowed, blocked, counted] = await Promise.all([
        fetchCw("AWS/WAFV2", "AllowedRequests", dims, "Sum").catch(() => null),
        fetchCw("AWS/WAFV2", "BlockedRequests", dims, "Sum").catch(() => null),
        fetchCw("AWS/WAFV2", "CountedRequests", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (allowed && allowed.points.length > 0) results.push({ ...allowed, label: "Allowed" });
      if (blocked && blocked.points.length > 0) results.push({ ...blocked, label: "Blocked" });
      if (counted && counted.points.length > 0) results.push({ ...counted, label: "Counted" });
      return results;
    }
    case "apprunner-service": {
      // App Runner dim is ServiceName.
      const serviceName = String(f.serviceName ?? resource.externalId ?? "");
      if (!serviceName) return [];
      const dims = [{ Name: "ServiceName", Value: serviceName }];
      const [cpu, mem, reqs, status4xx, status5xx] = await Promise.all([
        fetchCw("AWS/AppRunner", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/AppRunner", "MemoryUtilization", dims).catch(() => null),
        fetchCw("AWS/AppRunner", "Requests", dims, "Sum").catch(() => null),
        fetchCw("AWS/AppRunner", "4xxStatusResponses", dims, "Sum").catch(() => null),
        fetchCw("AWS/AppRunner", "5xxStatusResponses", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (mem && mem.points.length > 0)
        results.push({ ...mem, label: "Memory Utilization", unit: "%" });
      if (reqs && reqs.points.length > 0) results.push({ ...reqs, label: "Requests" });
      if (status4xx && status4xx.points.length > 0)
        results.push({ ...status4xx, label: "4xx Responses" });
      if (status5xx && status5xx.points.length > 0)
        results.push({ ...status5xx, label: "5xx Responses" });
      return results;
    }
    default:
      return [];
  }
}
