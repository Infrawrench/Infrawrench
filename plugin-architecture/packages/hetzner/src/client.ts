import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  SizeOption,
  ImageOption,
  ResourceStatus,
  ResourceTypeDefinition,
  DashboardStat,
} from "@infrawrench/plugin-base";
import { labeledFieldItems, resourceTypeDisplayName } from "@infrawrench/plugin-base";

/**
 * Hetzner Cloud plugin client.
 * Created per account (per API token) by the host.
 */
export class HetznerClient implements PluginClient {
  private readonly token: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly baseUrl = "https://api.hetzner.cloud/v1";

  private static readonly LOCATION_INFO: Record<string, { location: string; flag: string }> = {
    fsn1: { location: "Falkenstein, Germany", flag: "🇩🇪" },
    nbg1: { location: "Nuremberg, Germany", flag: "🇩🇪" },
    hel1: { location: "Helsinki, Finland", flag: "🇫🇮" },
    ash: { location: "Ashburn, USA", flag: "🇺🇸" },
    hil: { location: "Hillsboro, USA", flag: "🇺🇸" },
    sin: { location: "Singapore", flag: "🇸🇬" },
  };

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Hetzner plugin: missing apiToken credential");
    this.token = token;
    this.resourceTypes = resourceTypes;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Hetzner API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  private async fetchAll<T>(path: string, rootKey: string): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    const perPage = 50;

    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      const data = await this.fetch<Record<string, unknown>>(
        `${path}${separator}page=${page}&per_page=${perPage}`,
      );
      const batch = data[rootKey] as T[] | undefined;
      if (!batch || batch.length === 0) break;
      items.push(...batch);
      const meta = data["meta"] as { pagination?: { total_entries?: number } } | undefined;
      if (meta?.pagination?.total_entries != null && items.length >= meta.pagination.total_entries)
        break;
      if (batch.length < perPage) break;
      page++;
    }

    return items;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "server":
        return this.listServers(accountId);
      case "volume":
        return this.listVolumes(accountId);
      case "floating-ip":
        return this.listFloatingIps(accountId);
      case "firewall":
        return this.listFirewalls(accountId);
      default:
        throw new Error(`Hetzner plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    // For servers, do a direct API call for fresh data
    if (typeId === "server") {
      const externalId = resourceId.split(":").pop();
      if (!externalId) throw new Error("Cannot parse server ID");
      const data = await this.fetch<{ server: HetznerServer }>(`/servers/${externalId}`);
      return this.mapServer(data.server, accountId);
    }

    // For other types, fall back to listing
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Hetzner plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "server") {
      const externalId = resourceId.split(":").pop();
      if (!externalId) throw new Error("Cannot parse server ID");
      const data = await this.fetch<{ server: HetznerServer }>(`/servers/${externalId}`);
      const s = data.server;
      switch (outputKey) {
        case "ipv4":
          return s.public_net?.ipv4?.ip ?? "";
        case "ipv6":
          return s.public_net?.ipv6?.ip ?? "";
        case "ipv4Private":
          return s.private_net?.[0]?.ip ?? "";
        default:
          throw new Error(`Hetzner plugin: unknown output "${outputKey}" for server`);
      }
    }

    if (typeId === "floating-ip") {
      const externalId = resourceId.split(":").pop();
      if (!externalId) throw new Error("Cannot parse floating IP ID");
      const data = await this.fetch<{ floating_ip: HetznerFloatingIp }>(
        `/floating_ips/${externalId}`,
      );
      if (outputKey === "ip") return data.floating_ip.ip;
      throw new Error(`Hetzner plugin: unknown output "${outputKey}" for floating-ip`);
    }

    throw new Error(`Hetzner plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "server") {
      const [locationsData, serverTypesData, imagesData] = await Promise.all([
        this.fetchAll<HetznerLocation>("/locations", "locations"),
        this.fetchAll<HetznerServerType>("/server_types", "server_types"),
        this.fetchAll<HetznerImage>("/images?type=system&status=available", "images"),
      ]);

      const regions = locationsData.map((loc) => {
        const info = HetznerClient.LOCATION_INFO[loc.name];
        return {
          id: loc.name,
          label: loc.city,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });

      // Group server types by architecture/category
      const sizesByCategory = new Map<string, SizeOption[]>();
      for (const st of serverTypesData) {
        if (st.deprecated) continue;
        const category = categorizeServerType(st.name);
        if (!sizesByCategory.has(category)) sizesByCategory.set(category, []);
        // Use the first price entry for monthly pricing
        const price = st.prices?.[0];
        const priceMonthly = price?.price_monthly?.gross
          ? parseFloat(price.price_monthly.gross)
          : undefined;
        sizesByCategory.get(category)!.push({
          id: st.name,
          label: st.name,
          vcpus: st.cores,
          memoryMb: st.memory * 1024,
          diskGb: st.disk,
          category,
          ...(priceMonthly != null ? { priceMonthly } : {}),
        });
      }
      const sizes = [...sizesByCategory.values()].flat();

      // Build image list grouped by OS
      const imageMap = new Map<string, ImageOption[]>();
      for (const img of imagesData) {
        if (img.status !== "available") continue;
        const cat = img.os_flavor || img.os_version || "Other";
        if (!imageMap.has(cat)) imageMap.set(cat, []);
        imageMap.get(cat)!.push({
          id: img.name ?? String(img.id),
          label: img.description || img.name || String(img.id),
          category: cat,
        });
      }
      const images = [...imageMap.values()].flat();
      const defaultImage = images.find((i) => i.category === "ubuntu")?.id ?? images[0]?.id;

      const firstRegion = regions[0]?.id;
      const firstSize = sizes[0]?.id;

      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "location",
            label: "Location",
            kind: "region-picker",
            required: true,
            regions,
            ...(firstRegion ? { defaultValue: firstRegion } : {}),
          },
          {
            key: "serverType",
            label: "Server Type",
            kind: "size-picker",
            required: true,
            sizes,
            ...(firstSize ? { defaultValue: firstSize } : {}),
          },
          {
            key: "image",
            label: "Image",
            kind: "image-picker",
            required: true,
            images,
            ...(defaultImage ? { defaultValue: defaultImage } : {}),
          },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
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
    if (typeId === "server") {
      // Upload SSH key to Hetzner account if provided
      const sshKeyIds: number[] = [];
      const sshPub = fields["sshPublicKey"];
      if (sshPub) {
        try {
          const comment = sshPub.trim().split(" ")[2] ?? "infrawrench";
          type KeyResponse = { ssh_key: { id: number } };
          const keyData = await this.fetch<KeyResponse>("/ssh_keys", {
            method: "POST",
            body: JSON.stringify({ name: comment, public_key: sshPub.trim() }),
          }).catch(async (e: unknown) => {
            // If key already exists (uniqueness_error), find it
            if (String(e).includes("uniqueness_error") || String(e).includes("409")) {
              const existing = await this.fetchAll<{ id: number; public_key: string }>(
                "/ssh_keys",
                "ssh_keys",
              );
              const match = existing.find((k) => k.public_key.trim() === sshPub.trim());
              if (match) return { ssh_key: { id: match.id } } as KeyResponse;
            }
            throw e;
          });
          if (keyData.ssh_key.id) sshKeyIds.push(keyData.ssh_key.id);
        } catch {
          /* skip SSH key if upload fails */
        }
      }

      const body: Record<string, unknown> = {
        name: fields["name"],
        server_type: fields["serverType"],
        image: fields["image"],
        location: fields["location"],
        ...(sshKeyIds.length > 0 ? { ssh_keys: sshKeyIds } : {}),
      };

      const data = await this.fetch<{ server: HetznerServer }>("/servers", {
        method: "POST",
        body: JSON.stringify(body),
      });

      return this.mapServer(data.server, accountId);
    }

    throw new Error(`Hetzner plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId !== "server") {
      throw new Error(`Hetzner plugin: deleteResource not supported for type "${typeId}"`);
    }
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error("Cannot parse server ID");
    await this.fetch<unknown>(`/servers/${externalId}`, { method: "DELETE" });
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    if (resourceTypeId === "server") {
      const statusVariant =
        f["status"] === "running"
          ? ("status-healthy" as const)
          : f["status"] === "off"
            ? ("status-error" as const)
            : ("status-degraded" as const);
      return [
        { label: "Status", value: String(f["status"] ?? "unknown"), variant: statusVariant },
        { label: "Type", value: String(f["serverType"] ?? "") },
        { label: "Location", value: String(f["location"] ?? "") },
        ...(resource.resolvedOutputs["ipv4"]
          ? [{ label: "IPv4", value: resource.resolvedOutputs["ipv4"] }]
          : []),
      ];
    }

    if (resourceTypeId === "volume") {
      return [
        { label: "Size", value: `${String(f["sizeGb"])} GB` },
        { label: "Location", value: String(f["location"] ?? "") },
      ];
    }

    if (resourceTypeId === "floating-ip") {
      return [
        { label: "IP", value: String(f["ip"] ?? "") },
        { label: "Type", value: String(f["type"] ?? "") },
        { label: "Location", value: String(f["location"] ?? "") },
      ];
    }

    if (resourceTypeId === "firewall") {
      return [
        { label: "Rules", value: String(f["rulesCount"] ?? 0) },
        { label: "Applied To", value: String(f["appliedToCount"] ?? 0) },
      ];
    }

    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status =
      resource.resourceTypeId === "server"
        ? serverStatusToDot(String(fields["status"] ?? "unknown"))
        : ("unknown" as const);

    return {
      title: resource.displayName,
      subtitle: `${resourceTypeDisplayName(this.resourceTypes, resource.resourceTypeId)} · ${String(fields["location"] ?? "")}`,
      status: { kind: "status-dot", status },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: labeledFieldItems(fields, this.resourceTypes, resource.resourceTypeId),
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const status =
      resource.resourceTypeId === "server"
        ? serverStatusToDot(String(resource.fields["status"] ?? "unknown"))
        : ("unknown" as const);

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  private async listServers(accountId: string): Promise<ResourceInstance[]> {
    const servers = await this.fetchAll<HetznerServer>("/servers", "servers");
    return servers.map((s) => this.mapServer(s, accountId));
  }

  private mapServer(s: HetznerServer, accountId: string): ResourceInstance {
    const publicIpv4 = s.public_net?.ipv4?.ip ?? "";
    const publicIpv6 = s.public_net?.ipv6?.ip ?? "";
    const privateIp = s.private_net?.[0]?.ip ?? "";

    return {
      id: `${accountId}:server:${s.id}`,
      pluginId: "hetzner",
      resourceTypeId: "server",
      accountId,
      displayName: s.name,
      fields: {
        name: s.name,
        status: s.status,
        serverType: s.server_type?.name ?? "",
        location: s.datacenter?.location?.name ?? "",
        image: s.image?.name ?? s.image?.description ?? "",
        datacenter: s.datacenter?.name ?? "",
      },
      resolvedOutputs: {
        ipv4: publicIpv4,
        ipv6: publicIpv6,
        ipv4Private: privateIp,
      },
      secretStates: [],
      externalId: String(s.id),
      createdAt: s.created ?? new Date().toISOString(),
      updatedAt: s.created ?? new Date().toISOString(),
    };
  }

  private async listVolumes(accountId: string): Promise<ResourceInstance[]> {
    const volumes = await this.fetchAll<HetznerVolume>("/volumes", "volumes");
    return volumes.map((v) => ({
      id: `${accountId}:volume:${v.id}`,
      pluginId: "hetzner",
      resourceTypeId: "volume",
      accountId,
      displayName: v.name,
      fields: {
        name: v.name,
        sizeGb: v.size,
        location: v.location?.name ?? "",
        format: v.format ?? "",
        serverId: v.server != null ? String(v.server) : "",
        linuxDevice: v.linux_device ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(v.id),
      createdAt: v.created ?? new Date().toISOString(),
      updatedAt: v.created ?? new Date().toISOString(),
    }));
  }

  private async listFloatingIps(accountId: string): Promise<ResourceInstance[]> {
    const ips = await this.fetchAll<HetznerFloatingIp>("/floating_ips", "floating_ips");
    return ips.map((fip) => ({
      id: `${accountId}:floating-ip:${fip.id}`,
      pluginId: "hetzner",
      resourceTypeId: "floating-ip",
      accountId,
      displayName: fip.name || fip.ip,
      fields: {
        name: fip.name || "",
        ip: fip.ip,
        type: fip.type,
        location: fip.home_location?.name ?? "",
        serverId: fip.server != null ? String(fip.server) : "",
        blocked: fip.blocked ?? false,
      },
      resolvedOutputs: { ip: fip.ip },
      secretStates: [],
      externalId: String(fip.id),
      createdAt: fip.created ?? new Date().toISOString(),
      updatedAt: fip.created ?? new Date().toISOString(),
    }));
  }

  private async listFirewalls(accountId: string): Promise<ResourceInstance[]> {
    const firewalls = await this.fetchAll<HetznerFirewall>("/firewalls", "firewalls");
    return firewalls.map((fw) => ({
      id: `${accountId}:firewall:${fw.id}`,
      pluginId: "hetzner",
      resourceTypeId: "firewall",
      accountId,
      displayName: fw.name,
      fields: {
        name: fw.name,
        rulesCount: (fw.rules ?? []).length,
        appliedToCount: (fw.applied_to ?? []).length,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(fw.id),
      createdAt: fw.created ?? new Date().toISOString(),
      updatedAt: fw.created ?? new Date().toISOString(),
    }));
  }
}

function serverStatusToDot(status: string): ResourceStatus {
  switch (status) {
    case "running":
      return "healthy";
    case "initializing":
    case "starting":
    case "rebuilding":
      return "provisioning";
    case "stopping":
    case "migrating":
      return "degraded";
    case "off":
    case "deleting":
      return "error";
    default:
      return "unknown";
  }
}

function categorizeServerType(name: string): string {
  if (name.startsWith("cx") || name.startsWith("cpx")) return "Shared vCPU (x86)";
  if (name.startsWith("cax")) return "Shared vCPU (Arm64)";
  if (name.startsWith("ccx")) return "Dedicated vCPU (x86)";
  if (name.startsWith("cax")) return "Dedicated vCPU (Arm64)";
  return "Other";
}

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  created: string;
  public_net?: {
    ipv4?: { ip: string };
    ipv6?: { ip: string };
  };
  private_net?: Array<{ ip: string }>;
  server_type?: { name: string; cores: number; memory: number; disk: number };
  datacenter?: { name: string; location?: { name: string; city: string } };
  image?: { name: string; description: string };
}

interface HetznerVolume {
  id: number;
  name: string;
  size: number;
  created: string;
  server: number | null;
  location?: { name: string };
  format: string | null;
  linux_device: string | null;
}

interface HetznerFloatingIp {
  id: number;
  name: string;
  ip: string;
  type: string;
  created: string;
  server: number | null;
  blocked: boolean;
  home_location?: { name: string };
}

interface HetznerFirewall {
  id: number;
  name: string;
  created: string;
  rules?: unknown[];
  applied_to?: unknown[];
}

interface HetznerLocation {
  id: number;
  name: string;
  city: string;
  country: string;
  description: string;
}

interface HetznerServerType {
  id: number;
  name: string;
  cores: number;
  memory: number;
  disk: number;
  deprecated: boolean;
  prices?: Array<{
    location: string;
    price_monthly: { net: string; gross: string };
  }>;
}

interface HetznerImage {
  id: number;
  name: string | null;
  description: string;
  status: string;
  type: string;
  os_flavor: string;
  os_version: string | null;
}
