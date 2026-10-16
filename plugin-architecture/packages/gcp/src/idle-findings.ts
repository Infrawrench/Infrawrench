/**
 * Metric-based idle findings for GCP (`manifest.idleFindings`), read from
 * Cloud Monitoring `projects.timeSeries.list` at a one-day alignment period
 * and judged per resource.
 *
 * Metric types and resource labels (verified 2026-10):
 * - GKE: `kubernetes.io/container/cpu/core_usage_time` (`k8s_container`) and
 *   `kubernetes.io/node/cpu/allocatable_utilization` (`k8s_node`), both keyed
 *   by `resource.labels.cluster_name` and `location`. System metrics are on
 *   by default, cannot be turned off on Autopilot, and can be turned off on
 *   Standard; a cluster with them off has no node series and is skipped.
 *   https://docs.cloud.google.com/kubernetes-engine/docs/how-to/configure-metrics
 * - Cloud NAT: `router.googleapis.com/nat/*` on `nat_gateway`, labels
 *   `project_id`, `region`, `router_id`, `gateway_name`.
 *   https://docs.cloud.google.com/nat/docs/monitoring
 *
 * Workloads are told from system pods by grouping container CPU by namespace
 * and dropping the namespaces GKE manages, client-side: `timeSeries.list`
 * filters do not support `NOT`
 * (https://docs.cloud.google.com/monitoring/api/v3/filters).
 */
import {
  IdleFindingAccessError,
  type CostEstimate,
  type IdleFindingRecord,
  type IdleFindingsCapabilityDeclaration,
  type IdleMetricEvidence,
  type IdleScanRequest,
  type IdleScanResource,
} from "@infrawrench/plugin-base";

const DAY_SECONDS = 86_400;
const MB = 1_000_000;

/**
 * GKE's cluster management fee: $0.10 per cluster-hour for Standard and
 * Autopilot alike (https://cloud.google.com/kubernetes-engine/pricing). One
 * zonal or Autopilot cluster per billing account is covered by a monthly
 * free-tier credit, which the estimate's note says.
 */
export const GKE_MANAGEMENT_FEE_HOURLY_USD = 0.1;
const HOURS_PER_MONTH = 730;

export const GCP_IDLE_FINDINGS: IdleFindingsCapabilityDeclaration = {
  rules: [
    {
      id: "gke-cluster",
      label: "Idle GKE cluster",
      description:
        "A cluster that ran no workloads outside the namespaces GKE manages, or whose nodes averaged next to no CPU, over the lookback window. Nodes and the cluster management fee bill regardless.",
      resourceTypeIds: ["gke-cluster"],
      action: "remove",
      thresholds: [
        {
          key: "maxWorkloadNamespaces",
          label: "Namespaces with workloads",
          description:
            "Namespaces outside kube-system and the gke-/gmp- managed ones that reported a container, at or under which the cluster is idle.",
          unit: "count",
          default: 0,
          min: 0,
          max: 50,
        },
        {
          key: "maxNodeCpuPercent",
          label: "Average node CPU",
          description:
            "Average of the nodes' allocatable CPU utilisation at or under which the cluster is idle.",
          unit: "percent",
          default: 2,
          min: 0,
          max: 20,
        },
      ],
    },
    {
      id: "cloud-nat",
      label: "Idle Cloud NAT gateway",
      description:
        "A Cloud NAT gateway with VMs assigned that sent next to no traffic over the lookback window. It bills per assigned VM and for its NAT IP addresses.",
      resourceTypeIds: ["cloud-nat"],
      action: "remove",
      thresholds: [
        {
          key: "maxSentBytes",
          label: "Bytes sent",
          description: "Total sent_bytes_count over the window at or under which it is idle.",
          unit: "bytes",
          default: 1 * MB,
          min: 0,
          max: 10_000 * MB,
        },
      ],
    },
  ],
};

/** Namespaces GKE creates and manages; a container in one is not a workload. */
export function isSystemNamespace(namespace: string): boolean {
  return (
    namespace === "kube-system" ||
    namespace === "kube-public" ||
    namespace === "kube-node-lease" ||
    namespace.startsWith("gke-") ||
    namespace.startsWith("gmp-")
  );
}

/** One `timeSeries.list` request at a one-day period. */
export interface SeriesQuery {
  metricType: string;
  /** Extra filter clauses, ANDed after the metric type. */
  filters: string[];
  aligner: "ALIGN_MEAN" | "ALIGN_SUM" | "ALIGN_MAX" | "ALIGN_RATE";
  reducer: "REDUCE_SUM" | "REDUCE_MEAN" | "REDUCE_MAX" | "REDUCE_COUNT";
  groupBy?: string[];
}

/** A returned series: its group labels (when grouped) and daily values, oldest first. */
export interface DailySeries {
  labels: Record<string, string>;
  values: number[];
}

export type SeriesReader = (
  query: SeriesQuery,
  window: { start: Date; end: Date },
) => Promise<DailySeries[]>;

interface TimeSeriesResponse {
  timeSeries?: Array<{
    resource?: { labels?: Record<string, string> };
    metric?: { labels?: Record<string, string> };
    points?: Array<{
      interval: { endTime: string };
      value: { doubleValue?: number; int64Value?: string };
    }>;
  }>;
  nextPageToken?: string;
}

/** The real reader: `projects.timeSeries.list` through the client's authenticated GET. */
export function monitoringReader(
  project: string,
  get: <T>(url: string) => Promise<T>,
): SeriesReader {
  return async (query, window) => {
    const out: DailySeries[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries`);
      url.searchParams.set(
        "filter",
        [`metric.type="${query.metricType}"`, ...query.filters].join(" AND "),
      );
      url.searchParams.set("interval.startTime", window.start.toISOString());
      url.searchParams.set("interval.endTime", window.end.toISOString());
      url.searchParams.set("aggregation.alignmentPeriod", `${DAY_SECONDS}s`);
      url.searchParams.set("aggregation.perSeriesAligner", query.aligner);
      url.searchParams.set("aggregation.crossSeriesReducer", query.reducer);
      for (const field of query.groupBy ?? [])
        url.searchParams.append("aggregation.groupByFields", field);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      let resp: TimeSeriesResponse;
      try {
        resp = await get<TimeSeriesResponse>(url.toString());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          /\b403\b|PERMISSION_DENIED/.test(message) &&
          !/SERVICE_DISABLED|has not been used/.test(message)
        ) {
          throw new IdleFindingAccessError(
            `Cloud Monitoring denied timeSeries.list in ${project}: grant monitoring.timeSeries.list (roles/monitoring.viewer).`,
            {
              label: "Cloud Monitoring roles",
              url: "https://cloud.google.com/monitoring/access-control",
            },
          );
        }
        throw err;
      }
      for (const ts of resp.timeSeries ?? []) {
        const values = (ts.points ?? [])
          .map((p) => ({
            t: Date.parse(p.interval.endTime),
            v: p.value.doubleValue ?? Number(p.value.int64Value ?? NaN),
          }))
          .filter((p) => Number.isFinite(p.v))
          .sort((a, b) => a.t - b.t)
          .map((p) => p.v);
        out.push({
          labels: { ...(ts.resource?.labels ?? {}), ...(ts.metric?.labels ?? {}) },
          values,
        });
      }
      pageToken = resp.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return out;
  };
}

const sum = (v: number[]): number | null => (v.length === 0 ? null : v.reduce((a, b) => a + b, 0));
const mean = (v: number[]): number | null => (v.length === 0 ? null : (sum(v) ?? 0) / v.length);

/** Daily points needed before a series is trusted: the window less two days. */
export function requiredCoverage(lookbackDays: number): number {
  return Math.max(1, lookbackDays - 2);
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function ev(
  metric: string,
  label: string,
  statistic: IdleMetricEvidence["statistic"],
  value: number | null,
  unit: IdleMetricEvidence["unit"],
  threshold?: number,
): IdleMetricEvidence {
  return {
    metric,
    label,
    statistic,
    value,
    unit,
    ...(threshold !== undefined ? { threshold, comparison: "atMost" as const } : {}),
  };
}

function fmtBytes(n: number): string {
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < MB) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / MB).toFixed(1)} MB`;
}

interface Verdict {
  reason: string;
  evidence: IdleMetricEvidence[];
}

export async function judgeGkeCluster(
  resource: IdleScanResource,
  thresholds: Record<string, number>,
  lookbackDays: number,
  window: { start: Date; end: Date },
  read: SeriesReader,
): Promise<Verdict | null> {
  const f = resource.fields;
  const name = String(f["name"] ?? resource.externalId ?? "");
  const location = String(f["location"] ?? "");
  if (!name || String(f["status"] ?? "RUNNING") !== "RUNNING") return null;
  const scope = [
    `resource.labels.cluster_name=${quote(name)}`,
    ...(location ? [`resource.labels.location=${quote(location)}`] : []),
  ];
  const [nodes, namespaces] = await Promise.all([
    read(
      {
        metricType: "kubernetes.io/node/cpu/allocatable_utilization",
        filters: ['resource.type="k8s_node"', ...scope],
        aligner: "ALIGN_MEAN",
        reducer: "REDUCE_MEAN",
      },
      window,
    ),
    read(
      {
        metricType: "kubernetes.io/container/cpu/core_usage_time",
        filters: ['resource.type="k8s_container"', ...scope],
        aligner: "ALIGN_RATE",
        reducer: "REDUCE_SUM",
        groupBy: ["resource.labels.namespace_name"],
      },
      window,
    ),
  ]);
  const nodeDays = nodes[0]?.values ?? [];
  // No node series for the window: system metrics are off (or the read is
  // wrong). Either way there is no evidence to judge on.
  if (nodeDays.length < requiredCoverage(lookbackDays)) return null;
  const nodeCpuPercent = (mean(nodeDays) ?? 0) * 100;
  const workloads = namespaces.filter(
    (s) => s.values.length > 0 && !isSystemNamespace(s.labels["namespace_name"] ?? ""),
  );
  const workloadCores = sum(workloads.flatMap((s) => s.values)) ?? 0;
  const maxNamespaces = thresholds["maxWorkloadNamespaces"] ?? 0;
  const maxCpu = thresholds["maxNodeCpuPercent"] ?? 2;
  const noWorkloads = workloads.length <= maxNamespaces;
  const quietNodes = nodeCpuPercent <= maxCpu;
  if (!noWorkloads && !quietNodes) return null;
  const cpu = `${Number(nodeCpuPercent.toFixed(2))}%`;
  return {
    reason: noWorkloads
      ? `${workloads.length === 0 ? "No workloads" : `Workloads in only ${workloads.length} namespace(s)`} outside GKE's own namespaces over ${lookbackDays} days; nodes averaged ${cpu} CPU`
      : `Nodes averaged ${cpu} CPU over ${lookbackDays} days`,
    evidence: [
      ev(
        "kubernetes.io/container/cpu/core_usage_time",
        "Namespaces with workloads",
        "count",
        workloads.length,
        "count",
        maxNamespaces,
      ),
      ev(
        "kubernetes.io/node/cpu/allocatable_utilization",
        "Average node CPU",
        "average",
        Number(nodeCpuPercent.toFixed(3)),
        "percent",
        maxCpu,
      ),
      ev(
        "kubernetes.io/container/cpu/core_usage_time",
        "Workload CPU core-days",
        "sum",
        Number(workloadCores.toFixed(3)),
        "count",
      ),
    ],
  };
}

export async function judgeCloudNat(
  resource: IdleScanResource,
  thresholds: Record<string, number>,
  lookbackDays: number,
  window: { start: Date; end: Date },
  read: SeriesReader,
): Promise<Verdict | null> {
  const f = resource.fields;
  const name = String(f["name"] ?? "");
  const region = String(f["region"] ?? "");
  if (!name || !region) return null;
  const scope = [
    'resource.type="nat_gateway"',
    `resource.labels.gateway_name=${quote(name)}`,
    `resource.labels.region=${quote(region)}`,
  ];
  const [ports, sent] = await Promise.all([
    read(
      {
        metricType: "router.googleapis.com/nat/allocated_ports",
        filters: scope,
        aligner: "ALIGN_MAX",
        reducer: "REDUCE_SUM",
      },
      window,
    ),
    read(
      {
        metricType: "router.googleapis.com/nat/sent_bytes_count",
        filters: scope,
        aligner: "ALIGN_SUM",
        reducer: "REDUCE_SUM",
      },
      window,
    ),
  ]);
  const portDays = ports[0]?.values ?? [];
  // Ports allocated across the window prove VMs are assigned (what it bills
  // for) and that the read reaches the gateway; without them, nothing to judge.
  if (portDays.length < requiredCoverage(lookbackDays)) return null;
  const bytes = sum(sent[0]?.values ?? []) ?? 0;
  const maxBytes = thresholds["maxSentBytes"] ?? 1 * MB;
  if (bytes > maxBytes) return null;
  return {
    reason: `Sent ${fmtBytes(bytes)} over ${lookbackDays} days while holding NAT ports for its VMs`,
    evidence: [
      ev(
        "router.googleapis.com/nat/sent_bytes_count",
        "Bytes sent",
        "sum",
        bytes,
        "bytes",
        maxBytes,
      ),
      ev(
        "router.googleapis.com/nat/allocated_ports",
        "Peak ports allocated",
        "max",
        Math.max(...portDays),
        "count",
      ),
    ],
  };
}

export interface GcpIdleDeps {
  read: SeriesReader;
  /** The client's own `estimateCost`, for the GKE node cost. */
  estimateCost?: (typeId: string, fields: Record<string, string>) => Promise<CostEstimate | null>;
}

async function gkeEstimate(
  resource: IdleScanResource,
  estimateCost: GcpIdleDeps["estimateCost"],
): Promise<IdleFindingRecord["estimate"]> {
  const fee = GKE_MANAGEMENT_FEE_HOURLY_USD * HOURS_PER_MONTH;
  let nodes = 0;
  if (estimateCost) {
    const fields = Object.fromEntries(
      Object.entries(resource.fields).map(([k, v]) => [k, String(v)]),
    );
    const est = await estimateCost("gke-cluster", fields).catch(() => null);
    if (est && est.currency === "USD") nodes = est.monthlyAmount;
  }
  return {
    monthlyAmount: Math.round((fee + nodes) * 100) / 100,
    currency: "USD",
    basis: "list-price",
    note:
      nodes > 0
        ? "Management fee plus the first node pool's nodes and boot disks. One zonal or Autopilot cluster per billing account is covered by the free-tier credit."
        : "Management fee only; one zonal or Autopilot cluster per billing account is covered by the free-tier credit.",
  };
}

/**
 * Judge the project's GKE clusters and Cloud NAT gateways against the
 * enabled rules. A failed read throws (never a short list).
 */
export async function fetchGcpIdleFindings(
  request: IdleScanRequest,
  deps: GcpIdleDeps,
): Promise<IdleFindingRecord[]> {
  const end = new Date(request.windowEnd);
  end.setUTCHours(0, 0, 0, 0);
  const window = {
    start: new Date(end.getTime() - request.lookbackDays * DAY_SECONDS * 1000),
    end,
  };
  const findings: IdleFindingRecord[] = [];
  for (const resource of request.resources) {
    let verdict: Verdict | null = null;
    let ruleId = "";
    if (resource.resourceTypeId === "gke-cluster" && request.rules["gke-cluster"]) {
      ruleId = "gke-cluster";
      verdict = await judgeGkeCluster(
        resource,
        request.rules[ruleId]!.thresholds,
        request.lookbackDays,
        window,
        deps.read,
      );
    } else if (resource.resourceTypeId === "cloud-nat" && request.rules["cloud-nat"]) {
      ruleId = "cloud-nat";
      verdict = await judgeCloudNat(
        resource,
        request.rules[ruleId]!.thresholds,
        request.lookbackDays,
        window,
        deps.read,
      );
    }
    if (!verdict) continue;
    findings.push({
      ruleId,
      subjectKey: resource.externalId ?? resource.id,
      resourceId: resource.id,
      resourceTypeId: resource.resourceTypeId,
      displayName: resource.displayName,
      reason: verdict.reason,
      evidence: verdict.evidence,
      // Cloud NAT bills per assigned VM-hour and NAT IP; the VM count is not
      // a metric, so its figure is left unpriced rather than guessed.
      estimate: ruleId === "gke-cluster" ? await gkeEstimate(resource, deps.estimateCost) : null,
    });
  }
  return findings;
}
