import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  SizeOption,
  ImageOption,
  SectionNode,
  BadgeNode,
} from "@infrawrench/plugin-base";
import { DOKSClusterResourceType } from "./resources/doks-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";

// ─── DNS helpers ────────────────────────────────────────────────────────────

const DNS_RECORD_TYPE_COLORS: Record<string, BadgeNode["color"]> = {
  A: "blue", AAAA: "blue", CNAME: "green", MX: "yellow", TXT: "gray",
  NS: "gray", SRV: "yellow", CAA: "red", SOA: "gray",
};

function dnsRecordBadgeColor(type: string): BadgeNode["color"] {
  return DNS_RECORD_TYPE_COLORS[type] ?? "gray";
}

function formatDnsTtl(ttl: number): string {
  if (ttl <= 0) return "Default";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

/**
 * DigitalOcean plugin client.
 * Created per account (per API token) by the host.
 * All API calls are made server-side — the token never reaches the browser.
 */
export class DigitalOceanClient implements PluginClient {
  private readonly token: string;
  private readonly credentials: Record<string, string>;
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
    this.credentials = credentials;
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
      case "domain":
        return this.listDomains(accountId);
      case "dns-record":
        return this.listAllDnsRecords(accountId);
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
        database: { connection: Record<string, string>; private_connection?: Record<string, string> };
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
        case "caCertificate": {
          const caData = await this.fetch<{ ca: { certificate: string } }>(`/databases/${resourceId}/ca`);
          return caData.ca.certificate;
        }
      }
    }

    if (typeId === "spaces-bucket") {
      // Spaces credentials are account-level (from the Spaces API keys), not bucket-specific
      if (outputKey === "endpoint") {
        const resource = await this.getResource(typeId, resourceId, _accountId);
        const region = String(resource.fields["region"] ?? "nyc3");
        return `https://${region}.digitaloceanspaces.com`;
      }
      if (outputKey === "accessKeyId") return this.credentials["spacesAccessKeyId"] ?? "";
      if (outputKey === "secretAccessKey") return this.credentials["spacesSecretAccessKey"] ?? "";
    }

    if (typeId === "domain" && outputKey === "nameservers") {
      return "ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com";
    }

    throw new Error(
      `DigitalOcean plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "droplet") {
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

    if (typeId === "doks-cluster") {
      const [optionsData, sizesData] = await Promise.all([
        this.fetch<{
          options?: {
            regions?: Array<{ slug: string; name: string }>;
            sizes?: Array<{ slug: string; name: string }>;
            versions?: Array<{ slug: string; kubernetes_version: string }>;
          };
        }>("/kubernetes/options"),
        this.fetch<{ sizes: Array<{ slug: string; memory: number; vcpus: number; disk: number; price_monthly: number; available: boolean; description: string }> }>("/sizes"),
      ]);

      const regions = (optionsData.options?.regions ?? []).map((region) => {
        const info = DigitalOceanClient.REGION_INFO[region.slug];
        return {
          id: region.slug,
          label: region.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });

      const availableSizeSlugs = new Set((optionsData.options?.sizes ?? []).map((size) => size.slug));
      const sizesByCategory = new Map<string, SizeOption[]>();
      for (const size of sizesData.sizes) {
        if (!size.available || !availableSizeSlugs.has(size.slug)) continue;
        const category = size.description || "Standard";
        if (!sizesByCategory.has(category)) sizesByCategory.set(category, []);
        sizesByCategory.get(category)!.push({
          id: size.slug,
          label: size.slug,
          vcpus: size.vcpus,
          memoryMb: size.memory,
          diskGb: size.disk,
          priceMonthly: size.price_monthly,
          category,
        });
      }
      const sizes = [...sizesByCategory.values()].flat();

      const versions = (optionsData.options?.versions ?? []).map((version) => ({
        id: version.slug,
        label: `${version.kubernetes_version} (${version.slug})`,
      }));
      const defaultRegion = regions[0]?.id;
      const defaultSize = sizes[0]?.id;
      const defaultVersion = versions[0]?.id;

      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "region", label: "Region", kind: "region-picker", required: true, regions, ...(defaultRegion ? { defaultValue: defaultRegion } : {}) },
          { key: "version", label: "Kubernetes Version", kind: "select", required: true, options: versions, ...(defaultVersion ? { defaultValue: defaultVersion } : {}) },
          { key: "nodePoolSize", label: "Node Pool Size", kind: "size-picker", required: true, sizes, ...(defaultSize ? { defaultValue: defaultSize } : {}) },
          {
            key: "nodeCount",
            label: "Node Count",
            kind: "number",
            required: true,
            defaultValue: "3",
            minValue: 1,
            stepValue: 1,
            description: "Initial number of nodes in the default node pool.",
          },
        ],
      };
    }

    throw new Error(`No create config for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId !== "droplet") throw new Error(`DigitalOcean plugin: deleteResource not supported for type "${typeId}"`);
    // resourceId format: "{accountId}:droplet:{externalId}"
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error("Cannot parse droplet ID");
    await this.fetch<unknown>(`/droplets/${externalId}`, { method: "DELETE" });
  }

  async createResource(typeId: string, accountId: string, fields: Record<string, string>): Promise<ResourceInstance> {
    if (typeId === "droplet") {
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

    if (typeId === "doks-cluster") {
      const requestedNodeCount = Number.parseInt(fields["nodeCount"] ?? "3", 10);
      const nodeCount = Number.isFinite(requestedNodeCount) && requestedNodeCount > 0
        ? requestedNodeCount
        : 3;
      const nodePoolNameBase = (fields["name"] ?? "cluster").trim() || "cluster";
      const body = {
        name: fields["name"],
        region: fields["region"],
        version: fields["version"] ?? "latest",
        node_pools: [
          {
            name: `${nodePoolNameBase}-default-pool`,
            size: fields["nodePoolSize"],
            count: nodeCount,
          },
        ],
      };
      const data = await this.fetch<{ kubernetes_cluster: Record<string, unknown> }>(
        "/kubernetes/clusters",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      const cluster = data.kubernetes_cluster;
      const nodePool = (cluster["node_pools"] as Array<Record<string, unknown>> | undefined)?.[0];
      return {
        id: `${accountId}:doks-cluster:${String(cluster["id"])}`,
        pluginId: "digitalocean",
        resourceTypeId: "doks-cluster",
        accountId,
        displayName: String(cluster["name"] ?? fields["name"] ?? "DOKS Cluster"),
        fields: {
          name: String(cluster["name"] ?? fields["name"] ?? ""),
          region: String(cluster["region"] ?? fields["region"] ?? ""),
          version: String(cluster["version"] ?? fields["version"] ?? ""),
          nodePoolSize: String(nodePool?.["size"] ?? fields["nodePoolSize"] ?? ""),
          nodeCount: Number(nodePool?.["count"] ?? nodeCount),
        },
        resolvedOutputs: {
          clusterEndpoint: String(cluster["endpoint"] ?? ""),
        },
        secretStates: [],
        externalId: String(cluster["id"]),
        createdAt: String(cluster["created_at"] ?? new Date().toISOString()),
        updatedAt: String(cluster["updated_at"] ?? cluster["created_at"] ?? new Date().toISOString()),
      };
    }

    throw new Error(`DigitalOcean plugin: createResource not supported for type "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    if (resource.resourceTypeId === "domain") {
      return this.renderDomainDetail(resource);
    }
    if (resource.resourceTypeId === "dns-record") {
      return this.renderDnsRecordDetail(resource);
    }
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: `${resource.resourceTypeId} \u00B7 ${String(fields["region"] ?? "")}`,
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

  private renderDomainDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Domain Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Domain", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Default TTL", value: formatDnsTtl(Number(fields["ttl"] ?? 0)) },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Nameservers",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "NS 1", value: "ns1.digitalocean.com", copyable: true },
              { key: "NS 2", value: "ns2.digitalocean.com", copyable: true },
              { key: "NS 3", value: "ns3.digitalocean.com", copyable: true },
            ],
          },
          {
            kind: "text",
            content: "Point your domain registrar to these nameservers to use DigitalOcean DNS.",
            variant: "muted",
          },
        ],
      },
    ];
    return {
      title: resource.displayName,
      subtitle: "DNS Domain",
      status: { kind: "status-dot", status: "healthy", label: "Active" },
      sections,
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderDnsRecordDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const type = String(fields["type"] ?? "");
    const name = String(fields["name"] ?? "");
    const data = String(fields["data"] ?? "");
    const ttl = Number(fields["ttl"] ?? 0);
    const priority = fields["priority"] !== undefined ? Number(fields["priority"]) : null;
    const domainName = String(fields["domainName"] ?? "");

    const infoItems: Array<{ key: string; value: string; copyable?: boolean }> = [
      { key: "Type", value: type },
      { key: "Name", value: name, copyable: true },
      { key: "Data", value: data, copyable: true },
      { key: "TTL", value: formatDnsTtl(ttl) },
    ];
    if (priority !== null && priority > 0) {
      infoItems.push({ key: "Priority", value: String(priority) });
    }
    if (fields["port"] !== undefined) {
      infoItems.push({ key: "Port", value: String(fields["port"]) });
    }
    if (fields["weight"] !== undefined) {
      infoItems.push({ key: "Weight", value: String(fields["weight"]) });
    }
    if (domainName) {
      infoItems.push({ key: "Domain", value: domainName });
    }
    if (fields["tag"]) {
      infoItems.push({ key: "Tag", value: String(fields["tag"]) });
    }

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Record Details",
        children: [
          { kind: "badge", label: type, color: dnsRecordBadgeColor(type) },
          { kind: "key-value-list", items: infoItems },
        ],
      },
    ];

    return {
      title: name,
      subtitle: `${type} \u2192 ${data.length > 50 ? `${data.slice(0, 47)}...` : data}`,
      status: { kind: "status-dot", status: "healthy" },
      sections,
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "dns-record") {
      const type = String(resource.fields["type"] ?? "");
      const name = String(resource.fields["name"] ?? "");
      const shortName = name.length > 30 ? `${name.slice(0, 27)}...` : name;
      return {
        id: resource.id,
        label: `${type}  ${shortName}`,
      };
    }
    if (resource.resourceTypeId === "domain") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: "healthy", label: "Active" },
      };
    }
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

  private async listDomains(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ domains: Array<Record<string, unknown>> }>("/domains");
    return (data.domains ?? []).map((d) => ({
      id: `${accountId}:domain:${String(d["name"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "domain",
      accountId,
      displayName: String(d["name"]),
      fields: {
        name: String(d["name"]),
        ttl: Number(d["ttl"] ?? 1800),
        zoneFile: String(d["zone_file"] ?? ""),
      },
      resolvedOutputs: {
        nameservers: "ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com",
      },
      secretStates: [],
      externalId: String(d["name"]),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  private async listAllDnsRecords(accountId: string): Promise<ResourceInstance[]> {
    const domains = await this.listDomains(accountId);
    const results: ResourceInstance[] = [];
    for (const domain of domains) {
      const domainName = String(domain.fields["name"]);
      try {
        const data = await this.fetch<{
          domain_records: Array<Record<string, unknown>>;
        }>(`/domains/${domainName}/records?per_page=200`);
        for (const r of data.domain_records ?? []) {
          const type = String(r["type"] ?? "");
          const name = String(r["name"] ?? "@");
          const displayName = name === "@" ? domainName : `${name}.${domainName}`;
          results.push({
            id: `${accountId}:dns-record:${domainName}/${String(r["id"])}`,
            pluginId: "digitalocean",
            resourceTypeId: "dns-record",
            accountId,
            displayName: `${type} ${displayName}`,
            fields: {
              type,
              name: displayName,
              data: String(r["data"] ?? ""),
              ttl: Number(r["ttl"] ?? 1800),
              ...(r["priority"] !== undefined && r["priority"] !== null ? { priority: Number(r["priority"]) } : {}),
              ...(r["port"] !== undefined && r["port"] !== null ? { port: Number(r["port"]) } : {}),
              ...(r["weight"] !== undefined && r["weight"] !== null ? { weight: Number(r["weight"]) } : {}),
              ...(r["flags"] !== undefined && r["flags"] !== null ? { flags: Number(r["flags"]) } : {}),
              ...(r["tag"] ? { tag: String(r["tag"]) } : {}),
              domainName,
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: `${domainName}/${String(r["id"])}`,
            parentResourceId: `${accountId}:domain:${domainName}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch {
        // Skip domains we can't read records for
      }
    }
    return results;
  }

  // Satisfy the required fields from DOKSClusterResourceType and ManagedDatabaseResourceType
  // so TypeScript knows they are used
  static readonly _resourceTypes = [DOKSClusterResourceType, ManagedDatabaseResourceType];
}
