import type {
  DescribeCapability,
  DetailViewSchema,
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
  IDLE_BUCKET_LABEL,
  SYSTEM_RESERVED_BUCKET_LABEL,
  podEntry,
  workloadEntry,
} from "./cost-surface.js";
import { formatCores, formatMemory, type ResourcePair } from "./quantity.js";
import { describeRateSource } from "./node-rates.js";

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
 */
const K8S_COST_METRICS = { defaultTimeRangeMs: 24 * 60 * 60 * 1000 };

function pairText(pair: ResourcePair): string {
  return `${formatCores(pair.cpuCores)} CPU · ${formatMemory(pair.memoryBytes)}`;
}

/** A "Cost & efficiency" section for one allocated thing. Omitted when unknown. */
function costSection(
  entry:
    | {
        dailyCost: number | null;
        requests: ResourcePair;
        usage: ResourcePair | null;
        efficiency: Efficiency;
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
            {
              key: "Basis",
              value: money
                ? `Apportioned from node prices (${describeRateSource(costs.rateSource)}) — a derived estimate, not a billed amount.`
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
 * dropped — a workload that exists but cannot be priced is a fact, and hiding
 * it would make the namespace look cheaper than it is.
 */
function namespaceCostTable(namespace: string, costs: CostIndex | undefined): SectionNode[] {
  if (!costs) return [];
  const workloads = costs.cluster.workloads.filter((w) => w.namespace === namespace);
  if (workloads.length === 0) return [];

  const rows: TableRow[] = workloads.map((w) => ({
    cells: {
      workload: w.workload,
      kind: w.workloadKind,
      pods: String(w.podCount),
      requests: pairText(w.requests),
      efficiency: formatEfficiency(w.efficiency) || "—",
      cost: w.dailyCost == null ? "—" : `${formatMoney(w.dailyCost, costs.currency)}/day`,
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
      { key: "efficiency", label: "Efficiency" },
      { key: "cost", label: "Derived cost", width: "narrow" },
    ],
    rows,
  };

  return [{ kind: "section", title: "Cost by workload", children: [table] }];
}

/**
 * Cost broken down by namespace, for the whole cluster — including the idle
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

  const rows: TableRow[] = cluster.namespaces.map((ns) => ({
    cells: {
      namespace: ns.namespace,
      pods: String(ns.podCount),
      requests: pairText(ns.requests),
      efficiency: formatEfficiency(ns.efficiency) || "—",
      cost: ns.dailyCost == null ? "—" : `${formatMoney(ns.dailyCost, costs.currency)}/day`,
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

  rows.push({
    cells: {
      namespace: IDLE_BUCKET_LABEL,
      pods: "—",
      requests: pairText(idlePair),
      efficiency: "—",
      cost:
        cluster.dailyIdleCost == null
          ? "—"
          : `${formatMoney(cluster.dailyIdleCost, costs.currency)}/day`,
    },
  });
  rows.push({
    cells: {
      namespace: SYSTEM_RESERVED_BUCKET_LABEL,
      pods: "—",
      requests: pairText(reservedPair),
      efficiency: "—",
      cost:
        cluster.dailySystemReservedCost == null
          ? "—"
          : `${formatMoney(cluster.dailySystemReservedCost, costs.currency)}/day`,
    },
  });

  const table: TableNode = {
    kind: "table",
    emphasizeFirstColumn: true,
    columns: [
      { key: "namespace", label: "Namespace", width: "wide" },
      { key: "pods", label: "Pods", width: "narrow" },
      { key: "requests", label: "Requests", mono: true },
      { key: "efficiency", label: "Efficiency" },
      { key: "cost", label: "Derived cost", width: "narrow" },
    ],
    rows,
  };

  return [{ kind: "section", title: "Cost by namespace", children: [table] }];
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
  if (!costs) return generic;
  return {
    ...generic,
    subtitle: "Kubernetes cluster",
    sections: [...clusterCostTable(costs), ...generic.sections],
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
  if (!costs) return generic;
  return {
    ...generic,
    subtitle: "Namespace",
    sections: [
      ...costSection(entry, costs),
      ...namespaceCostTable(name, costs),
      ...generic.sections,
    ],
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
                    { key: "Type", value: "Ephemeral \u2014 auto-destroys after TTL" },
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
    ...(costs ? { metricsCapability: K8S_COST_METRICS } : {}),
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
    ...(costs ? { metricsCapability: K8S_COST_METRICS } : {}),
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
    ...(costs ? { metricsCapability: K8S_COST_METRICS } : {}),
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
    ...(costs ? { metricsCapability: K8S_COST_METRICS } : {}),
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
