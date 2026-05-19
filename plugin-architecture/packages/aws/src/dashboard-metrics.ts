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
      // Verified against
      // https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/viewing_metrics_with_cloudwatch.html
      // Note: DiskRead/WriteOps are instance store (ephemeral) — for EBS use
      // EBSReadOps/EBSWriteOps. CPUCreditBalance is T-class only and silently
      // returns empty for other instance types.
      const instanceId = resource.externalId ?? "";
      const dims = [{ Name: "InstanceId", Value: instanceId }];
      const [
        cpu,
        netIn,
        netOut,
        netPktsIn,
        netPktsOut,
        statusFailed,
        statusInst,
        statusSys,
        diskRead,
        diskWrite,
        ebsReadBytes,
        ebsWriteBytes,
        ebsReadOps,
        ebsWriteOps,
        creditBalance,
      ] = await Promise.all([
        fetchCw("AWS/EC2", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/EC2", "NetworkIn", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "NetworkOut", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "NetworkPacketsIn", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "NetworkPacketsOut", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "StatusCheckFailed", dims, "Maximum").catch(() => null),
        fetchCw("AWS/EC2", "StatusCheckFailed_Instance", dims, "Maximum").catch(() => null),
        fetchCw("AWS/EC2", "StatusCheckFailed_System", dims, "Maximum").catch(() => null),
        fetchCw("AWS/EC2", "DiskReadOps", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "DiskWriteOps", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "EBSReadBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "EBSWriteBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "EBSReadOps", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "EBSWriteOps", dims, "Sum").catch(() => null),
        fetchCw("AWS/EC2", "CPUCreditBalance", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
      if (netIn && netIn.points.length > 0)
        results.push({ ...netIn, label: "Network In", unit: "bytes" });
      if (netOut && netOut.points.length > 0)
        results.push({ ...netOut, label: "Network Out", unit: "bytes" });
      if (netPktsIn && netPktsIn.points.length > 0)
        results.push({ ...netPktsIn, label: "Packets In" });
      if (netPktsOut && netPktsOut.points.length > 0)
        results.push({ ...netPktsOut, label: "Packets Out" });
      if (statusFailed && statusFailed.points.length > 0)
        results.push({ ...statusFailed, label: "Status Check Failed" });
      if (statusInst && statusInst.points.length > 0)
        results.push({ ...statusInst, label: "Instance Check Failed" });
      if (statusSys && statusSys.points.length > 0)
        results.push({ ...statusSys, label: "System Check Failed" });
      if (ebsReadBytes && ebsReadBytes.points.length > 0)
        results.push({ ...ebsReadBytes, label: "EBS Read", unit: "bytes" });
      if (ebsWriteBytes && ebsWriteBytes.points.length > 0)
        results.push({ ...ebsWriteBytes, label: "EBS Write", unit: "bytes" });
      if (ebsReadOps && ebsReadOps.points.length > 0)
        results.push({ ...ebsReadOps, label: "EBS Read Ops" });
      if (ebsWriteOps && ebsWriteOps.points.length > 0)
        results.push({ ...ebsWriteOps, label: "EBS Write Ops" });
      if (diskRead && diskRead.points.length > 0)
        results.push({ ...diskRead, label: "Instance Store Read Ops" });
      if (diskWrite && diskWrite.points.length > 0)
        results.push({ ...diskWrite, label: "Instance Store Write Ops" });
      if (creditBalance && creditBalance.points.length > 0)
        results.push({ ...creditBalance, label: "CPU Credit Balance" });
      return results;
    }
    case "rds-instance": {
      // Verified against
      // https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html
      const dbId = String(f.dbInstanceId ?? resource.externalId ?? "");
      if (!dbId) return [];
      const dims = [{ Name: "DBInstanceIdentifier", Value: dbId }];
      const [
        cpu,
        conns,
        freeStorage,
        freeableMem,
        swap,
        readIops,
        writeIops,
        readLat,
        writeLat,
        netIn,
        netOut,
        burstBal,
        replicaLag,
      ] = await Promise.all([
        fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
        fetchCw("AWS/RDS", "FreeStorageSpace", dims).catch(() => null),
        fetchCw("AWS/RDS", "FreeableMemory", dims).catch(() => null),
        fetchCw("AWS/RDS", "SwapUsage", dims).catch(() => null),
        fetchCw("AWS/RDS", "ReadIOPS", dims).catch(() => null),
        fetchCw("AWS/RDS", "WriteIOPS", dims).catch(() => null),
        fetchCw("AWS/RDS", "ReadLatency", dims).catch(() => null),
        fetchCw("AWS/RDS", "WriteLatency", dims).catch(() => null),
        fetchCw("AWS/RDS", "NetworkReceiveThroughput", dims).catch(() => null),
        fetchCw("AWS/RDS", "NetworkTransmitThroughput", dims).catch(() => null),
        fetchCw("AWS/RDS", "BurstBalance", dims).catch(() => null),
        fetchCw("AWS/RDS", "ReplicaLag", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (freeStorage && freeStorage.points.length > 0)
        results.push({ ...freeStorage, label: "Free Storage", unit: " bytes" });
      if (freeableMem && freeableMem.points.length > 0)
        results.push({ ...freeableMem, label: "Freeable Memory", unit: " bytes" });
      if (swap && swap.points.length > 0)
        results.push({ ...swap, label: "Swap Usage", unit: " bytes" });
      if (readIops && readIops.points.length > 0) results.push({ ...readIops, label: "Read IOPS" });
      if (writeIops && writeIops.points.length > 0)
        results.push({ ...writeIops, label: "Write IOPS" });
      if (readLat && readLat.points.length > 0)
        results.push({ ...readLat, label: "Read Latency", unit: "s" });
      if (writeLat && writeLat.points.length > 0)
        results.push({ ...writeLat, label: "Write Latency", unit: "s" });
      if (netIn && netIn.points.length > 0)
        results.push({ ...netIn, label: "Network In", unit: " bytes/s" });
      if (netOut && netOut.points.length > 0)
        results.push({ ...netOut, label: "Network Out", unit: " bytes/s" });
      if (burstBal && burstBal.points.length > 0)
        results.push({ ...burstBal, label: "Burst Balance", unit: "%" });
      // ReplicaLag is only emitted on read replicas.
      if (replicaLag && replicaLag.points.length > 0)
        results.push({ ...replicaLag, label: "Replica Lag", unit: "s" });
      return results;
    }
    case "lambda-function": {
      // Verified against
      // https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html
      // IteratorAge applies only to stream sources (Kinesis/DynamoDB/DocDB);
      // DeadLetterErrors / AsyncEventAge apply to async invocations; the
      // points-length guard naturally hides metrics that don't apply.
      const fnName = String(f.name ?? resource.externalId ?? "");
      if (!fnName) return [];
      const dims = [{ Name: "FunctionName", Value: fnName }];
      const [
        invocations,
        duration,
        errors,
        throttles,
        concurrent,
        deadLetter,
        iteratorAge,
        asyncEventAge,
      ] = await Promise.all([
        fetchCw("AWS/Lambda", "Invocations", dims, "Sum").catch(() => null),
        fetchCw("AWS/Lambda", "Duration", dims).catch(() => null),
        fetchCw("AWS/Lambda", "Errors", dims, "Sum").catch(() => null),
        fetchCw("AWS/Lambda", "Throttles", dims, "Sum").catch(() => null),
        fetchCw("AWS/Lambda", "ConcurrentExecutions", dims, "Maximum").catch(() => null),
        fetchCw("AWS/Lambda", "DeadLetterErrors", dims, "Sum").catch(() => null),
        fetchCw("AWS/Lambda", "IteratorAge", dims, "Maximum").catch(() => null),
        fetchCw("AWS/Lambda", "AsyncEventAge", dims, "Maximum").catch(() => null),
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
      if (deadLetter && deadLetter.points.length > 0)
        results.push({ ...deadLetter, label: "Dead Letter Errors" });
      if (iteratorAge && iteratorAge.points.length > 0)
        results.push({ ...iteratorAge, label: "Iterator Age", unit: "ms" });
      if (asyncEventAge && asyncEventAge.points.length > 0)
        results.push({ ...asyncEventAge, label: "Async Event Age", unit: "ms" });
      return results;
    }
    case "alb": {
      // Verified against
      // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html
      // ALB dimension wants the trailing portion of the ARN (e.g.
      // `app/my-lb/abc123`). ELB 4xx/5xx are different from Target 4xx/5xx —
      // ELB-originated codes mean the load balancer never reached a target
      // (no targets, malformed request, etc.), so worth surfacing separately.
      const arn = String(resource.resolvedOutputs?.["loadBalancerArn"] ?? "");
      const dim = arn.split(":loadbalancer/").pop() ?? "";
      if (!dim) return [];
      const dims = [{ Name: "LoadBalancer", Value: dim }];
      const [
        reqs,
        active,
        newConn,
        rejected,
        bytes,
        latency,
        target5xx,
        target4xx,
        elb5xx,
        elb4xx,
        targetConnErr,
        consumedLcus,
      ] = await Promise.all([
        fetchCw("AWS/ApplicationELB", "RequestCount", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "ActiveConnectionCount", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "NewConnectionCount", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "RejectedConnectionCount", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "ProcessedBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "TargetResponseTime", dims).catch(() => null),
        fetchCw("AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "HTTPCode_ELB_4XX_Count", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "TargetConnectionErrorCount", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "ConsumedLCUs", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (reqs && reqs.points.length > 0) results.push({ ...reqs, label: "Requests" });
      if (active && active.points.length > 0)
        results.push({ ...active, label: "Active Connections" });
      if (newConn && newConn.points.length > 0)
        results.push({ ...newConn, label: "New Connections" });
      if (rejected && rejected.points.length > 0)
        results.push({ ...rejected, label: "Rejected Connections" });
      if (bytes && bytes.points.length > 0)
        results.push({ ...bytes, label: "Processed Bytes", unit: "bytes" });
      if (latency && latency.points.length > 0)
        results.push({ ...latency, label: "Target Response Time", unit: "s" });
      if (target5xx && target5xx.points.length > 0)
        results.push({ ...target5xx, label: "5xx Errors (target)" });
      if (target4xx && target4xx.points.length > 0)
        results.push({ ...target4xx, label: "4xx Errors (target)" });
      if (elb5xx && elb5xx.points.length > 0)
        results.push({ ...elb5xx, label: "5xx Errors (ELB)" });
      if (elb4xx && elb4xx.points.length > 0)
        results.push({ ...elb4xx, label: "4xx Errors (ELB)" });
      if (targetConnErr && targetConnErr.points.length > 0)
        results.push({ ...targetConnErr, label: "Target Conn Errors" });
      if (consumedLcus && consumedLcus.points.length > 0)
        results.push({ ...consumedLcus, label: "Consumed LCUs" });
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
      // Verified against
      // https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html
      // SQS dimension is the queue NAME (last segment of the queue URL), not ARN.
      // For DLQs `ApproximateNumberOfMessagesVisible` is the canonical "backlog"
      // signal — `NumberOfMessagesSent` doesn't count auto-redriven messages.
      const queueUrl = String(f.queueUrl ?? "");
      const queueName = String(f.queueName ?? queueUrl.split("/").pop() ?? "");
      if (!queueName) return [];
      const dims = [{ Name: "QueueName", Value: queueName }];
      const [visible, notVisible, delayed, age, sent, received, deleted, emptyReceives, msgSize] =
        await Promise.all([
          fetchCw("AWS/SQS", "ApproximateNumberOfMessagesVisible", dims).catch(() => null),
          fetchCw("AWS/SQS", "ApproximateNumberOfMessagesNotVisible", dims).catch(() => null),
          fetchCw("AWS/SQS", "ApproximateNumberOfMessagesDelayed", dims).catch(() => null),
          fetchCw("AWS/SQS", "ApproximateAgeOfOldestMessage", dims).catch(() => null),
          fetchCw("AWS/SQS", "NumberOfMessagesSent", dims, "Sum").catch(() => null),
          fetchCw("AWS/SQS", "NumberOfMessagesReceived", dims, "Sum").catch(() => null),
          fetchCw("AWS/SQS", "NumberOfMessagesDeleted", dims, "Sum").catch(() => null),
          fetchCw("AWS/SQS", "NumberOfEmptyReceives", dims, "Sum").catch(() => null),
          fetchCw("AWS/SQS", "SentMessageSize", dims).catch(() => null),
        ]);
      const results: MetricSeries[] = [];
      if (visible && visible.points.length > 0)
        results.push({ ...visible, label: "Messages Visible" });
      if (notVisible && notVisible.points.length > 0)
        results.push({ ...notVisible, label: "In-flight Messages" });
      if (delayed && delayed.points.length > 0)
        results.push({ ...delayed, label: "Delayed Messages" });
      if (age && age.points.length > 0)
        results.push({ ...age, label: "Age of Oldest Message", unit: "s" });
      if (sent && sent.points.length > 0) results.push({ ...sent, label: "Messages Sent" });
      if (received && received.points.length > 0)
        results.push({ ...received, label: "Messages Received" });
      if (deleted && deleted.points.length > 0)
        results.push({ ...deleted, label: "Messages Deleted" });
      if (emptyReceives && emptyReceives.points.length > 0)
        results.push({ ...emptyReceives, label: "Empty Receives" });
      if (msgSize && msgSize.points.length > 0)
        results.push({ ...msgSize, label: "Sent Message Size", unit: "bytes" });
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
      // Verified against
      // https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/CacheMetrics.Redis.html
      // ElastiCache CloudWatch dim is CacheClusterId; for replication groups the
      // metric is published per-node. Fall back to the cluster externalId.
      // `EngineCPUUtilization` is a more precise CPU number than the host-level
      // `CPUUtilization` on small nodes (≤2 vCPU); we surface both so users on
      // larger nodes can pick the more useful series.
      const clusterId = String(f.clusterId ?? f.cacheClusterId ?? resource.externalId ?? "");
      if (!clusterId) return [];
      const dims = [{ Name: "CacheClusterId", Value: clusterId }];
      const [
        cpu,
        engineCpu,
        conns,
        newConns,
        dbMemPct,
        bytesUsed,
        hits,
        misses,
        evictions,
        replLag,
        netIn,
        netOut,
      ] = await Promise.all([
        fetchCw("AWS/ElastiCache", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/ElastiCache", "EngineCPUUtilization", dims).catch(() => null),
        fetchCw("AWS/ElastiCache", "CurrConnections", dims).catch(() => null),
        fetchCw("AWS/ElastiCache", "NewConnections", dims, "Sum").catch(() => null),
        fetchCw("AWS/ElastiCache", "DatabaseMemoryUsagePercentage", dims).catch(() => null),
        fetchCw("AWS/ElastiCache", "BytesUsedForCache", dims).catch(() => null),
        fetchCw("AWS/ElastiCache", "CacheHits", dims, "Sum").catch(() => null),
        fetchCw("AWS/ElastiCache", "CacheMisses", dims, "Sum").catch(() => null),
        fetchCw("AWS/ElastiCache", "Evictions", dims, "Sum").catch(() => null),
        fetchCw("AWS/ElastiCache", "ReplicationLag", dims).catch(() => null),
        fetchCw("AWS/ElastiCache", "NetworkBytesIn", dims, "Sum").catch(() => null),
        fetchCw("AWS/ElastiCache", "NetworkBytesOut", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "Host CPU", unit: "%" });
      if (engineCpu && engineCpu.points.length > 0)
        results.push({ ...engineCpu, label: "Engine CPU", unit: "%" });
      if (conns && conns.points.length > 0)
        results.push({ ...conns, label: "Current Connections" });
      if (newConns && newConns.points.length > 0)
        results.push({ ...newConns, label: "New Connections" });
      if (dbMemPct && dbMemPct.points.length > 0)
        results.push({ ...dbMemPct, label: "Memory Used", unit: "%" });
      if (bytesUsed && bytesUsed.points.length > 0)
        results.push({ ...bytesUsed, label: "Bytes Used", unit: "bytes" });
      if (hits && hits.points.length > 0) results.push({ ...hits, label: "Cache Hits" });
      if (misses && misses.points.length > 0) results.push({ ...misses, label: "Cache Misses" });
      if (evictions && evictions.points.length > 0)
        results.push({ ...evictions, label: "Evictions" });
      if (replLag && replLag.points.length > 0)
        results.push({ ...replLag, label: "Replica Lag", unit: "s" });
      if (netIn && netIn.points.length > 0)
        results.push({ ...netIn, label: "Network In", unit: "bytes" });
      if (netOut && netOut.points.length > 0)
        results.push({ ...netOut, label: "Network Out", unit: "bytes" });
      return results;
    }
    case "rds-cluster": {
      // Verified against
      // https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Monitoring.Metrics.html
      // Aurora clusters expose extra metrics over non-Aurora RDS:
      // BufferCacheHitRatio, CommitLatency, AuroraReplicaLag(/Maximum),
      // DeadlockCount, VolumeBytesUsed (Aurora storage grows automatically;
      // worth watching).
      const clusterId = String(
        f.clusterIdentifier ?? f.dbClusterIdentifier ?? resource.externalId ?? "",
      );
      if (!clusterId) return [];
      const dims = [{ Name: "DBClusterIdentifier", Value: clusterId }];
      const [
        cpu,
        conns,
        readLat,
        writeLat,
        readIops,
        writeIops,
        bufHit,
        commitLat,
        replicaLag,
        replicaLagMax,
        deadlocks,
        volBytes,
      ] = await Promise.all([
        fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
        fetchCw("AWS/RDS", "ReadLatency", dims).catch(() => null),
        fetchCw("AWS/RDS", "WriteLatency", dims).catch(() => null),
        fetchCw("AWS/RDS", "ReadIOPS", dims).catch(() => null),
        fetchCw("AWS/RDS", "WriteIOPS", dims).catch(() => null),
        fetchCw("AWS/RDS", "BufferCacheHitRatio", dims).catch(() => null),
        fetchCw("AWS/RDS", "CommitLatency", dims).catch(() => null),
        fetchCw("AWS/RDS", "AuroraReplicaLag", dims).catch(() => null),
        fetchCw("AWS/RDS", "AuroraReplicaLagMaximum", dims).catch(() => null),
        fetchCw("AWS/RDS", "DeadlockCount", dims, "Sum").catch(() => null),
        fetchCw("AWS/RDS", "VolumeBytesUsed", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (bufHit && bufHit.points.length > 0)
        results.push({ ...bufHit, label: "Buffer Cache Hit Ratio", unit: "%" });
      if (commitLat && commitLat.points.length > 0)
        results.push({ ...commitLat, label: "Commit Latency", unit: "ms" });
      if (readLat && readLat.points.length > 0)
        results.push({ ...readLat, label: "Read Latency", unit: "s" });
      if (writeLat && writeLat.points.length > 0)
        results.push({ ...writeLat, label: "Write Latency", unit: "s" });
      if (readIops && readIops.points.length > 0) results.push({ ...readIops, label: "Read IOPS" });
      if (writeIops && writeIops.points.length > 0)
        results.push({ ...writeIops, label: "Write IOPS" });
      if (replicaLag && replicaLag.points.length > 0)
        results.push({ ...replicaLag, label: "Replica Lag", unit: "ms" });
      if (replicaLagMax && replicaLagMax.points.length > 0)
        results.push({ ...replicaLagMax, label: "Replica Lag (max)", unit: "ms" });
      if (deadlocks && deadlocks.points.length > 0)
        results.push({ ...deadlocks, label: "Deadlocks" });
      if (volBytes && volBytes.points.length > 0)
        results.push({ ...volBytes, label: "Volume Size", unit: "bytes" });
      return results;
    }
    case "cloudfront-distribution": {
      // Verified against
      // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html
      // CloudFront metrics only publish in us-east-1 and require
      // Region=Global. CacheHitRate / OriginLatency / 4xx-error / 5xx-error
      // / 4xxErrorRate / 5xxErrorRate require "additional metrics" to be
      // toggled on per distribution — they silently emit nothing otherwise,
      // so listing them costs nothing.
      const distId = String(resource.externalId ?? "");
      if (!distId) return [];
      const dims = [
        { Name: "DistributionId", Value: distId },
        { Name: "Region", Value: "Global" },
      ];
      const [reqs, bytesDown, bytesUp, totalErr, err4xx, err5xx, cacheHit, originLat] =
        await Promise.all([
          fetchCw("AWS/CloudFront", "Requests", dims, "Sum").catch(() => null),
          fetchCw("AWS/CloudFront", "BytesDownloaded", dims, "Sum").catch(() => null),
          fetchCw("AWS/CloudFront", "BytesUploaded", dims, "Sum").catch(() => null),
          fetchCw("AWS/CloudFront", "TotalErrorRate", dims).catch(() => null),
          fetchCw("AWS/CloudFront", "4xxErrorRate", dims).catch(() => null),
          fetchCw("AWS/CloudFront", "5xxErrorRate", dims).catch(() => null),
          fetchCw("AWS/CloudFront", "CacheHitRate", dims).catch(() => null),
          fetchCw("AWS/CloudFront", "OriginLatency", dims).catch(() => null),
        ]);
      const results: MetricSeries[] = [];
      if (reqs && reqs.points.length > 0) results.push({ ...reqs, label: "Requests" });
      if (bytesDown && bytesDown.points.length > 0)
        results.push({ ...bytesDown, label: "Bytes Downloaded", unit: "bytes" });
      if (bytesUp && bytesUp.points.length > 0)
        results.push({ ...bytesUp, label: "Bytes Uploaded", unit: "bytes" });
      if (totalErr && totalErr.points.length > 0)
        results.push({ ...totalErr, label: "Total Error Rate", unit: "%" });
      if (err4xx && err4xx.points.length > 0)
        results.push({ ...err4xx, label: "4xx Error Rate", unit: "%" });
      if (err5xx && err5xx.points.length > 0)
        results.push({ ...err5xx, label: "5xx Error Rate", unit: "%" });
      if (cacheHit && cacheHit.points.length > 0)
        results.push({ ...cacheHit, label: "Cache Hit Rate", unit: "%" });
      if (originLat && originLat.points.length > 0)
        results.push({ ...originLat, label: "Origin Latency", unit: "ms" });
      return results;
    }
    case "api-gateway": {
      // Verified against
      // https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-metrics-and-dimensions.html
      // v1 REST APIs publish metrics keyed on `ApiName`; v2 (HTTP/WebSocket)
      // APIs publish on `ApiId`. IntegrationLatency = backend portion of
      // Latency; the difference is API GW's own overhead. CacheHit/Miss only
      // emit when API caching is enabled on the stage.
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
      const [count, latency, integrationLat, errors5xx, errors4xx, cacheHit, cacheMiss] =
        await Promise.all([
          fetchCw("AWS/ApiGateway", "Count", dims, "Sum").catch(() => null),
          fetchCw("AWS/ApiGateway", "Latency", dims).catch(() => null),
          fetchCw("AWS/ApiGateway", "IntegrationLatency", dims).catch(() => null),
          fetchCw("AWS/ApiGateway", "5XXError", dims, "Sum").catch(() => null),
          fetchCw("AWS/ApiGateway", "4XXError", dims, "Sum").catch(() => null),
          fetchCw("AWS/ApiGateway", "CacheHitCount", dims, "Sum").catch(() => null),
          fetchCw("AWS/ApiGateway", "CacheMissCount", dims, "Sum").catch(() => null),
        ]);
      const results: MetricSeries[] = [];
      if (count && count.points.length > 0) results.push({ ...count, label: "Request Count" });
      if (latency && latency.points.length > 0)
        results.push({ ...latency, label: "Latency (total)", unit: "ms" });
      if (integrationLat && integrationLat.points.length > 0)
        results.push({ ...integrationLat, label: "Backend Latency", unit: "ms" });
      if (errors5xx && errors5xx.points.length > 0)
        results.push({ ...errors5xx, label: "5xx Errors" });
      if (errors4xx && errors4xx.points.length > 0)
        results.push({ ...errors4xx, label: "4xx Errors" });
      if (cacheHit && cacheHit.points.length > 0)
        results.push({ ...cacheHit, label: "Cache Hits" });
      if (cacheMiss && cacheMiss.points.length > 0)
        results.push({ ...cacheMiss, label: "Cache Misses" });
      return results;
    }
    case "sns-topic": {
      // Verified against
      // https://docs.aws.amazon.com/sns/latest/dg/sns-monitoring-using-cloudwatch.html
      // SNS dimension is TopicName (last segment of ARN).
      const arn = String(resource.resolvedOutputs?.["topicArn"] ?? resource.externalId ?? "");
      const topicName = arn.split(":").pop() ?? "";
      if (!topicName) return [];
      const dims = [{ Name: "TopicName", Value: topicName }];
      const [published, delivered, failed, filteredOut, redrivenDlq, publishSize] =
        await Promise.all([
          fetchCw("AWS/SNS", "NumberOfMessagesPublished", dims, "Sum").catch(() => null),
          fetchCw("AWS/SNS", "NumberOfNotificationsDelivered", dims, "Sum").catch(() => null),
          fetchCw("AWS/SNS", "NumberOfNotificationsFailed", dims, "Sum").catch(() => null),
          fetchCw("AWS/SNS", "NumberOfNotificationsFilteredOut", dims, "Sum").catch(() => null),
          fetchCw("AWS/SNS", "NumberOfNotificationsRedrivenToDlq", dims, "Sum").catch(() => null),
          fetchCw("AWS/SNS", "PublishSize", dims).catch(() => null),
        ]);
      const results: MetricSeries[] = [];
      if (published && published.points.length > 0)
        results.push({ ...published, label: "Messages Published" });
      if (delivered && delivered.points.length > 0)
        results.push({ ...delivered, label: "Notifications Delivered" });
      if (failed && failed.points.length > 0)
        results.push({ ...failed, label: "Notifications Failed" });
      if (filteredOut && filteredOut.points.length > 0)
        results.push({ ...filteredOut, label: "Filtered Out" });
      if (redrivenDlq && redrivenDlq.points.length > 0)
        results.push({ ...redrivenDlq, label: "Redriven to DLQ" });
      if (publishSize && publishSize.points.length > 0)
        results.push({ ...publishSize, label: "Publish Size", unit: "bytes" });
      return results;
    }
    case "kinesis-stream": {
      // Verified against
      // https://docs.aws.amazon.com/streams/latest/dev/monitoring-with-cloudwatch.html
      // IteratorAgeMilliseconds is the docs-recommended #1 metric to watch
      // for stream consumer health — alert above 50% of retention period.
      const streamName = String(f.streamName ?? resource.externalId ?? "");
      if (!streamName) return [];
      const dims = [{ Name: "StreamName", Value: streamName }];
      const [
        incomingBytes,
        incomingRecords,
        getBytes,
        getRecords,
        putBytes,
        putSuccess,
        putRecordsSucc,
        putRecordsFail,
        iteratorAge,
        writeThrottle,
        readThrottle,
      ] = await Promise.all([
        fetchCw("AWS/Kinesis", "IncomingBytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "IncomingRecords", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "GetRecords.Bytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "GetRecords.Records", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "PutRecord.Bytes", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "PutRecord.Success", dims).catch(() => null),
        fetchCw("AWS/Kinesis", "PutRecords.SuccessfulRecords", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "PutRecords.FailedRecords", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "GetRecords.IteratorAgeMilliseconds", dims, "Maximum").catch(
          () => null,
        ),
        fetchCw("AWS/Kinesis", "WriteProvisionedThroughputExceeded", dims, "Sum").catch(() => null),
        fetchCw("AWS/Kinesis", "ReadProvisionedThroughputExceeded", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (incomingBytes && incomingBytes.points.length > 0)
        results.push({ ...incomingBytes, label: "Incoming Bytes", unit: "bytes" });
      if (incomingRecords && incomingRecords.points.length > 0)
        results.push({ ...incomingRecords, label: "Incoming Records" });
      if (getBytes && getBytes.points.length > 0)
        results.push({ ...getBytes, label: "GetRecords Bytes", unit: "bytes" });
      if (getRecords && getRecords.points.length > 0)
        results.push({ ...getRecords, label: "GetRecords (count)" });
      if (putBytes && putBytes.points.length > 0)
        results.push({ ...putBytes, label: "PutRecord Bytes", unit: "bytes" });
      if (putSuccess && putSuccess.points.length > 0)
        results.push({ ...putSuccess, label: "PutRecord Success Rate" });
      if (putRecordsSucc && putRecordsSucc.points.length > 0)
        results.push({ ...putRecordsSucc, label: "PutRecords Successful" });
      if (putRecordsFail && putRecordsFail.points.length > 0)
        results.push({ ...putRecordsFail, label: "PutRecords Failed" });
      if (iteratorAge && iteratorAge.points.length > 0)
        results.push({ ...iteratorAge, label: "Iterator Age", unit: "ms" });
      if (writeThrottle && writeThrottle.points.length > 0)
        results.push({ ...writeThrottle, label: "Write Throttles" });
      if (readThrottle && readThrottle.points.length > 0)
        results.push({ ...readThrottle, label: "Read Throttles" });
      return results;
    }
    case "opensearch-domain": {
      // Verified against
      // https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-cloudwatchmetrics.html
      // OpenSearch metrics can take either {DomainName} or
      // {DomainName, ClientId} dimensions; the single-dim form works in
      // every region we've tested. ClusterStatus.{green,yellow,red} are
      // separate metrics (not a dim split).
      const domainName = String(f.domainName ?? resource.externalId ?? "");
      if (!domainName) return [];
      const dims = [{ Name: "DomainName", Value: domainName }];
      const [
        cpu,
        jvm,
        masterCpu,
        masterJvm,
        storage,
        statusYellow,
        statusRed,
        unassignedShards,
        searchRate,
        searchLat,
        indexRate,
        indexLat,
        docs,
      ] = await Promise.all([
        fetchCw("AWS/ES", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/ES", "JVMMemoryPressure", dims).catch(() => null),
        fetchCw("AWS/ES", "MasterCPUUtilization", dims).catch(() => null),
        fetchCw("AWS/ES", "MasterJVMMemoryPressure", dims).catch(() => null),
        fetchCw("AWS/ES", "FreeStorageSpace", dims).catch(() => null),
        fetchCw("AWS/ES", "ClusterStatus.yellow", dims, "Maximum").catch(() => null),
        fetchCw("AWS/ES", "ClusterStatus.red", dims, "Maximum").catch(() => null),
        fetchCw("AWS/ES", "Shards.unassigned", dims, "Maximum").catch(() => null),
        fetchCw("AWS/ES", "SearchRate", dims, "Sum").catch(() => null),
        fetchCw("AWS/ES", "SearchLatency", dims).catch(() => null),
        fetchCw("AWS/ES", "IndexingRate", dims, "Sum").catch(() => null),
        fetchCw("AWS/ES", "IndexingLatency", dims).catch(() => null),
        fetchCw("AWS/ES", "SearchableDocuments", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (masterCpu && masterCpu.points.length > 0)
        results.push({ ...masterCpu, label: "Master CPU", unit: "%" });
      if (jvm && jvm.points.length > 0)
        results.push({ ...jvm, label: "JVM Memory Pressure", unit: "%" });
      if (masterJvm && masterJvm.points.length > 0)
        results.push({ ...masterJvm, label: "Master JVM Pressure", unit: "%" });
      if (storage && storage.points.length > 0)
        results.push({ ...storage, label: "Free Storage", unit: "MB" });
      if (statusYellow && statusYellow.points.length > 0)
        results.push({ ...statusYellow, label: "Cluster Yellow" });
      if (statusRed && statusRed.points.length > 0)
        results.push({ ...statusRed, label: "Cluster Red" });
      if (unassignedShards && unassignedShards.points.length > 0)
        results.push({ ...unassignedShards, label: "Unassigned Shards" });
      if (searchRate && searchRate.points.length > 0)
        results.push({ ...searchRate, label: "Search Rate" });
      if (searchLat && searchLat.points.length > 0)
        results.push({ ...searchLat, label: "Search Latency", unit: "ms" });
      if (indexRate && indexRate.points.length > 0)
        results.push({ ...indexRate, label: "Indexing Rate" });
      if (indexLat && indexLat.points.length > 0)
        results.push({ ...indexLat, label: "Indexing Latency", unit: "ms" });
      if (docs && docs.points.length > 0) results.push({ ...docs, label: "Searchable Documents" });
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
      // Verified against
      // https://docs.aws.amazon.com/redshift/latest/mgmt/metrics-listing.html
      // Redshift dimension is `ClusterIdentifier` (the cluster name), not the
      // ARN.
      const clusterId = String(f.clusterIdentifier ?? resource.externalId ?? "");
      if (!clusterId) return [];
      const dims = [{ Name: "ClusterIdentifier", Value: clusterId }];
      const [
        cpu,
        conns,
        diskPct,
        healthStatus,
        maintenance,
        readIops,
        writeIops,
        readLat,
        writeLat,
        netIn,
        netOut,
        commitQueue,
      ] = await Promise.all([
        fetchCw("AWS/Redshift", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/Redshift", "DatabaseConnections", dims).catch(() => null),
        fetchCw("AWS/Redshift", "PercentageDiskSpaceUsed", dims).catch(() => null),
        fetchCw("AWS/Redshift", "HealthStatus", dims).catch(() => null),
        fetchCw("AWS/Redshift", "MaintenanceMode", dims).catch(() => null),
        fetchCw("AWS/Redshift", "ReadIOPS", dims).catch(() => null),
        fetchCw("AWS/Redshift", "WriteIOPS", dims).catch(() => null),
        fetchCw("AWS/Redshift", "ReadLatency", dims).catch(() => null),
        fetchCw("AWS/Redshift", "WriteLatency", dims).catch(() => null),
        fetchCw("AWS/Redshift", "NetworkReceiveThroughput", dims).catch(() => null),
        fetchCw("AWS/Redshift", "NetworkTransmitThroughput", dims).catch(() => null),
        fetchCw("AWS/Redshift", "CommitQueueLength", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (diskPct && diskPct.points.length > 0)
        results.push({ ...diskPct, label: "% Disk Used", unit: "%" });
      if (healthStatus && healthStatus.points.length > 0)
        results.push({ ...healthStatus, label: "Health (1=OK)" });
      if (maintenance && maintenance.points.length > 0)
        results.push({ ...maintenance, label: "Maintenance Mode" });
      if (readIops && readIops.points.length > 0) results.push({ ...readIops, label: "Read IOPS" });
      if (writeIops && writeIops.points.length > 0)
        results.push({ ...writeIops, label: "Write IOPS" });
      if (readLat && readLat.points.length > 0)
        results.push({ ...readLat, label: "Read Latency", unit: "s" });
      if (writeLat && writeLat.points.length > 0)
        results.push({ ...writeLat, label: "Write Latency", unit: "s" });
      if (netIn && netIn.points.length > 0)
        results.push({ ...netIn, label: "Network In", unit: "bytes/s" });
      if (netOut && netOut.points.length > 0)
        results.push({ ...netOut, label: "Network Out", unit: "bytes/s" });
      if (commitQueue && commitQueue.points.length > 0)
        results.push({ ...commitQueue, label: "Commit Queue" });
      return results;
    }
    case "documentdb-cluster": {
      // Verified against
      // https://docs.aws.amazon.com/documentdb/latest/developerguide/cloud_watch.html
      // DBClusterIdentifier is the cluster name (not the ARN).
      const clusterId = String(f.clusterIdentifier ?? resource.externalId ?? "");
      if (!clusterId) return [];
      const dims = [{ Name: "DBClusterIdentifier", Value: clusterId }];
      const [
        cpu,
        conns,
        bufHit,
        freeableMem,
        readLat,
        writeLat,
        replicaLag,
        opQuery,
        opInsert,
        opUpdate,
        opDelete,
        netIn,
        netOut,
      ] = await Promise.all([
        fetchCw("AWS/DocDB", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/DocDB", "DatabaseConnections", dims).catch(() => null),
        fetchCw("AWS/DocDB", "BufferCacheHitRatio", dims).catch(() => null),
        fetchCw("AWS/DocDB", "FreeableMemory", dims).catch(() => null),
        fetchCw("AWS/DocDB", "ReadLatency", dims).catch(() => null),
        fetchCw("AWS/DocDB", "WriteLatency", dims).catch(() => null),
        fetchCw("AWS/DocDB", "DBClusterReplicaLagMaximum", dims).catch(() => null),
        fetchCw("AWS/DocDB", "OpcountersQuery", dims, "Sum").catch(() => null),
        fetchCw("AWS/DocDB", "OpcountersInsert", dims, "Sum").catch(() => null),
        fetchCw("AWS/DocDB", "OpcountersUpdate", dims, "Sum").catch(() => null),
        fetchCw("AWS/DocDB", "OpcountersDelete", dims, "Sum").catch(() => null),
        fetchCw("AWS/DocDB", "NetworkReceiveThroughput", dims).catch(() => null),
        fetchCw("AWS/DocDB", "NetworkTransmitThroughput", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (bufHit && bufHit.points.length > 0)
        results.push({ ...bufHit, label: "Buffer Cache Hit Ratio", unit: "%" });
      if (freeableMem && freeableMem.points.length > 0)
        results.push({ ...freeableMem, label: "Freeable Memory", unit: "bytes" });
      if (readLat && readLat.points.length > 0)
        results.push({ ...readLat, label: "Read Latency", unit: "ms" });
      if (writeLat && writeLat.points.length > 0)
        results.push({ ...writeLat, label: "Write Latency", unit: "ms" });
      if (replicaLag && replicaLag.points.length > 0)
        results.push({ ...replicaLag, label: "Replica Lag (max)", unit: "ms" });
      if (opQuery && opQuery.points.length > 0) results.push({ ...opQuery, label: "Queries" });
      if (opInsert && opInsert.points.length > 0) results.push({ ...opInsert, label: "Inserts" });
      if (opUpdate && opUpdate.points.length > 0) results.push({ ...opUpdate, label: "Updates" });
      if (opDelete && opDelete.points.length > 0) results.push({ ...opDelete, label: "Deletes" });
      if (netIn && netIn.points.length > 0)
        results.push({ ...netIn, label: "Network In", unit: "bytes/s" });
      if (netOut && netOut.points.length > 0)
        results.push({ ...netOut, label: "Network Out", unit: "bytes/s" });
      return results;
    }
    case "neptune-cluster": {
      // Verified against
      // https://docs.aws.amazon.com/neptune/latest/userguide/cw-metrics.html
      // Neptune emits metrics only when they have a non-zero value, so the
      // `points.length > 0` guards effectively pick the engines (Gremlin /
      // openCypher / SPARQL) that this cluster actually serves.
      const clusterId = String(f.clusterIdentifier ?? resource.externalId ?? "");
      if (!clusterId) return [];
      const dims = [{ Name: "DBClusterIdentifier", Value: clusterId }];
      const [
        cpu,
        freeableMem,
        bufHit,
        pending,
        totalReq,
        gremlinReq,
        cypherReq,
        sparqlReq,
        txCommit,
        txRollback,
        replicaLag,
        http4xx,
        http5xx,
      ] = await Promise.all([
        fetchCw("AWS/Neptune", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/Neptune", "FreeableMemory", dims).catch(() => null),
        fetchCw("AWS/Neptune", "BufferCacheHitRatio", dims).catch(() => null),
        fetchCw("AWS/Neptune", "MainRequestQueuePendingRequests", dims, "Sum").catch(() => null),
        fetchCw("AWS/Neptune", "TotalRequestsPerSec", dims).catch(() => null),
        fetchCw("AWS/Neptune", "GremlinRequestsPerSec", dims).catch(() => null),
        fetchCw("AWS/Neptune", "OpenCypherRequestsPerSec", dims).catch(() => null),
        fetchCw("AWS/Neptune", "SparqlRequestsPerSec", dims).catch(() => null),
        fetchCw("AWS/Neptune", "NumTxCommitted", dims, "Sum").catch(() => null),
        fetchCw("AWS/Neptune", "NumTxRolledBack", dims, "Sum").catch(() => null),
        fetchCw("AWS/Neptune", "ClusterReplicaLag", dims).catch(() => null),
        fetchCw("AWS/Neptune", "Http4xx", dims, "Sum").catch(() => null),
        fetchCw("AWS/Neptune", "Http5xx", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (freeableMem && freeableMem.points.length > 0)
        results.push({ ...freeableMem, label: "Freeable Memory", unit: "bytes" });
      if (bufHit && bufHit.points.length > 0)
        results.push({ ...bufHit, label: "Buffer Cache Hit Ratio", unit: "%" });
      if (pending && pending.points.length > 0)
        results.push({ ...pending, label: "Pending Requests" });
      if (totalReq && totalReq.points.length > 0)
        results.push({ ...totalReq, label: "Total Requests/sec" });
      if (gremlinReq && gremlinReq.points.length > 0)
        results.push({ ...gremlinReq, label: "Gremlin Requests/sec" });
      if (cypherReq && cypherReq.points.length > 0)
        results.push({ ...cypherReq, label: "openCypher Requests/sec" });
      if (sparqlReq && sparqlReq.points.length > 0)
        results.push({ ...sparqlReq, label: "SPARQL Requests/sec" });
      if (txCommit && txCommit.points.length > 0)
        results.push({ ...txCommit, label: "Tx Committed" });
      if (txRollback && txRollback.points.length > 0)
        results.push({ ...txRollback, label: "Tx Rolled Back" });
      if (replicaLag && replicaLag.points.length > 0)
        results.push({ ...replicaLag, label: "Replica Lag", unit: "ms" });
      if (http4xx && http4xx.points.length > 0) results.push({ ...http4xx, label: "4xx Errors" });
      if (http5xx && http5xx.points.length > 0) results.push({ ...http5xx, label: "5xx Errors" });
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
      // Verified against
      // https://docs.aws.amazon.com/sagemaker/latest/dg/monitoring-cloudwatch.html
      // (`AWS/SageMaker` namespace; latency metrics are in microseconds).
      const endpointName = String(f.endpointName ?? resource.externalId ?? "");
      if (!endpointName) return [];
      const dims = [
        { Name: "EndpointName", Value: endpointName },
        { Name: "VariantName", Value: "AllTraffic" },
      ];
      const [invocations, modelLatency, overheadLatency, errors4xx, errors5xx] = await Promise.all([
        fetchCw("AWS/SageMaker", "Invocations", dims, "Sum").catch(() => null),
        fetchCw("AWS/SageMaker", "ModelLatency", dims).catch(() => null),
        fetchCw("AWS/SageMaker", "OverheadLatency", dims).catch(() => null),
        fetchCw("AWS/SageMaker", "Invocation4XXErrors", dims, "Sum").catch(() => null),
        fetchCw("AWS/SageMaker", "Invocation5XXErrors", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (invocations && invocations.points.length > 0)
        results.push({ ...invocations, label: "Invocations" });
      if (modelLatency && modelLatency.points.length > 0)
        results.push({ ...modelLatency, label: "Model Latency", unit: "μs" });
      if (overheadLatency && overheadLatency.points.length > 0)
        results.push({ ...overheadLatency, label: "Overhead Latency", unit: "μs" });
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
      // App Runner dim is ServiceName. Service-level metrics include the
      // request/response counters; instance-level metrics are CPU/Memory.
      // Verified against
      // https://docs.aws.amazon.com/apprunner/latest/dg/monitor-cw.html
      const serviceName = String(f.serviceName ?? resource.externalId ?? "");
      if (!serviceName) return [];
      const dims = [{ Name: "ServiceName", Value: serviceName }];
      const [cpu, mem, reqs, latency, concurrency, activeInstances, status4xx, status5xx] =
        await Promise.all([
          fetchCw("AWS/AppRunner", "CPUUtilization", dims).catch(() => null),
          fetchCw("AWS/AppRunner", "MemoryUtilization", dims).catch(() => null),
          fetchCw("AWS/AppRunner", "Requests", dims, "Sum").catch(() => null),
          fetchCw("AWS/AppRunner", "RequestLatency", dims).catch(() => null),
          fetchCw("AWS/AppRunner", "Concurrency", dims).catch(() => null),
          fetchCw("AWS/AppRunner", "ActiveInstances", dims).catch(() => null),
          fetchCw("AWS/AppRunner", "4xxStatusResponses", dims, "Sum").catch(() => null),
          fetchCw("AWS/AppRunner", "5xxStatusResponses", dims, "Sum").catch(() => null),
        ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0)
        results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
      if (mem && mem.points.length > 0)
        results.push({ ...mem, label: "Memory Utilization", unit: "%" });
      if (reqs && reqs.points.length > 0) results.push({ ...reqs, label: "Requests" });
      if (latency && latency.points.length > 0)
        results.push({ ...latency, label: "Request Latency", unit: "ms" });
      if (concurrency && concurrency.points.length > 0)
        results.push({ ...concurrency, label: "Concurrency" });
      if (activeInstances && activeInstances.points.length > 0)
        results.push({ ...activeInstances, label: "Active Instances" });
      if (status4xx && status4xx.points.length > 0)
        results.push({ ...status4xx, label: "4xx Responses" });
      if (status5xx && status5xx.points.length > 0)
        results.push({ ...status5xx, label: "5xx Responses" });
      return results;
    }
    case "target-group": {
      // Verified against
      // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html
      // ALB target metrics REQUIRE both LoadBalancer and TargetGroup dims —
      // querying with just TargetGroup returns nothing. Both dims use the
      // trailing portion of the ARN (`app/...` and `targetgroup/...`).
      const tgArn = String(resource.resolvedOutputs?.["targetGroupArn"] ?? "");
      const tgDim = tgArn.split(":targetgroup/").pop() ?? "";
      if (!tgDim) return [];
      const tgDimName = tgDim ? `targetgroup/${tgDim}` : "";
      // Target groups don't store the parent LB ARN; the lister sets
      // `loadBalancerArn` on the field map when known. Without it we can't
      // build a complete dimension set, but querying by TargetGroup alone
      // works for HealthyHostCount/UnHealthyHostCount in many setups.
      const lbArn = String(f.loadBalancerArn ?? "");
      const lbDim = lbArn.split(":loadbalancer/").pop() ?? "";
      const dims = lbDim
        ? [
            { Name: "LoadBalancer", Value: lbDim },
            { Name: "TargetGroup", Value: tgDimName },
          ]
        : [{ Name: "TargetGroup", Value: tgDimName }];
      const [healthy, unhealthy, reqPerTarget, targetRT, targetConnErr] = await Promise.all([
        fetchCw("AWS/ApplicationELB", "HealthyHostCount", dims).catch(() => null),
        fetchCw("AWS/ApplicationELB", "UnHealthyHostCount", dims).catch(() => null),
        fetchCw("AWS/ApplicationELB", "RequestCountPerTarget", dims, "Sum").catch(() => null),
        fetchCw("AWS/ApplicationELB", "TargetResponseTime", dims).catch(() => null),
        fetchCw("AWS/ApplicationELB", "TargetConnectionErrorCount", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (healthy && healthy.points.length > 0)
        results.push({ ...healthy, label: "Healthy Hosts" });
      if (unhealthy && unhealthy.points.length > 0)
        results.push({ ...unhealthy, label: "Unhealthy Hosts" });
      if (reqPerTarget && reqPerTarget.points.length > 0)
        results.push({ ...reqPerTarget, label: "Requests per Target" });
      if (targetRT && targetRT.points.length > 0)
        results.push({ ...targetRT, label: "Target Response Time", unit: "s" });
      if (targetConnErr && targetConnErr.points.length > 0)
        results.push({ ...targetConnErr, label: "Target Conn Errors" });
      return results;
    }
    default:
      return [];
  }
}
