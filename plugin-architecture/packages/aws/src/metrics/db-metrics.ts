import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { MetricsContext } from "./cw-helpers.js";

/**
 * Database-family metric handlers — RDS instances/clusters, DynamoDB,
 * ElastiCache, Redshift, OpenSearch, DocumentDB, Neptune.
 */

export async function rdsInstanceMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html
  const f = resource.fields;
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
    ctx.fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/RDS", "FreeStorageSpace", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "FreeableMemory", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "SwapUsage", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "ReadIOPS", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "WriteIOPS", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "ReadLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "WriteLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "NetworkReceiveThroughput", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "NetworkTransmitThroughput", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "BurstBalance", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "ReplicaLag", dims).catch(() => null),
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
  if (writeIops && writeIops.points.length > 0) results.push({ ...writeIops, label: "Write IOPS" });
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

export async function rdsClusterMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Monitoring.Metrics.html
  // Aurora clusters expose extra metrics over non-Aurora RDS:
  // BufferCacheHitRatio, CommitLatency, AuroraReplicaLag(/Maximum),
  // DeadlockCount, VolumeBytesUsed (Aurora storage grows automatically;
  // worth watching).
  const f = resource.fields;
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
    ctx.fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/RDS", "ReadLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "WriteLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "ReadIOPS", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "WriteIOPS", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "BufferCacheHitRatio", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "CommitLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "AuroraReplicaLag", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "AuroraReplicaLagMaximum", dims).catch(() => null),
    ctx.fetchCw("AWS/RDS", "DeadlockCount", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/RDS", "VolumeBytesUsed", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
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
  if (writeIops && writeIops.points.length > 0) results.push({ ...writeIops, label: "Write IOPS" });
  if (replicaLag && replicaLag.points.length > 0)
    results.push({ ...replicaLag, label: "Replica Lag", unit: "ms" });
  if (replicaLagMax && replicaLagMax.points.length > 0)
    results.push({ ...replicaLagMax, label: "Replica Lag (max)", unit: "ms" });
  if (deadlocks && deadlocks.points.length > 0) results.push({ ...deadlocks, label: "Deadlocks" });
  if (volBytes && volBytes.points.length > 0)
    results.push({ ...volBytes, label: "Volume Size", unit: "bytes" });
  return results;
}

export async function dynamoDbTableMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  const f = resource.fields;
  const tableName = String(f.tableName ?? resource.externalId ?? "");
  const dims = [{ Name: "TableName", Value: tableName }];
  const [readCap, writeCap, throttled, sysErrors] = await Promise.all([
    ctx.fetchCw("AWS/DynamoDB", "ConsumedReadCapacityUnits", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/DynamoDB", "ConsumedWriteCapacityUnits", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/DynamoDB", "ThrottledRequests", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/DynamoDB", "SystemErrors", dims, "Sum").catch(() => null),
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

export async function elastiCacheClusterMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/CacheMetrics.Redis.html
  // ElastiCache CloudWatch dim is CacheClusterId; for replication groups the
  // metric is published per-node. Fall back to the cluster externalId.
  // `EngineCPUUtilization` is a more precise CPU number than the host-level
  // `CPUUtilization` on small nodes (≤2 vCPU); we surface both so users on
  // larger nodes can pick the more useful series.
  const f = resource.fields;
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
    ctx.fetchCw("AWS/ElastiCache", "CPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "EngineCPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "CurrConnections", dims).catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "NewConnections", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "DatabaseMemoryUsagePercentage", dims).catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "BytesUsedForCache", dims).catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "CacheHits", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "CacheMisses", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "Evictions", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "ReplicationLag", dims).catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "NetworkBytesIn", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ElastiCache", "NetworkBytesOut", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "Host CPU", unit: "%" });
  if (engineCpu && engineCpu.points.length > 0)
    results.push({ ...engineCpu, label: "Engine CPU", unit: "%" });
  if (conns && conns.points.length > 0) results.push({ ...conns, label: "Current Connections" });
  if (newConns && newConns.points.length > 0)
    results.push({ ...newConns, label: "New Connections" });
  if (dbMemPct && dbMemPct.points.length > 0)
    results.push({ ...dbMemPct, label: "Memory Used", unit: "%" });
  if (bytesUsed && bytesUsed.points.length > 0)
    results.push({ ...bytesUsed, label: "Bytes Used", unit: "bytes" });
  if (hits && hits.points.length > 0) results.push({ ...hits, label: "Cache Hits" });
  if (misses && misses.points.length > 0) results.push({ ...misses, label: "Cache Misses" });
  if (evictions && evictions.points.length > 0) results.push({ ...evictions, label: "Evictions" });
  if (replLag && replLag.points.length > 0)
    results.push({ ...replLag, label: "Replica Lag", unit: "s" });
  if (netIn && netIn.points.length > 0)
    results.push({ ...netIn, label: "Network In", unit: "bytes" });
  if (netOut && netOut.points.length > 0)
    results.push({ ...netOut, label: "Network Out", unit: "bytes" });
  return results;
}

export async function redshiftClusterMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/redshift/latest/mgmt/metrics-listing.html
  // Redshift dimension is `ClusterIdentifier` (the cluster name), not the
  // ARN.
  const f = resource.fields;
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
    ctx.fetchCw("AWS/Redshift", "CPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "DatabaseConnections", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "PercentageDiskSpaceUsed", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "HealthStatus", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "MaintenanceMode", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "ReadIOPS", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "WriteIOPS", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "ReadLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "WriteLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "NetworkReceiveThroughput", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "NetworkTransmitThroughput", dims).catch(() => null),
    ctx.fetchCw("AWS/Redshift", "CommitQueueLength", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
  if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
  if (diskPct && diskPct.points.length > 0)
    results.push({ ...diskPct, label: "% Disk Used", unit: "%" });
  if (healthStatus && healthStatus.points.length > 0)
    results.push({ ...healthStatus, label: "Health (1=OK)" });
  if (maintenance && maintenance.points.length > 0)
    results.push({ ...maintenance, label: "Maintenance Mode" });
  if (readIops && readIops.points.length > 0) results.push({ ...readIops, label: "Read IOPS" });
  if (writeIops && writeIops.points.length > 0) results.push({ ...writeIops, label: "Write IOPS" });
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

export async function openSearchDomainMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-cloudwatchmetrics.html
  // OpenSearch metrics can take either {DomainName} or
  // {DomainName, ClientId} dimensions; the single-dim form works in
  // every region we've tested. ClusterStatus.{green,yellow,red} are
  // separate metrics (not a dim split).
  const f = resource.fields;
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
    ctx.fetchCw("AWS/ES", "CPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/ES", "JVMMemoryPressure", dims).catch(() => null),
    ctx.fetchCw("AWS/ES", "MasterCPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/ES", "MasterJVMMemoryPressure", dims).catch(() => null),
    ctx.fetchCw("AWS/ES", "FreeStorageSpace", dims).catch(() => null),
    ctx.fetchCw("AWS/ES", "ClusterStatus.yellow", dims, "Maximum").catch(() => null),
    ctx.fetchCw("AWS/ES", "ClusterStatus.red", dims, "Maximum").catch(() => null),
    ctx.fetchCw("AWS/ES", "Shards.unassigned", dims, "Maximum").catch(() => null),
    ctx.fetchCw("AWS/ES", "SearchRate", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ES", "SearchLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/ES", "IndexingRate", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ES", "IndexingLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/ES", "SearchableDocuments", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
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

export async function documentDbClusterMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/documentdb/latest/developerguide/cloud_watch.html
  // DBClusterIdentifier is the cluster name (not the ARN).
  const f = resource.fields;
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
    ctx.fetchCw("AWS/DocDB", "CPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/DocDB", "DatabaseConnections", dims).catch(() => null),
    ctx.fetchCw("AWS/DocDB", "BufferCacheHitRatio", dims).catch(() => null),
    ctx.fetchCw("AWS/DocDB", "FreeableMemory", dims).catch(() => null),
    ctx.fetchCw("AWS/DocDB", "ReadLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/DocDB", "WriteLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/DocDB", "DBClusterReplicaLagMaximum", dims).catch(() => null),
    ctx.fetchCw("AWS/DocDB", "OpcountersQuery", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/DocDB", "OpcountersInsert", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/DocDB", "OpcountersUpdate", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/DocDB", "OpcountersDelete", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/DocDB", "NetworkReceiveThroughput", dims).catch(() => null),
    ctx.fetchCw("AWS/DocDB", "NetworkTransmitThroughput", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
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

export async function neptuneClusterMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/neptune/latest/userguide/cw-metrics.html
  // Neptune emits metrics only when they have a non-zero value, so the
  // `points.length > 0` guards effectively pick the engines (Gremlin /
  // openCypher / SPARQL) that this cluster actually serves.
  const f = resource.fields;
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
    ctx.fetchCw("AWS/Neptune", "CPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/Neptune", "FreeableMemory", dims).catch(() => null),
    ctx.fetchCw("AWS/Neptune", "BufferCacheHitRatio", dims).catch(() => null),
    ctx.fetchCw("AWS/Neptune", "MainRequestQueuePendingRequests", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Neptune", "TotalRequestsPerSec", dims).catch(() => null),
    ctx.fetchCw("AWS/Neptune", "GremlinRequestsPerSec", dims).catch(() => null),
    ctx.fetchCw("AWS/Neptune", "OpenCypherRequestsPerSec", dims).catch(() => null),
    ctx.fetchCw("AWS/Neptune", "SparqlRequestsPerSec", dims).catch(() => null),
    ctx.fetchCw("AWS/Neptune", "NumTxCommitted", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Neptune", "NumTxRolledBack", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Neptune", "ClusterReplicaLag", dims).catch(() => null),
    ctx.fetchCw("AWS/Neptune", "Http4xx", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Neptune", "Http5xx", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
  if (freeableMem && freeableMem.points.length > 0)
    results.push({ ...freeableMem, label: "Freeable Memory", unit: "bytes" });
  if (bufHit && bufHit.points.length > 0)
    results.push({ ...bufHit, label: "Buffer Cache Hit Ratio", unit: "%" });
  if (pending && pending.points.length > 0) results.push({ ...pending, label: "Pending Requests" });
  if (totalReq && totalReq.points.length > 0)
    results.push({ ...totalReq, label: "Total Requests/sec" });
  if (gremlinReq && gremlinReq.points.length > 0)
    results.push({ ...gremlinReq, label: "Gremlin Requests/sec" });
  if (cypherReq && cypherReq.points.length > 0)
    results.push({ ...cypherReq, label: "openCypher Requests/sec" });
  if (sparqlReq && sparqlReq.points.length > 0)
    results.push({ ...sparqlReq, label: "SPARQL Requests/sec" });
  if (txCommit && txCommit.points.length > 0) results.push({ ...txCommit, label: "Tx Committed" });
  if (txRollback && txRollback.points.length > 0)
    results.push({ ...txRollback, label: "Tx Rolled Back" });
  if (replicaLag && replicaLag.points.length > 0)
    results.push({ ...replicaLag, label: "Replica Lag", unit: "ms" });
  if (http4xx && http4xx.points.length > 0) results.push({ ...http4xx, label: "4xx Errors" });
  if (http5xx && http5xx.points.length > 0) results.push({ ...http5xx, label: "5xx Errors" });
  return results;
}
