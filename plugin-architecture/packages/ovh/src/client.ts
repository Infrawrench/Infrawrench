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

function ovhSshUsername(imageName: string): string {
  const lower = imageName.toLowerCase();
  if (lower.includes("ubuntu")) return "ubuntu";
  if (lower.includes("debian")) return "debian";
  if (lower.includes("centos")) return "centos";
  if (lower.includes("fedora")) return "fedora";
  return "root";
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

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
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
        const res = await fetch(`${this.baseUrl}/auth/time`);
        const serverTime = (await res.json()) as number;
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

    const res = await fetch(url, {
      ...options,
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Ovh-Application": this.applicationKey,
        "X-Ovh-Timestamp": String(timestamp),
        "X-Ovh-Consumer": this.consumerKey,
        "X-Ovh-Signature": signature,
        ...(options?.headers ?? {}),
      },
    });

    if (!res.ok) {
      throw new Error(`OVH API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
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
      switch (outputKey) {
        case "connectionString":
          return endpoint?.uri ?? "";
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
            key: "flavor",
            label: "Flavor",
            kind: "text",
            required: true,
            defaultValue: "db1-7",
            description: "Node flavor, e.g. db1-7",
          },
          {
            key: "nodeCount",
            label: "Node Count",
            kind: "number",
            required: true,
            defaultValue: "1",
            minValue: 1,
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

      const body = {
        name: fields["name"],
        region: fields["region"],
        version: fields["version"] ?? "1.31",
      };

      const cluster = await this.ovhFetch<OvhKubeCluster>(this.cloudPath("/kube"), {
        method: "POST",
        body: JSON.stringify(body),
      });

      // nodeCount is used for reference but the node pool is created separately via the API
      // For simplicity, store it in fields
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
      const data = await this.ovhFetch<OvhDatabaseService>(this.cloudPath("/database/service"), {
        method: "POST",
        body: JSON.stringify({
          description: fields["description"] ?? "",
          engine: fields["engine"] ?? "postgresql",
          version: fields["version"] ?? "16",
          plan: fields["plan"] ?? "essential",
          flavor: fields["flavor"] ?? "db1-7",
          nodeList: Array.from({ length: Number(fields["nodeCount"] ?? 1) }, () => ({
            region: "GRA",
          })),
        }),
      });
      const now = new Date().toISOString();
      return {
        id: `${accountId}:managed-db:${data.id}`,
        pluginId: "ovh",
        resourceTypeId: "managed-db",
        accountId,
        displayName: data.description || `${data.engine} (${data.id.slice(0, 8)})`,
        fields: {
          description: data.description ?? "",
          engine: data.engine ?? fields["engine"] ?? "",
          version: data.version ?? fields["version"] ?? "",
          plan: data.plan ?? fields["plan"] ?? "",
          region: "",
          flavor: data.flavor ?? fields["flavor"] ?? "",
          nodeCount: Number(fields["nodeCount"] ?? 1),
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
      case "managed-db":
        await this.ovhFetch<unknown>(this.cloudPath(`/database/service/${externalId}`), {
          method: "DELETE",
        });
        break;
      case "volume":
        await this.ovhFetch<unknown>(this.cloudPath(`/volume/${externalId}`), { method: "DELETE" });
        break;
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

    return {
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
      clusterIds.map((id) => this.ovhFetch<OvhKubeCluster>(this.cloudPath(`/kube/${id}`))),
    );
    return clusters.map((c) => ({
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
        nodesUrl: c.nodesUrl ?? "",
      },
      resolvedOutputs: {
        clusterUrl: c.url ?? "",
      },
      secretStates: [],
      externalId: c.id,
      createdAt: c.createdAt ?? new Date().toISOString(),
      updatedAt: c.updatedAt ?? c.createdAt ?? new Date().toISOString(),
    }));
  }

  private async listManagedDatabases(accountId: string): Promise<ResourceInstance[]> {
    const services = await this.ovhFetch<OvhDatabaseService[]>(this.cloudPath("/database/service"));
    return services.map((svc) => ({
      id: `${accountId}:managed-db:${svc.id}`,
      pluginId: "ovh",
      resourceTypeId: "managed-db",
      accountId,
      displayName: svc.description || `${svc.engine} (${svc.id.slice(0, 8)})`,
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
