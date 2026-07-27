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

interface ImageInfo {
  Id: string;
  RepoTags?: string[];
  Created: number;
  Size: number;
  Containers?: number;
}

interface VolumeInfo {
  Name: string;
  Driver: string;
  Mountpoint: string;
  CreatedAt?: string;
  Labels?: Record<string, string>;
  Scope?: string;
}

interface NetworkInfo {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
  Created?: string;
  Internal?: boolean;
  Attachable?: boolean;
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
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

function resourceId(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${encodeURIComponent(externalId)}`;
}

function parseExternalId(resourceIdValue: string): string {
  const raw = resourceIdValue.split(":").pop();
  if (!raw) throw new Error("Cannot parse Docker resource ID");
  return decodeURIComponent(raw);
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

const resourceTypeIds = new Set([
  "docker-container",
  "docker-image",
  "docker-volume",
  "docker-network",
]);

export class DockerClient implements PluginClient {
  private readonly services: HostServices | undefined;

  constructor(_credentials: Record<string, string>, services?: HostServices) {
    this.services = services;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (!resourceTypeIds.has(typeId)) {
      throw new Error(`Docker plugin: unknown resource type "${typeId}"`);
    }
    const docker = this.services?.docker;
    if (!docker) return [];

    const now = new Date().toISOString();
    if (typeId === "docker-container") {
      const containers = (await docker.command("listContainers")) as ContainerInfo[];

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

    if (typeId === "docker-image") {
      const images = (await docker.command("listImages")) as ImageInfo[];
      return images.map((image) => {
        const tags = (image.RepoTags ?? []).filter((tag) => tag && tag !== "<none>:<none>");
        const displayName = tags[0] ?? image.Id.replace(/^sha256:/, "").slice(0, 12);
        return {
          id: resourceId(accountId, "docker-image", image.Id),
          pluginId: "docker",
          resourceTypeId: "docker-image",
          accountId,
          displayName,
          fields: {
            tags: tags.join(", "),
            size: formatBytes(image.Size),
            containers: image.Containers ?? 0,
          },
          resolvedOutputs: { imageId: image.Id },
          secretStates: [],
          externalId: image.Id,
          createdAt: new Date(image.Created * 1000).toISOString(),
          updatedAt: now,
        };
      });
    }

    if (typeId === "docker-volume") {
      const volumes = (await docker.command("listVolumes")) as VolumeInfo[];
      return volumes.map((volume) => ({
        id: resourceId(accountId, "docker-volume", volume.Name),
        pluginId: "docker",
        resourceTypeId: "docker-volume",
        accountId,
        displayName: volume.Name,
        fields: {
          name: volume.Name,
          driver: volume.Driver,
          mountpoint: volume.Mountpoint,
          scope: volume.Scope ?? "",
        },
        resolvedOutputs: { volumeName: volume.Name },
        secretStates: [],
        externalId: volume.Name,
        createdAt: volume.CreatedAt ?? now,
        updatedAt: now,
      }));
    }

    if (typeId === "docker-network") {
      const networks = (await docker.command("listNetworks")) as NetworkInfo[];
      return networks.map((network) => {
        const subnet = network.IPAM?.Config?.find((config) => config.Subnet)?.Subnet ?? "";
        return {
          id: resourceId(accountId, "docker-network", network.Id),
          pluginId: "docker",
          resourceTypeId: "docker-network",
          accountId,
          displayName: network.Name,
          fields: {
            name: network.Name,
            driver: network.Driver,
            scope: network.Scope,
            subnet,
            internal: network.Internal ?? false,
          },
          resolvedOutputs: { networkId: network.Id },
          secretStates: [],
          externalId: network.Id,
          createdAt: network.Created ?? now,
          updatedAt: now,
        };
      });
    }

    throw new Error(`Docker plugin: unknown resource type "${typeId}"`);
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
    if (resource.resourceTypeId === "docker-image") {
      return {
        title: resource.displayName,
        subtitle: String(resource.fields["tags"] ?? ""),
        sections: [
          {
            kind: "section",
            title: "Image",
            children: [
              {
                kind: "key-value-list",
                items: [
                  { key: "ID", value: String(resource.externalId ?? "").slice(0, 19) },
                  { key: "Tags", value: String(resource.fields["tags"] ?? "—") || "—" },
                  { key: "Size", value: String(resource.fields["size"] ?? "—") || "—" },
                  { key: "Containers", value: String(resource.fields["containers"] ?? "—") },
                ],
              },
            ],
          },
        ],
        headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      };
    }

    if (resource.resourceTypeId === "docker-volume") {
      return {
        title: resource.displayName,
        subtitle: String(resource.fields["driver"] ?? ""),
        sections: [
          {
            kind: "section",
            title: "Volume",
            children: [
              {
                kind: "key-value-list",
                items: [
                  { key: "Name", value: String(resource.fields["name"] ?? "—") || "—" },
                  { key: "Driver", value: String(resource.fields["driver"] ?? "—") || "—" },
                  {
                    key: "Mountpoint",
                    value: String(resource.fields["mountpoint"] ?? "—") || "—",
                  },
                  { key: "Scope", value: String(resource.fields["scope"] ?? "—") || "—" },
                ],
              },
            ],
          },
        ],
        headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      };
    }

    if (resource.resourceTypeId === "docker-network") {
      return {
        title: resource.displayName,
        subtitle: String(resource.fields["driver"] ?? ""),
        sections: [
          {
            kind: "section",
            title: "Network",
            children: [
              {
                kind: "key-value-list",
                items: [
                  { key: "ID", value: String(resource.externalId ?? "").slice(0, 12) },
                  { key: "Driver", value: String(resource.fields["driver"] ?? "—") || "—" },
                  { key: "Scope", value: String(resource.fields["scope"] ?? "—") || "—" },
                  { key: "Subnet", value: String(resource.fields["subnet"] ?? "—") || "—" },
                  { key: "Internal", value: String(resource.fields["internal"] ?? false) },
                ],
              },
            ],
          },
        ],
        headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      };
    }

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
    if (resource.resourceTypeId !== "docker-container") {
      return { id: resource.id, label: resource.displayName };
    }

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
    if (typeId === "docker-volume") {
      return {
        fields: [
          { key: "name", label: "Volume Name", kind: "text", required: true },
          {
            key: "driver",
            label: "Driver",
            kind: "text",
            required: false,
            defaultValue: "local",
          },
        ],
      };
    }
    if (typeId === "docker-network") {
      return {
        fields: [
          { key: "name", label: "Network Name", kind: "text", required: true },
          {
            key: "driver",
            label: "Driver",
            kind: "text",
            required: false,
            defaultValue: "bridge",
          },
          {
            key: "internal",
            label: "Internal",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
            defaultValue: "false",
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
    if (typeId === "docker-volume") {
      const docker = this.services?.docker;
      if (!docker) throw new Error("Docker service not available");
      const name = fields["name"] ?? "";
      const driver = fields["driver"] || "local";
      const result = (await docker.command("createVolume", { name, driver })) as VolumeInfo;
      const now = new Date().toISOString();
      return {
        id: resourceId(accountId, "docker-volume", result.Name),
        pluginId: "docker",
        resourceTypeId: "docker-volume",
        accountId,
        displayName: result.Name,
        fields: {
          name: result.Name,
          driver: result.Driver,
          mountpoint: result.Mountpoint,
          scope: result.Scope ?? "",
        },
        resolvedOutputs: { volumeName: result.Name },
        secretStates: [],
        externalId: result.Name,
        createdAt: result.CreatedAt ?? now,
        updatedAt: now,
      };
    }
    if (typeId === "docker-network") {
      const docker = this.services?.docker;
      if (!docker) throw new Error("Docker service not available");
      const name = fields["name"] ?? "";
      const driver = fields["driver"] || "bridge";
      const internal = fields["internal"] === "true";
      const result = (await docker.command("createNetwork", { name, driver, internal })) as {
        Id: string;
        Warning?: string;
      };
      const now = new Date().toISOString();
      return {
        id: resourceId(accountId, "docker-network", result.Id),
        pluginId: "docker",
        resourceTypeId: "docker-network",
        accountId,
        displayName: name || result.Id.slice(0, 12),
        fields: { name, driver, scope: "", subnet: "", internal },
        resolvedOutputs: { networkId: result.Id },
        secretStates: [],
        externalId: result.Id,
        createdAt: now,
        updatedAt: now,
      };
    }
    throw new Error(`Docker plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (!resourceTypeIds.has(typeId)) {
      throw new Error(`Docker plugin: deleteResource not supported for type "${typeId}"`);
    }
    const docker = this.services?.docker;
    if (!docker) throw new Error("Docker service not available");
    const id = parseExternalId(resourceId);
    if (typeId === "docker-container") {
      await docker.command("removeContainer", { id });
      return;
    }
    if (typeId === "docker-image") {
      await docker.command("removeImage", { id });
      return;
    }
    if (typeId === "docker-volume") {
      await docker.command("removeVolume", { name: id });
      return;
    }
    if (typeId === "docker-network") {
      await docker.command("removeNetwork", { id });
      return;
    }
    throw new Error(`Docker plugin: deleteResource not supported for type "${typeId}"`);
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
