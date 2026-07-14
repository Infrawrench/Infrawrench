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
  MetricSeries,
  HostServices,
} from "@infrawrench/plugin-base";
import { labeledFieldItems, resourceTypeDisplayName } from "@infrawrench/plugin-base";

function ovhSshUsername(imageName: string): string {
  const lower = imageName.toLowerCase();
  if (lower.includes("ubuntu")) return "ubuntu";
  if (lower.includes("debian")) return "debian";
  if (lower.includes("centos")) return "centos";
  if (lower.includes("fedora")) return "fedora";
  return "root";
}

/**
 * Normalize an OVH managed-Kafka `endpoint.uri` to the form the kafka
 * plugin's driver expects: explicit `sasl=scram-sha-512` and `ssl=true`
 * query params. OVH's Kafka offering uses SASL/SCRAM-SHA-512 over TLS.
 */
function normalizeKafkaUri(uri: string): string {
  if (!uri) return uri;
  let normalized = uri.startsWith("kafkas://") ? `kafka://${uri.slice("kafkas://".length)}` : uri;
  const queryIdx = normalized.indexOf("?");
  const base = queryIdx === -1 ? normalized : normalized.slice(0, queryIdx);
  const params = new URLSearchParams(queryIdx === -1 ? "" : normalized.slice(queryIdx + 1));
  if (!params.has("sasl")) params.set("sasl", "scram-sha-512");
  if (!params.has("ssl")) params.set("ssl", "true");
  normalized = `${base}?${params.toString()}`;
  return normalized;
}

function headersFromInit(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** Map OVH's MetricUnitEnum to the short units the metrics chart renders. */
function ovhMetricUnit(units: string): string {
  switch (units) {
    case "PERCENT":
      return "%";
    case "BYTES":
      return "bytes";
    case "BYTES_PER_SECOND":
      return "bytes/s";
    case "MEGABYTES":
      return "MB";
    case "MEGABYTES_PER_SECOND":
      return "MB/s";
    case "GIGABYTES":
      return "GB";
    case "GIGABYTES_PER_HOUR":
      return "GB/h";
    case "MILLISECONDS":
      return "ms";
    case "SECONDS":
      return "s";
    case "SCALAR_PER_SECOND":
      return "/s";
    default:
      return "";
  }
}

function stringifyAddress(address: unknown): string {
  if (!address || typeof address !== "object") return "";
  const value = address as Record<string, unknown>;
  return String(value["ip"] ?? value["address"] ?? value["ipv4"] ?? value["value"] ?? "");
}

function stringifyAssociatedEntity(entity: unknown): string {
  if (!entity || typeof entity !== "object") return "";
  const value = entity as Record<string, unknown>;
  return [value["type"], value["id"], value["name"]]
    .filter((part) => part != null && part !== "")
    .join(":");
}

/**
 * OVHcloud plugin client.
 * Created per account (per credential set) by the host.
 *
 * OVH uses a signature-based authentication scheme:
 *   X-Ovh-Application: <applicationKey>
 *   X-Ovh-Timestamp: <timestamp>
 *   X-Ovh-Consumer: <consumerKey>
 *   X-Ovh-Signature: $1$<SHA1(applicationSecret+"+"+consumerKey+"+"+method+"+"+url+"+"+body+"+"+timestamp)>
 */
export class OvhClient implements PluginClient {
  private readonly applicationKey: string;
  private readonly applicationSecret: string;
  private readonly consumerKey: string;
  private readonly projectId: string;
  private readonly baseUrl: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;
  private timeDelta: number | null = null;

  private static readonly ENDPOINT_URLS: Record<string, string> = {
    eu: "https://eu.api.ovh.com/1.0",
    ca: "https://ca.api.ovh.com/1.0",
    us: "https://api.us.ovhcloud.com/1.0",
  };

  private static readonly REGION_INFO: Record<string, { location: string; flag: string }> = {
    GRA1: { location: "Gravelines, France", flag: "🇫🇷" },
    GRA3: { location: "Gravelines, France", flag: "🇫🇷" },
    GRA5: { location: "Gravelines, France", flag: "🇫🇷" },
    GRA7: { location: "Gravelines, France", flag: "🇫🇷" },
    GRA9: { location: "Gravelines, France", flag: "🇫🇷" },
    GRA11: { location: "Gravelines, France", flag: "🇫🇷" },
    SBG5: { location: "Strasbourg, France", flag: "🇫🇷" },
    BHS5: { location: "Beauharnois, Canada", flag: "🇨🇦" },
    WAW1: { location: "Warsaw, Poland", flag: "🇵🇱" },
    DE1: { location: "Frankfurt, Germany", flag: "🇩🇪" },
    UK1: { location: "London, United Kingdom", flag: "🇬🇧" },
    SGP1: { location: "Singapore", flag: "🇸🇬" },
    SYD1: { location: "Sydney, Australia", flag: "🇦🇺" },
  };

  private readonly resourceTypes: ResourceTypeDefinition[];

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    const ak = credentials["applicationKey"];
    const as = credentials["applicationSecret"];
    const ck = credentials["consumerKey"];
    const pid = credentials["projectId"];
    if (!ak) throw new Error("OVH plugin: missing applicationKey credential");
    if (!as) throw new Error("OVH plugin: missing applicationSecret credential");
    if (!ck) throw new Error("OVH plugin: missing consumerKey credential");
    if (!pid) throw new Error("OVH plugin: missing projectId credential");

    this.applicationKey = ak;
    this.applicationSecret = as;
    this.consumerKey = ck;
    this.projectId = pid;
    this.resourceTypes = resourceTypes;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;

    const endpoint = (credentials["endpoint"] ?? "eu").toLowerCase();
    this.baseUrl = OvhClient.ENDPOINT_URLS[endpoint] ?? OvhClient.ENDPOINT_URLS["eu"]!;
  }

  private async sha1(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-1", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async getTimestamp(): Promise<number> {
    if (this.timeDelta === null) {
      try {
        let serverTime: number;
        if (this.services?.http) {
          const result = await this.services.http.request({
            url: `${this.baseUrl}/auth/time`,
            method: "GET",
            headers: {},
            ...(this.caCert ? { caCert: this.caCert } : {}),
          });
          if (result.status < 200 || result.status >= 300) {
            throw new Error(`OVH API error ${result.status} for /auth/time: ${result.body}`);
          }
          serverTime = Number(JSON.parse(result.body));
        } else {
          const res = await fetch(`${this.baseUrl}/auth/time`);
          serverTime = (await res.json()) as number;
        }
        this.timeDelta = serverTime - Math.floor(Date.now() / 1000);
      } catch {
        this.timeDelta = 0;
      }
    }
    return Math.floor(Date.now() / 1000) + this.timeDelta;
  }

  private async sign(
    method: string,
    url: string,
    body: string,
    timestamp: number,
  ): Promise<string> {
    const toSign = [
      this.applicationSecret,
      this.consumerKey,
      method.toUpperCase(),
      url,
      body,
      String(timestamp),
    ].join("+");
    const hash = await this.sha1(toSign);
    return `$1$${hash}`;
  }

  private async ovhFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const method = (options?.method ?? "GET").toUpperCase();
    const url = `${this.baseUrl}${path}`;
    const body = options?.body ? String(options.body) : "";
    const timestamp = await this.getTimestamp();
    const signature = await this.sign(method, url, body, timestamp);
    const headers = {
      "Content-Type": "application/json",
      "X-Ovh-Application": this.applicationKey,
      "X-Ovh-Timestamp": String(timestamp),
      "X-Ovh-Consumer": this.consumerKey,
      "X-Ovh-Signature": signature,
      ...headersFromInit(options?.headers),
    };

    if (this.services?.http) {
      const result = await this.services.http.request({
        url,
        method,
        headers,
        ...(body ? { body } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`OVH API error ${result.status} for ${path}: ${result.body}`);
      }
      if (result.status === 204 || !result.body) return undefined as unknown as T;
      return JSON.parse(result.body) as T;
    }

    const res = await fetch(url, {
      ...options,
      method,
      headers,
    });

    if (!res.ok) {
      throw new Error(`OVH API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  private databaseEnginePath(engine: string): string {
    const safeEngine = engine.trim().toLowerCase();
    if (!safeEngine) throw new Error("OVH plugin: managed database engine is required");
    return `/database/${encodeURIComponent(safeEngine)}`;
  }

  private serviceDisplayName(svc: OvhDatabaseService): string {
    const engine = svc.engine ?? "database";
    return svc.description || `${engine} (${svc.id.slice(0, 8)})`;
  }

  private cloudPath(suffix: string): string {
    return `/cloud/project/${this.projectId}${suffix}`;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "instance":
        return this.listInstances(accountId);
      case "managed-kube":
        return this.listManagedKubeClusters(accountId);
      case "managed-db":
        return this.listManagedDatabases(accountId);
      case "volume":
        return this.listVolumes(accountId);
      case "object-storage-bucket":
        return this.listObjectStorageBuckets(accountId);
      case "load-balancer":
        return this.listLoadBalancers(accountId);
      case "private-network":
        return this.listPrivateNetworks(accountId);
      case "floating-ip":
        return this.listFloatingIps(accountId);
      case "gateway":
        return this.listGateways(accountId);
      default:
        throw new Error(`OVH plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`OVH plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "managed-kube" && outputKey === "kubeconfig") {
      const externalId = resourceId.split(":").pop();
      if (!externalId) throw new Error("Cannot parse cluster ID");
      const data = await this.ovhFetch<{ content: string }>(
        this.cloudPath(`/kube/${externalId}/kubeconfig`),
        { method: "POST", body: JSON.stringify({}) },
      );
      return data.content;
    }

    if (typeId === "managed-db") {
      const externalId = resourceId.split(":").pop();
      if (!externalId) throw new Error("Cannot parse database service ID");
      const svc = await this.ovhFetch<OvhDatabaseService>(
        this.cloudPath(`/database/service/${externalId}`),
      );
      const endpoint = svc.endpoints?.[0];
      const engine = String(svc.engine ?? "");
      switch (outputKey) {
        case "connectionString": {
          const uri = endpoint?.uri ?? "";
          if (engine === "kafka") return normalizeKafkaUri(uri);
          return uri;
        }
        case "host":
          return endpoint?.domain ?? "";
        case "port":
          return String(endpoint?.port ?? "");
        case "username": {
          // Fetch users for this service
          const users = await this.ovhFetch<Array<{ username: string }>>(
            this.cloudPath(`/database/service/${externalId}/user`),
          );
          return users[0]?.username ?? "";
        }
        case "password":
          // Password must be reset/retrieved separately — cannot be read from the API after creation
          return "";
        case "database":
          return svc.description ?? "";
      }
    }

    // For instance outputs, re-fetch the resource to get IPs
    if (typeId === "instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return resource.resolvedOutputs[outputKey] ?? "";
    }

    if (typeId === "object-storage-bucket" && outputKey === "endpoint") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const region = String(resource.fields["region"] ?? "");
      return region ? `https://s3.${region.toLowerCase()}.io.cloud.ovh.net` : "";
    }

    if (typeId === "load-balancer" && outputKey === "address") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return resource.resolvedOutputs[outputKey] ?? "";
    }

    if (typeId === "floating-ip" && outputKey === "ip") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return resource.resolvedOutputs[outputKey] ?? "";
    }

    throw new Error(`OVH plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "instance") {
      const [flavorsData, imagesData, regionsData] = await Promise.all([
        this.ovhFetch<OvhFlavor[]>(this.cloudPath("/flavor")),
        this.ovhFetch<OvhImage[]>(this.cloudPath("/image")),
        this.ovhFetch<OvhRegion[]>(this.cloudPath("/region")),
      ]);

      const regions = regionsData
        .filter((r) => r.status === "UP")
        .map((r) => {
          const info = OvhClient.REGION_INFO[r.name];
          return {
            id: r.name,
            label: r.name,
            ...(info ? { location: info.location, flag: info.flag } : {}),
          };
        });

      // Group flavors by type (e.g. "General Purpose", "CPU", "RAM", "GPU")
      const sizesByCategory = new Map<string, SizeOption[]>();
      for (const f of flavorsData) {
        if (!f.available) continue;
        const cat = f.type ?? "General Purpose";
        if (!sizesByCategory.has(cat)) sizesByCategory.set(cat, []);
        sizesByCategory.get(cat)!.push({
          id: f.id,
          label: f.name,
          vcpus: f.vcpus,
          memoryMb: f.ram,
          diskGb: f.disk,
          category: cat,
        });
      }
      const sizes = [...sizesByCategory.values()].flat();

      // Build image list grouped by OS type
      const imageMap = new Map<string, ImageOption[]>();
      // Only show active, non-deprecated images
      for (const img of imagesData) {
        if (img.status !== "active") continue;
        const cat = img.flavorType ?? "General";
        // Group by OS type
        const osCat = img.type ?? "linux";
        const groupLabel = osCat.charAt(0).toUpperCase() + osCat.slice(1);
        if (!imageMap.has(groupLabel)) imageMap.set(groupLabel, []);
        imageMap.get(groupLabel)!.push({
          id: img.id,
          label: img.name,
          category: groupLabel,
        });
      }
      const images: ImageOption[] = [...imageMap.values()].flat();
      const defaultImage =
        images.find((i) => i.label.toLowerCase().includes("ubuntu"))?.id ?? images[0]?.id;

      const firstRegion = regions[0]?.id;
      const firstSize = sizes[0]?.id;

      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            ...(firstRegion ? { defaultValue: firstRegion } : {}),
          },
          {
            key: "flavorId",
            label: "Size",
            kind: "size-picker",
            required: true,
            sizes,
            ...(firstSize ? { defaultValue: firstSize } : {}),
          },
          {
            key: "imageId",
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

    if (typeId === "managed-kube") {
      const [regionsData, flavorsData] = await Promise.all([
        this.ovhFetch<OvhRegion[]>(this.cloudPath("/region")),
        this.ovhFetch<OvhFlavor[]>(this.cloudPath("/flavor")).catch(() => [] as OvhFlavor[]),
      ]);
      const regions = regionsData
        .filter((r) => r.status === "UP")
        .map((r) => {
          const info = OvhClient.REGION_INFO[r.name];
          return {
            id: r.name,
            label: r.name,
            ...(info ? { location: info.location, flag: info.flag } : {}),
          };
        });

      // Group flavors by name (across regions) so the picker shows one row per
      // commercial type. OVH's node pool API takes `flavorName` (e.g. "b3-8"),
      // not the per-region flavor id.
      const sizesByName = new Map<string, SizeOption>();
      for (const f of flavorsData) {
        if (!f.available) continue;
        if (sizesByName.has(f.name)) continue;
        sizesByName.set(f.name, {
          id: f.name,
          label: f.name,
          vcpus: f.vcpus,
          memoryMb: f.ram,
          diskGb: f.disk,
          category: f.type ?? "General Purpose",
        });
      }
      const sizes = [...sizesByName.values()];

      const defaultRegion = regions[0]?.id;
      const defaultSize = sizes.find((s) => s.id === "b3-8")?.id ?? sizes[0]?.id;

      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            ...(defaultRegion ? { defaultValue: defaultRegion } : {}),
          },
          {
            key: "version",
            label: "Kubernetes Version",
            kind: "select",
            required: true,
            options: [
              { id: "1.31", label: "1.31" },
              { id: "1.30", label: "1.30" },
              { id: "1.29", label: "1.29" },
            ],
            defaultValue: "1.31",
          },
          {
            key: "flavor",
            label: "Node Flavor",
            kind: "size-picker",
            required: true,
            sizes,
            ...(defaultSize ? { defaultValue: defaultSize } : {}),
          },
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

    if (typeId === "managed-db") {
      return {
        fields: [
          { key: "description", label: "Name / Description", kind: "text", required: true },
          {
            key: "engine",
            label: "Engine",
            kind: "select",
            required: true,
            options: [
              { id: "postgresql", label: "PostgreSQL" },
              { id: "mysql", label: "MySQL" },
              { id: "mongodb", label: "MongoDB" },
              { id: "redis", label: "Redis" },
              { id: "kafka", label: "Kafka" },
              { id: "opensearch", label: "OpenSearch" },
            ],
            defaultValue: "postgresql",
          },
          {
            key: "version",
            label: "Version",
            kind: "text",
            required: true,
            defaultValue: "16",
            description: "Engine version, e.g. 16 for PostgreSQL 16",
          },
          {
            key: "plan",
            label: "Plan",
            kind: "select",
            required: true,
            options: [
              { id: "essential", label: "Essential" },
              { id: "business", label: "Business" },
              { id: "enterprise", label: "Enterprise" },
            ],
            defaultValue: "essential",
          },
          {
            // The full flavor list varies by region/engine/plan and OVH adds
            // new generations frequently — we keep this as text rather than a
            // curated select to avoid offering a flavor that errors at order
            // time. The capabilities endpoint
            // (/cloud/project/$pid/database/capabilities) returns the
            // currently-orderable set if we ever wire it through.
            key: "flavor",
            label: "Flavor",
            kind: "text",
            required: true,
            defaultValue: "db1-7",
            description:
              "Node flavor, e.g. db1-4, db1-7, db1-15. Available flavors depend on engine/plan/region.",
          },
          {
            key: "nodeCount",
            label: "Node Count",
            kind: "number",
            required: true,
            defaultValue: "1",
            minValue: 1,
          },
          {
            key: "region",
            label: "Region",
            kind: "text",
            required: true,
            defaultValue: "GRA",
            description: "Database node region, e.g. GRA, SBG, BHS.",
          },
        ],
      };
    }

    if (typeId === "volume") {
      const regionsData = await this.ovhFetch<OvhRegion[]>(this.cloudPath("/region"));
      const regions = regionsData
        .filter((r) => r.status === "UP")
        .map((r) => {
          const info = OvhClient.REGION_INFO[r.name];
          return {
            id: r.name,
            label: r.name,
            ...(info ? { location: info.location, flag: info.flag } : {}),
          };
        });
      const defaultRegion = regions[0]?.id;
      return {
        fields: [
          { key: "name", label: "Volume Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            ...(defaultRegion ? { defaultValue: defaultRegion } : {}),
          },
          {
            key: "size",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 10,
            maxGb: 4000,
            defaultGb: 100,
            stepGb: 10,
          },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "classic",
            options: [
              { id: "classic", label: "Classic (HDD)" },
              { id: "high-speed", label: "High Speed (SSD)" },
              { id: "high-speed-gen2", label: "High Speed Gen2 (NVMe)" },
              { id: "classic-luks", label: "Classic · LUKS encrypted" },
              { id: "high-speed-luks", label: "High Speed · LUKS encrypted" },
              { id: "high-speed-gen2-luks", label: "High Speed Gen2 · LUKS encrypted" },
            ],
          },
        ],
      };
    }

    if (typeId === "object-storage-bucket") {
      const regionsData = await this.ovhFetch<OvhRegion[]>(this.cloudPath("/region"));
      const regions = regionsData
        .filter((r) => r.status === "UP")
        .map((r) => {
          const info = OvhClient.REGION_INFO[r.name];
          return {
            id: r.name,
            label: r.name,
            ...(info ? { location: info.location, flag: info.flag } : {}),
          };
        });
      const defaultRegion = regions[0]?.id;
      return {
        fields: [
          { key: "name", label: "Bucket Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            ...(defaultRegion ? { defaultValue: defaultRegion } : {}),
          },
        ],
      };
    }

    if (typeId === "load-balancer") {
      const regions = await this.ovhFetch<string[]>(
        this.cloudPath("/capabilities/loadbalancer/region"),
      ).catch(async () => {
        const regionsData = await this.ovhFetch<OvhRegion[]>(this.cloudPath("/region"));
        return regionsData.filter((r) => r.status === "UP").map((r) => r.name);
      });
      const regionOptions = regions.map((id) => {
        const info = OvhClient.REGION_INFO[id];
        return {
          id,
          label: id,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
      const defaultRegion = regionOptions[0]?.id;
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: regionOptions,
            ...(defaultRegion ? { defaultValue: defaultRegion } : {}),
          },
          {
            key: "size",
            label: "Size",
            kind: "select",
            required: true,
            defaultValue: "SMALL",
            options: [
              { id: "SMALL", label: "Small" },
              { id: "MEDIUM", label: "Medium" },
              { id: "LARGE", label: "Large" },
            ],
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    }

    if (typeId === "private-network") {
      const regionsData = await this.ovhFetch<OvhRegion[]>(this.cloudPath("/region"));
      const regions = regionsData
        .filter((r) => r.status === "UP")
        .map((r) => {
          const info = OvhClient.REGION_INFO[r.name];
          return {
            id: r.name,
            label: r.name,
            ...(info ? { location: info.location, flag: info.flag } : {}),
          };
        });
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: false,
            regions,
            description: "Optional. Leave empty to let OVH activate the network in all regions.",
          },
          {
            key: "vlanId",
            label: "VLAN ID",
            kind: "number",
            required: false,
            minValue: 0,
            maxValue: 4095,
            description: "Optional VLAN ID. 0 means no VLAN.",
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
  ): Promise<ResourceInstance> {
    if (typeId === "instance") {
      // Upload SSH key if provided
      let sshKeyId: string | undefined;
      const sshPub = fields["sshPublicKey"];
      if (sshPub) {
        try {
          const comment = sshPub.trim().split(" ")[2] ?? "infrawrench";
          const keyData = await this.ovhFetch<{ id: string }>(this.cloudPath("/sshkey"), {
            method: "POST",
            body: JSON.stringify({ name: comment, publicKey: sshPub.trim() }),
          }).catch(async () => {
            // Key may already exist — find it
            const keys = await this.ovhFetch<Array<{ id: string; publicKey: string }>>(
              this.cloudPath("/sshkey"),
            );
            return keys.find((k) => k.publicKey.trim() === sshPub.trim());
          });
          sshKeyId = keyData?.id;
        } catch {
          /* skip SSH key if upload fails */
        }
      }

      const body: Record<string, unknown> = {
        name: fields["name"],
        flavorId: fields["flavorId"],
        imageId: fields["imageId"],
        region: fields["region"],
        ...(sshKeyId ? { sshKeyId } : {}),
      };

      const instance = await this.ovhFetch<OvhInstance>(this.cloudPath("/instance"), {
        method: "POST",
        body: JSON.stringify(body),
      });

      const publicIp =
        instance.ipAddresses?.find((ip) => ip.type === "public" && ip.version === 4)?.ip ?? "";
      const privateIp =
        instance.ipAddresses?.find((ip) => ip.type === "private" && ip.version === 4)?.ip ?? "";

      return {
        id: `${accountId}:instance:${instance.id}`,
        pluginId: "ovh",
        resourceTypeId: "instance",
        accountId,
        displayName: instance.name,
        fields: {
          name: instance.name,
          region: instance.region,
          flavorName: instance.flavor?.name ?? fields["flavorId"] ?? "",
          imageName: instance.image?.name ?? fields["imageId"] ?? "",
          status: instance.status,
          sshUsername: ovhSshUsername(instance.image?.name ?? ""),
        },
        resolvedOutputs: { ipv4: publicIp, ipv4Private: privateIp },
        secretStates: [],
        externalId: instance.id,
        createdAt: instance.created ?? new Date().toISOString(),
        updatedAt: instance.created ?? new Date().toISOString(),
      };
    }

    if (typeId === "managed-kube") {
      const requestedNodeCount = Number.parseInt(fields["nodeCount"] ?? "3", 10);
      const nodeCount =
        Number.isFinite(requestedNodeCount) && requestedNodeCount > 0 ? requestedNodeCount : 3;
      const flavorName = fields["flavor"] ?? "b3-8";
      const clusterName = fields["name"] ?? "";

      const body = {
        name: clusterName,
        region: fields["region"],
        version: fields["version"] ?? "1.31",
      };

      const cluster = await this.ovhFetch<OvhKubeCluster>(this.cloudPath("/kube"), {
        method: "POST",
        body: JSON.stringify(body),
      });

      // OVH lets us create node pools immediately after the cluster POST —
      // unlike EKS, the cluster doesn't need to be ACTIVE first.
      const poolName = `${clusterName || "cluster"}-default-pool`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 40);
      let nodePoolCount = 0;
      try {
        await this.ovhFetch<OvhKubeNodePool>(this.cloudPath(`/kube/${cluster.id}/nodepool`), {
          method: "POST",
          body: JSON.stringify({
            name: poolName,
            flavorName,
            desiredNodes: nodeCount,
            monthlyBilled: false,
            autoscale: false,
            antiAffinity: false,
          }),
        });
        nodePoolCount = 1;
      } catch (e) {
        // Surface the failure but keep the cluster — the user can add a pool by hand
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Cluster ${clusterName} created but node pool creation failed: ${msg}. Delete the cluster and retry, or add a node pool via the OVH console.`,
          { cause: e },
        );
      }

      return {
        id: `${accountId}:managed-kube:${cluster.id}`,
        pluginId: "ovh",
        resourceTypeId: "managed-kube",
        accountId,
        displayName: cluster.name ?? fields["name"] ?? "OVH Kubernetes",
        fields: {
          name: cluster.name ?? fields["name"] ?? "",
          region: cluster.region ?? fields["region"] ?? "",
          version: cluster.version ?? fields["version"] ?? "",
          status: cluster.status ?? "INSTALLING",
          flavor: flavorName,
          nodeCount,
          nodePoolCount,
          nodesUrl: cluster.nodesUrl ?? "",
        },
        resolvedOutputs: {
          clusterUrl: cluster.url ?? "",
        },
        secretStates: [],
        externalId: cluster.id,
        createdAt: cluster.createdAt ?? new Date().toISOString(),
        updatedAt: cluster.updatedAt ?? cluster.createdAt ?? new Date().toISOString(),
      };
    }

    if (typeId === "managed-db") {
      const engine = fields["engine"] ?? "postgresql";
      const nodeCount = Math.max(1, Number(fields["nodeCount"] ?? 1) || 1);
      const region = fields["region"] ?? "GRA";
      const flavor = fields["flavor"] ?? "db1-7";
      const data = await this.ovhFetch<OvhDatabaseService>(
        this.cloudPath(this.databaseEnginePath(engine)),
        {
          method: "POST",
          body: JSON.stringify({
            description: fields["description"] ?? "",
            version: fields["version"] ?? "16",
            plan: fields["plan"] ?? "essential",
            nodesPattern: {
              flavor,
              number: nodeCount,
              region,
            },
          }),
        },
      );
      const now = new Date().toISOString();
      return {
        id: `${accountId}:managed-db:${data.id}`,
        pluginId: "ovh",
        resourceTypeId: "managed-db",
        accountId,
        displayName: this.serviceDisplayName({ ...data, engine }),
        fields: {
          description: data.description ?? "",
          engine: data.engine ?? fields["engine"] ?? "",
          version: data.version ?? fields["version"] ?? "",
          plan: data.plan ?? fields["plan"] ?? "",
          region: data.nodes?.[0]?.region ?? region,
          flavor: data.flavor ?? flavor,
          nodeCount: data.nodeNumber ?? data.nodes?.length ?? nodeCount,
          status: data.status ?? "CREATING",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: data.id,
        createdAt: data.createdAt ?? now,
        updatedAt: data.updatedAt ?? data.createdAt ?? now,
      };
    }

    if (typeId === "volume") {
      const data = await this.ovhFetch<{
        id: string;
        name?: string;
        region: string;
        size: number;
        type: string;
        status?: string;
        bootable?: boolean;
        attachedTo?: string[];
        creationDate?: string;
      }>(this.cloudPath("/volume"), {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"],
          region: fields["region"],
          size: Number(fields["size"] ?? 100),
          type: fields["type"] ?? "classic",
        }),
      });
      const now = new Date().toISOString();
      return {
        id: `${accountId}:volume:${data.id}`,
        pluginId: "ovh",
        resourceTypeId: "volume",
        accountId,
        displayName: data.name ?? fields["name"] ?? data.id,
        fields: {
          name: data.name ?? fields["name"] ?? "",
          region: data.region,
          sizeGb: data.size,
          type: data.type,
          status: data.status ?? "creating",
          bootable: data.bootable ?? false,
          attachedTo: (data.attachedTo ?? []).join(","),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: data.id,
        createdAt: data.creationDate ?? now,
        updatedAt: now,
      };
    }

    if (typeId === "object-storage-bucket") {
      const region = fields["region"] ?? "";
      const data = await this.ovhFetch<OvhStorageContainer>(
        this.cloudPath(`/region/${enc(region)}/storage`),
        {
          method: "POST",
          body: JSON.stringify({ name: fields["name"] ?? "" }),
        },
      );
      return this.mapObjectStorageBucket(data, region, accountId);
    }

    if (typeId === "load-balancer") {
      const data = await this.ovhFetch<OvhLoadBalancer>(this.cloudPath("/loadbalancer"), {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"] ?? "",
          region: fields["region"] ?? "",
          size: fields["size"] ?? "SMALL",
          ...(fields["description"] ? { description: fields["description"] } : {}),
        }),
      });
      return this.mapLoadBalancer(data, accountId);
    }

    if (typeId === "private-network") {
      const region = fields["region"] ?? "";
      const vlanId = fields["vlanId"];
      const data = await this.ovhFetch<OvhPrivateNetwork>(this.cloudPath("/network/private"), {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"] ?? "",
          ...(region ? { regions: [region] } : {}),
          ...(vlanId ? { vlanId: Number(vlanId) } : {}),
        }),
      });
      return this.mapPrivateNetwork(data, accountId);
    }

    throw new Error(`OVH plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error("Cannot parse resource ID");

    switch (typeId) {
      case "instance":
        await this.ovhFetch<unknown>(this.cloudPath(`/instance/${externalId}`), {
          method: "DELETE",
        });
        break;
      case "managed-kube":
        await this.ovhFetch<unknown>(this.cloudPath(`/kube/${externalId}`), { method: "DELETE" });
        break;
      case "managed-db": {
        const svc = await this.ovhFetch<OvhDatabaseService>(
          this.cloudPath(`/database/service/${externalId}`),
        );
        await this.ovhFetch<unknown>(
          this.cloudPath(`${this.databaseEnginePath(svc.engine ?? "")}/${externalId}`),
          { method: "DELETE" },
        );
        break;
      }
      case "volume":
        await this.ovhFetch<unknown>(this.cloudPath(`/volume/${externalId}`), { method: "DELETE" });
        break;
      case "object-storage-bucket": {
        const [region, ...nameParts] = externalId.split("/");
        const name = nameParts.join("/");
        if (!region || !name) throw new Error("Cannot parse object storage bucket ID");
        await this.ovhFetch<unknown>(
          this.cloudPath(`/region/${enc(region)}/storage/${enc(name)}`),
          {
            method: "DELETE",
          },
        );
        break;
      }
      case "load-balancer":
        await this.ovhFetch<unknown>(this.cloudPath(`/loadbalancer/${enc(externalId)}`), {
          method: "DELETE",
        });
        break;
      case "private-network":
        await this.ovhFetch<unknown>(this.cloudPath(`/network/private/${enc(externalId)}`), {
          method: "DELETE",
        });
        break;
      case "floating-ip": {
        const [region, floatingIpId] = externalId.split("/");
        if (!region || !floatingIpId) throw new Error("Cannot parse floating IP ID");
        await this.ovhFetch<unknown>(
          this.cloudPath(`/region/${enc(region)}/floatingip/${enc(floatingIpId)}`),
          { method: "DELETE" },
        );
        break;
      }
      case "gateway": {
        const [region, gatewayId] = externalId.split("/");
        if (!region || !gatewayId) throw new Error("Cannot parse gateway ID");
        await this.ovhFetch<unknown>(
          this.cloudPath(`/region/${enc(region)}/gateway/${enc(gatewayId)}`),
          { method: "DELETE" },
        );
        break;
      }
      default:
        throw new Error(`OVH plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "volume" && targetTypeId === "instance") {
      const [volume, instance] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const volumeRegion = String(volume.fields["region"] ?? "");
      const instanceRegion = String(instance.fields["region"] ?? "");
      if (volumeRegion && instanceRegion && volumeRegion !== instanceRegion) {
        throw new Error(
          `Volume region ${volumeRegion} does not match instance region ${instanceRegion} — OVH volumes must be in the same region as the instance.`,
        );
      }
      const volumeId = volume.externalId ?? sourceResourceId.split(":").pop();
      const instanceId = instance.externalId ?? targetResourceId.split(":").pop();
      if (!volumeId || !instanceId) {
        throw new Error("Cannot determine volume or instance id for attachment");
      }
      await this.ovhFetch(this.cloudPath(`/volume/${volumeId}/attach`), {
        method: "POST",
        body: JSON.stringify({ instanceId }),
      });
      return;
    }
    throw new Error(
      `OVH plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  // Managed databases are the only OVH Public Cloud resources with a metrics API:
  // GET .../database/{engine}/{clusterId}/metric lists metric names and
  // GET .../metric/{metricName}?period= returns per-host series. Instances used to
  // have /instance/{id}/monitoring but OVH removed it from the API (404s today);
  // everything else only exists in the separate Metrics Data Platform, which needs
  // its own token and endpoint and is out of scope for this single-credential plugin.
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "managed-db") return [];
    const externalId = resourceId.split(":").pop();
    if (!externalId) return [];

    // The metric routes embed the engine in the path, which the resource id
    // doesn't carry — resolve it from the service first.
    const svc = await this.ovhFetch<OvhDatabaseService>(
      this.cloudPath(`/database/service/${enc(externalId)}`),
    );
    const engine = (svc.engine ?? "").trim().toLowerCase();
    if (!engine) return [];
    const metricBase = this.cloudPath(
      `${this.databaseEnginePath(engine)}/${enc(externalId)}/metric`,
    );

    // The API only supports fixed lookback windows; pick the smallest one that
    // covers the requested range, then trim points back down to the range.
    const now = Date.now();
    const startMs = timeRange?.startMs ?? now - 3_600_000;
    const spanMs = (timeRange?.endMs ?? now) - startMs;
    let period: string;
    if (spanMs <= 3_600_000) period = "lastHour";
    else if (spanMs <= 86_400_000) period = "lastDay";
    else if (spanMs <= 7 * 86_400_000) period = "lastWeek";
    else if (spanMs <= 31 * 86_400_000) period = "lastMonth";
    else period = "lastYear";

    let metricNames: string[];
    try {
      metricNames = await this.ovhFetch<string[]>(metricBase);
    } catch {
      // Not ready yet (Client::Conflict::ServiceNotReady) or no metric access.
      return [];
    }

    const results = await Promise.all(
      metricNames.slice(0, OvhClient.DB_METRIC_LIMIT).map(async (name) => {
        try {
          const metric = await this.ovhFetch<OvhDatabaseMetric>(
            `${metricBase}/${enc(name)}?period=${enc(period)}`,
          );
          const unit = ovhMetricUnit(metric.units ?? "");
          const hosts = metric.metrics ?? [];
          return hosts.flatMap((host): MetricSeries[] => {
            const points = (host.dataPoints ?? [])
              .map((p) => ({ timestamp: p.timestamp * 1000, value: p.value }))
              .filter((p) => p.timestamp >= startMs)
              .sort((a, b) => a.timestamp - b.timestamp);
            if (points.length === 0) return [];
            const label =
              hosts.length > 1
                ? `${metric.name ?? name} (${host.hostname})`
                : (metric.name ?? name);
            return [{ label, unit, points }];
          });
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  /** Metric-name list order is provider-defined; cap fan-out per fetch. */
  private static readonly DB_METRIC_LIMIT = 8;

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;
    const ro = resource.resolvedOutputs ?? {};

    switch (resourceTypeId) {
      case "instance": {
        const status = String(f.status ?? "unknown");
        const stats: DashboardStat[] = [
          {
            label: "Status",
            value: status,
            variant:
              status === "ACTIVE" || status === "active" || status === "running"
                ? "status-healthy"
                : status === "STOPPED" || status === "stopped"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Flavor", value: String(f.flavorName ?? "") },
          { label: "Region", value: String(f.region ?? "") },
        ];
        if (ro.publicIp) stats.push({ label: "Public IP", value: String(ro.publicIp) });
        return stats;
      }
      case "managed-kube": {
        const status = String(f.status ?? "unknown");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "READY" || status === "running" ? "status-healthy" : "status-degraded",
          },
          { label: "Version", value: String(f.version ?? "") },
          { label: "Region", value: String(f.region ?? "") },
          { label: "Nodes", value: String(f.nodeCount ?? 0) },
        ];
      }
      case "managed-db": {
        const status = String(f.status ?? "unknown");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "READY" || status === "running" ? "status-healthy" : "status-degraded",
          },
          { label: "Engine", value: String(f.engine ?? "") },
          { label: "Plan", value: String(f.plan ?? "") },
          { label: "Region", value: String(f.region ?? "") },
        ];
      }
      case "volume": {
        return [
          { label: "Status", value: String(f.status ?? "") },
          { label: "Type", value: String(f.type ?? "") },
          { label: "Region", value: String(f.region ?? "") },
          { label: "Size", value: `${String(f.sizeGb ?? "")} GB` },
        ];
      }
      case "object-storage-bucket": {
        return [
          { label: "Region", value: String(f.region ?? "") },
          { label: "Objects", value: String(f.objectsCount ?? 0) },
          { label: "Size", value: `${String(f.objectsSizeBytes ?? 0)} bytes` },
        ];
      }
      case "load-balancer": {
        const status = String(f.status ?? "unknown");
        return [
          {
            label: "Status",
            value: status,
            variant: status === "ACTIVE" || status === "OK" ? "status-healthy" : "status-degraded",
          },
          { label: "Size", value: String(f.size ?? "") },
          { label: "Region", value: String(f.region ?? "") },
          { label: "Address", value: String(f.address ?? "") },
        ];
      }
      case "private-network": {
        return [
          { label: "Status", value: String(f.status ?? "") },
          { label: "VLAN", value: String(f.vlanId ?? "") },
          { label: "Regions", value: String(f.regions ?? "") },
        ];
      }
      case "floating-ip": {
        return [
          { label: "Status", value: String(f.status ?? "") },
          { label: "IP", value: String(f.ip ?? "") },
          { label: "Region", value: String(f.region ?? "") },
          { label: "Associated", value: String(f.associatedEntity ?? "") },
        ];
      }
      case "gateway": {
        return [
          { label: "Status", value: String(f.status ?? "") },
          { label: "Model", value: String(f.model ?? "") },
          { label: "Region", value: String(f.region ?? "") },
          { label: "Interfaces", value: String(f.interfaces ?? 0) },
        ];
      }
      default:
        return [];
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const statusStr = String(fields["status"] ?? "").toUpperCase();

    const status = ((): ResourceStatus => {
      if (statusStr === "ACTIVE" || statusStr === "READY") return "healthy";
      if (statusStr === "BUILD" || statusStr === "INSTALLING" || statusStr === "CREATING")
        return "provisioning";
      if (statusStr === "ERROR" || statusStr === "DELETED") return "error";
      if (statusStr === "SUSPENDED" || statusStr === "SHUTOFF" || statusStr === "STOPPED")
        return "degraded";
      return "info";
    })();

    const detail: DetailViewSchema = {
      title: resource.displayName,
      subtitle: `${resourceTypeDisplayName(this.resourceTypes, resource.resourceTypeId)} · ${String(fields["region"] ?? "")}`,
      status: { kind: "status-dot", status, ...(statusStr ? { label: statusStr } : {}) },
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

    // MongoDB-engined OVH managed databases used to also surface a separate
    // inline "Documents" tab via the host's `mongodb-peer` browser. That
    // duplicated the MongoDB peer-pane tab declared by this resource type's
    // peerIntegration with the MongoDB plugin (which now implements
    // renderPeerPane), so the inline tab is dropped — the peer-pane lists
    // databases and opens each in the existing MongoDocumentBrowser.

    return detail;
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const statusStr = String(resource.fields["status"] ?? "").toUpperCase();
    const status = ((): ResourceStatus => {
      if (statusStr === "ACTIVE" || statusStr === "READY") return "healthy";
      if (statusStr === "BUILD" || statusStr === "INSTALLING" || statusStr === "CREATING")
        return "provisioning";
      if (statusStr === "ERROR" || statusStr === "DELETED") return "error";
      if (statusStr === "SUSPENDED" || statusStr === "SHUTOFF" || statusStr === "STOPPED")
        return "degraded";
      return "info";
    })();

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  private async listUpRegions(): Promise<string[]> {
    const regions = await this.ovhFetch<OvhRegion[]>(this.cloudPath("/region"));
    return regions.filter((r) => r.status === "UP").map((r) => r.name);
  }

  private async listObjectStorageBuckets(accountId: string): Promise<ResourceInstance[]> {
    const regions = await this.listUpRegions();
    const perRegion = await Promise.all(
      regions.map(async (region) => {
        try {
          const buckets = await this.ovhFetch<OvhStorageContainer[]>(
            this.cloudPath(`/region/${enc(region)}/storage`),
          );
          return buckets.map((bucket) => this.mapObjectStorageBucket(bucket, region, accountId));
        } catch {
          return [];
        }
      }),
    );
    return perRegion.flat();
  }

  private mapObjectStorageBucket(
    bucket: OvhStorageContainer,
    region: string,
    accountId: string,
  ): ResourceInstance {
    const bucketRegion = bucket.region ?? region;
    const createdAt = bucket.createdAt ?? new Date().toISOString();
    return {
      id: `${accountId}:object-storage-bucket:${bucketRegion}/${bucket.name}`,
      pluginId: "ovh",
      resourceTypeId: "object-storage-bucket",
      accountId,
      displayName: bucket.name,
      fields: {
        name: bucket.name,
        region: bucketRegion,
        objectsCount: bucket.objectsCount ?? 0,
        objectsSizeBytes: bucket.objectsSize ?? 0,
        virtualHost: bucket.virtualHost ?? "",
      },
      resolvedOutputs: {
        endpoint: `https://s3.${bucketRegion.toLowerCase()}.io.cloud.ovh.net`,
      },
      secretStates: [],
      externalId: `${bucketRegion}/${bucket.name}`,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private async listLoadBalancers(accountId: string): Promise<ResourceInstance[]> {
    const ids = await this.ovhFetch<string[]>(this.cloudPath("/loadbalancer"));
    const loadBalancers = await Promise.all(
      ids.map((id) => this.ovhFetch<OvhLoadBalancer>(this.cloudPath(`/loadbalancer/${enc(id)}`))),
    );
    return loadBalancers.map((lb) => this.mapLoadBalancer(lb, accountId));
  }

  private mapLoadBalancer(lb: OvhLoadBalancer, accountId: string): ResourceInstance {
    const createdAt = lb.createdAt ?? new Date().toISOString();
    const address = stringifyAddress(lb.address);
    return {
      id: `${accountId}:load-balancer:${lb.id}`,
      pluginId: "ovh",
      resourceTypeId: "load-balancer",
      accountId,
      displayName: lb.name || lb.id,
      fields: {
        name: lb.name ?? "",
        region: lb.region ?? lb.openstackRegion ?? "",
        size: lb.size ?? "",
        status: lb.status ?? "",
        address,
        description: lb.description ?? "",
      },
      resolvedOutputs: { address },
      secretStates: [],
      externalId: lb.id,
      createdAt,
      updatedAt: lb.updatedAt ?? createdAt,
    };
  }

  private async listPrivateNetworks(accountId: string): Promise<ResourceInstance[]> {
    const networks = await this.ovhFetch<OvhPrivateNetwork[]>(this.cloudPath("/network/private"));
    return networks.map((network) => this.mapPrivateNetwork(network, accountId));
  }

  private mapPrivateNetwork(network: OvhPrivateNetwork, accountId: string): ResourceInstance {
    const regions = (network.regions ?? []).map((region) => region.name ?? "").filter(Boolean);
    const now = new Date().toISOString();
    return {
      id: `${accountId}:private-network:${network.id}`,
      pluginId: "ovh",
      resourceTypeId: "private-network",
      accountId,
      displayName: network.name || network.id,
      fields: {
        name: network.name ?? "",
        regions: regions.join(","),
        vlanId: network.vlanId ?? 0,
        status: network.status ?? "",
        type: network.type ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: network.id,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listFloatingIps(accountId: string): Promise<ResourceInstance[]> {
    const regions = await this.listUpRegions();
    const perRegion = await Promise.all(
      regions.map(async (region) => {
        try {
          const ips = await this.ovhFetch<OvhFloatingIp[]>(
            this.cloudPath(`/region/${enc(region)}/floatingip`),
          );
          return ips.map((ip) => this.mapFloatingIp(ip, region, accountId));
        } catch {
          return [];
        }
      }),
    );
    return perRegion.flat();
  }

  private mapFloatingIp(ip: OvhFloatingIp, region: string, accountId: string): ResourceInstance {
    const ipRegion = ip.region ?? region;
    const now = new Date().toISOString();
    const associatedEntity = stringifyAssociatedEntity(ip.associatedEntity);
    return {
      id: `${accountId}:floating-ip:${ipRegion}/${ip.id}`,
      pluginId: "ovh",
      resourceTypeId: "floating-ip",
      accountId,
      displayName: ip.ip,
      fields: {
        ip: ip.ip,
        region: ipRegion,
        status: ip.status ?? "",
        networkId: ip.networkId ?? "",
        associatedEntity,
      },
      resolvedOutputs: { ip: ip.ip },
      secretStates: [],
      externalId: `${ipRegion}/${ip.id}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listGateways(accountId: string): Promise<ResourceInstance[]> {
    const regions = await this.listUpRegions();
    const perRegion = await Promise.all(
      regions.map(async (region) => {
        try {
          const gateways = await this.ovhFetch<OvhGateway[]>(
            this.cloudPath(`/region/${enc(region)}/gateway?withSubnets=true`),
          );
          return gateways.map((gateway) => this.mapGateway(gateway, region, accountId));
        } catch {
          return [];
        }
      }),
    );
    return perRegion.flat();
  }

  private mapGateway(gateway: OvhGateway, region: string, accountId: string): ResourceInstance {
    const gatewayRegion = gateway.region ?? region;
    const now = new Date().toISOString();
    return {
      id: `${accountId}:gateway:${gatewayRegion}/${gateway.id}`,
      pluginId: "ovh",
      resourceTypeId: "gateway",
      accountId,
      displayName: gateway.name || gateway.id,
      fields: {
        name: gateway.name ?? "",
        region: gatewayRegion,
        model: gateway.model ?? "",
        status: gateway.status ?? "",
        type: gateway.type ?? "",
        interfaces: gateway.interfaces?.length ?? 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${gatewayRegion}/${gateway.id}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listVolumes(accountId: string): Promise<ResourceInstance[]> {
    const volumes = await this.ovhFetch<
      Array<{
        id: string;
        name?: string;
        region: string;
        size: number;
        type: string;
        status?: string;
        bootable?: boolean;
        attachedTo?: string[];
        creationDate?: string;
      }>
    >(this.cloudPath("/volume"));
    return volumes.map((v) => ({
      id: `${accountId}:volume:${v.id}`,
      pluginId: "ovh",
      resourceTypeId: "volume",
      accountId,
      displayName: v.name ?? v.id,
      fields: {
        name: v.name ?? "",
        region: v.region,
        sizeGb: v.size,
        type: v.type,
        status: v.status ?? "",
        bootable: v.bootable ?? false,
        attachedTo: (v.attachedTo ?? []).join(","),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: v.id,
      createdAt: v.creationDate ?? new Date().toISOString(),
      updatedAt: v.creationDate ?? new Date().toISOString(),
    }));
  }

  private async listInstances(accountId: string): Promise<ResourceInstance[]> {
    const instances = await this.ovhFetch<OvhInstance[]>(this.cloudPath("/instance"));
    return instances.map((inst) => {
      const publicIp =
        inst.ipAddresses?.find((ip) => ip.type === "public" && ip.version === 4)?.ip ?? "";
      const publicIpv6 =
        inst.ipAddresses?.find((ip) => ip.type === "public" && ip.version === 6)?.ip ?? "";
      const privateIp =
        inst.ipAddresses?.find((ip) => ip.type === "private" && ip.version === 4)?.ip ?? "";
      return {
        id: `${accountId}:instance:${inst.id}`,
        pluginId: "ovh",
        resourceTypeId: "instance",
        accountId,
        displayName: inst.name,
        fields: {
          name: inst.name,
          region: inst.region,
          flavorName: inst.flavor?.name ?? "",
          imageName: inst.image?.name ?? "",
          status: inst.status,
          sshUsername: ovhSshUsername(inst.image?.name ?? ""),
        },
        resolvedOutputs: { ipv4: publicIp, ipv6: publicIpv6, ipv4Private: privateIp },
        secretStates: [],
        externalId: inst.id,
        createdAt: inst.created ?? new Date().toISOString(),
        updatedAt: inst.created ?? new Date().toISOString(),
      };
    });
  }

  private async listManagedKubeClusters(accountId: string): Promise<ResourceInstance[]> {
    // OVH /kube returns an array of cluster IDs, need to fetch each
    const clusterIds = await this.ovhFetch<string[]>(this.cloudPath("/kube"));
    const clusters = await Promise.all(
      clusterIds.map(async (id) => {
        const cluster = await this.ovhFetch<OvhKubeCluster>(this.cloudPath(`/kube/${id}`));
        let pools: OvhKubeNodePool[] = [];
        try {
          pools = await this.ovhFetch<OvhKubeNodePool[]>(this.cloudPath(`/kube/${id}/nodepool`));
        } catch {
          // No permission to list node pools — leave fields empty
        }
        return { cluster, pools };
      }),
    );
    return clusters.map(({ cluster: c, pools }) => {
      const firstPool = pools[0];
      const totalNodes = pools.reduce(
        (sum, p) => sum + Number(p.desiredNodes ?? p.currentNodes ?? 0),
        0,
      );
      return {
        id: `${accountId}:managed-kube:${c.id}`,
        pluginId: "ovh",
        resourceTypeId: "managed-kube",
        accountId,
        displayName: c.name ?? c.id,
        fields: {
          name: c.name ?? "",
          region: c.region ?? "",
          version: c.version ?? "",
          status: c.status ?? "",
          flavor: firstPool?.flavorName ?? "",
          nodeCount: totalNodes,
          nodePoolCount: pools.length,
          nodesUrl: c.nodesUrl ?? "",
        },
        resolvedOutputs: {
          clusterUrl: c.url ?? "",
        },
        secretStates: [],
        externalId: c.id,
        createdAt: c.createdAt ?? new Date().toISOString(),
        updatedAt: c.updatedAt ?? c.createdAt ?? new Date().toISOString(),
      };
    });
  }

  private async listManagedDatabases(accountId: string): Promise<ResourceInstance[]> {
    const serviceIds = await this.ovhFetch<string[]>(this.cloudPath("/database/service"));
    const services = await Promise.all(
      serviceIds.map((id) =>
        this.ovhFetch<OvhDatabaseService>(this.cloudPath(`/database/service/${id}`)),
      ),
    );
    return services.map((svc) => ({
      id: `${accountId}:managed-db:${svc.id}`,
      pluginId: "ovh",
      resourceTypeId: "managed-db",
      accountId,
      displayName: this.serviceDisplayName(svc),
      fields: {
        description: svc.description ?? "",
        engine: svc.engine ?? "",
        version: svc.version ?? "",
        plan: svc.plan ?? "",
        region: svc.nodes?.[0]?.region ?? "",
        flavor: svc.flavor ?? "",
        nodeCount: svc.nodeNumber ?? svc.nodes?.length ?? 1,
        status: svc.status ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: svc.id,
      createdAt: svc.createdAt ?? new Date().toISOString(),
      updatedAt: svc.updatedAt ?? svc.createdAt ?? new Date().toISOString(),
    }));
  }
}

interface OvhIpAddress {
  ip: string;
  type: "public" | "private";
  version: 4 | 6;
}

interface OvhInstance {
  id: string;
  name: string;
  region: string;
  status: string;
  created: string;
  flavor?: { id: string; name: string };
  image?: { id: string; name: string };
  ipAddresses?: OvhIpAddress[];
  sshKey?: { id: string; name: string };
}

interface OvhKubeCluster {
  id: string;
  name?: string;
  region?: string;
  version?: string;
  status?: string;
  url?: string;
  nodesUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface OvhStorageContainer {
  name: string;
  region?: string;
  createdAt?: string;
  objectsCount?: number;
  objectsSize?: number;
  virtualHost?: string;
}

interface OvhLoadBalancer {
  id: string;
  name?: string | null;
  region?: string;
  openstackRegion?: string;
  size?: string;
  status?: string;
  description?: string | null;
  address?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

interface OvhPrivateNetwork {
  id: string;
  name?: string;
  regions?: Array<{ name?: string }>;
  vlanId?: number;
  status?: string;
  type?: string;
}

interface OvhFloatingIp {
  id: string;
  ip: string;
  region?: string;
  status?: string;
  networkId?: string;
  associatedEntity?: unknown;
}

interface OvhGateway {
  id: string;
  name?: string;
  region?: string;
  model?: string;
  status?: string;
  type?: string;
  interfaces?: unknown[];
}

interface OvhKubeNodePool {
  id: string;
  name?: string;
  flavorName?: string;
  desiredNodes?: number;
  currentNodes?: number;
  minNodes?: number;
  maxNodes?: number;
  status?: string;
}

/** Response of GET .../database/{engine}/{clusterId}/metric/{name} (timestamps in epoch seconds). */
interface OvhDatabaseMetric {
  name?: string;
  units?: string;
  metrics?: Array<{
    hostname?: string;
    dataPoints?: Array<{ timestamp: number; value: number }>;
  }>;
}

interface OvhDatabaseService {
  id: string;
  description?: string;
  engine?: string;
  version?: string;
  plan?: string;
  flavor?: string;
  status?: string;
  nodeNumber?: number;
  nodes?: Array<{ region: string }>;
  endpoints?: Array<{ uri?: string; domain?: string; port?: number; scheme?: string }>;
  createdAt?: string;
  updatedAt?: string;
}

interface OvhFlavor {
  id: string;
  name: string;
  region: string;
  ram: number;
  disk: number;
  vcpus: number;
  type?: string;
  available: boolean;
  planCodes?: { monthly?: string; hourly?: string };
}

interface OvhImage {
  id: string;
  name: string;
  region: string;
  status: string;
  type?: string;
  flavorType?: string;
}

interface OvhRegion {
  name: string;
  status: string;
  services?: Array<{ name: string; status: string }>;
}
