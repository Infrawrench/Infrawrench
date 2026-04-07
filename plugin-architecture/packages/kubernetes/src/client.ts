import type {
  DetailViewSchema,
  PeerPaneContext,
  PeerPaneSchema,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";

// ── Kubeconfig parsing ──────────────────────────────────────────────────────

interface ParsedKubeconfig {
  server: string;
  caCertData?: string;
  token?: string;
  clientCertData?: string;
  clientKeyData?: string;
}

/**
 * Minimal kubeconfig YAML parser — handles the standard fields without
 * pulling in a full YAML library. Works for DOKS/GKE/EKS token-based configs.
 */
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

/**
 * Kubernetes plugin client.
 * The kubeconfig string is resolved by the host's SecretResolver before
 * being passed in credentials — the plugin never sees unresolved references.
 */
export class KubernetesClient implements PluginClient {
  private readonly kubeconfig: string;
  private readonly parsed: ParsedKubeconfig;

  constructor(credentials: Record<string, string>) {
    const kubeconfig = credentials["kubeconfig"];
    if (!kubeconfig) throw new Error("Kubernetes plugin: missing kubeconfig credential");
    this.kubeconfig = kubeconfig;
    this.parsed = parseKubeconfig(kubeconfig);
  }

  private async k8sFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const { server, token } = this.parsed;
    if (!server) throw new Error("Kubernetes plugin: no server in kubeconfig");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${server}${path}`, { headers, ...options });
    if (!res.ok) throw new Error(`K8s API error ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    // In a full implementation this would use @kubernetes/client-node
    // with the kubeconfig parsed into a KubeConfig object.
    switch (typeId) {
      case "k8s-cluster":
        return this.listClusters(accountId);
      case "k8s-namespace":
        return this.listNamespaces(accountId);
      case "k8s-pod":
        return this.listPods(accountId);
      case "k8s-deployment":
        return this.listDeployments(accountId);
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
      // Would call the /version API endpoint
      return "1.30.0";
    }
    throw new Error(
      `Kubernetes plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
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

  async listNamespacesForImport(_accountId: string): Promise<string[]> {
    try {
      const data = await this.k8sFetch<{ items: Array<{ metadata: { name: string } }> }>(
        "/api/v1/namespaces",
      );
      return data.items.map((ns) => ns.metadata.name).sort();
    } catch {
      // Fallback for stub/offline mode
      return ["default", "kube-system"];
    }
  }

  async importSecret(
    _accountId: string,
    config: { namespace: string; secretName: string; data: Record<string, string> },
  ): Promise<void> {
    // Base64-encode each value as required by the K8s Secret API
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
          labels: {
            "app.kubernetes.io/managed-by": "infrawrench",
          },
        },
        type: "Opaque",
        data: encoded,
      }),
    });
  }

  async renderPeerPane(_context: PeerPaneContext): Promise<PeerPaneSchema> {
    const syntheticAccountId = "peer";
    const [namespaces, pods, deployments] = await Promise.all([
      this.listNamespaces(syntheticAccountId),
      this.listPods(syntheticAccountId),
      this.listDeployments(syntheticAccountId),
    ]);

    return {
      status: { kind: "status-dot", status: "healthy" },
      supportsK9s: true,
      supportsSecretImport: true,
      resourceGroups: [
        {
          title: `Namespaces (${namespaces.length})`,
          resourceTypeId: "k8s-namespace",
          pluginId: "kubernetes",
          items: namespaces.map((ns) => ({
            id: ns.id,
            pluginId: ns.pluginId,
            resourceTypeId: ns.resourceTypeId,
            displayName: ns.displayName,
            subtitle: "Active",
            fields: ns.fields,
            namespace: String(ns.fields["name"] ?? ns.displayName),
            ...(ns.externalId ? { externalId: ns.externalId } : {}),
          })),
        },
        {
          title: `Pods (${pods.length})`,
          resourceTypeId: "k8s-pod",
          pluginId: "kubernetes",
          supportsCreate: true,
          items: pods.map((pod) => ({
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
        },
        {
          title: `Deployments (${deployments.length})`,
          resourceTypeId: "k8s-deployment",
          pluginId: "kubernetes",
          items: deployments.map((deployment) => ({
            id: deployment.id,
            pluginId: deployment.pluginId,
            resourceTypeId: deployment.resourceTypeId,
            displayName: deployment.displayName,
            subtitle: [
              String(deployment.fields["namespace"] ?? ""),
              deployment.fields["replicas"] != null
                ? `${String(deployment.fields["replicas"])} replicas`
                : "",
            ].filter(Boolean).join(" · "),
            fields: deployment.fields,
            namespace: String(deployment.fields["namespace"] ?? ""),
            ...(deployment.externalId ? { externalId: deployment.externalId } : {}),
          })),
        },
      ],
    };
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "k8s-pod") throw new Error(`No create config for type "${typeId}"`);
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        { key: "namespace", label: "Namespace", kind: "text", required: true, defaultValue: "default" },
        { key: "image", label: "Image", kind: "text", required: true },
      ],
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "k8s-pod") {
      throw new Error(`Kubernetes plugin: createResource not supported for type "${typeId}"`);
    }

    const now = new Date().toISOString();
    const namespace = fields["namespace"] || "default";
    const name = fields["name"] || "new-pod";
    const image = fields["image"] || "busybox";

    return {
      id: `${accountId}:k8s-pod:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-pod",
      accountId,
      displayName: name,
      fields: {
        name,
        namespace,
        image,
        status: "Pending",
        containerName: name,
      },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "unknown" },
    };
  }

  private async listClusters(accountId: string): Promise<ResourceInstance[]> {
    // The kubeconfig itself describes the cluster — return a synthetic instance
    const now = new Date().toISOString();
    return [
      {
        id: `${accountId}:k8s-cluster:default`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-cluster",
        accountId,
        displayName: "cluster",
        fields: { name: "cluster" },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private async listNamespaces(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    // Stub — real impl calls CoreV1Api.listNamespace()
    return ["default", "kube-system"].map((name) => ({
      id: `${accountId}:k8s-namespace:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-namespace",
      accountId,
      displayName: name,
      fields: { name },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-cluster:default`,
      createdAt: now,
      updatedAt: now,
    }));
  }

  private async listPods(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    return [
      {
        id: `${accountId}:k8s-pod:default:api-7d4d6f9c7f-abc12`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-pod",
        accountId,
        displayName: "api-7d4d6f9c7f-abc12",
        fields: {
          name: "api-7d4d6f9c7f-abc12",
          namespace: "default",
          image: "ghcr.io/infrawrench/api:latest",
          status: "Running",
          containerName: "api",
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:default`,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `${accountId}:k8s-pod:kube-system:coredns-5dd5756b68-xyz89`,
        pluginId: "kubernetes",
        resourceTypeId: "k8s-pod",
        accountId,
        displayName: "coredns-5dd5756b68-xyz89",
        fields: {
          name: "coredns-5dd5756b68-xyz89",
          namespace: "kube-system",
          image: "registry.k8s.io/coredns/coredns:v1.11.1",
          status: "Pending",
          containerName: "coredns",
        },
        resolvedOutputs: {},
        secretStates: [],
        parentResourceId: `${accountId}:k8s-namespace:kube-system`,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private async listDeployments(accountId: string): Promise<ResourceInstance[]> {
    return [];
  }

  private mapPeerStatus(
    status: string,
  ): "healthy" | "degraded" | "error" | "unknown" | "provisioning" {
    switch (status.toLowerCase()) {
      case "running":
      case "ready":
      case "active":
        return "healthy";
      case "pending":
      case "creating":
      case "containercreating":
        return "provisioning";
      case "crashloopbackoff":
      case "terminating":
        return "degraded";
      case "failed":
      case "error":
        return "error";
      default:
        return "unknown";
    }
  }
}
