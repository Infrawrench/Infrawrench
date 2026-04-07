import type {
  DetailViewSchema,
  HostServices,
  PeerPaneContext,
  PeerPaneSchema,
  PeerPaneResource,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";

// ── K8s API response shapes (minimal) ──────────────────────────────────────

interface K8sMeta {
  name: string;
  namespace?: string;
  uid: string;
  creationTimestamp: string;
  labels?: Record<string, string>;
}

interface K8sList<T> {
  items: T[];
}

interface K8sNamespace {
  metadata: K8sMeta;
  status: { phase: string };
}

interface K8sPod {
  metadata: K8sMeta;
  spec: { containers: Array<{ name: string; image: string }> };
  status: {
    phase: string;
    containerStatuses?: Array<{
      ready: boolean;
      restartCount: number;
      state: Record<string, unknown>;
    }>;
  };
}

interface K8sDeployment {
  metadata: K8sMeta;
  spec: {
    replicas?: number;
    template: { spec: { containers: Array<{ name: string; image: string }> } };
  };
  status: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
  };
}

interface K8sService {
  metadata: K8sMeta;
  spec: {
    type: string;
    clusterIP?: string;
    ports?: Array<{ port: number; targetPort: number | string; protocol: string; name?: string }>;
  };
}

interface K8sStatefulSet {
  metadata: K8sMeta;
  spec: {
    replicas?: number;
    template: { spec: { containers: Array<{ name: string; image: string }> } };
  };
  status: { replicas?: number; readyReplicas?: number; currentReplicas?: number };
}

interface K8sDaemonSet {
  metadata: K8sMeta;
  spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } };
  status: {
    desiredNumberScheduled: number;
    numberReady: number;
    currentNumberScheduled?: number;
    numberMisscheduled?: number;
  };
}

interface K8sJob {
  metadata: K8sMeta;
  spec: {
    completions?: number;
    parallelism?: number;
    template: { spec: { containers: Array<{ name: string; image: string }> } };
  };
  status: {
    succeeded?: number;
    failed?: number;
    active?: number;
    startTime?: string;
    completionTime?: string;
    conditions?: Array<{ type: string; status: string }>;
  };
}

interface K8sCronJob {
  metadata: K8sMeta;
  spec: {
    schedule: string;
    suspend?: boolean;
    jobTemplate: { spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } } };
  };
  status: { lastScheduleTime?: string; lastSuccessfulTime?: string };
}

interface K8sIngress {
  metadata: K8sMeta;
  spec: {
    ingressClassName?: string;
    rules?: Array<{ host?: string }>;
  };
  status: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } };
}

interface K8sConfigMap {
  metadata: K8sMeta;
  data?: Record<string, string>;
}

interface K8sSecret {
  metadata: K8sMeta;
  type?: string;
  data?: Record<string, string>;
}

// ── Kubeconfig parsing ──────────────────────────────────────────────────────

interface ParsedKubeconfig {
  server: string;
  caCertData?: string;
  token?: string;
  clientCertData?: string;
  clientKeyData?: string;
}

function parseKubeconfig(raw: string): ParsedKubeconfig {
  const getVal = (key: string): string => {
    const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m");
    const m = raw.match(re);
    return m?.[1]?.trim() ?? "";
  };
  const ca = getVal("certificate-authority-data");
  const tok = getVal("token");
  const cert = getVal("client-certificate-data");
  const key = getVal("client-key-data");
  return {
    server: getVal("server"),
    ...(ca ? { caCertData: ca } : {}),
    ...(tok ? { token: tok } : {}),
    ...(cert ? { clientCertData: cert } : {}),
    ...(key ? { clientKeyData: key } : {}),
  };
}

// ── Helper: system namespaces to collapse/filter ────────────────────────────

const SYSTEM_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "gke-managed-system",
  "gke-gmp-system",
  "gmp-system",
  "gke-managed-cim",
  "config-management-system",
  "config-management-monitoring",
  "asm-system",
  "istio-system",
  "knative-serving",
  "gke-managed-filestorecsi",
]);

// ── Client ──────────────────────────────────────────────────────────────────

export class KubernetesClient implements PluginClient {
  private readonly kubeconfig: string;
  private readonly parsed: ParsedKubeconfig;
  private readonly services?: HostServices;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const kubeconfig = credentials["kubeconfig"];
    if (!kubeconfig) throw new Error("Kubernetes plugin: missing kubeconfig credential");
    this.kubeconfig = kubeconfig;
    this.parsed = parseKubeconfig(kubeconfig);
    if (services) this.services = services;
  }

  private async k8sFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const { server, token, caCertData } = this.parsed;
    if (!server) throw new Error("Kubernetes plugin: no server in kubeconfig");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (caCertData && this.services?.http) {
      const caPem = atob(caCertData);
      const result = await this.services.http.request({
        url: `${server}${path}`,
        method: options?.method ?? "GET",
        headers,
        ...(options?.body ? { body: String(options.body) } : {}),
        caCert: caPem,
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`K8s API error ${result.status}: ${result.body}`);
      }
      return JSON.parse(result.body) as T;
    }

    const res = await fetch(`${server}${path}`, { headers, ...options });
    if (!res.ok) throw new Error(`K8s API error ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  // ── listResources ───────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "k8s-cluster":
        return this.listClusters(accountId);
      case "k8s-namespace":
        return this.listNamespaces(accountId);
      case "k8s-pod":
        return this.listPods(accountId);
      case "k8s-deployment":
        return this.listDeployments(accountId);
      case "k8s-service":
        return this.listServices(accountId);
      case "k8s-statefulset":
        return this.listStatefulSets(accountId);
      case "k8s-daemonset":
        return this.listDaemonSets(accountId);
      case "k8s-job":
        return this.listJobs(accountId);
      case "k8s-cronjob":
        return this.listCronJobs(accountId);
      case "k8s-ingress":
        return this.listIngresses(accountId);
      case "k8s-configmap":
        return this.listConfigMaps(accountId);
      case "k8s-secret":
        return this.listSecrets(accountId);
      default:
        throw new Error(`Kubernetes plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Kubernetes plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    _resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    if (typeId === "k8s-cluster" && outputKey === "serverVersion") {
      try {
        const data = await this.k8sFetch<{ gitVersion: string }>("/version");
        return data.gitVersion;
      } catch {
        return "unknown";
      }
    }
    throw new Error(
      `Kubernetes plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  // ── Detail views ────────────────────────────────────────────────────────

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "k8s-pod":
        return this.renderPodDetail(resource);
      case "k8s-deployment":
        return this.renderDeploymentDetail(resource);
      case "k8s-service":
        return this.renderServiceDetail(resource);
      case "k8s-statefulset":
        return this.renderStatefulSetDetail(resource);
      case "k8s-daemonset":
        return this.renderDaemonSetDetail(resource);
      case "k8s-job":
        return this.renderJobDetail(resource);
      case "k8s-cronjob":
        return this.renderCronJobDetail(resource);
      case "k8s-ingress":
        return this.renderIngressDetail(resource);
      case "k8s-configmap":
        return this.renderConfigMapDetail(resource);
      case "k8s-secret":
        return this.renderSecretDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  private renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: resource.resourceTypeId,
      status: { kind: "status-dot", status: "unknown" },
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderPodDetail(resource: ResourceInstance): DetailViewSchema {
    const status = String(resource.fields["status"] ?? "Unknown");
    return {
      title: resource.displayName,
      subtitle: `Pod in ${resource.fields["namespace"] ?? "default"}`,
      status: { kind: "status-dot", status: this.mapPeerStatus(status), label: status },
      sections: [
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderDeploymentDetail(resource: ResourceInstance): DetailViewSchema {
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderServiceDetail(resource: ResourceInstance): DetailViewSchema {
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderStatefulSetDetail(resource: ResourceInstance): DetailViewSchema {
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderDaemonSetDetail(resource: ResourceInstance): DetailViewSchema {
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderJobDetail(resource: ResourceInstance): DetailViewSchema {
    const status = String(resource.fields["status"] ?? "Unknown");
    return {
      title: resource.displayName,
      subtitle: `Job in ${resource.fields["namespace"] ?? "default"}`,
      status: { kind: "status-dot", status: this.mapJobStatus(status), label: status },
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderCronJobDetail(resource: ResourceInstance): DetailViewSchema {
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderIngressDetail(resource: ResourceInstance): DetailViewSchema {
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderConfigMapDetail(resource: ResourceInstance): DetailViewSchema {
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderSecretDetail(resource: ResourceInstance): DetailViewSchema {
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
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  // ── Namespace import ────────────────────────────────────────────────────

  async listNamespacesForImport(_accountId: string): Promise<string[]> {
    try {
      const data = await this.k8sFetch<K8sList<K8sNamespace>>("/api/v1/namespaces");
      return data.items.map((ns) => ns.metadata.name).sort();
    } catch {
      return ["default", "kube-system"];
    }
  }

  async importSecret(
    _accountId: string,
    config: { namespace: string; secretName: string; data: Record<string, string> },
  ): Promise<void> {
    const encoded: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.data)) {
      encoded[key] = btoa(value);
    }

    await this.k8sFetch(`/api/v1/namespaces/${encodeURIComponent(config.namespace)}/secrets`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: config.secretName,
          namespace: config.namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench" },
        },
        type: "Opaque",
        data: encoded,
      }),
    });
  }

  // ── Peer pane ───────────────────────────────────────────────────────────

  async renderPeerPane(_context: PeerPaneContext): Promise<PeerPaneSchema> {
    const syntheticAccountId = "peer";

    const [namespaces, pods, deployments, services, statefulSets, daemonSets, jobs, cronJobs, ingresses] =
      await Promise.all([
        this.listNamespaces(syntheticAccountId),
        this.listPods(syntheticAccountId),
        this.listDeployments(syntheticAccountId),
        this.listServices(syntheticAccountId),
        this.listStatefulSets(syntheticAccountId),
        this.listDaemonSets(syntheticAccountId),
        this.listJobs(syntheticAccountId),
        this.listCronJobs(syntheticAccountId),
        this.listIngresses(syntheticAccountId),
      ]);

    const groups = [
      this.namespacePeerGroup(namespaces),
      this.podPeerGroup(pods),
      this.deploymentPeerGroup(deployments),
      this.statefulSetPeerGroup(statefulSets),
      this.daemonSetPeerGroup(daemonSets),
      this.servicePeerGroup(services),
      this.ingressPeerGroup(ingresses),
      this.jobPeerGroup(jobs),
      this.cronJobPeerGroup(cronJobs),
    ].filter((g) => g.items.length > 0);

    return {
      status: { kind: "status-dot", status: "healthy" },
      supportsK9s: true,
      supportsSecretImport: true,
      resourceGroups: groups,
    };
  }

  private namespacePeerGroup(namespaces: ResourceInstance[]) {
    return {
      title: `Namespaces (${namespaces.length})`,
      resourceTypeId: "k8s-namespace" as const,
      pluginId: "kubernetes" as const,
      items: namespaces.map((ns): PeerPaneResource => ({
        id: ns.id,
        pluginId: ns.pluginId,
        resourceTypeId: ns.resourceTypeId,
        displayName: ns.displayName,
        subtitle: String(ns.fields["phase"] ?? "Active"),
        status: ns.fields["phase"] === "Terminating" ? "degraded" : "healthy",
        fields: ns.fields,
        namespace: String(ns.fields["name"] ?? ns.displayName),
        ...(ns.externalId ? { externalId: ns.externalId } : {}),
      })),
    };
  }

  private podPeerGroup(pods: ResourceInstance[]) {
    return {
      title: `Pods (${pods.length})`,
      resourceTypeId: "k8s-pod" as const,
      pluginId: "kubernetes" as const,
      supportsCreate: true,
      items: pods.map((pod): PeerPaneResource => ({
        id: pod.id,
        pluginId: pod.pluginId,
        resourceTypeId: pod.resourceTypeId,
        displayName: pod.displayName,
        subtitle: [
          String(pod.fields["namespace"] ?? ""),
          String(pod.fields["image"] ?? ""),
        ].filter(Boolean).join(" · "),
        status: this.mapPeerStatus(String(pod.fields["status"] ?? "")),
        fields: pod.fields,
        supportsExec: true,
        namespace: String(pod.fields["namespace"] ?? ""),
        ...(pod.externalId ? { externalId: pod.externalId } : {}),
        ...(pod.fields["containerName"]
          ? { containerName: String(pod.fields["containerName"]) }
          : {}),
      })),
    };
  }

  private deploymentPeerGroup(deployments: ResourceInstance[]) {
    return {
      title: `Deployments (${deployments.length})`,
      resourceTypeId: "k8s-deployment" as const,
      pluginId: "kubernetes" as const,
      items: deployments.map((d): PeerPaneResource => {
        const ready = d.fields["readyReplicas"] ?? 0;
        const desired = d.fields["replicas"] ?? 0;
        return {
          id: d.id,
          pluginId: d.pluginId,
          resourceTypeId: d.resourceTypeId,
          displayName: d.displayName,
          subtitle: [
            String(d.fields["namespace"] ?? ""),
            `${ready}/${desired} ready`,
          ].filter(Boolean).join(" · "),
          status: Number(ready) === Number(desired) && Number(desired) > 0
            ? "healthy"
            : Number(ready) > 0
              ? "degraded"
              : Number(desired) === 0 ? "unknown" : "error",
          fields: d.fields,
          namespace: String(d.fields["namespace"] ?? ""),
          ...(d.externalId ? { externalId: d.externalId } : {}),
        };
      }),
    };
  }

  private statefulSetPeerGroup(items: ResourceInstance[]) {
    return {
      title: `StatefulSets (${items.length})`,
      resourceTypeId: "k8s-statefulset" as const,
      pluginId: "kubernetes" as const,
      items: items.map((s): PeerPaneResource => {
        const ready = s.fields["readyReplicas"] ?? 0;
        const desired = s.fields["replicas"] ?? 0;
        return {
          id: s.id,
          pluginId: s.pluginId,
          resourceTypeId: s.resourceTypeId,
          displayName: s.displayName,
          subtitle: [
            String(s.fields["namespace"] ?? ""),
            `${ready}/${desired} ready`,
          ].filter(Boolean).join(" · "),
          status: Number(ready) === Number(desired) && Number(desired) > 0
            ? "healthy"
            : Number(ready) > 0 ? "degraded" : "error",
          fields: s.fields,
          namespace: String(s.fields["namespace"] ?? ""),
          ...(s.externalId ? { externalId: s.externalId } : {}),
        };
      }),
    };
  }

  private daemonSetPeerGroup(items: ResourceInstance[]) {
    return {
      title: `DaemonSets (${items.length})`,
      resourceTypeId: "k8s-daemonset" as const,
      pluginId: "kubernetes" as const,
      items: items.map((d): PeerPaneResource => {
        const ready = Number(d.fields["numberReady"] ?? 0);
        const desired = Number(d.fields["desiredNumberScheduled"] ?? 0);
        return {
          id: d.id,
          pluginId: d.pluginId,
          resourceTypeId: d.resourceTypeId,
          displayName: d.displayName,
          subtitle: [
            String(d.fields["namespace"] ?? ""),
            `${ready}/${desired} scheduled`,
          ].filter(Boolean).join(" · "),
          status: ready === desired && desired > 0 ? "healthy" : ready > 0 ? "degraded" : "error",
          fields: d.fields,
          namespace: String(d.fields["namespace"] ?? ""),
          ...(d.externalId ? { externalId: d.externalId } : {}),
        };
      }),
    };
  }

  private servicePeerGroup(items: ResourceInstance[]) {
    return {
      title: `Services (${items.length})`,
      resourceTypeId: "k8s-service" as const,
      pluginId: "kubernetes" as const,
      items: items.map((s): PeerPaneResource => ({
        id: s.id,
        pluginId: s.pluginId,
        resourceTypeId: s.resourceTypeId,
        displayName: s.displayName,
        subtitle: [
          String(s.fields["namespace"] ?? ""),
          String(s.fields["type"] ?? ""),
          String(s.fields["ports"] ?? ""),
        ].filter(Boolean).join(" · "),
        status: "healthy",
        fields: s.fields,
        namespace: String(s.fields["namespace"] ?? ""),
        ...(s.externalId ? { externalId: s.externalId } : {}),
      })),
    };
  }

  private ingressPeerGroup(items: ResourceInstance[]) {
    return {
      title: `Ingresses (${items.length})`,
      resourceTypeId: "k8s-ingress" as const,
      pluginId: "kubernetes" as const,
      items: items.map((i): PeerPaneResource => ({
        id: i.id,
        pluginId: i.pluginId,
        resourceTypeId: i.resourceTypeId,
        displayName: i.displayName,
        subtitle: [
          String(i.fields["namespace"] ?? ""),
          String(i.fields["hosts"] ?? ""),
        ].filter(Boolean).join(" · "),
        status: "healthy",
        fields: i.fields,
        namespace: String(i.fields["namespace"] ?? ""),
        ...(i.externalId ? { externalId: i.externalId } : {}),
      })),
    };
  }

  private jobPeerGroup(items: ResourceInstance[]) {
    return {
      title: `Jobs (${items.length})`,
      resourceTypeId: "k8s-job" as const,
      pluginId: "kubernetes" as const,
      items: items.map((j): PeerPaneResource => ({
        id: j.id,
        pluginId: j.pluginId,
        resourceTypeId: j.resourceTypeId,
        displayName: j.displayName,
        subtitle: [
          String(j.fields["namespace"] ?? ""),
          String(j.fields["completions"] ?? ""),
        ].filter(Boolean).join(" · "),
        status: this.mapJobStatus(String(j.fields["status"] ?? "")),
        fields: j.fields,
        namespace: String(j.fields["namespace"] ?? ""),
        ...(j.externalId ? { externalId: j.externalId } : {}),
      })),
    };
  }

  private cronJobPeerGroup(items: ResourceInstance[]) {
    return {
      title: `CronJobs (${items.length})`,
      resourceTypeId: "k8s-cronjob" as const,
      pluginId: "kubernetes" as const,
      items: items.map((c): PeerPaneResource => ({
        id: c.id,
        pluginId: c.pluginId,
        resourceTypeId: c.resourceTypeId,
        displayName: c.displayName,
        subtitle: [
          String(c.fields["namespace"] ?? ""),
          String(c.fields["schedule"] ?? ""),
        ].filter(Boolean).join(" · "),
        status: c.fields["suspended"] === "true" ? "degraded" : "healthy",
        fields: c.fields,
        namespace: String(c.fields["namespace"] ?? ""),
        ...(c.externalId ? { externalId: c.externalId } : {}),
      })),
    };
  }

  // ── Create ──────────────────────────────────────────────────────────────

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "k8s-pod") {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "namespace", label: "Namespace", kind: "text", required: true, defaultValue: "default" },
          { key: "image", label: "Image", kind: "text", required: true },
        ],
      };
    }
    if (typeId === "k8s-configmap") {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "namespace", label: "Namespace", kind: "text", required: true, defaultValue: "default" },
        ],
      };
    }
    throw new Error(`No create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const now = new Date().toISOString();
    const namespace = fields["namespace"] || "default";
    const name = fields["name"] || "unnamed";

    if (typeId === "k8s-pod") {
      const image = fields["image"] || "busybox";
      await this.k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "infrawrench" } },
          spec: { containers: [{ name, image }] },
        }),
      });
      return {
        id: `${accountId}:k8s-pod:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-pod",
        accountId,
        displayName: name,
        fields: { name, namespace, image, status: "Pending", containerName: name },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "k8s-configmap") {
      await this.k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps`, {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "infrawrench" } },
          data: {},
        }),
      });
      return {
        id: `${accountId}:k8s-configmap:${namespace}:${name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-configmap",
        accountId,
        displayName: name,
        fields: { name, namespace, dataCount: 0, keys: "" },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    throw new Error(`Kubernetes plugin: createResource not supported for type "${typeId}"`);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "unknown" },
    };
  }

  // ── Real K8s API list methods ───────────────────────────────────────────

  private async listClusters(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    let name = "cluster";
    try {
      const ver = await this.k8sFetch<{ gitVersion: string }>("/version");
      name = `cluster (${ver.gitVersion})`;
    } catch { /* use default name */ }
    return [
      {
        id: `${accountId}:k8s-cluster:default`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-cluster",
        accountId,
        displayName: name,
        fields: { name },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private async listNamespaces(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sNamespace>>("/api/v1/namespaces");
      return data.items.map((ns) => ({
        id: `${accountId}:k8s-namespace:${ns.metadata.name}`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-namespace",
        accountId,
        displayName: ns.metadata.name,
        fields: {
          name: ns.metadata.name,
          phase: ns.status.phase,
          system: SYSTEM_NAMESPACES.has(ns.metadata.name) ? "true" : "false",
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-cluster:default`,
        createdAt: ns.metadata.creationTimestamp,
        updatedAt: now,
      }));
    } catch {
      return [];
    }
  }

  private async listPods(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sPod>>("/api/v1/pods");
      return data.items
        .filter((pod) => !SYSTEM_NAMESPACES.has(pod.metadata.namespace ?? ""))
        .map((pod) => {
          const container = pod.spec.containers[0];
          const restarts = pod.status.containerStatuses?.[0]?.restartCount ?? 0;
          return {
            id: `${accountId}:k8s-pod:${pod.metadata.namespace}:${pod.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-pod",
            accountId,
            displayName: pod.metadata.name,
            fields: {
              name: pod.metadata.name,
              namespace: pod.metadata.namespace ?? "default",
              image: container?.image ?? "",
              status: pod.status.phase,
              containerName: container?.name ?? pod.metadata.name,
              restarts,
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${pod.metadata.namespace ?? "default"}`,
            createdAt: pod.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listDeployments(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sDeployment>>("/apis/apps/v1/deployments");
      return data.items
        .filter((d) => !SYSTEM_NAMESPACES.has(d.metadata.namespace ?? ""))
        .map((d) => {
          const container = d.spec.template.spec.containers[0];
          return {
            id: `${accountId}:k8s-deployment:${d.metadata.namespace}:${d.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-deployment",
            accountId,
            displayName: d.metadata.name,
            fields: {
              name: d.metadata.name,
              namespace: d.metadata.namespace ?? "default",
              replicas: d.spec.replicas ?? 0,
              readyReplicas: d.status.readyReplicas ?? 0,
              image: container?.image ?? "",
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${d.metadata.namespace ?? "default"}`,
            createdAt: d.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listServices(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sService>>("/api/v1/services");
      return data.items
        .filter((s) => !SYSTEM_NAMESPACES.has(s.metadata.namespace ?? ""))
        .map((s) => {
          const ports = (s.spec.ports ?? [])
            .map((p) => `${p.port}/${p.protocol}`)
            .join(", ");
          return {
            id: `${accountId}:k8s-service:${s.metadata.namespace}:${s.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-service",
            accountId,
            displayName: s.metadata.name,
            fields: {
              name: s.metadata.name,
              namespace: s.metadata.namespace ?? "default",
              type: s.spec.type,
              clusterIP: s.spec.clusterIP ?? "",
              ports,
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${s.metadata.namespace ?? "default"}`,
            createdAt: s.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listStatefulSets(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sStatefulSet>>("/apis/apps/v1/statefulsets");
      return data.items
        .filter((s) => !SYSTEM_NAMESPACES.has(s.metadata.namespace ?? ""))
        .map((s) => {
          const container = s.spec.template.spec.containers[0];
          return {
            id: `${accountId}:k8s-statefulset:${s.metadata.namespace}:${s.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-statefulset",
            accountId,
            displayName: s.metadata.name,
            fields: {
              name: s.metadata.name,
              namespace: s.metadata.namespace ?? "default",
              replicas: s.spec.replicas ?? 0,
              readyReplicas: s.status.readyReplicas ?? 0,
              image: container?.image ?? "",
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${s.metadata.namespace ?? "default"}`,
            createdAt: s.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listDaemonSets(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sDaemonSet>>("/apis/apps/v1/daemonsets");
      return data.items
        .filter((d) => !SYSTEM_NAMESPACES.has(d.metadata.namespace ?? ""))
        .map((d) => {
          const container = d.spec.template.spec.containers[0];
          return {
            id: `${accountId}:k8s-daemonset:${d.metadata.namespace}:${d.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-daemonset",
            accountId,
            displayName: d.metadata.name,
            fields: {
              name: d.metadata.name,
              namespace: d.metadata.namespace ?? "default",
              desiredNumberScheduled: d.status.desiredNumberScheduled,
              numberReady: d.status.numberReady,
              image: container?.image ?? "",
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${d.metadata.namespace ?? "default"}`,
            createdAt: d.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listJobs(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sJob>>("/apis/batch/v1/jobs");
      return data.items
        .filter((j) => !SYSTEM_NAMESPACES.has(j.metadata.namespace ?? ""))
        .map((j) => {
          const container = j.spec.template.spec.containers[0];
          const succeeded = j.status.succeeded ?? 0;
          const failed = j.status.failed ?? 0;
          const active = j.status.active ?? 0;
          const completions = j.spec.completions ?? 1;
          let status: string;
          if (succeeded >= completions) status = "Complete";
          else if (failed > 0) status = "Failed";
          else if (active > 0) status = "Running";
          else status = "Pending";
          return {
            id: `${accountId}:k8s-job:${j.metadata.namespace}:${j.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-job",
            accountId,
            displayName: j.metadata.name,
            fields: {
              name: j.metadata.name,
              namespace: j.metadata.namespace ?? "default",
              completions: `${succeeded}/${completions}`,
              status,
              image: container?.image ?? "",
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${j.metadata.namespace ?? "default"}`,
            createdAt: j.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listCronJobs(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sCronJob>>("/apis/batch/v1/cronjobs");
      return data.items
        .filter((c) => !SYSTEM_NAMESPACES.has(c.metadata.namespace ?? ""))
        .map((c) => ({
          id: `${accountId}:k8s-cronjob:${c.metadata.namespace}:${c.metadata.name}`,
          pluginId: "kubernetes",
          resourceTypeId: "k8s-cronjob",
          accountId,
          displayName: c.metadata.name,
          fields: {
            name: c.metadata.name,
            namespace: c.metadata.namespace ?? "default",
            schedule: c.spec.schedule,
            suspended: String(c.spec.suspend ?? false),
            lastSchedule: c.status.lastScheduleTime ?? "",
          },
          resolvedOutputs: {},
          secretStates: [],
          parentResourceId: `${accountId}:k8s-namespace:${c.metadata.namespace ?? "default"}`,
          createdAt: c.metadata.creationTimestamp,
          updatedAt: now,
        }));
    } catch {
      return [];
    }
  }

  private async listIngresses(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sIngress>>("/apis/networking.k8s.io/v1/ingresses");
      return data.items
        .filter((i) => !SYSTEM_NAMESPACES.has(i.metadata.namespace ?? ""))
        .map((i) => {
          const hosts = (i.spec.rules ?? [])
            .map((r) => r.host ?? "*")
            .join(", ");
          const lbIngress = i.status?.loadBalancer?.ingress ?? [];
          const address = lbIngress.map((lb) => lb.ip ?? lb.hostname ?? "").filter(Boolean).join(", ");
          return {
            id: `${accountId}:k8s-ingress:${i.metadata.namespace}:${i.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-ingress",
            accountId,
            displayName: i.metadata.name,
            fields: {
              name: i.metadata.name,
              namespace: i.metadata.namespace ?? "default",
              ingressClassName: i.spec.ingressClassName ?? "",
              hosts,
              address,
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${i.metadata.namespace ?? "default"}`,
            createdAt: i.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listConfigMaps(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sConfigMap>>("/api/v1/configmaps");
      return data.items
        .filter((cm) => !SYSTEM_NAMESPACES.has(cm.metadata.namespace ?? ""))
        .map((cm) => {
          const keys = Object.keys(cm.data ?? {});
          return {
            id: `${accountId}:k8s-configmap:${cm.metadata.namespace}:${cm.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-configmap",
            accountId,
            displayName: cm.metadata.name,
            fields: {
              name: cm.metadata.name,
              namespace: cm.metadata.namespace ?? "default",
              keys: keys.join(", "),
              dataCount: keys.length,
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${cm.metadata.namespace ?? "default"}`,
            createdAt: cm.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  private async listSecrets(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    try {
      const data = await this.k8sFetch<K8sList<K8sSecret>>("/api/v1/secrets");
      return data.items
        .filter((s) => !SYSTEM_NAMESPACES.has(s.metadata.namespace ?? ""))
        // Filter out service account tokens and other auto-generated secrets
        .filter((s) => s.type !== "kubernetes.io/service-account-token")
        .map((s) => {
          const keys = Object.keys(s.data ?? {});
          return {
            id: `${accountId}:k8s-secret:${s.metadata.namespace}:${s.metadata.name}`,
            pluginId: "kubernetes",
            resourceTypeId: "k8s-secret",
            accountId,
            displayName: s.metadata.name,
            fields: {
              name: s.metadata.name,
              namespace: s.metadata.namespace ?? "default",
              type: s.type ?? "Opaque",
              keys: keys.join(", "),
              dataCount: keys.length,
            },
            resolvedOutputs: {},
            secretStates: [],
            parentResourceId: `${accountId}:k8s-namespace:${s.metadata.namespace ?? "default"}`,
            createdAt: s.metadata.creationTimestamp,
            updatedAt: now,
          };
        });
    } catch {
      return [];
    }
  }

  // ── Status mapping ──────────────────────────────────────────────────────

  private mapPeerStatus(
    status: string,
  ): "healthy" | "degraded" | "error" | "unknown" | "provisioning" {
    switch (status.toLowerCase()) {
      case "running":
      case "ready":
      case "active":
      case "succeeded":
        return "healthy";
      case "pending":
      case "creating":
      case "containercreating":
        return "provisioning";
      case "crashloopbackoff":
      case "terminating":
      case "evicted":
        return "degraded";
      case "failed":
      case "error":
      case "imagepullbackoff":
      case "errimagepull":
      case "oomkilled":
        return "error";
      default:
        return "unknown";
    }
  }

  private mapJobStatus(
    status: string,
  ): "healthy" | "degraded" | "error" | "unknown" | "provisioning" {
    switch (status.toLowerCase()) {
      case "complete":
      case "succeeded":
        return "healthy";
      case "running":
      case "active":
        return "provisioning";
      case "failed":
        return "error";
      default:
        return "unknown";
    }
  }
}
