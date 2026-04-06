import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  SizeOption,
  ImageOption,
} from "@infrawrench/plugin-base";
import { DOKSClusterResourceType } from "./resources/doks-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";

/**
 * DigitalOcean plugin client.
 * Created per account (per API token) by the host.
 * All API calls are made server-side — the token never reaches the browser.
 */
export class DigitalOceanClient implements PluginClient {
  private readonly token: string;
  private readonly baseUrl = "https://api.digitalocean.com/v2";

  private static readonly REGION_INFO: Record<string, { location: string; flag: string }> = {
    nyc1: { location: "New York City, USA",    flag: "🇺🇸" },
    nyc3: { location: "New York City, USA",    flag: "🇺🇸" },
    sfo2: { location: "San Francisco, USA",    flag: "🇺🇸" },
    sfo3: { location: "San Francisco, USA",    flag: "🇺🇸" },
    ams3: { location: "Amsterdam, Netherlands", flag: "🇳🇱" },
    fra1: { location: "Frankfurt, Germany",    flag: "🇩🇪" },
    sgp1: { location: "Singapore",             flag: "🇸🇬" },
    lon1: { location: "London, UK",            flag: "🇬🇧" },
    tor1: { location: "Toronto, Canada",       flag: "🇨🇦" },
    blr1: { location: "Bangalore, India",      flag: "🇮🇳" },
    syd1: { location: "Sydney, Australia",     flag: "🇦🇺" },
  };

  constructor(credentials: Record<string, string>) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("DigitalOcean plugin: missing apiToken credential");
    this.token = token;
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
      throw new Error(`DO API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "project":
        return this.listProjects(accountId);
      case "droplet":
        return this.listDroplets(accountId);
      case "doks-cluster":
        return this.listDOKSClusters(accountId);
      case "managed-database":
        return this.listManagedDatabases(accountId);
      case "spaces-bucket":
        return this.listSpacesBuckets(accountId);
      default:
        throw new Error(`DigitalOcean plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`DigitalOcean plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    if (typeId === "doks-cluster" && outputKey === "kubeconfig") {
      const data = await this.fetch<{ kubeconfig: string }>(
        `/kubernetes/clusters/${resourceId}/kubeconfig`,
      );
      return data.kubeconfig;
    }

    if (typeId === "managed-database") {
      const data = await this.fetch<{
        database: { connection: Record<string, string> };
      }>(`/databases/${resourceId}`);
      const conn = data.database.connection;
      switch (outputKey) {
        case "connectionString":
          return conn["uri"] ?? "";
        case "host":
          return conn["host"] ?? "";
        case "port":
          return conn["port"] ?? "";
        case "username":
          return conn["user"] ?? "";
        case "password":
          return conn["password"] ?? "";
        case "database":
          return conn["database"] ?? "";
      }
    }

    throw new Error(
      `DigitalOcean plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "droplet") throw new Error(`No create config for type "${typeId}"`);

    const [regionsData, sizesData, publicImagesData, privateImagesData] = await Promise.all([
      this.fetch<{ regions: Array<{ slug: string; name: string; available: boolean }> }>("/regions"),
      this.fetch<{ sizes: Array<{ slug: string; memory: number; vcpus: number; disk: number; price_monthly: number; available: boolean; description: string }> }>("/sizes"),
      this.fetch<{ images: Array<{ id: number; slug: string | null; name: string; distribution: string; type: string; public: boolean; status: string }> }>("/images?type=distribution&per_page=200"),
      this.fetch<{ images: Array<{ id: number; slug: string | null; name: string; distribution: string; type: string; public: boolean; status: string }> }>("/images?private=true&per_page=200"),
    ]);

    const regions = regionsData.regions
      .filter((r) => r.available)
      .map((r) => {
        const info = DigitalOceanClient.REGION_INFO[r.slug];
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });

    const sizesByCategory = new Map<string, SizeOption[]>();
    for (const s of sizesData.sizes) {
      if (!s.available) continue;
      const cat = s.description || "Standard";
      if (!sizesByCategory.has(cat)) sizesByCategory.set(cat, []);
      sizesByCategory.get(cat)!.push({
        id: s.slug, label: s.slug, vcpus: s.vcpus, memoryMb: s.memory,
        diskGb: s.disk, priceMonthly: s.price_monthly, category: cat,
      });
    }
    const sizes = [...sizesByCategory.values()].flat();

    // Build image list: public distribution images grouped by distro, then private images
    const imageMap = new Map<string, ImageOption[]>();
    for (const img of publicImagesData.images) {
      if (img.status !== "available") continue;
      const cat = img.distribution;
      if (!imageMap.has(cat)) imageMap.set(cat, []);
      imageMap.get(cat)!.push({ id: img.slug ?? String(img.id), label: img.name, category: cat });
    }
    const privateImages: ImageOption[] = privateImagesData.images
      .filter((i) => i.status === "available")
      .map((i) => ({ id: String(i.id), label: i.name, category: "My Snapshots", isOwned: true }));
    const images: ImageOption[] = [...[...imageMap.values()].flat(), ...privateImages];
    const defaultImage = images.find((i) => i.category === "Ubuntu")?.id ?? images[0]?.id;

    const firstRegion = regions[0]?.id;
    const firstSize = sizes[0]?.id;
    return {
      fields: [
        { key: "name",   label: "Name",   kind: "text",          required: true },
        { key: "region", label: "Region", kind: "region-picker", required: true, regions, ...(firstRegion ? { defaultValue: firstRegion } : {}) },
        { key: "size",   label: "Size",   kind: "size-picker",   required: true, sizes,   ...(firstSize   ? { defaultValue: firstSize }   : {}) },
        { key: "image",     label: "Image",   kind: "image-picker",  required: true,  images,  ...(defaultImage ? { defaultValue: defaultImage } : {}) },
        { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
      ],
    };
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId !== "droplet") throw new Error(`DigitalOcean plugin: deleteResource not supported for type "${typeId}"`);
    // resourceId format: "{accountId}:droplet:{externalId}"
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error("Cannot parse droplet ID");
    await this.fetch<unknown>(`/droplets/${externalId}`, { method: "DELETE" });
  }

  async createResource(typeId: string, accountId: string, fields: Record<string, string>): Promise<ResourceInstance> {
    if (typeId !== "droplet") {
      throw new Error(`DigitalOcean plugin: createResource not supported for type "${typeId}"`);
    }

    // SSH key: upload to DO account (idempotent — if it already exists DO returns the existing key)
    const sshKeyIds: number[] = [];
    const sshPub = fields["sshPublicKey"];
    if (sshPub) {
      try {
        const comment = sshPub.trim().split(" ")[2] ?? "infrawrench";
        type KeyResponse = { ssh_key: { id: number } } | { ssh_keys: Array<{ id: number; public_key: string }> };
        const keyData = await this.fetch<KeyResponse>(
          "/account/keys",
          { method: "POST", body: JSON.stringify({ name: comment, public_key: sshPub.trim() }) },
        ).catch(async (e: unknown) => {
          if (String(e).includes("422")) {
            return this.fetch<KeyResponse>("/account/keys");
          }
          throw e;
        });
        const keyId = "ssh_key" in keyData
          ? keyData.ssh_key.id
          : keyData.ssh_keys.find((k) => k.public_key.trim() === sshPub.trim())?.id;
        if (keyId) sshKeyIds.push(keyId);
      } catch { /* skip SSH key if upload fails */ }
    }

    const body: Record<string, unknown> = {
      name: fields["name"],
      region: fields["region"],
      size: fields["size"],
      image: fields["image"],
      ...(sshKeyIds.length > 0 ? { ssh_keys: sshKeyIds } : {}),
    };
    const data = await this.fetch<{ droplet: Record<string, unknown> }>("/droplets", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const d = data.droplet;
    const networks = d["networks"] as { v4?: Array<{ type: string; ip_address: string }> } | undefined;
    const publicIp = networks?.v4?.find((n) => n.type === "public")?.ip_address ?? "";
    const privateIp = networks?.v4?.find((n) => n.type === "private")?.ip_address ?? "";
    return {
      id: `${accountId}:droplet:${String(d["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      accountId,
      displayName: String(d["name"]),
      fields: {
        name: String(d["name"]),
        region: String((d["region"] as Record<string, unknown>)?.["slug"] ?? fields["region"]),
        size: String((d["size"] as Record<string, unknown>)?.["slug"] ?? fields["size"]),
        image: String((d["image"] as Record<string, unknown>)?.["slug"] ?? fields["image"]),
      },
      resolvedOutputs: { ipv4: publicIp, ipv4Private: privateIp },
      secretStates: [],
      externalId: String(d["id"]),
      createdAt: String(d["created_at"] ?? new Date().toISOString()),
      updatedAt: String(d["created_at"] ?? new Date().toISOString()),
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: `${resource.resourceTypeId} · ${String(fields["region"] ?? "")}`,
      status: { kind: "status-dot", status: "unknown" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(fields).map(([key, value]) => ({
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

  // ─── Private list helpers ─────────────────────────────────────────────────

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ projects: Array<Record<string, unknown>> }>("/projects");
    return data.projects.map((p) => ({
      id: `${accountId}:project:${String(p["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "project",
      accountId,
      displayName: String(p["name"]),
      fields: {
        name: String(p["name"]),
        purpose: String(p["purpose"] ?? ""),
        description: String(p["description"] ?? ""),
        environment: String(p["environment"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(p["id"]),
      createdAt: String(p["created_at"] ?? new Date().toISOString()),
      updatedAt: String(p["updated_at"] ?? new Date().toISOString()),
    }));
  }

  private async listDroplets(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ droplets: Array<Record<string, unknown>> }>("/droplets");
    return data.droplets.map((d) => ({
      id: `${accountId}:droplet:${String(d["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      accountId,
      displayName: String(d["name"]),
      fields: {
        name: String(d["name"]),
        region: String((d["region"] as Record<string, unknown>)?.["slug"] ?? ""),
        size: String((d["size"] as Record<string, unknown>)?.["slug"] ?? ""),
        image: String((d["image"] as Record<string, unknown>)?.["slug"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(d["id"]),
      createdAt: String(d["created_at"] ?? new Date().toISOString()),
      updatedAt: String(d["created_at"] ?? new Date().toISOString()),
    }));
  }

  private async listDOKSClusters(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{
      kubernetes_clusters: Array<Record<string, unknown>>;
    }>("/kubernetes/clusters");
    return data.kubernetes_clusters.map((c) => {
      const nodePool = (
        c["node_pools"] as Array<Record<string, unknown>> | undefined
      )?.[0];
      return {
        id: `${accountId}:doks-cluster:${String(c["id"])}`,
        pluginId: "digitalocean",
        resourceTypeId: "doks-cluster",
        accountId,
        displayName: String(c["name"]),
        fields: {
          name: String(c["name"]),
          region: String(c["region"] ?? ""),
          version: String(c["version"] ?? ""),
          nodePoolSize: String(nodePool?.["size"] ?? ""),
          nodeCount: Number(nodePool?.["count"] ?? 0),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: String(c["id"]),
        createdAt: String(c["created_at"] ?? new Date().toISOString()),
        updatedAt: String(c["updated_at"] ?? new Date().toISOString()),
      };
    });
  }

  private async listManagedDatabases(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{
      databases: Array<Record<string, unknown>>;
    }>("/databases");
    return data.databases.map((db) => ({
      id: `${accountId}:managed-database:${String(db["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "managed-database",
      accountId,
      displayName: String(db["name"]),
      fields: {
        name: String(db["name"]),
        engine: String(db["engine"] ?? ""),
        version: String(db["version"] ?? ""),
        region: String(db["region"] ?? ""),
        size: String(db["size"] ?? ""),
        nodeCount: Number(db["num_nodes"] ?? 1),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(db["id"]),
      createdAt: String(db["created_at"] ?? new Date().toISOString()),
      updatedAt: String(db["created_at"] ?? new Date().toISOString()),
    }));
  }

  private async listSpacesBuckets(accountId: string): Promise<ResourceInstance[]> {
    // Spaces uses S3-compatible API — stub for now
    return [];
  }

  // Satisfy the required fields from DOKSClusterResourceType and ManagedDatabaseResourceType
  // so TypeScript knows they are used
  static readonly _resourceTypes = [DOKSClusterResourceType, ManagedDatabaseResourceType];
}
