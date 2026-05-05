import type {
  DescribeCapability,
  DetailViewSchema,
  LogsCapability,
  ManifestEditorCapability,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { mapPeerStatus, mapJobStatus } from "./types.js";

/** Standard manifest editor capability for all namespaced K8s resources */
const K8S_MANIFEST_EDITOR: ManifestEditorCapability = {
  language: "yaml",
};

/** Standard describe capability for all K8s resources */
const K8S_DESCRIBE: DescribeCapability = { language: "text" };

/** Standard logs capability for pod-bearing K8s resources */
const K8S_LOGS: LogsCapability = { defaultTailLines: 500, supportsPrevious: true };

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

export function renderPodDetail(resource: ResourceInstance): DetailViewSchema {
  const status = String(resource.fields["status"] ?? "Unknown");
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
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "Pod" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
  };
}

export function renderDeploymentDetail(resource: ResourceInstance): DetailViewSchema {
  const ready = resource.fields["readyReplicas"] ?? 0;
  const desired = resource.fields["replicas"] ?? 0;
  const allReady = Number(ready) === Number(desired) && Number(desired) > 0;
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
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "Deployment" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
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

export function renderStatefulSetDetail(resource: ResourceInstance): DetailViewSchema {
  const ready = resource.fields["readyReplicas"] ?? 0;
  const desired = resource.fields["replicas"] ?? 0;
  const allReady = Number(ready) === Number(desired) && Number(desired) > 0;
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
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "StatefulSet" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
  };
}

export function renderDaemonSetDetail(resource: ResourceInstance): DetailViewSchema {
  const ready = Number(resource.fields["numberReady"] ?? 0);
  const desired = Number(resource.fields["desiredNumberScheduled"] ?? 0);
  const allReady = ready === desired && desired > 0;
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
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    manifestEditor: { ...K8S_MANIFEST_EDITOR, resourceKind: "DaemonSet" },
    describe: K8S_DESCRIBE,
    logs: K8S_LOGS,
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
