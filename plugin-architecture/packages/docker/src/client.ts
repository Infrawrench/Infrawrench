import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceStatus,
  DashboardStat,
  CreateResourceConfig,
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
      return "info";
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

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "docker-container") {
      // Fetch available images for the selector
      const docker = this.services?.docker;
      const images = docker
        ? ((await docker.command("listImages")) as Array<{
            RepoTags?: string[];
          }>)
        : [];
      const imageOptions = images
        .flatMap((img) => img.RepoTags ?? [])
        .filter((tag) => tag && tag !== "<none>:<none>")
        .map((tag) => ({ id: tag, label: tag }));
      return {
        fields: [
          { key: "name", label: "Container Name", kind: "text", required: false },
          {
            key: "image",
            label: "Image",
            kind: imageOptions.length > 0 ? "select" : "text",
            required: true,
            ...(imageOptions.length > 0 ? { options: imageOptions } : {}),
            description: "Docker image to run",
          },
          {
            key: "ports",
            label: "Port Mapping",
            kind: "text",
            required: false,
            description: "host:container (e.g. 8080:80)",
          },
          {
            key: "start",
            label: "Start Immediately",
            kind: "select",
            required: false,
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ],
            defaultValue: "true",
          },
        ],
      };
    }
    throw new Error(`Docker plugin: getCreateConfig not supported for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "docker-container") {
      const docker = this.services?.docker;
      if (!docker) throw new Error("Docker service not available");
      const image = fields["image"] ?? "";
      const name = fields["name"] || undefined;
      const portsStr = fields["ports"] ?? "";
      const start = fields["start"] !== "false";

      // Parse port mapping (host:container format)
      const exposedPorts: Record<string, object> = {};
      const portBindings: Record<string, Array<{ HostPort: string }>> = {};
      if (portsStr) {
        for (const mapping of portsStr.split(",")) {
          const [hostPort, containerPort] = mapping.trim().split(":");
          if (hostPort && containerPort) {
            exposedPorts[`${containerPort}/tcp`] = {};
            portBindings[`${containerPort}/tcp`] = [{ HostPort: hostPort }];
          }
        }
      }

      const result = (await docker.command("createContainer", {
        image,
        name,
        exposedPorts: Object.keys(exposedPorts).length > 0 ? exposedPorts : undefined,
        hostConfig:
          Object.keys(portBindings).length > 0 ? { PortBindings: portBindings } : undefined,
        start,
      })) as { Id: string; Name: string; State: { Status: string }; Created: string };

      const containerId = result.Id ?? "";
      const containerName = (result.Name ?? name ?? "").replace(/^\//, "");
      const now = new Date().toISOString();
      return {
        id: `${accountId}:docker-container:${containerId.slice(0, 12)}`,
        pluginId: "docker",
        resourceTypeId: "docker-container",
        accountId,
        displayName: containerName || containerId.slice(0, 12),
        fields: {
          name: containerName,
          image,
          status: start ? "Up" : "Created",
          ports: portsStr,
        },
        resolvedOutputs: {
          containerId,
          status: start ? "running" : "created",
        },
        secretStates: [],
        externalId: containerId,
        createdAt: result.Created ?? now,
        updatedAt: now,
      };
    }
    throw new Error(`Docker plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId !== "docker-container") {
      throw new Error(`Docker plugin: deleteResource not supported for type "${typeId}"`);
    }
    const docker = this.services?.docker;
    if (!docker) throw new Error("Docker service not available");
    const containerId = resourceId.split(":").pop();
    if (!containerId) throw new Error("Cannot parse container ID");
    await docker.command("removeContainer", { id: containerId });
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
