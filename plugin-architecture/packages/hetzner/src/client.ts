import type {
  ActionNode,
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
  HostServices,
  MetricSeries,
  CostFetchRange,
  CostRow,
  PriceCatalogRequest,
  PriceCatalogResult,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  jsonRestFetch,
  labeledFieldItems,
  resourceTypeDisplayName,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { fetchHetznerCostData } from "./cost-data.js";
import type { HetznerApi } from "./api.js";
import {
  createRrset,
  createZone,
  deleteRrset,
  deleteZone,
  listRrsets,
  listZones,
  recordCreateConfig,
  updateRrset,
  updateZone,
  zoneCreateConfig,
} from "./dns.js";
import {
  certificateCreateConfig,
  createCertificate,
  listCertificates,
  retryCertificate,
} from "./certificates.js";
import {
  STORAGE_BOX_ACTIONS,
  createStorageBox,
  deleteStorageBox,
  invokeStorageBoxAction,
  listStorageBoxes,
  storageBoxCreateConfig,
  updateStorageBox,
} from "./storage-boxes.js";
import { createRateCardCache, type RateCardCache } from "./pricing.js";
import { fetchHetznerPriceCatalog } from "./price-catalog.js";

/**
 * Hetzner Cloud plugin client.
 * Created per account (per API token) by the host.
 */
export class HetznerClient implements PluginClient {
  private readonly token: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly baseUrl = "https://api.hetzner.cloud/v1";
  /**
   * The Hetzner API (as opposed to the Cloud API) hosts Storage Boxes. It
   * accepts the same project-scoped token.
   */
  private readonly hetznerBaseUrl = "https://api.hetzner.com/v1";

  private static readonly LOCATION_INFO: Record<string, { location: string; flag: string }> = {
    fsn1: { location: "Falkenstein, Germany", flag: "🇩🇪" },
    nbg1: { location: "Nuremberg, Germany", flag: "🇩🇪" },
    hel1: { location: "Helsinki, Finland", flag: "🇫🇮" },
    ash: { location: "Ashburn, USA", flag: "🇺🇸" },
    hil: { location: "Hillsboro, USA", flag: "🇺🇸" },
    sin: { location: "Singapore", flag: "🇸🇬" },
  };

  private readonly caCert: string;
  private readonly services: HostServices | undefined;
  /** One rate card per client, i.e. per cost-collection pass. */
  private readonly rateCardCache: RateCardCache = createRateCardCache();

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Hetzner plugin: missing apiToken credential");
    this.token = token;
    this.resourceTypes = resourceTypes;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private async fetch<T>(path: string, options?: RequestInit, baseUrl?: string): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Hetzner",
      url: `${baseUrl ?? this.baseUrl}${path}`,
      errorPath: path,
      headers: { Authorization: `Bearer ${this.token}` },
      ...(options ? { init: options } : {}),
      ...(this.caCert && this.services?.http
        ? { caCert: this.caCert, http: this.services.http }
        : {}),
    });
  }

  /** The request surface handed to the per-product modules. */
  private get api(): HetznerApi {
    return {
      fetch: (path, init) => this.fetch(path, init),
      fetchAll: (path, rootKey) => this.fetchAll(path, rootKey),
      fetchHetzner: (path, init) => this.fetch(path, init, this.hetznerBaseUrl),
      fetchAllHetzner: (path, rootKey) => this.fetchAll(path, rootKey, this.hetznerBaseUrl),
    };
  }

  private async fetchAll<T>(path: string, rootKey: string, baseUrl?: string): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    const perPage = 50;

    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      const data = await this.fetch<Record<string, unknown>>(
        `${path}${separator}page=${page}&per_page=${perPage}`,
        undefined,
        baseUrl,
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
      case "network":
        return this.listNetworks(accountId);
      case "load-balancer":
        return this.listLoadBalancers(accountId);
      case "primary-ip":
        return this.listPrimaryIps(accountId);
      case "ssh-key":
        return this.listSshKeys(accountId);
      case "image":
        return this.listImages(accountId);
      case "placement-group":
        return this.listPlacementGroups(accountId);
      case "certificate":
        return listCertificates(this.api, accountId);
      case "dns-zone":
        return listZones(this.api, accountId);
      case "dns-record":
        return listRrsets(this.api, accountId);
      case "storage-box":
        return listStorageBoxes(this.api, accountId);
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

    if (typeId === "firewall" && outputKey === "id") {
      return resourceId.split(":").pop() ?? "";
    }

    if (typeId === "network" && outputKey === "networkId") return resourceId.split(":").pop() ?? "";
    if (typeId === "load-balancer") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "loadBalancerId") return resource.externalId ?? "";
      if (outputKey === "ipv4") return String(resource.resolvedOutputs["ipv4"] ?? "");
      if (outputKey === "ipv6") return String(resource.resolvedOutputs["ipv6"] ?? "");
    }
    if (typeId === "primary-ip") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "primaryIpId") return resource.externalId ?? "";
      if (outputKey === "ip") return String(resource.resolvedOutputs["ip"] ?? "");
    }
    if (typeId === "ssh-key") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "sshKeyId") return resource.externalId ?? "";
      if (outputKey === "publicKey") return String(resource.resolvedOutputs["publicKey"] ?? "");
    }
    if (typeId === "image" && outputKey === "imageId") return resourceId.split(":").pop() ?? "";
    if (typeId === "placement-group" && outputKey === "placementGroupId") {
      return resourceId.split(":").pop() ?? "";
    }
    if (typeId === "certificate" && outputKey === "certificateId") {
      return resourceId.split(":").pop() ?? "";
    }
    if (typeId === "dns-zone" || typeId === "storage-box") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const value = resource.resolvedOutputs[outputKey];
      if (value !== undefined) return String(value);
    }

    throw new Error(`Hetzner plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "certificate") return certificateCreateConfig();
    if (typeId === "dns-zone") return zoneCreateConfig();
    if (typeId === "dns-record") return recordCreateConfig(this.api, parentResourceId);
    if (typeId === "storage-box") return storageBoxCreateConfig(this.api);
    if (typeId === "network") return this.networkCreateConfig();
    if (typeId === "primary-ip") return this.primaryIpCreateConfig();
    if (typeId === "load-balancer") return this.loadBalancerCreateConfig();
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
        if (!isServerTypeOrderable(st)) continue;
        const category = categorizeServerType(st);
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
      const seenImageIds = new Set<string>();
      for (const img of imagesData) {
        if (img.status !== "available") continue;
        if (img.deprecation || img.deprecated) continue;
        // System images exist once per architecture under the same name;
        // Hetzner resolves the name against the chosen server type's arch.
        const imageId = img.name ?? String(img.id);
        if (seenImageIds.has(imageId)) continue;
        seenImageIds.add(imageId);
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
          {
            key: "firewall",
            label: "Firewall",
            kind: "resource-picker",
            required: false,
            description: "Apply an existing firewall to the server",
            associationSources: [
              { pluginId: "hetzner", resourceTypeId: "firewall", outputKey: "id" },
            ],
          },
          {
            key: "addExtraDisk",
            label: "Extra Volume",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "false", label: "None" },
              { id: "true", label: "Create and attach a volume" },
            ],
          },
          {
            key: "extraDiskSizeGb",
            label: "Volume Size",
            kind: "disk-slider",
            required: false,
            minGb: 10,
            maxGb: 10240,
            defaultGb: 40,
            stepGb: 10,
            showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
          },
          {
            key: "extraDiskFormat",
            label: "Filesystem",
            kind: "select",
            required: false,
            defaultValue: "ext4",
            options: [
              { id: "ext4", label: "ext4" },
              { id: "xfs", label: "xfs" },
            ],
            showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
          },
        ],
      };
    }

    if (typeId === "volume") {
      const locationsData = await this.fetchAll<HetznerLocation>("/locations", "locations");
      const regions = locationsData.map((loc) => {
        const info = HetznerClient.LOCATION_INFO[loc.name];
        return {
          id: loc.name,
          label: loc.city,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
      const firstRegion = regions[0]?.id;

      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "sizeGb",
            label: "Size (GB)",
            kind: "number",
            required: true,
            minValue: 10,
            maxValue: 10240,
            defaultValue: "10",
          },
          {
            key: "location",
            label: "Location",
            kind: "region-picker",
            required: true,
            regions,
            ...(firstRegion ? { defaultValue: firstRegion } : {}),
          },
          {
            key: "format",
            label: "Filesystem",
            kind: "select",
            required: false,
            options: [
              { id: "ext4", label: "ext4" },
              { id: "xfs", label: "xfs" },
            ],
            defaultValue: "ext4",
          },
        ],
      };
    }

    if (typeId === "floating-ip") {
      const locationsData = await this.fetchAll<HetznerLocation>("/locations", "locations");
      const regions = locationsData.map((loc) => {
        const info = HetznerClient.LOCATION_INFO[loc.name];
        return {
          id: loc.name,
          label: loc.city,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
      const firstRegion = regions[0]?.id;

      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: false },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            options: [
              { id: "ipv4", label: "IPv4" },
              { id: "ipv6", label: "IPv6" },
            ],
            defaultValue: "ipv4",
          },
          {
            key: "homeLocation",
            label: "Location",
            kind: "region-picker",
            required: true,
            regions,
            ...(firstRegion ? { defaultValue: firstRegion } : {}),
          },
        ],
      };
    }

    if (typeId === "firewall") {
      return {
        fields: [{ key: "name", label: "Name", kind: "text", required: true }],
      };
    }

    if (typeId === "placement-group") {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "spread",
            options: [{ id: "spread", label: "Spread" }],
          },
        ],
      };
    }

    throw new Error(`No create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    if (typeId === "certificate") return createCertificate(this.api, accountId, fields);
    if (typeId === "dns-zone") return createZone(this.api, accountId, fields);
    if (typeId === "dns-record") {
      return createRrset(this.api, accountId, fields, parentResourceId);
    }
    if (typeId === "storage-box") return createStorageBox(this.api, accountId, fields);
    if (typeId === "network") return this.createNetwork(accountId, fields);
    if (typeId === "primary-ip") return this.createPrimaryIp(accountId, fields);
    if (typeId === "load-balancer") return this.createLoadBalancer(accountId, fields);
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

      const firewallId = Number(fields["firewall"] ?? 0);
      const body: Record<string, unknown> = {
        name: fields["name"],
        server_type: fields["serverType"],
        image: fields["image"],
        location: fields["location"],
        ...(sshKeyIds.length > 0 ? { ssh_keys: sshKeyIds } : {}),
        ...(firewallId > 0 ? { firewalls: [{ firewall: firewallId }] } : {}),
      };

      const data = await this.fetch<{ server: HetznerServer }>("/servers", {
        method: "POST",
        body: JSON.stringify(body),
      });

      // Optionally create and attach an extra volume in the same flow
      if (fields["addExtraDisk"] === "true") {
        await this.fetch("/volumes", {
          method: "POST",
          body: JSON.stringify({
            name: `${fields["name"]}-data`,
            size: Number(fields["extraDiskSizeGb"] ?? 40),
            server: data.server.id,
            automount: true,
            format: fields["extraDiskFormat"] ?? "ext4",
          }),
        });
      }

      return this.mapServer(data.server, accountId);
    }

    if (typeId === "volume") {
      const body: Record<string, unknown> = {
        name: fields["name"],
        size: Number(fields["sizeGb"] || 10),
        location: fields["location"],
        automount: false,
        ...(fields["format"] ? { format: fields["format"] } : {}),
      };
      const data = await this.fetch<{ volume: HetznerVolume }>("/volumes", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const v = data.volume;
      return {
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
          serverId: "",
          linuxDevice: v.linux_device ?? "",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: String(v.id),
        createdAt: v.created ?? new Date().toISOString(),
        updatedAt: v.created ?? new Date().toISOString(),
      };
    }

    if (typeId === "floating-ip") {
      const body: Record<string, unknown> = {
        type: fields["type"] || "ipv4",
        home_location: fields["homeLocation"],
        ...(fields["name"] ? { name: fields["name"] } : {}),
      };
      const data = await this.fetch<{ floating_ip: HetznerFloatingIp }>("/floating_ips", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const fip = data.floating_ip;
      return {
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
          serverId: "",
          blocked: false,
        },
        resolvedOutputs: { ip: fip.ip },
        secretStates: [],
        externalId: String(fip.id),
        createdAt: fip.created ?? new Date().toISOString(),
        updatedAt: fip.created ?? new Date().toISOString(),
      };
    }

    if (typeId === "firewall") {
      const data = await this.fetch<{ firewall: HetznerFirewall }>("/firewalls", {
        method: "POST",
        body: JSON.stringify({ name: fields["name"], rules: [] }),
      });
      const fw = data.firewall;
      return {
        id: `${accountId}:firewall:${fw.id}`,
        pluginId: "hetzner",
        resourceTypeId: "firewall",
        accountId,
        displayName: fw.name,
        fields: {
          name: fw.name,
          rulesCount: 0,
          appliedToCount: 0,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: String(fw.id),
        createdAt: fw.created ?? new Date().toISOString(),
        updatedAt: fw.created ?? new Date().toISOString(),
      };
    }

    if (typeId === "placement-group") {
      const data = await this.fetch<{ placement_group: HetznerPlacementGroup }>(
        "/placement_groups",
        {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"],
            type: fields["type"] || "spread",
          }),
        },
      );
      const group = data.placement_group;
      return {
        id: `${accountId}:placement-group:${group.id}`,
        pluginId: "hetzner",
        resourceTypeId: "placement-group",
        accountId,
        displayName: group.name,
        fields: {
          name: group.name,
          type: group.type,
          serverCount: (group.servers ?? []).length,
        },
        resolvedOutputs: { placementGroupId: String(group.id) },
        secretStates: [],
        externalId: String(group.id),
        createdAt: group.created ?? new Date().toISOString(),
        updatedAt: group.created ?? new Date().toISOString(),
      };
    }

    throw new Error(`Hetzner plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error("Cannot parse resource ID");

    switch (typeId) {
      case "server":
        await this.fetch<unknown>(`/servers/${externalId}`, { method: "DELETE" });
        break;
      case "volume":
        await this.fetch<unknown>(`/volumes/${externalId}`, { method: "DELETE" });
        break;
      case "floating-ip":
        await this.fetch<unknown>(`/floating_ips/${externalId}`, { method: "DELETE" });
        break;
      case "firewall":
        await this.fetch<unknown>(`/firewalls/${externalId}`, { method: "DELETE" });
        break;
      case "placement-group":
        await this.fetch<unknown>(`/placement_groups/${externalId}`, { method: "DELETE" });
        break;
      case "network":
        await this.fetch<unknown>(`/networks/${externalId}`, { method: "DELETE" });
        break;
      case "load-balancer":
        await this.fetch<unknown>(`/load_balancers/${externalId}`, { method: "DELETE" });
        break;
      case "primary-ip":
        // Hetzner refuses (`must_be_unassigned`) while the IP is assigned.
        await this.fetch<unknown>(`/primary_ips/${externalId}`, { method: "DELETE" });
        break;
      case "ssh-key":
        await this.fetch<unknown>(`/ssh_keys/${externalId}`, { method: "DELETE" });
        break;
      case "image":
        // Only snapshots and backups can be deleted; Hetzner rejects system images.
        await this.fetch<unknown>(`/images/${externalId}`, { method: "DELETE" });
        break;
      case "certificate":
        await this.fetch<unknown>(`/certificates/${externalId}`, { method: "DELETE" });
        break;
      case "dns-zone":
        await deleteZone(this.api, resourceId);
        break;
      case "dns-record":
        await deleteRrset(this.api, resourceId);
        break;
      case "storage-box":
        await deleteStorageBox(this.api, resourceId);
        break;
      default:
        throw new Error(`Hetzner plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  /**
   * Edit a server: rename (`name`) and/or change its type (`serverType`).
   *
   * The type change is Hetzner's `change_type` action with
   * `upgrade_disk: false`: the disk keeps its current size, which is what
   * keeps a later downgrade possible. Hetzner rejects the action with
   * `server_not_stopped` (422) unless the server is powered off, and refuses
   * targets whose included disk is smaller than the server's current disk or
   * whose architecture differs; those provider errors are surfaced as-is.
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "volume") return this.updateVolume(resourceId, accountId, fields);
    if (typeId === "dns-zone") return updateZone(this.api, resourceId, accountId, fields);
    if (typeId === "dns-record") return updateRrset(this.api, resourceId, accountId, fields);
    if (typeId === "storage-box") {
      return updateStorageBox(this.api, resourceId, accountId, fields);
    }
    const renamePath = RENAMEABLE_COLLECTIONS[typeId];
    if (renamePath) return this.updateSimple(typeId, renamePath, resourceId, accountId, fields);
    if (typeId !== "server") {
      throw new Error(`Hetzner plugin: updateResource not supported for type "${typeId}"`);
    }
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error("Cannot parse server ID");

    // Rename and change_type are independent calls: one failing must not
    // silently skip or hide the other. Each runs in its own guard and the
    // failures are combined into one labelled error, so partial success is
    // explicit rather than reported as a clean failure.
    const failures: string[] = [];
    const name = fields["name"];
    if (name !== undefined && name !== "") {
      try {
        await this.fetch<unknown>(`/servers/${externalId}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
      } catch (e) {
        failures.push(`rename failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const serverType = fields["serverType"];
    if (serverType !== undefined && serverType !== "") {
      try {
        await this.fetch<unknown>(`/servers/${externalId}/actions/change_type`, {
          method: "POST",
          body: JSON.stringify({ server_type: serverType, upgrade_disk: false }),
        });
      } catch (e) {
        failures.push(`change type failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Hetzner server update: ${failures.join("; ")}`);
    }

    // change_type is asynchronous on Hetzner's side: an immediate re-read
    // can still report the old server type while the action runs. Overlay the
    // accepted values so the returned resource reflects the requested end
    // state; the next sync reads the converged truth (the disk keeps its size
    // because upgrade_disk is false).
    const refreshed = await this.getResource(typeId, resourceId, accountId);
    return {
      ...refreshed,
      fields: {
        ...refreshed.fields,
        ...(name !== undefined && name !== "" ? { name } : {}),
        ...(serverType !== undefined && serverType !== "" ? { serverType } : {}),
      },
      ...(name !== undefined && name !== "" ? { displayName: name } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  private async locationRegions(): Promise<
    Array<{ id: string; label: string; location?: string; flag?: string; networkZone?: string }>
  > {
    const locations = await this.fetchAll<HetznerLocation>("/locations", "locations");
    return locations.map((loc) => {
      const info = HetznerClient.LOCATION_INFO[loc.name];
      return {
        id: loc.name,
        label: loc.city,
        ...(info ? { location: info.location, flag: info.flag } : {}),
        ...(loc.network_zone ? { networkZone: loc.network_zone } : {}),
      };
    });
  }

  private async networkCreateConfig(): Promise<CreateResourceConfig> {
    const regions = await this.locationRegions();
    const zones = [...new Set(regions.map((r) => r.networkZone).filter((z): z is string => !!z))];
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "ipRange",
          label: "IP Range",
          kind: "text",
          required: true,
          defaultValue: "10.0.0.0/16",
          description: "Private RFC 1918 range for the whole network, /24 or larger",
        },
        {
          key: "subnetRange",
          label: "First Subnet",
          kind: "text",
          required: false,
          defaultValue: "10.0.0.0/24",
          description: "Cloud subnet inside the IP range. Leave empty to add subnets later",
        },
        {
          key: "networkZone",
          label: "Network Zone",
          kind: "select",
          required: false,
          options: zones.map((z) => ({ id: z, label: z })),
          ...(zones[0] ? { defaultValue: zones[0] } : {}),
          description: "Servers in locations of this zone can join the subnet",
        },
      ],
    };
  }

  private async createNetwork(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const subnetRange = fields["subnetRange"]?.trim();
    const data = await this.fetch<{ network: HetznerNetwork }>("/networks", {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"],
        ip_range: fields["ipRange"],
        ...(subnetRange && fields["networkZone"]
          ? {
              subnets: [
                { type: "cloud", ip_range: subnetRange, network_zone: fields["networkZone"] },
              ],
            }
          : {}),
      }),
    });
    return this.mapNetwork(data.network, accountId);
  }

  private async primaryIpCreateConfig(): Promise<CreateResourceConfig> {
    const regions = await this.locationRegions();
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: "ipv4",
          options: [
            { id: "ipv4", label: "IPv4" },
            { id: "ipv6", label: "IPv6 (/64)" },
          ],
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions,
          ...(regions[0] ? { defaultValue: regions[0].id } : {}),
        },
        {
          key: "autoDelete",
          label: "Auto Delete",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: [
            { id: "false", label: "Keep when the server is deleted" },
            { id: "true", label: "Delete with the server" },
          ],
        },
      ],
    };
  }

  private async createPrimaryIp(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const data = await this.fetch<{ primary_ip: HetznerPrimaryIp }>("/primary_ips", {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"],
        type: fields["type"] || "ipv4",
        // No assignee: the IP is created unassigned, bound to the location.
        location: fields["location"],
        auto_delete: fields["autoDelete"] === "true",
      }),
    });
    return this.mapPrimaryIp(data.primary_ip, accountId);
  }

  private async loadBalancerCreateConfig(): Promise<CreateResourceConfig> {
    const [regions, types] = await Promise.all([
      this.locationRegions(),
      this.fetchAll<HetznerLoadBalancerType>("/load_balancer_types", "load_balancer_types"),
    ]);
    const options = types
      .filter((t) => !t.deprecation && !t.deprecated)
      .map((t) => {
        const monthly = t.prices?.[0]?.price_monthly?.gross;
        return {
          id: t.name,
          label: [
            t.name.toUpperCase(),
            t.max_targets ? `${t.max_targets} targets` : "",
            t.max_connections ? `${t.max_connections.toLocaleString("en")} connections` : "",
            monthly ? `${Number(monthly).toFixed(2)}/mo gross` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        };
      });
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions,
          ...(regions[0] ? { defaultValue: regions[0].id } : {}),
        },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          options,
          ...(options[0] ? { defaultValue: options[0].id } : {}),
        },
        {
          key: "algorithm",
          label: "Algorithm",
          kind: "select",
          required: false,
          defaultValue: "round_robin",
          options: [
            { id: "round_robin", label: "Round robin" },
            { id: "least_connections", label: "Least connections" },
          ],
        },
      ],
    };
  }

  private async createLoadBalancer(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const data = await this.fetch<{ load_balancer: HetznerLoadBalancer }>("/load_balancers", {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"],
        load_balancer_type: fields["type"],
        location: fields["location"],
        algorithm: { type: fields["algorithm"] || "round_robin" },
      }),
    });
    return this.mapLoadBalancer(data.load_balancer, accountId);
  }

  /**
   * Edit a volume: rename via `PUT /volumes/{id}` and grow via
   * `actions/resize`. Hetzner only grows volumes, so a smaller size is
   * refused here with a clear message rather than as a provider 422.
   */
  private async updateVolume(
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error("Cannot parse volume ID");
    const current = await this.getResource("volume", resourceId, accountId);
    const failures: string[] = [];
    const name = fields["name"];
    if (name !== undefined && name !== "") {
      try {
        await this.fetch<unknown>(`/volumes/${externalId}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
      } catch (e) {
        failures.push(`rename failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const sizeRaw = fields["sizeGb"];
    const size = sizeRaw !== undefined && sizeRaw !== "" ? Number(sizeRaw) : undefined;
    if (size !== undefined) {
      const currentSize = Number(current.fields["sizeGb"] ?? 0);
      if (!Number.isFinite(size) || size < currentSize) {
        failures.push(
          `resize failed: Hetzner volumes can only grow (current size ${currentSize} GB)`,
        );
      } else if (size > currentSize) {
        try {
          await this.fetch<unknown>(`/volumes/${externalId}/actions/resize`, {
            method: "POST",
            body: JSON.stringify({ size }),
          });
        } catch (e) {
          failures.push(`resize failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (failures.length > 0) throw new Error(`Hetzner volume update: ${failures.join("; ")}`);
    return {
      ...current,
      ...(name ? { displayName: name } : {}),
      fields: {
        ...current.fields,
        ...(name ? { name } : {}),
        ...(size !== undefined ? { sizeGb: size } : {}),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Edit the resource types whose only mutable attributes live on the
   * object itself (`PUT /{collection}/{id}`): the name everywhere, plus a
   * floating IP's description and a primary IP's `auto_delete`.
   */
  private async updateSimple(
    typeId: string,
    collection: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error(`Cannot parse ${typeId} ID`);
    const body: Record<string, unknown> = {};
    if (fields["name"] !== undefined && fields["name"] !== "") body["name"] = fields["name"];
    if (typeId === "floating-ip" && fields["description"] !== undefined) {
      body["description"] = fields["description"];
    }
    if (typeId === "primary-ip" && fields["autoDelete"] !== undefined) {
      body["auto_delete"] = fields["autoDelete"] === "true";
    }
    if (Object.keys(body).length > 0) {
      await this.fetch<unknown>(`/${collection}/${externalId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  /**
   * Per-location monthly prices for server types. `/server_types` carries a
   * price per location, so unlike the create-config catalog (which quotes the
   * first location's price) this resolves the one the caller asked for.
   */
  async getCreateSizePricing(
    typeId: string,
    request: { regionId?: string; sizes: Array<{ id: string }> },
  ): Promise<Record<string, number>> {
    if (typeId !== "server") return {};
    const serverTypes = await this.fetchAll<HetznerServerType>("/server_types", "server_types");
    const wanted = new Set(request.sizes.map((s) => s.id));
    const out: Record<string, number> = {};
    for (const st of serverTypes) {
      if (!wanted.has(st.name)) continue;
      const price =
        (request.regionId ? st.prices?.find((p) => p.location === request.regionId) : undefined) ??
        st.prices?.[0];
      const monthly = price?.price_monthly?.gross ? parseFloat(price.price_monthly.gross) : NaN;
      if (Number.isFinite(monthly)) out[st.name] = monthly;
    }
    return out;
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = resourceId.split(":").pop();
    if (typeId === "server" && SERVER_ACTIONS.has(actionId)) {
      if (!externalId) throw new Error("Cannot parse server ID");
      if (actionId === "create_snapshot") {
        // `create_image` with type snapshot; the description is what the
        // Console lists, so stamp it with the date the snapshot was taken.
        await this.fetch<unknown>(`/servers/${externalId}/actions/create_image`, {
          method: "POST",
          body: JSON.stringify({
            type: "snapshot",
            description: `infrawrench-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`,
          }),
        });
        return;
      }
      if (actionId === "enable_protection" || actionId === "disable_protection") {
        const on = actionId === "enable_protection";
        await this.fetch<unknown>(`/servers/${externalId}/actions/change_protection`, {
          method: "POST",
          body: JSON.stringify({ delete: on, rebuild: on }),
        });
        return;
      }
      await this.fetch<unknown>(`/servers/${externalId}/actions/${actionId}`, { method: "POST" });
      return;
    }
    if (typeId === "certificate" && actionId === "retry") {
      await retryCertificate(this.api, resourceId);
      return;
    }
    if (typeId === "storage-box" && STORAGE_BOX_ACTIONS.has(actionId)) {
      await invokeStorageBoxAction(this.api, resourceId, actionId);
      return;
    }
    throw new Error(
      `Hetzner plugin: invokeAction "${actionId}" not supported for type "${typeId}"`,
    );
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "volume" && targetTypeId === "server") {
      const [volume, server] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const volumeId = volume.externalId ?? sourceResourceId.split(":").pop();
      const serverId = server.externalId ?? targetResourceId.split(":").pop();
      const volumeLocation = String(volume.fields["location"] ?? "");
      const serverLocation = String(server.fields["location"] ?? "");
      if (!volumeId || !serverId) {
        throw new Error("Cannot determine volume or server id for attachment");
      }
      if (volumeLocation && serverLocation && volumeLocation !== serverLocation) {
        throw new Error(
          `Volume location ${volumeLocation} does not match server location ${serverLocation} — Hetzner volumes must be in the same location as the server.`,
        );
      }
      await this.fetch(`/volumes/${volumeId}/actions/attach`, {
        method: "POST",
        body: JSON.stringify({ server: Number(serverId), automount: true }),
      });
      return;
    }
    if (sourceTypeId === "firewall" && targetTypeId === "server") {
      const [firewall, server] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const firewallId = firewall.externalId ?? sourceResourceId.split(":").pop();
      const serverId = server.externalId ?? targetResourceId.split(":").pop();
      if (!firewallId || !serverId) {
        throw new Error("Cannot determine firewall or server id for attachment");
      }
      await this.fetch(`/firewalls/${firewallId}/actions/apply_to_resources`, {
        method: "POST",
        body: JSON.stringify({
          apply_to: [{ type: "server", server: { id: Number(serverId) } }],
        }),
      });
      return;
    }
    if (sourceTypeId === "load-balancer" && targetTypeId === "server") {
      const [loadBalancer, server] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const loadBalancerId = loadBalancer.externalId ?? sourceResourceId.split(":").pop();
      const serverId = server.externalId ?? targetResourceId.split(":").pop();
      const loadBalancerLocation = String(loadBalancer.fields["location"] ?? "");
      const serverLocation = String(server.fields["location"] ?? "");
      if (!loadBalancerId || !serverId) {
        throw new Error("Cannot determine load balancer or server id for attachment");
      }
      if (loadBalancerLocation && serverLocation && loadBalancerLocation !== serverLocation) {
        throw new Error(
          `Load balancer location ${loadBalancerLocation} does not match server location ${serverLocation}.`,
        );
      }
      await this.fetch(`/load_balancers/${loadBalancerId}/actions/add_target`, {
        method: "POST",
        body: JSON.stringify({ type: "server", server: { id: Number(serverId) } }),
      });
      return;
    }
    if (sourceTypeId === "network" && targetTypeId === "server") {
      const [network, server] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const networkId = network.externalId ?? sourceResourceId.split(":").pop();
      const serverId = server.externalId ?? targetResourceId.split(":").pop();
      if (!networkId || !serverId) {
        throw new Error("Cannot determine network or server id for attachment");
      }
      await this.fetch(`/servers/${serverId}/actions/attach_to_network`, {
        method: "POST",
        body: JSON.stringify({ network: Number(networkId) }),
      });
      return;
    }
    if (sourceTypeId === "network" && targetTypeId === "load-balancer") {
      const [network, loadBalancer] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const networkId = network.externalId ?? sourceResourceId.split(":").pop();
      const loadBalancerId = loadBalancer.externalId ?? targetResourceId.split(":").pop();
      if (!networkId || !loadBalancerId) {
        throw new Error("Cannot determine network or load balancer id for attachment");
      }
      await this.fetch(`/load_balancers/${loadBalancerId}/actions/attach_to_network`, {
        method: "POST",
        body: JSON.stringify({ network: Number(networkId) }),
      });
      return;
    }
    if (sourceTypeId === "floating-ip" && targetTypeId === "server") {
      const [floatingIp, server] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const floatingIpId = floatingIp.externalId ?? sourceResourceId.split(":").pop();
      const serverId = server.externalId ?? targetResourceId.split(":").pop();
      if (!floatingIpId || !serverId) {
        throw new Error("Cannot determine floating IP or server id for assignment");
      }
      await this.fetch(`/floating_ips/${floatingIpId}/actions/assign`, {
        method: "POST",
        body: JSON.stringify({ server: Number(serverId) }),
      });
      return;
    }
    if (sourceTypeId === "primary-ip" && targetTypeId === "server") {
      const [primaryIp, server] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const primaryIpId = primaryIp.externalId ?? sourceResourceId.split(":").pop();
      const serverId = server.externalId ?? targetResourceId.split(":").pop();
      if (!primaryIpId || !serverId) {
        throw new Error("Cannot determine primary IP or server id for assignment");
      }
      await this.fetch(`/primary_ips/${primaryIpId}/actions/assign`, {
        method: "POST",
        body: JSON.stringify({ assignee_id: Number(serverId), assignee_type: "server" }),
      });
      return;
    }
    if (sourceTypeId === "placement-group" && targetTypeId === "server") {
      const [placementGroup, server] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const placementGroupId = placementGroup.externalId ?? sourceResourceId.split(":").pop();
      const serverId = server.externalId ?? targetResourceId.split(":").pop();
      if (!placementGroupId || !serverId) {
        throw new Error("Cannot determine placement group or server id for attachment");
      }
      await this.fetch(`/servers/${serverId}/actions/add_to_placement_group`, {
        method: "POST",
        body: JSON.stringify({ placement_group: Number(placementGroupId) }),
      });
      return;
    }
    throw new Error(
      `Hetzner plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
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

    if (resourceTypeId === "network") {
      return [
        { label: "IP Range", value: String(f["ipRange"] ?? "") },
        { label: "Subnets", value: String(f["subnetCount"] ?? 0) },
        { label: "Servers", value: String(f["serverCount"] ?? 0) },
      ];
    }

    if (resourceTypeId === "load-balancer") {
      return [
        { label: "Status", value: String(f["status"] ?? "unknown") },
        { label: "Type", value: String(f["type"] ?? "") },
        { label: "Targets", value: String(f["targetCount"] ?? 0) },
        ...(resource.resolvedOutputs["ipv4"]
          ? [{ label: "IPv4", value: resource.resolvedOutputs["ipv4"] }]
          : []),
      ];
    }

    if (resourceTypeId === "primary-ip") {
      return [
        { label: "IP", value: String(f["ip"] ?? "") },
        { label: "Type", value: String(f["type"] ?? "") },
        { label: "Assigned", value: String(f["assigneeId"] ?? "") || "No" },
      ];
    }

    if (resourceTypeId === "placement-group") {
      return [
        { label: "Type", value: String(f["type"] ?? "") },
        { label: "Servers", value: String(f["serverCount"] ?? 0) },
      ];
    }

    if (resourceTypeId === "certificate") {
      const issuance = String(f["issuanceStatus"] ?? "");
      return [
        { label: "Type", value: String(f["type"] ?? "") },
        ...(issuance
          ? [
              {
                label: "Issuance",
                value: issuance,
                variant:
                  issuance === "completed"
                    ? ("status-healthy" as const)
                    : issuance === "failed"
                      ? ("status-error" as const)
                      : ("status-degraded" as const),
              },
            ]
          : []),
        { label: "Valid Until", value: String(f["notValidAfter"] ?? "") || "Pending" },
        { label: "Domains", value: String(f["domainNames"] ?? "") },
      ];
    }

    if (resourceTypeId === "dns-zone") {
      const delegation = String(f["delegationStatus"] ?? "");
      return [
        { label: "Records", value: String(f["recordCount"] ?? 0) },
        { label: "Default TTL", value: `${String(f["ttl"] ?? "")}s` },
        {
          label: "Delegation",
          value: delegation || "unknown",
          variant:
            delegation === "valid"
              ? ("status-healthy" as const)
              : delegation === "invalid" || delegation === "lame"
                ? ("status-error" as const)
                : ("status-degraded" as const),
        },
        { label: "Nameservers", value: String(f["nameservers"] ?? "") },
      ];
    }

    if (resourceTypeId === "storage-box") {
      const size = Number(f["sizeGb"] ?? 0);
      const used = Number(f["usedGb"] ?? 0);
      return [
        { label: "Status", value: String(f["status"] ?? "") },
        { label: "Type", value: String(f["storageBoxType"] ?? "") },
        {
          label: "Used",
          value:
            size > 0 ? `${used} / ${size} GB (${Math.round((used / size) * 100)}%)` : `${used} GB`,
        },
        { label: "Snapshots", value: `${String(f["snapshotsGb"] ?? 0)} GB` },
        { label: "Server", value: String(f["server"] ?? "") },
      ];
    }

    return [];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "server" && resourceTypeId !== "load-balancer") return [];

    const externalId = resourceId.split(":").pop();
    if (!externalId) return [];

    const now = Date.now();
    const start = new Date(timeRange?.startMs ?? now - 3_600_000).toISOString();
    const end = new Date(timeRange?.endMs ?? now).toISOString();

    interface HetznerMetricsResponse {
      metrics: {
        time_series: Record<string, { values: [number, string][] }>;
      };
    }

    const toSeries = (
      ts: Record<string, { values: [number, string][] }>,
      key: string,
      label: string,
      unit: string,
    ): MetricSeries | null => {
      const values = ts[key]?.values;
      if (!values || values.length === 0) return null;
      return {
        label,
        unit,
        points: values.map(([t, v]) => ({
          timestamp: Math.round(t * 1000),
          value: Number(v),
        })),
      };
    };

    if (resourceTypeId === "server") {
      let resp: HetznerMetricsResponse;
      // Hetzner's `cpu` series is per vCPU (100 = one full core, so a busy
      // 4-vCPU server reads 400), so the core count is needed to turn it into
      // the 0-100% utilisation the chart and right-sizing expect. Fetched
      // alongside; a failure just leaves the series unnormalised.
      let cores = 0;
      try {
        const [metrics, server] = await Promise.all([
          this.fetch<HetznerMetricsResponse>(
            `/servers/${externalId}/metrics?type=cpu,disk,network&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
          ),
          this.fetch<{ server: HetznerServer }>(`/servers/${externalId}`).catch(() => null),
        ]);
        resp = metrics;
        cores = server?.server?.server_type?.cores ?? 0;
      } catch {
        return [];
      }

      const ts = resp.metrics?.time_series ?? {};
      const results: MetricSeries[] = [];
      const push = (s: MetricSeries | null) => {
        if (s) results.push(s);
      };
      const cpu = toSeries(ts, "cpu", "CPU Utilization", "%");
      if (cpu && cores > 1) {
        cpu.points = cpu.points.map((p) => ({ ...p, value: p.value / cores }));
      }
      push(cpu);
      push(toSeries(ts, "disk.0.iops.read", "Disk IOPS (read)", "iops"));
      push(toSeries(ts, "disk.0.iops.write", "Disk IOPS (write)", "iops"));
      push(toSeries(ts, "disk.0.bandwidth.read", "Disk Read", "bytes/s"));
      push(toSeries(ts, "disk.0.bandwidth.write", "Disk Write", "bytes/s"));
      push(toSeries(ts, "network.0.bandwidth.in", "Network In", "bytes/s"));
      push(toSeries(ts, "network.0.bandwidth.out", "Network Out", "bytes/s"));
      push(toSeries(ts, "network.0.pps.in", "Packets In", "packets/s"));
      push(toSeries(ts, "network.0.pps.out", "Packets Out", "packets/s"));
      return results;
    }

    // load-balancer: Hetzner exposes /load_balancers/{id}/metrics with metric types
    // open_connections, connections_per_second, requests_per_second, bandwidth
    // (https://docs.hetzner.cloud/reference/cloud#load-balancers-get-metrics-for-a-loadbalancer).
    if (resourceTypeId === "load-balancer") {
      let resp: HetznerMetricsResponse;
      try {
        resp = await this.fetch<HetznerMetricsResponse>(
          `/load_balancers/${externalId}/metrics?type=open_connections,connections_per_second,requests_per_second,bandwidth&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        );
      } catch {
        return [];
      }

      const ts = resp.metrics?.time_series ?? {};
      const results: MetricSeries[] = [];
      const push = (s: MetricSeries | null) => {
        if (s) results.push(s);
      };
      push(toSeries(ts, "open_connections", "Open Connections", "connections"));
      push(toSeries(ts, "connections_per_second", "New Connections", "connections/s"));
      push(toSeries(ts, "requests_per_second", "Requests", "requests/s"));
      push(toSeries(ts, "bandwidth.in", "Bandwidth In", "bytes/s"));
      push(toSeries(ts, "bandwidth.out", "Bandwidth Out", "bytes/s"));
      return results;
    }

    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    // Servers and load balancers declare `supportsMetrics`; Hetzner's
    // `/metrics` endpoints default to the last hour when the host asks
    // without a range.
    return withMetricsCapability(
      this.renderDetailInner(resource),
      this.resourceTypes,
      resource.resourceTypeId,
      3_600_000,
    );
  }

  private renderDetailInner(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status =
      resource.resourceTypeId === "server"
        ? serverStatusToDot(String(fields["status"] ?? "unknown"))
        : ("info" as const);

    // Power off/on header actions for the server lifecycle pair (see the
    // type's `lifecycle` declaration).
    const lifecycleActions: ActionNode[] = [];
    if (resource.resourceTypeId === "server") {
      const s = String(fields["status"] ?? "");
      if (s === "running") {
        lifecycleActions.push({
          kind: "action",
          label: "Power off",
          action: {
            type: "plugin-action",
            actionId: "poweroff",
            confirmMessage:
              "Power off this server? This is a hard poweroff (like pulling the plug); Hetzner keeps billing a powered-off server.",
            successMessage: "Power off requested.",
          },
          variant: "danger",
        });
      } else if (s === "off") {
        lifecycleActions.push({
          kind: "action",
          label: "Power on",
          action: {
            type: "plugin-action",
            actionId: "poweron",
            successMessage: "Power on requested.",
          },
        });
      }
      if (s === "running") {
        lifecycleActions.push(
          {
            kind: "action",
            label: "Shut down",
            action: {
              type: "plugin-action",
              actionId: "shutdown",
              confirmMessage:
                "Send an ACPI shutdown to this server? The guest OS shuts down gracefully; Hetzner keeps billing a powered-off server.",
              successMessage: "Shutdown requested.",
            },
          },
          {
            kind: "action",
            label: "Reboot",
            action: {
              type: "plugin-action",
              actionId: "reboot",
              confirmMessage: "Send a soft (ACPI) reboot to this server?",
              successMessage: "Reboot requested.",
            },
          },
          {
            kind: "action",
            label: "Reset",
            action: {
              type: "plugin-action",
              actionId: "reset",
              confirmMessage:
                "Hard reset this server? This is like pressing the reset button; unsaved data in memory is lost.",
              successMessage: "Reset requested.",
            },
            variant: "danger",
          },
        );
      }
      lifecycleActions.push({
        kind: "action",
        label: "Take snapshot",
        action: {
          type: "plugin-action",
          actionId: "create_snapshot",
          confirmMessage:
            "Create a snapshot of this server's disk? Snapshots are billed per GB-month until deleted.",
          successMessage: "Snapshot requested. It appears under Images once Hetzner finishes it.",
        },
      });
      const backupsOn = String(fields["backupWindow"] ?? "") !== "";
      lifecycleActions.push(
        backupsOn
          ? {
              kind: "action",
              label: "Disable backups",
              action: {
                type: "plugin-action",
                actionId: "disable_backup",
                confirmMessage:
                  "Disable automatic backups? Hetzner deletes every existing backup of this server immediately.",
                successMessage: "Backups disabled.",
              },
              variant: "danger",
            }
          : {
              kind: "action",
              label: "Enable backups",
              action: {
                type: "plugin-action",
                actionId: "enable_backup",
                confirmMessage:
                  "Enable daily automatic backups? Hetzner adds 20% of the server's price to its cost.",
                successMessage: "Backups enabled.",
              },
            },
      );
      const protectedNow = fields["deleteProtection"] === true;
      lifecycleActions.push({
        kind: "action",
        label: protectedNow ? "Disable protection" : "Enable protection",
        action: {
          type: "plugin-action",
          actionId: protectedNow ? "disable_protection" : "enable_protection",
          ...(protectedNow
            ? {
                confirmMessage:
                  "Remove delete and rebuild protection? The server can then be deleted or rebuilt.",
              }
            : {}),
          successMessage: protectedNow ? "Protection disabled." : "Protection enabled.",
        },
      });
    }

    if (resource.resourceTypeId === "certificate" && fields["type"] === "managed") {
      const failed = fields["issuanceStatus"] === "failed" || fields["renewalStatus"] === "failed";
      if (failed) {
        lifecycleActions.push({
          kind: "action",
          label: "Retry issuance",
          action: {
            type: "plugin-action",
            actionId: "retry",
            successMessage: "Hetzner is retrying the certificate.",
          },
        });
      }
    }

    if (resource.resourceTypeId === "storage-box") {
      const protectedNow = fields["deleteProtection"] === true;
      lifecycleActions.push(
        {
          kind: "action",
          label: "Take snapshot",
          action: {
            type: "plugin-action",
            actionId: "create_snapshot",
            successMessage: "Snapshot requested.",
          },
        },
        {
          kind: "action",
          label: protectedNow ? "Disable protection" : "Enable protection",
          action: {
            type: "plugin-action",
            actionId: protectedNow ? "disable_protection" : "enable_protection",
            successMessage: protectedNow ? "Protection disabled." : "Protection enabled.",
          },
        },
      );
      if (fields["snapshotPlan"]) {
        lifecycleActions.push({
          kind: "action",
          label: "Disable snapshot plan",
          action: {
            type: "plugin-action",
            actionId: "disable_snapshot_plan",
            confirmMessage: "Stop taking automatic snapshots? Existing snapshots are kept.",
            successMessage: "Snapshot plan disabled.",
          },
        });
      }
    }

    return {
      title: resource.displayName,
      subtitle: joinSubtitle(
        resourceTypeDisplayName(this.resourceTypes, resource.resourceTypeId),
        fields["location"] ?? fields["zoneName"],
      ),
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
      headerActions: [
        ...lifecycleActions,
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const status =
      resource.resourceTypeId === "server"
        ? serverStatusToDot(String(resource.fields["status"] ?? "unknown"))
        : ("info" as const);

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
    // All three come straight off the /servers payload: `private_net[].network`
    // is the attached Network's id, `public_net.firewalls[].id` the Firewalls
    // applied to the public interface, and `placement_group.id` the group the
    // server is spread across. No extra request.
    const networkIds = (s.private_net ?? [])
      .map((n) => (n.network != null ? String(n.network) : ""))
      .filter(Boolean);
    const firewallIds = (s.public_net?.firewalls ?? [])
      .map((fw) => (fw.id != null ? String(fw.id) : ""))
      .filter(Boolean);

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
        // `location` replaced `datacenter` (removed from the API 2026-07-01);
        // the nested form is read only as a fallback for older payloads.
        location: s.location?.name ?? s.datacenter?.location?.name ?? "",
        image: s.image?.name ?? s.image?.description ?? "",
        placementGroupId: s.placement_group?.id != null ? String(s.placement_group.id) : "",
        firewallIds: firewallIds.join(", "),
        networkIds: networkIds.join(", "),
        // Straight off the payload. Feeds the right-sizing disk guard: a
        // resize target's included disk must be >= this.
        primaryDiskGb: s.primary_disk_size ?? s.server_type?.disk ?? 0,
        // Non-null exactly when automatic backups are enabled.
        backupWindow: s.backup_window ?? "",
        deleteProtection: s.protection?.delete ?? false,
        rescueEnabled: s.rescue_enabled ?? false,
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
        description: fip.description ?? "",
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
    return firewalls.map((fw) => {
      // `applied_to` entries are either `{type:"server", server:{id}}` or
      // `{type:"label_selector", label_selector:{selector},
      // applied_to_resources:[{type:"server", server:{id}}]}`: collect the
      // concrete server ids from both shapes, and keep the selectors as text.
      const appliedTo = fw.applied_to ?? [];
      const appliedToServerIds = new Set<string>();
      const selectors: string[] = [];
      for (const entry of appliedTo) {
        if (entry.server?.id != null) appliedToServerIds.add(String(entry.server.id));
        for (const resolved of entry.applied_to_resources ?? []) {
          if (resolved.server?.id != null) appliedToServerIds.add(String(resolved.server.id));
        }
        if (entry.label_selector?.selector) selectors.push(entry.label_selector.selector);
      }
      return {
        id: `${accountId}:firewall:${fw.id}`,
        pluginId: "hetzner",
        resourceTypeId: "firewall",
        accountId,
        displayName: fw.name,
        fields: {
          name: fw.name,
          rulesCount: (fw.rules ?? []).length,
          appliedToCount: appliedTo.length,
          appliedToServerIds: [...appliedToServerIds].join(", "),
          appliedToLabelSelectors: selectors.join(", "),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: String(fw.id),
        createdAt: fw.created ?? new Date().toISOString(),
        updatedAt: fw.created ?? new Date().toISOString(),
      };
    });
  }

  private async listNetworks(accountId: string): Promise<ResourceInstance[]> {
    const networks = await this.fetchAll<HetznerNetwork>("/networks", "networks");
    return networks.map((n) => this.mapNetwork(n, accountId));
  }

  private mapNetwork(n: HetznerNetwork, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:network:${n.id}`,
      pluginId: "hetzner",
      resourceTypeId: "network",
      accountId,
      displayName: n.name,
      fields: {
        name: n.name,
        ipRange: n.ip_range,
        subnetCount: (n.subnets ?? []).length,
        routeCount: (n.routes ?? []).length,
        serverCount: (n.servers ?? []).length,
        // `servers` / `load_balancers` are plain id arrays on the payload the
        // list call already returns.
        serverIds: (n.servers ?? []).map((id) => String(id)).join(", "),
        loadBalancerIds: (n.load_balancers ?? []).map((id) => String(id)).join(", "),
        // The API field is `expose_routes_to_vswitch`; the older
        // `exposes_routes_to_vswitch` spelling is read as a fallback so the
        // existing field keeps working either way.
        exposesRoutesToVswitch: n.expose_routes_to_vswitch ?? n.exposes_routes_to_vswitch ?? false,
      },
      resolvedOutputs: { networkId: String(n.id) },
      secretStates: [],
      externalId: String(n.id),
      createdAt: n.created ?? new Date().toISOString(),
      updatedAt: n.created ?? new Date().toISOString(),
    };
  }

  private async listLoadBalancers(accountId: string): Promise<ResourceInstance[]> {
    const loadBalancers = await this.fetchAll<HetznerLoadBalancer>(
      "/load_balancers",
      "load_balancers",
    );
    return loadBalancers.map((lb) => this.mapLoadBalancer(lb, accountId));
  }

  private mapLoadBalancer(lb: HetznerLoadBalancer, accountId: string): ResourceInstance {
    // Targets are `{type:"server", server:{id}}`, or `{type:"label_selector",
    // targets:[{server:{id}}]}` once Hetzner has resolved the selector, or
    // `{type:"ip"}` (no server to link). Both server-bearing shapes count.
    const targetServerIds = new Set<string>();
    for (const target of lb.targets ?? []) {
      if (target.server?.id != null) targetServerIds.add(String(target.server.id));
      for (const resolved of target.targets ?? []) {
        if (resolved.server?.id != null) targetServerIds.add(String(resolved.server.id));
      }
    }
    const networkIds = (lb.private_net ?? [])
      .map((n) => (n.network != null ? String(n.network) : ""))
      .filter(Boolean);
    return {
      id: `${accountId}:load-balancer:${lb.id}`,
      pluginId: "hetzner",
      resourceTypeId: "load-balancer",
      accountId,
      displayName: lb.name,
      fields: {
        name: lb.name,
        status: lb.status ?? "unknown",
        type: lb.load_balancer_type?.name ?? "",
        location: lb.location?.name ?? "",
        ipv4: lb.public_net?.ipv4?.ip ?? "",
        ipv6: lb.public_net?.ipv6?.ip ?? "",
        targetCount: (lb.targets ?? []).length,
        serviceCount: (lb.services ?? []).length,
        targetServerIds: [...targetServerIds].join(", "),
        networkIds: networkIds.join(", "),
      },
      resolvedOutputs: {
        loadBalancerId: String(lb.id),
        ipv4: lb.public_net?.ipv4?.ip ?? "",
        ipv6: lb.public_net?.ipv6?.ip ?? "",
      },
      secretStates: [],
      externalId: String(lb.id),
      createdAt: lb.created ?? new Date().toISOString(),
      updatedAt: lb.created ?? new Date().toISOString(),
    };
  }

  private async listPrimaryIps(accountId: string): Promise<ResourceInstance[]> {
    const ips = await this.fetchAll<HetznerPrimaryIp>("/primary_ips", "primary_ips");
    return ips.map((ip) => this.mapPrimaryIp(ip, accountId));
  }

  private mapPrimaryIp(ip: HetznerPrimaryIp, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:primary-ip:${ip.id}`,
      pluginId: "hetzner",
      resourceTypeId: "primary-ip",
      accountId,
      displayName: ip.name || ip.ip,
      fields: {
        name: ip.name || "",
        ip: ip.ip,
        type: ip.type,
        location: ip.location?.name ?? ip.datacenter?.location?.name ?? "",
        assigneeId: ip.assignee_id != null ? String(ip.assignee_id) : "",
        assigneeType: ip.assignee_type ?? "",
        blocked: ip.blocked ?? false,
        autoDelete: ip.auto_delete ?? false,
      },
      resolvedOutputs: { primaryIpId: String(ip.id), ip: ip.ip },
      secretStates: [],
      externalId: String(ip.id),
      createdAt: ip.created ?? new Date().toISOString(),
      updatedAt: ip.created ?? new Date().toISOString(),
    };
  }

  private async listSshKeys(accountId: string): Promise<ResourceInstance[]> {
    const keys = await this.fetchAll<HetznerSshKey>("/ssh_keys", "ssh_keys");
    return keys.map((key) => ({
      id: `${accountId}:ssh-key:${key.id}`,
      pluginId: "hetzner",
      resourceTypeId: "ssh-key",
      accountId,
      displayName: key.name,
      fields: {
        name: key.name,
        fingerprint: key.fingerprint ?? "",
        publicKey: key.public_key ?? "",
      },
      resolvedOutputs: { sshKeyId: String(key.id), publicKey: key.public_key ?? "" },
      secretStates: [],
      externalId: String(key.id),
      createdAt: key.created ?? new Date().toISOString(),
      updatedAt: key.created ?? new Date().toISOString(),
    }));
  }

  private async listImages(accountId: string): Promise<ResourceInstance[]> {
    const images = await this.fetchAll<HetznerImageDetail>("/images?sort=name", "images");
    return images.map((image) => ({
      id: `${accountId}:image:${image.id}`,
      pluginId: "hetzner",
      resourceTypeId: "image",
      accountId,
      displayName: image.description || image.name || String(image.id),
      fields: {
        name: image.name ?? "",
        description: image.description ?? "",
        type: image.type,
        status: image.status,
        osFlavor: image.os_flavor ?? "",
        osVersion: image.os_version ?? "",
        imageSizeGb: image.image_size ?? 0,
        diskSizeGb: image.disk_size ?? 0,
        boundTo: image.bound_to != null ? String(image.bound_to) : "",
      },
      resolvedOutputs: { imageId: String(image.id) },
      secretStates: [],
      externalId: String(image.id),
      createdAt: image.created ?? new Date().toISOString(),
      updatedAt: image.created ?? new Date().toISOString(),
    }));
  }

  private async listPlacementGroups(accountId: string): Promise<ResourceInstance[]> {
    const groups = await this.fetchAll<HetznerPlacementGroup>(
      "/placement_groups",
      "placement_groups",
    );
    return groups.map((group) => ({
      id: `${accountId}:placement-group:${group.id}`,
      pluginId: "hetzner",
      resourceTypeId: "placement-group",
      accountId,
      displayName: group.name,
      fields: {
        name: group.name,
        type: group.type,
        serverCount: (group.servers ?? []).length,
      },
      resolvedOutputs: { placementGroupId: String(group.id) },
      secretStates: [],
      externalId: String(group.id),
      createdAt: group.created ?? new Date().toISOString(),
      updatedAt: group.created ?? new Date().toISOString(),
    }));
  }

  /**
   * Estimated spend, from inventory × the `/pricing` rate card.
   *
   * Hetzner Cloud has no billing endpoint, so there is nothing to read actual
   * spend from: see the header of `cost-data.ts` for what that costs in
   * accuracy and why this collector never backfills. The rate-card cache lives
   * on the client, which the host builds once per collection pass, so the
   * month chunks of one pass share a single `/pricing` request.
   */
  /**
   * Server type list prices (net of VAT) from `/server_types`, in the
   * currency `/pricing` reports. See `price-catalog.ts`.
   */
  async fetchPriceCatalog(request: PriceCatalogRequest): Promise<PriceCatalogResult> {
    return fetchHetznerPriceCatalog(
      {
        fetchAll: (path, rootKey) => this.fetchAll(path, rootKey),
        currency: async () =>
          (await this.rateCardCache.load({ fetch: (path) => this.fetch(path) })).currency,
      },
      request,
    );
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchHetznerCostData(
      {
        fetch: (path) => this.fetch(path),
        fetchAll: (path, rootKey) => this.fetchAll(path, rootKey),
        now: new Date(),
        rateCard: this.rateCardCache,
      },
      range,
    );
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
      return "info";
  }
}

/** Types `updateSimple` edits, mapped to their API collection. */
const RENAMEABLE_COLLECTIONS: Record<string, string> = {
  certificate: "certificates",
  "floating-ip": "floating_ips",
  "primary-ip": "primary_ips",
  firewall: "firewalls",
  network: "networks",
  "load-balancer": "load_balancers",
  "placement-group": "placement_groups",
  "ssh-key": "ssh_keys",
};

/**
 * Server action ids `invokeAction` accepts. Most are Hetzner action names
 * verbatim (`POST /servers/{id}/actions/{name}`); `create_snapshot` and the
 * protection pair are composed from `create_image` / `change_protection`.
 */
const SERVER_ACTIONS = new Set([
  "poweron",
  "poweroff",
  "shutdown",
  "reboot",
  "reset",
  "create_snapshot",
  "enable_backup",
  "disable_backup",
  "enable_protection",
  "disable_protection",
]);

/**
 * Picker group for a server type. Hetzner names the family itself in
 * `category` (added 2025-08-25, e.g. "Shared vCPU", "Cost-Optimized") and the
 * CPU in `architecture`; the name-prefix guess is the fallback for payloads
 * without them.
 */
function categorizeServerType(
  st: Pick<HetznerServerType, "name" | "category" | "architecture">,
): string {
  const arch = st.architecture === "arm" ? "Arm64" : st.architecture === "x86" ? "x86" : undefined;
  if (st.category) return arch ? `${st.category} (${arch})` : st.category;
  const name = st.name;
  if (name.startsWith("cax")) return "Shared vCPU (Arm64)";
  if (name.startsWith("cx") || name.startsWith("cpx")) return "Shared vCPU (x86)";
  if (name.startsWith("ccx")) return "Dedicated vCPU (x86)";
  return "Other";
}

/**
 * Whether a server type can still be ordered somewhere. Deprecation moved
 * per location on 2025-09-24 (`locations[].deprecation`, `.available`), and
 * the top-level `deprecated` flag is removed on 2026-11-02, so both forms are
 * read: a type is offered when at least one of its locations is neither
 * deprecated nor temporarily unavailable.
 */
function isServerTypeOrderable(st: HetznerServerType): boolean {
  if (st.locations && st.locations.length > 0) {
    return st.locations.some((l) => !l.deprecation && l.available !== false);
  }
  return !st.deprecation && !st.deprecated;
}

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  created: string;
  public_net?: {
    ipv4?: { ip: string };
    ipv6?: { ip: string };
    /** Firewalls applied to the public interface: `{ id, status }`. */
    firewalls?: Array<{ id?: number; status?: string }>;
  };
  /** One entry per attached Network; `network` is the Network id. */
  private_net?: Array<{ ip: string; network?: number }>;
  server_type?: { name: string; cores: number; memory: number; disk: number };
  /** Actual root disk size in GB: stays put on change_type with upgrade_disk=false. */
  primary_disk_size?: number;
  location?: { name: string; city?: string };
  /** Removed from the API on 2026-07-01; kept for older payloads. */
  datacenter?: { name: string; location?: { name: string; city: string } };
  image?: { name: string; description: string };
  placement_group?: { id?: number; name?: string; type?: string } | null;
  /** Time window (UTC) automatic backups run in; null when backups are disabled. */
  backup_window?: string | null;
  protection?: { delete?: boolean; rebuild?: boolean };
  rescue_enabled?: boolean;
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
  description?: string | null;
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
  applied_to?: Array<{
    type?: string;
    server?: { id?: number };
    label_selector?: { selector?: string };
    /** Servers a label-selector entry currently resolves to. */
    applied_to_resources?: Array<{ type?: string; server?: { id?: number } }>;
  }>;
}

interface HetznerLocation {
  id: number;
  name: string;
  city: string;
  network_zone?: string;
  country: string;
  description: string;
}

interface HetznerServerType {
  id: number;
  name: string;
  cores: number;
  memory: number;
  disk: number;
  /** Removed from the API on 2026-11-02; superseded by `locations[].deprecation`. */
  deprecated?: boolean;
  deprecation?: { unavailable_after?: string; announced?: string } | null;
  category?: string;
  architecture?: "x86" | "arm";
  locations?: Array<{
    name: string;
    deprecation?: { unavailable_after?: string; announced?: string } | null;
    available?: boolean;
    recommended?: boolean;
  }>;
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
  architecture?: "x86" | "arm";
  /** Removed from the API on 2026-11-02; superseded by `deprecation`. */
  deprecated?: string | boolean | null;
  deprecation?: { unavailable_after?: string; announced?: string } | null;
}

interface HetznerNetwork {
  id: number;
  name: string;
  ip_range: string;
  subnets?: unknown[];
  routes?: unknown[];
  servers?: number[];
  load_balancers?: number[];
  expose_routes_to_vswitch?: boolean;
  /** Legacy spelling kept for payloads that used it. */
  exposes_routes_to_vswitch?: boolean;
  created: string;
}

interface HetznerLoadBalancer {
  id: number;
  name: string;
  status?: string;
  created: string;
  load_balancer_type?: { name: string };
  location?: { name: string };
  public_net?: { ipv4?: { ip: string }; ipv6?: { ip: string } };
  /** One entry per attached Network; `network` is the Network id. */
  private_net?: Array<{ network?: number; ip?: string }>;
  targets?: Array<{
    type?: string;
    server?: { id?: number };
    label_selector?: { selector?: string };
    /** Servers a label-selector target currently resolves to. */
    targets?: Array<{ type?: string; server?: { id?: number } }>;
  }>;
  services?: unknown[];
  protection?: { delete?: boolean };
}

interface HetznerLoadBalancerType {
  id: number;
  name: string;
  max_connections?: number;
  max_targets?: number;
  /** Superseded by `deprecation` (2026-06-05). */
  deprecated?: boolean | string | null;
  deprecation?: unknown;
  prices?: Array<{ location: string; price_monthly?: { net?: string; gross?: string } }>;
}

interface HetznerPrimaryIp {
  id: number;
  name: string;
  ip: string;
  type: string;
  created: string;
  location?: { name: string };
  /** Removed from the API on 2026-07-01; kept for older payloads. */
  datacenter?: { name: string; location?: { name: string } };
  assignee_id: number | null;
  assignee_type: string | null;
  blocked: boolean;
  auto_delete: boolean;
}

interface HetznerSshKey {
  id: number;
  name: string;
  public_key: string;
  fingerprint: string;
  created: string;
}

interface HetznerImageDetail extends HetznerImage {
  created: string;
  image_size: number | null;
  disk_size: number;
  bound_to: number | null;
}

interface HetznerPlacementGroup {
  id: number;
  name: string;
  type: string;
  servers?: number[];
  created: string;
}
