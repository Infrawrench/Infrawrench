import type {
  DescribeCapability,
  DetailViewSchema,
  DetailViewTab,
  LogsCapability,
  ManifestEditorCapability,
  ResourceInstance,
  SectionNode,
  TableNode,
  TableRow,
} from "@infrawrench/plugin-base";
import { mapPeerStatus, mapJobStatus } from "./types.js";
import type { Efficiency } from "./cost-model.js";
import { formatDailyCost, formatEfficiency, formatMoney } from "./cost-model.js";
import type { CostIndex } from "./cost-surface.js";
import {
  CONTROL_PLANE_BUCKET_LABEL,
  GPU_IDLE_BUCKET_LABEL,
  IDLE_BUCKET_LABEL,
  SYSTEM_RESERVED_BUCKET_LABEL,
  UNATTACHED_STORAGE_BUCKET_LABEL,
  podEntry,
  workloadEntry,
} from "./cost-surface.js";
import {
  buildEfficiencyReport,
  describeGpuFinding,
  formatDaily,
  formatEfficiencyCell,
  formatGpuCell,
  formatGpuUtilizationCell,
  totalWaste,
  formatEfficiencyReportText,
  formatCapacityType,
  formatPair,
  RIGHTSIZING_NOTE,
  type EfficiencyReport,
  type EfficiencyRow,
  type NodeGroupRow,
} from "./efficiency-report.js";
import { formatCores, formatMemory, type ResourcePair } from "./quantity.js";
import { describeRateSource } from "./node-rates.js";
import { describeNodeGpus, formatGpus, type GpuPriceBasis } from "./gpu.js";
import { describeGpuMetricsSource } from "./gpu-metrics.js";

/** `2 GPU · 41% busy`, `0.5 GPU · unknown`, or a dash for no GPUs. */
function gpuText(gpus: number, utilization: number | null, unknown: boolean): string {
  if (!(gpus > 0)) return "—";
  const busy =
    utilization != null ? `${Math.round(utilization * 100)}% busy` : unknown ? "unknown" : "";
  return busy ? `${formatGpus(gpus)} · ${busy}` : formatGpus(gpus);
}

/** How the GPU share of a node's price was set, in words. */
export function describeGpuPriceBasis(basis: GpuPriceBasis | null): string {
  switch (basis) {
    case "per-gpu-price":
      return "per-GPU price";
    case "reference":
      return "published per-GPU reference ratio";
    case "remainder":
      return "node price less CPU and memory at reference rates";
    default:
      return "no node price";
  }
}

/** Standard manifest editor capability for all namespaced K8s resources */
const K8S_MANIFEST_EDITOR: ManifestEditorCapability = {
  language: "yaml",
};

/** Standard describe capability for all K8s resources */
const K8S_DESCRIBE: DescribeCapability = { language: "text" };

/** Standard logs capability for pod-bearing K8s resources */
const K8S_LOGS: LogsCapability = { defaultTailLines: 500, supportsPrevious: true };

/**
 * Cost and efficiency are time series worth charting, so every kind that gets
 * a cost breakdown also gets a Metrics tab. 24 hours is the useful default:
 * allocation only changes when workloads are rescheduled or resized.
 *
 * Declared unconditionally, unlike the cost *sections* below. Those need the
 * allocation synchronously and `renderDetail` cannot await one, so they only
 * appear once some earlier async pass has warmed `lastCostIndex`. The tab must
 * not work that way: on a cold client the host fetches the series anyway (the
 * type declares `supportsMetrics`) and they arrive asynchronously, so gating
 * the capability on the same warm cache is what made a first visit render the
 * series into a tab that was not there. An empty tab is the host's documented
 * "no data yet" state; a missing one reads as metrics being broken.
 */
const K8S_COST_METRICS = { defaultTimeRangeMs: 24 * 60 * 60 * 1000 };

function pairText(pair: ResourcePair): string {
  return `${formatCores(pair.cpuCores)} CPU · ${formatMemory(pair.memoryBytes)}`;
}

/** `240Gi` from a GiB count. PVC sizes are whole GiB in practice. */
function gibText(gib: number): string {
  if (gib <= 0) return "—";
  return gib >= 10 ? `${Math.round(gib)}Gi` : `${Number(gib.toFixed(2))}Gi`;
}

/** `120Gi · 2 LB`: the non-compute footprint, in one narrow column. */
function extrasText(storageGib: number, loadBalancerCount: number): string {
  const parts: string[] = [];
  if (storageGib > 0) parts.push(gibText(storageGib));
  if (loadBalancerCount > 0) {
    parts.push(`${loadBalancerCount} LB${loadBalancerCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ") || "—";
}

function moneyCell(amount: number | null, currency: string): string {
  return amount == null ? "—" : `${formatMoney(amount, currency)}/day`;
}

/** A "Cost & efficiency" section for one allocated thing. Omitted when unknown. */
function costSection(
  entry:
    | {
        dailyCost: number | null;
        requests: ResourcePair;
        usage: ResourcePair | null;
        efficiency: Efficiency;
        gpus: number;
        gpuDailyCost: number | null;
        gpuUtilization: number | null;
        gpuWastedDailyCost: number | null;
      }
    | undefined,
  costs: CostIndex | undefined,
): SectionNode[] {
  if (!entry || !costs) return [];
  const efficiency = formatEfficiency(entry.efficiency);
  const money = formatDailyCost(entry.dailyCost, costs.currency);
  return [
    {
      kind: "section",
      title: "Cost & efficiency",
      children: [
        {
          kind: "key-value-list",
          items: [
            ...(money ? [{ key: "Derived cost", value: money }] : []),
            { key: "Requests", value: pairText(entry.requests) },
            ...(entry.usage ? [{ key: "Actual usage", value: pairText(entry.usage) }] : []),
            ...(efficiency ? [{ key: "Efficiency (used ÷ requested)", value: efficiency }] : []),
            ...(entry.gpus > 0
              ? [
                  {
                    key: "GPUs",
                    value: gpuText(entry.gpus, entry.gpuUtilization, entry.gpuUtilization == null),
                  },
                  ...(entry.gpuDailyCost != null
                    ? [{ key: "GPU cost", value: moneyCell(entry.gpuDailyCost, costs.currency) }]
                    : []),
                  ...(entry.gpuWastedDailyCost != null
                    ? [
                        {
                          key: "Requested GPU idle",
                          value: moneyCell(entry.gpuWastedDailyCost, costs.currency),
                        },
                      ]
                    : []),
                ]
              : []),
            {
              key: "Basis",
              value: money
                ? `Apportioned from node prices (${describeRateSource(costs.rateSource)}). A derived estimate, not a billed amount.`
                : "No hourly rate is available for this cluster's nodes, so capacity is shown without cost.",
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Cost broken down by workload, for a namespace.
 *
 * Ordered by cost so the first row is the one worth looking at. Workloads with
 * no cost (unpriced nodes, unscheduled pods) sort last rather than being
 * dropped: a workload that exists but cannot be priced is a fact, and hiding
 * it would make the namespace look cheaper than it is.
 */
function namespaceCostTable(namespace: string, costs: CostIndex | undefined): SectionNode[] {
  if (!costs) return [];
  const workloads = costs.cluster.workloads.filter((w) => w.namespace === namespace);
  if (workloads.length === 0) return [];

  const showGpu = costs.cluster.gpu.nodeCount > 0;
  const rows: TableRow[] = workloads.map((w) => ({
    cells: {
      workload: w.workload,
      kind: w.workloadKind,
      pods: String(w.podCount),
      requests: pairText(w.requests),
      ...(showGpu ? { gpu: gpuText(w.gpus, w.gpuUtilization, w.gpuUsageUnknown) } : {}),
      extras: extrasText(w.storageGib, w.loadBalancerCount),
      efficiency: w.usageUnknown ? "unknown" : formatEfficiency(w.efficiency) || "—",
      cost: moneyCell(w.dailyCost, costs.currency),
    },
  }));

  const table: TableNode = {
    kind: "table",
    emphasizeFirstColumn: true,
    columns: [
      { key: "workload", label: "Workload", width: "wide" },
      { key: "kind", label: "Kind", width: "narrow" },
      { key: "pods", label: "Pods", width: "narrow" },
      { key: "requests", label: "Requests", mono: true },
      ...(showGpu ? [{ key: "gpu", label: "GPU", mono: true }] : []),
      { key: "extras", label: "Storage / LB", width: "narrow", mono: true },
      { key: "efficiency", label: "Efficiency" },
      { key: "cost", label: "Derived cost", width: "narrow" },
    ],
    rows,
  };

  return [{ kind: "section", title: "Cost by workload", children: [table] }];
}

/**
 * Cost broken down by namespace, for the whole cluster, including the idle
 * and system-reserved buckets.
 *
 * Those two rows are the point of the table. Spreading unallocated capacity
 * across the namespaces would overcharge every tenant AND hide the actual
 * finding, which is that the cluster is bigger than its workloads. They get
 * their own lines and are labelled as capacity, not as anyone's spend.
 */
function clusterCostTable(costs: CostIndex | undefined): SectionNode[] {
  if (!costs) return [];
  const { cluster } = costs;
  if (cluster.namespaces.length === 0 && cluster.nodeCount === 0) return [];

  const showGpu = cluster.gpu.nodeCount > 0;
  const rows: TableRow[] = cluster.namespaces.map((ns) => ({
    cells: {
      namespace: ns.namespace,
      pods: String(ns.podCount),
      requests: pairText(ns.requests),
      ...(showGpu ? { gpu: gpuText(ns.gpus, ns.gpuUtilization, ns.gpuUsageUnknown) } : {}),
      extras: extrasText(ns.storageGib, ns.loadBalancerCount),
      efficiency: ns.usageUnknown ? "unknown" : formatEfficiency(ns.efficiency) || "—",
      cost: moneyCell(ns.dailyCost, costs.currency),
    },
  }));

  const idlePair: ResourcePair = cluster.nodes.reduce(
    (acc, n) => ({
      cpuCores: acc.cpuCores + n.idle.cpuCores,
      memoryBytes: acc.memoryBytes + n.idle.memoryBytes,
    }),
    { cpuCores: 0, memoryBytes: 0 },
  );
  const reservedPair: ResourcePair = cluster.nodes.reduce(
    (acc, n) => ({
      cpuCores: acc.cpuCores + n.systemReserved.cpuCores,
      memoryBytes: acc.memoryBytes + n.systemReserved.memoryBytes,
    }),
    { cpuCores: 0, memoryBytes: 0 },
  );

  // The buckets. Each of these is money the cluster spends that belongs to no
  // tenant, and each is a different finding: idle means the cluster is bigger
  // than its workloads, system-reserved is the kubelet's tax, the control plane
  // is a fee you pay for existing, and unattached storage is disks nothing
  // mounts. Spreading any of them across the namespaces would hide all four.
  const bucket = (label: string, capacity: string, cost: number | null, gpu = "—") => {
    rows.push({
      cells: {
        namespace: label,
        pods: "—",
        requests: capacity,
        ...(showGpu ? { gpu } : {}),
        extras: "—",
        efficiency: "—",
        cost: moneyCell(cost, costs.currency),
      },
    });
  };

  bucket(IDLE_BUCKET_LABEL, pairText(idlePair), cluster.dailyIdleCost);
  bucket(SYSTEM_RESERVED_BUCKET_LABEL, pairText(reservedPair), cluster.dailySystemReservedCost);
  if (showGpu) {
    bucket(GPU_IDLE_BUCKET_LABEL, "—", cluster.gpu.dailyIdleCost, formatGpus(cluster.gpu.idle));
  }
  if (cluster.hourlyControlPlaneCost != null) {
    bucket(CONTROL_PLANE_BUCKET_LABEL, "—", cluster.dailyControlPlaneCost);
  }
  if (cluster.storage.unattachedCount > 0) {
    rows.push({
      cells: {
        namespace: UNATTACHED_STORAGE_BUCKET_LABEL,
        pods: "—",
        requests: "—",
        ...(showGpu ? { gpu: "—" } : {}),
        extras: gibText(cluster.storage.unattachedGib),
        efficiency: "—",
        cost: moneyCell(cluster.storage.dailyUnattachedCost, costs.currency),
      },
    });
  }

  const table: TableNode = {
    kind: "table",
    emphasizeFirstColumn: true,
    columns: [
      { key: "namespace", label: "Namespace", width: "wide" },
      { key: "pods", label: "Pods", width: "narrow" },
      { key: "requests", label: "Requests", mono: true },
      ...(showGpu ? [{ key: "gpu", label: "GPU", mono: true }] : []),
      { key: "extras", label: "Storage / LB", width: "narrow", mono: true },
      { key: "efficiency", label: "Efficiency" },
      { key: "cost", label: "Derived cost", width: "narrow" },
    ],
    rows,
  };

  return [
    { kind: "section", title: "Cost by namespace", children: [table] },
    ...clusterComponentSection(costs),
  ];
}

/**
 * What the cluster's money is made of, by component rather than by tenant.
 *
 * The by-namespace table answers "who spends it". This answers "on what", and
 * the two are different conversations: a cluster whose biggest line is the
 * control-plane fee has a consolidation problem, not a tenant problem.
 */
function clusterComponentSection(costs: CostIndex): SectionNode[] {
  const { cluster } = costs;
  const currency = costs.currency;
  const line = (key: string, amount: number | null, suffix = "") =>
    amount == null ? [] : [{ key, value: `${formatMoney(amount, currency)}/day${suffix}` }];

  const items = [
    ...line("Nodes", cluster.dailyNodeCost),
    ...line(
      "of which GPUs",
      cluster.gpu.dailyCost,
      cluster.gpu.physical > 0
        ? ` (${formatGpus(cluster.gpu.physical)} on ${cluster.gpu.nodeCount} node${cluster.gpu.nodeCount === 1 ? "" : "s"})`
        : "",
    ),
    ...line("Control plane", cluster.dailyControlPlaneCost),
    ...line(
      "Persistent volumes",
      cluster.storage.dailyAttributedCost,
      cluster.storage.gib > 0 ? ` (${gibText(cluster.storage.gib)} provisioned)` : "",
    ),
    ...line(
      "Unattached volumes",
      cluster.storage.dailyUnattachedCost,
      ` (${cluster.storage.unattachedCount} claim${cluster.storage.unattachedCount === 1 ? "" : "s"} nothing mounts)`,
    ),
    ...line(
      "Load balancers",
      cluster.loadBalancers.dailyCost,
      ` (${cluster.loadBalancers.provisionedCount} provisioned)`,
    ),
    ...line("Total", cluster.dailyTotalCost),
  ];

  // Facts worth stating even when there is no price behind them: a count of
  // disks with no money is more useful than silence, and it explains the gap.
  if (cluster.storage.dailyAttributedCost == null && cluster.storage.gib > 0) {
    items.push({
      key: "Persistent volumes",
      value: `${gibText(cluster.storage.gib)} across ${cluster.storage.count} claims. No price for ${cluster.storage.unpricedClasses.join(", ") || "these storage classes"}.`,
    });
  }
  if (cluster.loadBalancers.dailyCost == null && cluster.loadBalancers.count > 0) {
    items.push({
      key: "Load balancers",
      value: `${cluster.loadBalancers.count} LoadBalancer Service${cluster.loadBalancers.count === 1 ? "" : "s"}. No per-load-balancer price is configured.`,
    });
  }
  if (cluster.storage.unboundCount > 0) {
    items.push({
      key: "Unbound claims",
      value: `${cluster.storage.unboundCount} claim${cluster.storage.unboundCount === 1 ? "" : "s"} never bound to a volume (${gibText(cluster.storage.unboundGib)} requested). Not priced, nothing was provisioned.`,
    });
  }

  if (items.length === 0) return [];
  return [
    {
      kind: "section",
      title: "What the cluster costs",
      children: [{ kind: "key-value-list", items }],
    },
  ];
}

/**
 * Every PersistentVolumeClaim, worst first, with the two waste classes called
 * out by name in the Attribution column rather than left to be inferred.
 */
function storageTable(costs: CostIndex): SectionNode[] {
  const volumes = costs.cluster.storage.volumes;
  if (volumes.length === 0) return [];

  const rows: TableRow[] = volumes.map((v) => ({
    cells: {
      claim: `${v.namespace}/${v.name}`,
      size: gibText(v.gib) + (v.capacityBasis === "requested" ? " (requested)" : ""),
      class: v.storageClass || "(default)",
      attribution: v.unbound
        ? `Unbound (${v.phase})`
        : v.unattached
          ? "Mounted by nothing"
          : v.shared
            ? "Shared, charged to the namespace"
            : `${v.workloadKind} ${v.workload}`,
      cost: moneyCell(v.dailyCost, costs.currency),
    },
  }));

  return [
    {
      kind: "section",
      title: "Persistent volumes",
      children: [
        {
          kind: "table",
          emphasizeFirstColumn: true,
          columns: [
            { key: "claim", label: "Claim", width: "wide" },
            { key: "size", label: "Size", width: "narrow", mono: true },
            { key: "class", label: "Storage class" },
            { key: "attribution", label: "Attributed to", width: "wide" },
            { key: "cost", label: "Derived cost", width: "narrow" },
          ],
          rows,
        },
      ],
    },
  ];
}

/** Every `LoadBalancer` Service, with what it routes to and what it costs. */
function loadBalancerTable(costs: CostIndex): SectionNode[] {
  const loadBalancers = costs.cluster.loadBalancers.loadBalancers;
  if (loadBalancers.length === 0) return [];

  const rows: TableRow[] = loadBalancers.map((lb) => ({
    cells: {
      service: `${lb.namespace}/${lb.name}`,
      address: lb.pending ? "(not provisioned)" : lb.address,
      class: lb.loadBalancerClass || "(provider default)",
      attribution: lb.workload
        ? `${lb.workloadKind} ${lb.workload}`
        : "No single workload, charged to the namespace",
      cost: moneyCell(lb.dailyCost, costs.currency),
    },
  }));

  return [
    {
      kind: "section",
      title: "Load balancers",
      children: [
        {
          kind: "table",
          emphasizeFirstColumn: true,
          columns: [
            { key: "service", label: "Service", width: "wide" },
            { key: "address", label: "Address", mono: true },
            { key: "class", label: "Class" },
            { key: "attribution", label: "Attributed to", width: "wide" },
            { key: "cost", label: "Derived cost", width: "narrow" },
          ],
          rows,
        },
      ],
    },
  ];
}

/**
 * The GPU tab: every GPU node with what it holds and how its price was split,
 * then every GPU workload. Only rendered on a cluster with accelerators.
 */
function gpuSections(costs: CostIndex): SectionNode[] {
  const { cluster } = costs;
  if (cluster.gpu.nodeCount === 0) return [];
  const currency = costs.currency;
  const gpu = cluster.gpu;

  const summary = [
    {
      key: "GPUs",
      value: `${formatGpus(gpu.physical)} on ${gpu.nodeCount} node${gpu.nodeCount === 1 ? "" : "s"}, ${formatGpus(gpu.allocated)} requested`,
    },
    ...(gpu.dailyCost != null
      ? [{ key: "GPU cost", value: moneyCell(gpu.dailyCost, currency) }]
      : []),
    ...(gpu.dailyIdleCost != null
      ? [
          {
            key: "Unrequested GPUs",
            value: `${moneyCell(gpu.dailyIdleCost, currency)} (${formatGpus(gpu.idle)}): allocatable GPUs no pod asked for`,
          },
        ]
      : []),
    ...(gpu.utilization != null
      ? [
          {
            key: "GPU utilization",
            value: `${Math.round(gpu.utilization * 100)}% busy (GPU-weighted)`,
          },
        ]
      : []),
    ...(gpu.wastedDailyCost != null
      ? [
          {
            key: "Requested but idle",
            value: `${moneyCell(gpu.wastedDailyCost, currency)}: GPU time workloads hold and do not use`,
          },
        ]
      : []),
    ...(costs.gpuMetrics
      ? [{ key: "Utilization source", value: describeGpuMetricsSource(costs.gpuMetrics) }]
      : []),
  ];

  const nodeRows: TableRow[] = cluster.nodes
    .filter((n) => n.gpu)
    .map((n) => ({
      cells: {
        node: n.name,
        gpus: describeNodeGpus(n.gpu!.inventory),
        requested: formatGpus(n.gpu!.allocated),
        idle: formatGpus(n.gpu!.idle),
        basis: describeGpuPriceBasis(n.gpu!.priceBasis),
        cost: moneyCell(n.gpu!.hourlyPool == null ? null : n.gpu!.hourlyPool * 24, currency),
        idleCost: moneyCell(
          n.gpu!.hourlyIdleCost == null ? null : n.gpu!.hourlyIdleCost * 24,
          currency,
        ),
      },
    }));

  const workloadRows: TableRow[] = cluster.workloads
    .filter((w) => w.gpus > 0)
    .sort((a, b) => (b.gpuDailyCost ?? -1) - (a.gpuDailyCost ?? -1) || a.key.localeCompare(b.key))
    .map((w) => ({
      cells: {
        workload: `${w.namespace}/${w.workload}`,
        kind: w.workloadKind,
        gpus: formatGpus(w.gpus),
        busy: w.gpuUtilization != null ? `${Math.round(w.gpuUtilization * 100)}%` : "unknown",
        idle: moneyCell(w.gpuWastedDailyCost, currency),
        cost: moneyCell(w.gpuDailyCost, currency),
      },
    }));

  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "GPU summary",
      children: [{ kind: "key-value-list", items: summary }],
    },
    {
      kind: "section",
      title: "GPU nodes",
      children: [
        {
          kind: "table",
          emphasizeFirstColumn: true,
          columns: [
            { key: "node", label: "Node", width: "wide" },
            { key: "gpus", label: "GPUs", width: "wide" },
            { key: "requested", label: "Requested", width: "narrow", mono: true },
            { key: "idle", label: "Unrequested", width: "narrow", mono: true },
            { key: "basis", label: "GPU share priced by" },
            { key: "cost", label: "GPU cost", width: "narrow" },
            { key: "idleCost", label: "Idle cost", width: "narrow" },
          ],
          rows: nodeRows,
        },
      ],
    },
  ];
  if (workloadRows.length > 0) {
    sections.push({
      kind: "section",
      title: "GPU workloads",
      children: [
        {
          kind: "table",
          emphasizeFirstColumn: true,
          columns: [
            { key: "workload", label: "Workload", width: "wide" },
            { key: "kind", label: "Kind", width: "narrow" },
            { key: "gpus", label: "GPUs", width: "narrow", mono: true },
            { key: "busy", label: "Busy", width: "narrow" },
            { key: "idle", label: "Requested idle", width: "narrow" },
            { key: "cost", label: "GPU cost", width: "narrow" },
          ],
          rows: workloadRows,
        },
      ],
    });
  }
  sections.push({
    kind: "section",
    title: "How GPU cost is worked out",
    children: [
      {
        kind: "text",
        variant: "muted",
        content: [
          "• A GPU node's price is split into a GPU share and a CPU/memory share before anyone is charged. The GPU share is charged by GPU requests; a CPU-only pod on a GPU node pays only for CPU and memory.",
          "• A MIG slice pays its fraction of the card (compute slices out of 7), and a time-sliced or MPS replica pays 1/replicas.",
          "• Unrequested GPUs are their own line, never spread across tenants. Requested-but-idle GPU time is the workload's waste, measured from DCGM or AMD exporter metrics.",
          "• Derived from node prices, not billed amounts.",
        ].join("\n"),
      },
    ],
  });
  return sections;
}

/** Right-sizing findings for whole-GPU workloads, for the Efficiency tab. */
function gpuRightsizingSection(report: EfficiencyReport): SectionNode[] {
  if (report.gpuRightsizing.length === 0) return [];
  const rows: TableRow[] = report.gpuRightsizing.map((f) => ({
    cells: {
      workload: `${f.namespace}/${f.workload}`,
      model: f.model,
      p95: `${Math.round(f.p95Utilization * 100)}%`,
      memory: `${(f.peakMemoryMiB / 1024).toFixed(1)} GiB`,
      suggestion:
        f.suggestion === "mig" && f.profile
          ? `MIG ${f.profile.name}${f.gpusPerPod > 1 ? ` ×${f.gpusPerPod}` : ""}`
          : "Share the GPU (time-slicing or MPS)",
      saving: formatDaily(f.savingDailyCost, report.currency),
    },
  }));
  return [
    {
      kind: "section",
      title: "GPU right-sizing",
      children: [
        {
          kind: "table",
          emphasizeFirstColumn: true,
          columns: [
            { key: "workload", label: "Workload", width: "wide" },
            { key: "model", label: "GPU", width: "narrow" },
            { key: "p95", label: "p95 busy", width: "narrow" },
            { key: "memory", label: "Peak memory", width: "narrow" },
            { key: "suggestion", label: "Suggestion", width: "wide" },
            { key: "saving", label: "Saving", width: "narrow" },
          ],
          rows,
        },
        {
          kind: "text",
          variant: "muted",
          content:
            "Whole GPUs whose p95 utilization and peak memory, over the metrics history, fit a smaller MIG profile with 25% headroom. Moving to MIG means repartitioning the node (the GPU operator's mig.config label) and changing the workload's request to the profile's resource. A workload is only listed when every one of its GPU pods fits and has a day of history.",
        },
      ],
    },
  ];
}

/** The resource type a workload kind lists as, for the per-row "Open" link. */
function typeIdForWorkloadKind(kind: string): string | null {
  switch (kind) {
    case "Deployment":
      return "k8s-deployment";
    case "StatefulSet":
      return "k8s-statefulset";
    case "DaemonSet":
      return "k8s-daemonset";
    default:
      // Jobs, CronJobs and bare Pods roll up under their own names but do not
      // have a stable one-to-one listing row to link to. No link beats a link
      // that 404s.
      return null;
  }
}

/** Capacity by node group: pool × capacity type, most idle money first. */
function nodeGroupTable(rows: NodeGroupRow[], currency: string): TableNode {
  return {
    kind: "table",
    emphasizeFirstColumn: true,
    columns: [
      { key: "name", label: "Node group" },
      { key: "capacity", label: "Capacity", width: "narrow" as const },
      { key: "types", label: "Instance type", width: "narrow" as const },
      { key: "nodes", label: "Nodes", width: "narrow" as const },
      { key: "idleShare", label: "Idle", width: "narrow" as const },
      { key: "idle", label: "Idle cost", width: "narrow" as const },
      { key: "wasted", label: "Unused requests", width: "narrow" as const },
      { key: "cost", label: "Node cost", width: "narrow" as const },
    ],
    rows: rows.map((row) => ({
      cells: {
        name: row.label,
        capacity: formatCapacityType(row.capacityType),
        types: row.instanceTypes,
        nodes: String(row.nodeCount),
        idleShare: row.idleShare == null ? "—" : `${Math.round(row.idleShare * 100)}%`,
        idle: formatDaily(row.dailyIdleCost, currency),
        wasted: formatDaily(row.wastedDailyCost, currency),
        cost: formatDaily(row.dailyNodeCost, currency),
      },
    })),
  };
}

/** One efficiency table: namespaces or workloads, same columns. */
function efficiencyTable(
  rows: EfficiencyRow[],
  currency: string,
  accountId: string | null,
  showKind: boolean,
  showGpu = false,
): TableNode {
  const tableRows: TableRow[] = rows.map((row) => {
    const typeId = showKind ? typeIdForWorkloadKind(row.workloadKind) : null;
    return {
      cells: {
        name: showKind ? `${row.namespace}/${row.label}` : row.label,
        ...(showKind ? { kind: row.workloadKind } : {}),
        requested: formatPair(row.requests, false),
        used: formatPair(row.usage, row.unknown),
        cpu: formatEfficiencyCell(row, "cpu"),
        memory: formatEfficiencyCell(row, "memory"),
        ...(showGpu ? { gpu: formatGpuCell(row), gpuBusy: formatGpuUtilizationCell(row) } : {}),
        wasted: formatDaily(totalWaste(row), currency),
        cost: formatDaily(row.dailyCost, currency),
        ...(typeId && accountId
          ? {
              open: {
                kind: "action" as const,
                label: "Open",
                variant: "ghost" as const,
                action: {
                  type: "navigate-to-resource" as const,
                  pluginId: "kubernetes",
                  resourceTypeId: typeId,
                  resourceId: `${accountId}:${typeId}:${row.namespace}:${row.label}`,
                },
              },
            }
          : {}),
      },
    };
  });

  return {
    kind: "table",
    emphasizeFirstColumn: true,
    columns: [
      { key: "name", label: showKind ? "Workload" : "Namespace", width: "wide" },
      ...(showKind ? [{ key: "kind", label: "Kind", width: "narrow" as const }] : []),
      { key: "requested", label: "Requested", mono: true },
      { key: "used", label: "Used", mono: true },
      { key: "cpu", label: "CPU", width: "narrow" as const },
      { key: "memory", label: "Mem", width: "narrow" as const },
      ...(showGpu
        ? [
            { key: "gpu", label: "GPU", width: "narrow" as const, mono: true },
            { key: "gpuBusy", label: "GPU busy", width: "narrow" as const },
          ]
        : []),
      { key: "wasted", label: "Wasted", width: "narrow" as const },
      { key: "cost", label: "Cost", width: "narrow" as const },
      ...(showKind ? [{ key: "open", label: "", width: "narrow" as const }] : []),
    ],
    rows: tableRows,
  };
}

/**
 * The Efficiency tab: requested vs used vs wasted, per namespace and per
 * workload, worst offenders first.
 *
 * The percentage is the diagnosis and the money is the argument, so both
 * columns are always present and the ordering is by money: nobody schedules
 * work off a ratio. Where a row was never measured every cell that would be
 * derived from usage reads `unknown`; a workload with no metrics-server behind
 * it is not 0% efficient, and rendering it as 0% would make the cluster look
 * catastrophically wasteful the moment the metrics pipeline broke.
 */
function efficiencyTab(
  costs: CostIndex,
  accountId: string | null,
  generatedAt: string,
  namespaceFilter?: string,
): DetailViewTab[] {
  const report: EfficiencyReport = buildEfficiencyReport(
    costs.cluster,
    generatedAt,
    namespaceFilter,
    costs.nodeAttributes,
  );
  if (report.namespaces.length === 0 && report.workloads.length === 0) return [];

  const currency = report.currency;
  const title = namespaceFilter
    ? `Kubernetes efficiency: namespace ${namespaceFilter}`
    : "Kubernetes efficiency report";

  const summary = [
    { key: "Requested", value: formatPair(report.totals.requests, false) },
    { key: "Actually used", value: formatPair(report.totals.usage, !report.measured) },
    {
      key: "Requested but unused",
      value: formatPair(report.totals.wasted, !report.measured),
    },
    { key: "Cost of the unused", value: formatDaily(report.totals.wastedDailyCost, currency) },
    { key: "Attributed cost", value: formatDaily(report.totals.dailyCost, currency) },
    ...(report.totals.dailyIdleCost != null
      ? [
          {
            key: "Idle node capacity",
            value: `${formatDaily(report.totals.dailyIdleCost, currency)}, capacity nobody requested`,
          },
        ]
      : []),
    ...(report.totals.dailyUnattachedStorageCost != null
      ? [
          {
            key: "Unattached storage",
            value: `${formatDaily(report.totals.dailyUnattachedStorageCost, currency)}, volumes no running pod mounts`,
          },
        ]
      : []),
    ...(report.hasGpus
      ? [
          {
            key: "GPU cost",
            value: `${formatDaily(report.totals.gpuDailyCost, currency)} for ${formatGpus(report.totals.gpus)} requested${report.totals.gpuUtilization != null ? `, ${Math.round(report.totals.gpuUtilization * 100)}% busy` : ""}`,
          },
          {
            key: "Requested GPU idle",
            value: `${formatDaily(report.totals.gpuWastedDailyCost, currency)}: GPU time held and not used`,
          },
          ...(report.totals.dailyIdleGpuCost != null
            ? [
                {
                  key: "Unrequested GPUs",
                  value: `${formatDaily(report.totals.dailyIdleGpuCost, currency)} (${formatGpus(report.totals.idleGpus ?? 0)}): GPUs nobody asked for`,
                },
              ]
            : []),
        ]
      : []),
  ];

  const caveats: string[] = [];
  if (!report.measured) {
    caveats.push(
      "metrics-server is not reporting, so nothing here is measured and efficiency figures read “unknown”. Install it and the report fills in on the next refresh.",
    );
  } else if (report.unknownWorkloads > 0) {
    caveats.push(
      `${report.unknownWorkloads} of ${report.totalWorkloads} workloads reported no usage and read “unknown”. They are sorted last: an unmeasured workload is neither efficient nor wasteful.`,
    );
  }
  if (report.partiallyPriced) {
    caveats.push(
      "Some nodes have no hourly rate, so their workloads show a waste figure in CPU and memory but not in money.",
    );
  }
  if (report.hasGpus) {
    caveats.push(
      costs.gpuMetrics
        ? describeGpuMetricsSource(costs.gpuMetrics)
        : "No pod in scope requests a GPU, so no GPU metrics were read.",
    );
    caveats.push(
      "Wasted includes requested-but-idle GPU time wherever GPU utilization was measured. Time-sliced and MPS GPUs read “unknown”: no exporter can say which sharer is busy.",
    );
  }
  caveats.push(RIGHTSIZING_NOTE);

  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Summary",
      children: [{ kind: "key-value-list", items: summary }],
    },
    {
      kind: "section",
      title: "By namespace, worst first",
      children: [efficiencyTable(report.namespaces, currency, null, false, report.hasGpus)],
    },
    {
      kind: "section",
      title: "By workload, worst first",
      children: [efficiencyTable(report.workloads, currency, accountId, true, report.hasGpus)],
    },
    ...gpuRightsizingSection(report),
    ...(report.nodeGroups.length > 0
      ? [
          {
            kind: "section" as const,
            title: "By node group, most idle first",
            children: [nodeGroupTable(report.nodeGroups, currency)],
          },
        ]
      : []),
    {
      kind: "section",
      title: "How to read this",
      children: [
        {
          kind: "text",
          content: caveats.map((line) => `• ${line}`).join("\n"),
          variant: "muted",
        },
      ],
    },
    {
      // The shareable copy. A table on screen cannot be pasted into a ticket,
      // and a screenshot of numbers goes stale without saying so; this block
      // carries the figures, the caveats and the timestamp together.
      kind: "section",
      title: "Share",
      children: [
        {
          kind: "text",
          content: formatEfficiencyReportText(report, title),
          variant: "mono",
          copyable: true,
        },
      ],
    },
  ];

  return [{ id: "efficiency", label: "Efficiency", sections }];
}

/**
 * A Kubernetes cluster's own detail view. Exists mainly to carry the
 * by-namespace cost table; without cost data it falls back to the generic
 * key-value rendering.
 */
export function renderClusterDetail(
  resource: ResourceInstance,
  costs?: CostIndex,
): DetailViewSchema {
  const generic = renderGenericDetail(resource);
  if (!costs) return { ...generic, metricsCapability: K8S_COST_METRICS };
  const storage = storageTable(costs);
  const loadBalancers = loadBalancerTable(costs);
  const gpu = gpuSections(costs);
  return {
    ...generic,
    subtitle: "Kubernetes cluster",
    sections: [...clusterCostTable(costs), ...generic.sections],
    customTabs: [
      ...efficiencyTab(costs, resource.accountId, costs.generatedAt),
      ...(gpu.length ? [{ id: "gpus", label: "GPUs", sections: gpu }] : []),
      // Only worth a tab when there is something in it: a cluster with no PVCs
      // and no LoadBalancer Services should not grow an empty tab.
      ...(storage.length || loadBalancers.length
        ? [
            {
              id: "storage-and-network",
              label: "Storage & load balancers",
              sections: [...storage, ...loadBalancers],
            },
          ]
        : []),
    ],
    metricsCapability: K8S_COST_METRICS,
  };
}

/** A namespace's detail view, carrying the by-workload cost table. */
export function renderNamespaceDetail(
  resource: ResourceInstance,
  costs?: CostIndex,
): DetailViewSchema {
  const name = String(resource.fields["name"] ?? resource.displayName);
  const entry = costs?.namespaces.get(name);
  const generic = renderGenericDetail(resource);
  if (!costs) return { ...generic, metricsCapability: K8S_COST_METRICS };
  return {
    ...generic,
    subtitle: "Namespace",
    sections: [
      ...costSection(entry, costs),
      ...namespaceCostTable(name, costs),
      ...generic.sections,
    ],
    customTabs: efficiencyTab(costs, resource.accountId, costs.generatedAt, name),
    metricsCapability: K8S_COST_METRICS,
  };
}

export function renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: resource.resourceTypeId,
    status: { kind: "status-dot", status: "info" },
    sections: [
      {
        kind: "section",
        title: "Details",
        children: [
          {
            kind: "key-value-list",
            items: Object.entries(resource.fields).map(([key, value]) => ({
              key,
              value: String(value),
            })),
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

/** Format remaining TTL as a human-readable string */
function formatTimeRemaining(expiresAt: string): string {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "Expired";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  if (minutes > 0) return `${minutes}m remaining`;
  return "< 1m remaining";
}

/** Format a TTL in seconds as a human-readable duration */
function formatTtl(seconds: number): string {
  if (seconds >= 86400) return `${seconds / 86400}d`;
  if (seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function renderPodDetail(resource: ResourceInstance, costs?: CostIndex): DetailViewSchema {
  const status = String(resource.fields["status"] ?? "Unknown");
  const costEntry = podEntry(
    costs,
    String(resource.fields["namespace"] ?? "default"),
    String(resource.fields["name"] ?? resource.displayName),
  );
  const isEphemeral = resource.fields["ephemeral"] === "true";
  const expiresAt = String(resource.fields["expiresAt"] ?? "");
  const ttlSeconds = Number(resource.fields["ttlSeconds"] ?? 0);

  const subtitle = isEphemeral
    ? `Scratch pod in ${resource.fields["namespace"] ?? "default"}`
    : `Pod in ${resource.fields["namespace"] ?? "default"}`;

  const ephemeralItems = isEphemeral
    ? [
        { key: "TTL", value: formatTtl(ttlSeconds) },
        ...(expiresAt ? [{ key: "Time Remaining", value: formatTimeRemaining(expiresAt) }] : []),
        ...(expiresAt ? [{ key: "Expires At", value: new Date(expiresAt).toLocaleString() }] : []),
      ]
    : [];

  return {
    title: resource.displayName,
    subtitle,
    status: { kind: "status-dot", status: mapPeerStatus(status), label: status },
    sections: [
      ...(isEphemeral
        ? [
            {
              kind: "section" as const,
              title: "Scratch Pod",
              children: [
                {
                  kind: "key-value-list" as const,
                  items: [
                    { key: "Type", value: "Ephemeral (auto-destroys after TTL)" },
                    ...ephemeralItems,
                  ],
                },
              ],
            },
          ]
        : []),
      {
        kind: "section",
        title: "Pod Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              { key: "Image", value: String(resource.fields["image"] ?? "") },
              { key: "Status", value: status },
              ...(resource.fields["restarts"] != null
                ? [{ key: "Restarts", value: String(resource.fields["restarts"]) }]
                : []),
              ...(resource.fields["containerName"]
                ? [{ key: "Container", value: String(resource.fields["containerName"]) }]
                : []),
              ...(resource.fields["nodeName"]
                ? [{ key: "Node", value: String(resource.fields["nodeName"]) }]
                : []),
              ...(resource.fields["requestCpu"]
                ? [
                    {
                      key: "Requests",
                      value: `${resource.fields["requestCpu"]} CPU · ${resource.fields["requestMemory"]}`,
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      ...costSection(costEntry, costs),
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "Pod" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
    metricsCapability: K8S_COST_METRICS,
  };
}

export function renderDeploymentDetail(
  resource: ResourceInstance,
  costs?: CostIndex,
): DetailViewSchema {
  const ready = resource.fields["readyReplicas"] ?? 0;
  const desired = resource.fields["replicas"] ?? 0;
  const allReady = Number(ready) === Number(desired) && Number(desired) > 0;
  const costEntry = workloadEntry(
    costs,
    String(resource.fields["namespace"] ?? "default"),
    "Deployment",
    String(resource.fields["name"] ?? resource.displayName),
  );
  return {
    title: resource.displayName,
    subtitle: `Deployment in ${resource.fields["namespace"] ?? "default"}`,
    status: {
      kind: "status-dot",
      status: allReady ? "healthy" : Number(ready) > 0 ? "degraded" : "error",
      label: `${ready}/${desired} ready`,
    },
    sections: [
      {
        kind: "section",
        title: "Deployment Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              { key: "Replicas", value: `${ready}/${desired}` },
              ...(resource.fields["image"]
                ? [{ key: "Image", value: String(resource.fields["image"]) }]
                : []),
              ...(resource.fields["strategy"]
                ? [{ key: "Strategy", value: String(resource.fields["strategy"]) }]
                : []),
              ...(resource.fields["requestCpu"]
                ? [
                    {
                      key: "Requests (per pod)",
                      value: `${resource.fields["requestCpu"]} CPU · ${resource.fields["requestMemory"]}`,
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      ...costSection(costEntry, costs),
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "Deployment" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
    metricsCapability: K8S_COST_METRICS,
  };
}

export function renderServiceDetail(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: `Service in ${resource.fields["namespace"] ?? "default"}`,
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      {
        kind: "section",
        title: "Service Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              { key: "Type", value: String(resource.fields["type"] ?? "ClusterIP") },
              ...(resource.fields["clusterIP"]
                ? [{ key: "Cluster IP", value: String(resource.fields["clusterIP"]) }]
                : []),
              ...(resource.fields["ports"]
                ? [{ key: "Ports", value: String(resource.fields["ports"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "Service" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
  };
}

export function renderStatefulSetDetail(
  resource: ResourceInstance,
  costs?: CostIndex,
): DetailViewSchema {
  const ready = resource.fields["readyReplicas"] ?? 0;
  const desired = resource.fields["replicas"] ?? 0;
  const allReady = Number(ready) === Number(desired) && Number(desired) > 0;
  const costEntry = workloadEntry(
    costs,
    String(resource.fields["namespace"] ?? "default"),
    "StatefulSet",
    String(resource.fields["name"] ?? resource.displayName),
  );
  return {
    title: resource.displayName,
    subtitle: `StatefulSet in ${resource.fields["namespace"] ?? "default"}`,
    status: {
      kind: "status-dot",
      status: allReady ? "healthy" : Number(ready) > 0 ? "degraded" : "error",
      label: `${ready}/${desired} ready`,
    },
    sections: [
      {
        kind: "section",
        title: "StatefulSet Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              { key: "Replicas", value: `${ready}/${desired}` },
              ...(resource.fields["image"]
                ? [{ key: "Image", value: String(resource.fields["image"]) }]
                : []),
            ],
          },
        ],
      },
      ...costSection(costEntry, costs),
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "StatefulSet" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
    metricsCapability: K8S_COST_METRICS,
  };
}

export function renderDaemonSetDetail(
  resource: ResourceInstance,
  costs?: CostIndex,
): DetailViewSchema {
  const ready = Number(resource.fields["numberReady"] ?? 0);
  const desired = Number(resource.fields["desiredNumberScheduled"] ?? 0);
  const allReady = ready === desired && desired > 0;
  const costEntry = workloadEntry(
    costs,
    String(resource.fields["namespace"] ?? "default"),
    "DaemonSet",
    String(resource.fields["name"] ?? resource.displayName),
  );
  return {
    title: resource.displayName,
    subtitle: `DaemonSet in ${resource.fields["namespace"] ?? "default"}`,
    status: {
      kind: "status-dot",
      status: allReady ? "healthy" : ready > 0 ? "degraded" : "error",
      label: `${ready}/${desired} ready`,
    },
    sections: [
      {
        kind: "section",
        title: "DaemonSet Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              { key: "Desired", value: String(desired) },
              { key: "Ready", value: String(ready) },
              ...(resource.fields["image"]
                ? [{ key: "Image", value: String(resource.fields["image"]) }]
                : []),
            ],
          },
        ],
      },
      ...costSection(costEntry, costs),
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "DaemonSet" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
    metricsCapability: K8S_COST_METRICS,
  };
}

export function renderJobDetail(resource: ResourceInstance): DetailViewSchema {
  const status = String(resource.fields["status"] ?? "Unknown");
  return {
    title: resource.displayName,
    subtitle: `Job in ${resource.fields["namespace"] ?? "default"}`,
    status: { kind: "status-dot", status: mapJobStatus(status), label: status },
    sections: [
      {
        kind: "section",
        title: "Job Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              { key: "Completions", value: String(resource.fields["completions"] ?? "") },
              { key: "Status", value: status },
              ...(resource.fields["image"]
                ? [{ key: "Image", value: String(resource.fields["image"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "Job" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
  };
}

export function renderCronJobDetail(resource: ResourceInstance): DetailViewSchema {
  const suspended = resource.fields["suspended"] === "true";
  return {
    title: resource.displayName,
    subtitle: `CronJob in ${resource.fields["namespace"] ?? "default"}`,
    status: {
      kind: "status-dot",
      status: suspended ? "degraded" : "healthy",
      label: suspended ? "Suspended" : "Active",
    },
    sections: [
      {
        kind: "section",
        title: "CronJob Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              { key: "Schedule", value: String(resource.fields["schedule"] ?? "") },
              { key: "Suspended", value: suspended ? "Yes" : "No" },
              ...(resource.fields["lastSchedule"]
                ? [{ key: "Last Schedule", value: String(resource.fields["lastSchedule"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "CronJob" },
    describe: K8S_DESCRIBE,
  };
}

export function renderIngressDetail(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: `Ingress in ${resource.fields["namespace"] ?? "default"}`,
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      {
        kind: "section",
        title: "Ingress Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              ...(resource.fields["ingressClassName"]
                ? [{ key: "Ingress Class", value: String(resource.fields["ingressClassName"]) }]
                : []),
              ...(resource.fields["hosts"]
                ? [{ key: "Hosts", value: String(resource.fields["hosts"]) }]
                : []),
              ...(resource.fields["address"]
                ? [{ key: "Address", value: String(resource.fields["address"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "Ingress" },
    describe: K8S_DESCRIBE,
  };
}

export function renderConfigMapDetail(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: `ConfigMap in ${resource.fields["namespace"] ?? "default"}`,
    sections: [
      {
        kind: "section",
        title: "ConfigMap Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              { key: "Data Entries", value: String(resource.fields["dataCount"] ?? 0) },
              ...(resource.fields["keys"]
                ? [{ key: "Keys", value: String(resource.fields["keys"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "ConfigMap" },
    describe: K8S_DESCRIBE,
  };
}

export function renderSecretDetail(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: `Secret in ${resource.fields["namespace"] ?? "default"}`,
    sections: [
      {
        kind: "section",
        title: "Secret Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Namespace", value: String(resource.fields["namespace"] ?? "") },
              { key: "Type", value: String(resource.fields["type"] ?? "Opaque") },
              { key: "Data Entries", value: String(resource.fields["dataCount"] ?? 0) },
              ...(resource.fields["keys"]
                ? [{ key: "Keys", value: String(resource.fields["keys"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "Secret" },
    describe: K8S_DESCRIBE,
  };
}
