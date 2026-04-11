import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceStatus,
  DashboardStat,
} from "@infrawrench/plugin-base";

interface ContainerInfo {
  Id: string;
  Names: string[];
  Image: string;
  Status: string;
  State: string;
  Ports: Array<{ IP?: string; PrivatePort: number; PublicPort?: number; Type: string }>;
  Labels: Record<string, string>;
  Created: number;
}

interface VersionInfo {
  Version: string;
  ApiVersion: string;
  Os: string;
  Arch: string;
}

function formatPorts(ports: ContainerInfo["Ports"]): string {
  if (!ports || ports.length === 0) return "";
  return ports
    .filter((p) => p.PublicPort)
    .map((p) => `${p.PublicPort}->${p.PrivatePort}/${p.Type}`)
    .join(", ");
}

function containerStatus(state: string): ResourceStatus {
  switch (state.toLowerCase()) {
    case "running":
      return "healthy";
    case "paused":
      return "degraded";
    case "exited":
      return "error";
    case "created":
      return "provisioning";
    default:
      return "unknown";
  }
}

export class DockerClient implements PluginClient {
  private readonly dockerHost: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.dockerHost = credentials["dockerHost"] ?? "";
    this.services = services;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId !== "docker-container") {
      throw new Error(`Docker plugin: unknown resource type "${typeId}"`);
    }
    const docker = this.services?.docker;
    if (!docker) return [];

    const containers = (await docker.command("listContainers")) as ContainerInfo[];
    const now = new Date().toISOString();

    return containers.map((c) => {
      const name = (c.Names[0] ?? "").replace(/^\//, "");
      const ports = formatPorts(c.Ports);
      return {
        id: `${accountId}:docker-container:${c.Id.slice(0, 12)}`,
        pluginId: "docker",
        resourceTypeId: "docker-container",
        accountId,
        displayName: name || c.Id.slice(0, 12),
        fields: {
          name,
          image: c.Image,
          status: c.Status,
          ports,
        },
        resolvedOutputs: {
          containerId: c.Id,
          status: c.State,
        },
        secretStates: [],
        externalId: c.Id,
        createdAt: new Date(c.Created * 1000).toISOString(),
        updatedAt: now,
      };
    });
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Docker plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(_typeId: string, _resourceId: string, _outputKey: string): Promise<string> {
    throw new Error("Docker plugin: resolveOutput not supported");
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const name = String(resource.fields["name"] ?? resource.displayName);
    const image = String(resource.fields["image"] ?? "");
    const status = String(resource.fields["status"] ?? "");
    const ports = String(resource.fields["ports"] ?? "");
    const containerId = String(
      resource.resolvedOutputs["containerId"] ?? resource.externalId ?? "",
    );
    const state = String(resource.resolvedOutputs["status"] ?? "unknown");

    return {
      title: name,
      subtitle: image,
      status: { kind: "status-dot", status: containerStatus(state), label: status || state },
      sections: [
        {
          kind: "section",
          title: "Container",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "ID", value: containerId.slice(0, 12) },
                { key: "Image", value: image || "—" },
                { key: "Status", value: status || state || "—" },
                { key: "Ports", value: ports || "—" },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const state = String(resource.resolvedOutputs["status"] ?? "unknown");
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: containerStatus(state) },
    };
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId === "docker-container") {
      try {
        const resource = await this.getResource(resourceTypeId, resourceId, accountId);
        const f = resource.fields;
        const state = String(f["status"] ?? "unknown");
        const s = state.toLowerCase();
        const stats: DashboardStat[] = [
          {
            label: "Status",
            value: state,
            variant: s.includes("up")
              ? "status-healthy"
              : s.includes("exited") || s.includes("dead")
                ? "status-error"
                : "status-degraded",
          },
        ];
        if (f["image"]) stats.push({ label: "Image", value: String(f["image"]) });
        if (f["ports"]) stats.push({ label: "Ports", value: String(f["ports"]) });
        return stats;
      } catch {
        return [];
      }
    }

    const docker = this.services?.docker;
    if (!docker) return [];

    try {
      const [versionInfo, containers] = await Promise.all([
        docker.command("version") as Promise<VersionInfo>,
        docker.command("listContainers") as Promise<ContainerInfo[]>,
      ]);
      const runningCount = containers.filter((c) => c.State === "running").length;
      const result: DashboardStat[] = [{ label: "Version", value: versionInfo.Version ?? "" }];
      result.push({ label: "Running", value: String(runningCount) });
      return result;
    } catch {
      return [];
    }
  }
}
