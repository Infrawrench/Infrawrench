import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";

/**
 * Kubernetes plugin client.
 * The kubeconfig string is resolved by the host's SecretResolver before
 * being passed in credentials — the plugin never sees unresolved references.
 */
export class KubernetesClient implements PluginClient {
  private readonly kubeconfig: string;

  constructor(credentials: Record<string, string>) {
    const kubeconfig = credentials["kubeconfig"];
    if (!kubeconfig) throw new Error("Kubernetes plugin: missing kubeconfig credential");
    this.kubeconfig = kubeconfig;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    // In a full implementation this would use @kubernetes/client-node
    // with the kubeconfig parsed into a KubeConfig object.
    switch (typeId) {
      case "k8s-cluster":
        return this.listClusters(accountId);
      case "k8s-namespace":
        return this.listNamespaces(accountId);
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

  private async listDeployments(accountId: string): Promise<ResourceInstance[]> {
    return [];
  }

  // Suppress unused warning
  private get _kubeconfig() {
    return this.kubeconfig;
  }
}
