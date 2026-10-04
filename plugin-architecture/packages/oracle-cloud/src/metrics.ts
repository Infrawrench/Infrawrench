import type { MetricSeries } from "@infrawrench/plugin-base";
import type { OciApi } from "./api.js";
import { mapLimit } from "./inventory.js";

/**
 * Monitoring API series (`POST telemetry.{region}/20180401/metrics/actions/summarizeMetricsData`),
 * one MQL query per series. Metric names and dimension spellings per
 * namespace follow Oracle's per-service metric references; they differ in
 * casing between services (`resourceId`, Object Storage's
 * `resourceDisplayName`, Autonomous Database's documented `resourceId` /
 * `RESOURCEID`), which is why each query names its own dimension.
 */

export const DEFAULT_METRIC_WINDOW_MS = 3 * 3_600_000;

interface MetricSpec {
  metric: string;
  stat: "mean" | "sum" | "max";
  label: string;
  unit: string;
}

export interface MetricTarget {
  region: string;
  compartmentId: string;
  namespace: string;
  /** MQL dimension filter, e.g. `resourceId = "ocid1..."`. */
  filter: string;
  /** Tried when every primary query returns nothing (dimension casing). */
  fallbackFilter?: string;
  specs: MetricSpec[];
}

const INSTANCE: MetricSpec[] = [
  { metric: "CpuUtilization", stat: "mean", label: "CPU Utilization", unit: "%" },
  { metric: "MemoryUtilization", stat: "mean", label: "Memory Utilization", unit: "%" },
  { metric: "LoadAverage", stat: "mean", label: "Load Average", unit: "" },
  { metric: "NetworksBytesIn", stat: "sum", label: "Network In", unit: "bytes" },
  { metric: "NetworksBytesOut", stat: "sum", label: "Network Out", unit: "bytes" },
  { metric: "DiskBytesRead", stat: "sum", label: "Disk Read", unit: "bytes" },
  { metric: "DiskBytesWritten", stat: "sum", label: "Disk Write", unit: "bytes" },
  { metric: "DiskIopsRead", stat: "sum", label: "Disk Read Ops", unit: "ops" },
  { metric: "DiskIopsWritten", stat: "sum", label: "Disk Write Ops", unit: "ops" },
];

const BLOCK_VOLUME: MetricSpec[] = [
  { metric: "VolumeReadThroughput", stat: "sum", label: "Read Throughput", unit: "bytes" },
  { metric: "VolumeWriteThroughput", stat: "sum", label: "Write Throughput", unit: "bytes" },
  { metric: "VolumeReadOps", stat: "sum", label: "Read Ops", unit: "ops" },
  { metric: "VolumeWriteOps", stat: "sum", label: "Write Ops", unit: "ops" },
  { metric: "VolumeThrottledIOs", stat: "sum", label: "Throttled I/Os", unit: "ops" },
];

const LOAD_BALANCER: MetricSpec[] = [
  { metric: "httpRequests", stat: "sum", label: "HTTP Requests", unit: "requests" },
  { metric: "activeConnections", stat: "mean", label: "Active Connections", unit: "connections" },
  { metric: "bytesReceived", stat: "sum", label: "Bytes Received", unit: "bytes" },
  { metric: "bytesSent", stat: "sum", label: "Bytes Sent", unit: "bytes" },
  { metric: "peakBandwidth", stat: "max", label: "Peak Bandwidth", unit: "Mbps" },
  { metric: "unhealthyBackendServers", stat: "max", label: "Unhealthy Backends", unit: "" },
];

const BUCKET: MetricSpec[] = [
  { metric: "StoredBytes", stat: "max", label: "Stored Bytes", unit: "bytes" },
  { metric: "ObjectCount", stat: "max", label: "Object Count", unit: "objects" },
];

const AUTONOMOUS_DB: MetricSpec[] = [
  { metric: "CpuUtilization", stat: "mean", label: "CPU Utilization", unit: "%" },
  { metric: "StorageUtilization", stat: "mean", label: "Storage Utilization", unit: "%" },
  { metric: "Sessions", stat: "mean", label: "Sessions", unit: "sessions" },
  { metric: "ECPUsAllocated", stat: "max", label: "ECPUs Allocated", unit: "ECPU" },
  { metric: "ExecuteCount", stat: "sum", label: "Executions", unit: "" },
  { metric: "QueryLatency", stat: "mean", label: "Query Latency", unit: "ms" },
  { metric: "FailedConnections", stat: "sum", label: "Failed Connections", unit: "" },
];

const OKE: MetricSpec[] = [
  { metric: "APIServerRequestCount", stat: "sum", label: "API Server Requests", unit: "requests" },
  { metric: "UnschedulablePods", stat: "max", label: "Unschedulable Pods", unit: "pods" },
];

export function metricSpecs(typeId: string): { namespace: string; specs: MetricSpec[] } | null {
  switch (typeId) {
    case "instance":
      return { namespace: "oci_computeagent", specs: INSTANCE };
    case "block-volume":
      return { namespace: "oci_blockstore", specs: BLOCK_VOLUME };
    case "load-balancer":
      return { namespace: "oci_lbaas", specs: LOAD_BALANCER };
    case "bucket":
      return { namespace: "oci_objectstorage", specs: BUCKET };
    case "autonomous-database":
      return { namespace: "oci_autonomous_database", specs: AUTONOMOUS_DB };
    case "oke-cluster":
      return { namespace: "oci_oke", specs: OKE };
    default:
      return null;
  }
}

/** Interval and resolution for a window, inside MQL's per-interval range caps. */
export function intervalFor(windowMs: number): string {
  if (windowMs <= 6 * 3_600_000) return "1m";
  if (windowMs <= 3 * 86_400_000) return "5m";
  if (windowMs <= 30 * 86_400_000) return "1h";
  return "1d";
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function dimensionFilter(name: string, value: string): string {
  return `${name} = ${quote(value)}`;
}

async function runQuery(
  api: OciApi,
  target: MetricTarget,
  spec: MetricSpec,
  filter: string,
  interval: string,
  startMs: number,
  endMs: number,
): Promise<MetricSeries | null> {
  const data = await api
    .request<Array<{ aggregatedDatapoints?: Array<{ timestamp: string; value: number }> }>>({
      service: "telemetry",
      region: target.region,
      method: "POST",
      path: "/20180401/metrics/actions/summarizeMetricsData",
      query: { compartmentId: target.compartmentId },
      body: {
        namespace: target.namespace,
        query: `${spec.metric}[${interval}]{${filter}}.${spec.stat}()`,
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        resolution: interval,
      },
    })
    .then((r) => r.data)
    .catch(() => []);
  // Several streams (one per backend set, per tier) fold into one series by
  // summing points at the same timestamp, except for means, which average.
  const byTime = new Map<number, number[]>();
  for (const stream of data ?? []) {
    for (const p of stream.aggregatedDatapoints ?? []) {
      const t = Date.parse(p.timestamp);
      if (!Number.isFinite(t) || !Number.isFinite(p.value)) continue;
      if (!byTime.has(t)) byTime.set(t, []);
      byTime.get(t)!.push(p.value);
    }
  }
  if (byTime.size === 0) return null;
  const points = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, values]) => {
      const total = values.reduce((s, v) => s + v, 0);
      const value =
        spec.stat === "mean"
          ? total / values.length
          : spec.stat === "max"
            ? Math.max(...values)
            : total;
      return { timestamp, value };
    });
  return { label: spec.label, unit: spec.unit, points };
}

export async function fetchSeries(
  api: OciApi,
  target: MetricTarget,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRIC_WINDOW_MS;
  const interval = intervalFor(endMs - startMs);
  const run = async (filter: string) =>
    (
      await mapLimit(target.specs, 4, (spec) =>
        runQuery(api, target, spec, filter, interval, startMs, endMs),
      )
    ).filter((s): s is MetricSeries => s !== null);
  const series = await run(target.filter);
  if (series.length === 0 && target.fallbackFilter) return run(target.fallbackFilter);
  return series;
}
