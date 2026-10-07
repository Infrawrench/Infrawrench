import type { MetricSeries } from "@infrawrench/plugin-base";
import { mapLimit, type AliApi } from "./api.js";

/**
 * CloudMonitor series (`DescribeMetricList` on `metrics.{region}.aliyuncs.com`,
 * Cms 2019-01-01). `Datapoints` comes back as a JSON *string* of
 * `[{timestamp, Average, Maximum, Minimum, Sum, Value, ...dimensions}]`.
 * Metric names and dimension keys per namespace follow Alibaba's metric
 * references (verified 2026-10): ECS basic and agent metrics, CLB and ALB
 * monitoring pages, the FC 3.0 monitoring page, and the RDS, Tair and OSS
 * metric tables.
 */

export const DEFAULT_METRIC_WINDOW_MS = 3 * 3_600_000;

type Stat = "Average" | "Maximum" | "Sum" | "Value";

interface MetricSpec {
  metric: string;
  stat: Stat;
  label: string;
  unit: string;
}

export interface MetricTarget {
  region: string;
  namespace: string;
  dimensions: Record<string, string>;
  specs: MetricSpec[];
  /** Tried when every primary series comes back empty (engine-specific names). */
  fallbackSpecs?: MetricSpec[];
  /** FC metrics only aggregate at 60 seconds. */
  fixedPeriod?: number;
}

const m = (metric: string, label: string, unit: string, stat: Stat = "Average"): MetricSpec => ({
  metric,
  stat,
  label,
  unit,
});

export const ECS_METRICS = [
  m("CPUUtilization", "CPU Utilization", "%"),
  m("memory_usedutilization", "Memory Utilization", "%"),
  m("load_1m", "Load Average (1m)", ""),
  m("IntranetInRate", "Private Network In", "bit/s"),
  m("IntranetOutRate", "Private Network Out", "bit/s"),
  m("InternetInRate", "Internet In", "bit/s"),
  m("InternetOutRate", "Internet Out", "bit/s"),
  m("DiskReadBPS", "Disk Read", "bytes/s"),
  m("DiskWriteBPS", "Disk Write", "bytes/s"),
  m("DiskReadIOPS", "Disk Read IOPS", "ops/s"),
  m("DiskWriteIOPS", "Disk Write IOPS", "ops/s"),
];

const RDS_METRICS = [
  m("CpuUsage", "CPU Utilization", "%"),
  m("MemoryUsage", "Memory Utilization", "%"),
  m("DiskUsage", "Disk Utilization", "%"),
  m("IOPSUsage", "IOPS Utilization", "%"),
  m("ConnectionUsage", "Connection Utilization", "%"),
  m("MySQL_NetworkInNew", "Network In", "bit/s"),
  m("MySQL_NetworkOutNew", "Network Out", "bit/s"),
  m("MySQL_ComSelect", "Selects", "/s"),
];

const RDS_PG_METRICS = [
  m("cpu_usage", "CPU Utilization", "%"),
  m("mem_usage", "Memory Utilization", "%"),
  m("local_fs_size_usage", "Disk Utilization", "%"),
  m("iops_usage", "IOPS Utilization", "%"),
  // Alibaba's own spelling.
  m("conn_usgae", "Connection Utilization", "%"),
];

const REDIS_METRICS = [
  m("StandardCpuUsage", "CPU Utilization", "%"),
  m("StandardMemoryUsage", "Memory Utilization", "%"),
  m("StandardConnectionUsage", "Connection Utilization", "%"),
  m("StandardUsedQPS", "Requests", "/s"),
  m("StandardHitRate", "Hit Rate", "%"),
  m("StandardIntranetIn", "Network In", "KB/s"),
  m("StandardIntranetOut", "Network Out", "KB/s"),
  m("StandardKeys", "Keys", ""),
];

const SLB_METRICS = [
  m("InstanceActiveConnection", "Active Connections", ""),
  m("InstanceNewConnection", "New Connections", "/s"),
  m("InstanceTrafficRX", "Traffic In", "bit/s"),
  m("InstanceTrafficTX", "Traffic Out", "bit/s"),
  m("InstanceQps", "Requests", "/s"),
  m("InstanceStatusCode5xx", "5xx Responses", "/s"),
  m("InstanceRt", "Response Time", "ms"),
];

const ALB_METRICS = [
  m("LoadBalancerQPS", "Requests", "/s"),
  m("LoadBalancerActiveConnection", "Active Connections", ""),
  m("LoadBalancerNewConnection", "New Connections", "/s"),
  m("LoadBalancerInBits", "Traffic In", "bit/s"),
  m("LoadBalancerOutBits", "Traffic Out", "bit/s"),
  m("LoadBalancerHTTPCode5XX", "5xx Responses", "/s"),
  m("LoadBalancerRequestTime", "Request Time", "ms"),
  m("LoadBalancerUnHealthyHostCount", "Unhealthy Backends", "", "Maximum"),
  m("ConsumedLCUs", "Consumed LCUs", ""),
];

const OSS_METRICS = [
  m("InternetSend", "Internet Out", "bytes", "Value"),
  m("InternetRecv", "Internet In", "bytes", "Value"),
  m("IntranetSend", "Private Out", "bytes", "Value"),
  m("IntranetRecv", "Private In", "bytes", "Value"),
  m("GetObjectCount", "GetObject Requests", "", "Value"),
  m("Availability", "Availability", "%", "Value"),
];

const FC_METRICS = [
  m("FunctionTotalInvocations", "Invocations", "", "Sum"),
  m("FunctionServerErrors", "Server Errors", "", "Sum"),
  m("FunctionClientErrors", "Client Errors", "", "Sum"),
  m("FunctionFunctionErrors", "Function Errors", "", "Sum"),
  m("FunctionAvgDuration", "Average Duration", "ms"),
  m("FunctionP99Duration", "P99 Duration", "ms"),
  m("FunctionMaxMemoryUsageMB", "Max Memory", "MB", "Maximum"),
];

export function metricTarget(typeId: string, region: string, id: string): MetricTarget | null {
  switch (typeId) {
    case "ecs-instance":
      return {
        region,
        namespace: "acs_ecs_dashboard",
        dimensions: { instanceId: id },
        specs: ECS_METRICS,
      };
    case "rds-instance":
      return {
        region,
        namespace: "acs_rds_dashboard",
        dimensions: { instanceId: id },
        specs: RDS_METRICS,
        fallbackSpecs: RDS_PG_METRICS,
      };
    case "redis-instance":
      return {
        region,
        namespace: "acs_kvstore",
        dimensions: { instanceId: id },
        specs: REDIS_METRICS,
      };
    case "slb":
      return {
        region,
        namespace: "acs_slb_dashboard",
        dimensions: { instanceId: id },
        specs: SLB_METRICS,
      };
    case "alb":
      return {
        region,
        namespace: "acs_alb",
        dimensions: { loadBalancerId: id },
        specs: ALB_METRICS,
      };
    case "oss-bucket":
      return {
        region,
        namespace: "acs_oss_dashboard",
        dimensions: { BucketName: id },
        specs: OSS_METRICS,
      };
    case "fc-function":
      return {
        region,
        namespace: "acs_fc",
        dimensions: { region, functionName: id },
        specs: FC_METRICS,
        fixedPeriod: 60,
      };
    default:
      return null;
  }
}

export function periodFor(windowMs: number): number {
  if (windowMs <= 6 * 3_600_000) return 60;
  if (windowMs <= 3 * 86_400_000) return 300;
  return 3600;
}

interface Datapoint {
  timestamp?: number;
  [key: string]: unknown;
}

/** Parse the `Datapoints` string, tolerating an already-parsed array. */
export function parseDatapoints(raw: unknown): Datapoint[] {
  if (Array.isArray(raw)) return raw as Datapoint[];
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Datapoint[]) : [];
  } catch {
    return [];
  }
}

function pointValue(p: Datapoint, stat: Stat): number | undefined {
  for (const key of [stat, "Average", "Value", "Sum", "Maximum"]) {
    const v = p[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

async function runSpec(
  api: AliApi,
  target: MetricTarget,
  spec: MetricSpec,
  startMs: number,
  endMs: number,
  period: number,
): Promise<MetricSeries | null> {
  const points: Datapoint[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await api
      .rpc<{ Datapoints?: unknown; NextToken?: string }>(
        "cms",
        target.region,
        "DescribeMetricList",
        {
          Namespace: target.namespace,
          MetricName: spec.metric,
          Dimensions: JSON.stringify([target.dimensions]),
          Period: String(period),
          StartTime: String(startMs),
          EndTime: String(endMs),
          Length: "1440",
          NextToken: token,
        },
      )
      .catch(() => null);
    if (!res) break;
    points.push(...parseDatapoints(res.Datapoints));
    token = res.NextToken;
    if (!token) break;
  }
  // Per-port or per-listener rows at one timestamp fold into one point:
  // averages average, everything else sums.
  const byTime = new Map<number, number[]>();
  for (const p of points) {
    const t = Number(p.timestamp);
    const v = pointValue(p, spec.stat);
    if (!Number.isFinite(t) || v === undefined) continue;
    if (!byTime.has(t)) byTime.set(t, []);
    byTime.get(t)!.push(v);
  }
  if (byTime.size === 0) return null;
  return {
    label: spec.label,
    unit: spec.unit,
    points: [...byTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, values]) => {
        const total = values.reduce((s, v) => s + v, 0);
        const value =
          spec.stat === "Average"
            ? total / values.length
            : spec.stat === "Maximum"
              ? Math.max(...values)
              : total;
        return { timestamp, value };
      }),
  };
}

export async function fetchSeries(
  api: AliApi,
  target: MetricTarget,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRIC_WINDOW_MS;
  const period = target.fixedPeriod ?? periodFor(endMs - startMs);
  const run = async (specs: MetricSpec[]) =>
    (await mapLimit(specs, 4, (s) => runSpec(api, target, s, startMs, endMs, period))).filter(
      (s): s is MetricSeries => s !== null,
    );
  const series = await run(target.specs);
  if (series.length === 0 && target.fallbackSpecs) return run(target.fallbackSpecs);
  return series;
}
