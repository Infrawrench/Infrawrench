import type {
  DetailViewSchema,
  PeerPaneContext,
  PeerPaneSchema,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";

/**
 * Kubernetes plugin client.
 * The kubeconfig string is resolved by the host's SecretResolver before
 * being passed in credentials — the plugin never sees unresolved references.
 */
export class KubernetesClient implements PluginClient {
  constructor(credentials: Record<string, string>) {
    const kubeconfig = credentials["kubeconfig"];
    if (!kubeconfig) throw new Error("Kubernetes plugin: missing kubeconfig credential");
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
