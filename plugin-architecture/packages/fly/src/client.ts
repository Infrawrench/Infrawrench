import type {
  ActionNode,
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  CredentialExport,
  ResourceStatus,
  ResourceTypeDefinition,
  DashboardStat,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  RegionOption,
  SectionNode,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  jsonRestFetch,
  labeledFieldItems,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import {
  formatRegion,
  regionOptionsFrom,
  staticRegionOptions,
  type FlyPlatformRegion,
} from "./regions.js";
import {
  MPG_PLANS,
  mapPostgresCluster,
  postgresStatusDot,
  renderPostgresClusterDetail,
  type FlyPostgresCluster,
} from "./postgres.js";

/**
 * Machine size presets, as listed on Fly's pricing page. Memory is the
 * preset's default; the create form lets the user raise it.
 */
const MACHINE_SIZES: Array<{ id: string; cpuKind: string; cpus: number; memoryMb: number }> = [
  { id: "shared-cpu-1x", cpuKind: "shared", cpus: 1, memoryMb: 256 },
  { id: "shared-cpu-2x", cpuKind: "shared", cpus: 2, memoryMb: 512 },
  { id: "shared-cpu-4x", cpuKind: "shared", cpus: 4, memoryMb: 1024 },
  { id: "shared-cpu-8x", cpuKind: "shared", cpus: 8, memoryMb: 2048 },
  { id: "performance-1x", cpuKind: "performance", cpus: 1, memoryMb: 2048 },
  { id: "performance-2x", cpuKind: "performance", cpus: 2, memoryMb: 4096 },
  { id: "performance-4x", cpuKind: "performance", cpus: 4, memoryMb: 8192 },
  { id: "performance-8x", cpuKind: "performance", cpus: 8, memoryMb: 16384 },
  { id: "performance-16x", cpuKind: "performance", cpus: 16, memoryMb: 32768 },
];

/** Parameterless machine lifecycle routes: `POST /v1/apps/{app}/machines/{id}/{action}`. */
const MACHINE_ACTIONS = new Set(["start", "stop", "restart", "suspend", "cordon", "uncordon"]);

/** `IPAssignmentType` values `POST /ip_assignments` accepts. */
const IP_TYPES: Array<{ id: string; label: string; description: string }> = [
  { id: "shared_v4", label: "Shared IPv4", description: "Free; shared with other apps" },
  { id: "v4", label: "Dedicated IPv4", description: "Billed monthly" },
  { id: "v6", label: "Dedicated IPv6", description: "Free" },
  {
    id: "private_v6",
    label: "Private IPv6 (Flycast)",
    description: "Reachable only on the org's private network",
  },
  {
    id: "egress_pair",
    label: "Static egress (IPv4 + IPv6)",
    description: "Fixed outbound addresses for one region",
  },
];

/** `GET https://api.fly.io/api/v1/apps/{app}/logs`: a JSON:API document. */
interface FlyLogsResponse {
  data?: Array<{
    id?: string;
    attributes?: {
      timestamp?: string;
      message?: string;
      level?: string;
      instance?: string;
      region?: string;
      meta?: { instance?: string; region?: string };
    };
  }>;
  meta?: { next_token?: string };
}

/**
 * Fly.io plugin client.
 * Created per account (per API token + org slug) by the host.
 */
export class FlyClient implements PluginClient {
  private readonly token: string;
  private readonly orgSlug: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly baseUrl = "https://api.machines.dev";

  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Fly plugin: missing apiToken credential");
    this.token = token;
    this.orgSlug = credentials["orgSlug"] ?? "personal";
    this.resourceTypes = resourceTypes;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /* ------------------------------------------------------------------ */
  /*  HTTP helpers                                                       */
  /* ------------------------------------------------------------------ */

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Fly",
      url: `${this.baseUrl}${path}`,
      errorPath: path,
      headers: { Authorization: `Bearer ${this.token}` },
      ...(options ? { init: options } : {}),
      ...(this.services?.http
        ? {
            http: this.services.http,
            ...(this.caCert ? { caCert: this.caCert } : {}),
          }
        : {}),
    });
  }

  private regionCache: FlyPlatformRegion[] | null = null;

  /**
   * Live region list from `GET /v1/platform/regions`, cached per client.
   * Falls back to the static table when the call fails, so the create forms
   * never lose their picker.
   */
  private async regionOptions(opts: { requireMpg?: boolean } = {}): Promise<RegionOption[]> {
    try {
      if (!this.regionCache) {
        const data = await this.fetch<{ regions?: FlyPlatformRegion[] }>("/v1/platform/regions");
        this.regionCache = data.regions ?? [];
      }
      const options = regionOptionsFrom(this.regionCache, opts);
      if (options.length > 0) return options;
    } catch {
      /* fall through to the static table */
    }
    return staticRegionOptions();
  }

  /* ------------------------------------------------------------------ */
  /*  PluginClient: core contract                                       */
  /* ------------------------------------------------------------------ */

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "app":
        return this.listApps(accountId);
      case "machine":
        return this.listAllMachines(accountId);
      case "volume":
        return this.listAllVolumes(accountId);
      case "certificate":
        return this.listAllCertificates(accountId);
      case "ip-allocation":
        return this.listAllIpAllocations(accountId);
      case "app-secret":
        return this.listAllSecrets(accountId);
      case "postgres-cluster":
        return this.listPostgresClusters(accountId);
      default:
        throw new Error(`Fly plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === "app") {
      const appName = resourceId.split(":").pop();
      if (!appName) throw new Error("Cannot parse app name from resource ID");
      const data = await this.fetch<FlyApp>(`/v1/apps/${appName}`);
      return this.mapApp(data, accountId);
    }

    if (typeId === "machine") {
      const parts = parseMachineId(resourceId);
      const data = await this.fetch<FlyMachine>(
        `/v1/apps/${parts.appName}/machines/${parts.machineId}`,
      );
      return this.mapMachine(data, parts.appName, accountId);
    }

    if (typeId === "volume") {
      const parts = parseVolumeId(resourceId);
      const data = await this.fetch<FlyVolume>(
        `/v1/apps/${parts.appName}/volumes/${parts.volumeId}`,
      );
      return this.mapVolume(data, parts.appName, accountId);
    }

    if (typeId === "certificate") {
      const parts = parseAppChildId(resourceId);
      const data = await this.fetch<FlyCertificate>(
        `/v1/apps/${parts.appName}/certificates/${encodeURIComponent(parts.childId)}`,
      );
      return this.mapCertificate(data, parts.appName, accountId);
    }

    if (typeId === "app-secret") {
      const parts = parseAppChildId(resourceId);
      const data = await this.fetch<FlyAppSecret>(
        `/v1/apps/${parts.appName}/secrets/${encodeURIComponent(parts.childId)}`,
      );
      return this.mapSecret(data, parts.appName, accountId);
    }

    if (typeId === "postgres-cluster") {
      const clusterId = resourceId.split(":").slice(2).join(":");
      const data = await this.fetch<{ data: FlyPostgresCluster }>(
        `/v1/postgres/${encodeURIComponent(clusterId)}`,
      );
      return mapPostgresCluster(data.data, accountId);
    }

    if (typeId === "ip-allocation") {
      const { appName } = parseAppChildId(resourceId);
      const found = (await this.listIpAllocationsForApp(appName, accountId)).find(
        (r) => r.id === resourceId,
      );
      if (found) return found;
      throw new Error(`Fly plugin: resource ${typeId}/${resourceId} not found`);
    }

    throw new Error(`Fly plugin: unknown resource type "${typeId}"`);
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "machine") {
      const parts = parseMachineId(resourceId);
      const data = await this.fetch<FlyMachine>(
        `/v1/apps/${parts.appName}/machines/${parts.machineId}`,
      );
      if (outputKey === "privateIp") return data.private_ip ?? "";
      throw new Error(`Fly plugin: unknown output "${outputKey}" for machine`);
    }
    if (typeId === "app" && outputKey === "appName") {
      // The app's name is its external id (resource id = account:app:<name>).
      return resourceId.split(":").pop() ?? "";
    }
    if (typeId === "certificate" && outputKey === "hostname") {
      return parseAppChildId(resourceId).childId;
    }
    if (typeId === "ip-allocation" && outputKey === "address") {
      return parseAppChildId(resourceId).childId;
    }
    if (typeId === "app-secret" && outputKey === "secretName") {
      return parseAppChildId(resourceId).childId;
    }
    if (typeId === "postgres-cluster") {
      const cluster = await this.getResource(typeId, resourceId, accountId);
      const value = cluster.resolvedOutputs[outputKey];
      if (value !== undefined) return value;
    }
    throw new Error(`Fly plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const appPicker = (description: string): CreateResourceConfig["fields"] =>
      parentResourceId
        ? []
        : [
            {
              key: "appName",
              label: "App",
              kind: "resource-picker",
              required: true,
              description,
              associationSources: [
                { pluginId: "fly", resourceTypeId: "app", outputKey: "appName" },
              ],
            },
          ];

    if (typeId === "app") {
      return {
        fields: [
          { key: "name", label: "App Name", kind: "text", required: true },
          {
            key: "network",
            label: "Private Network",
            kind: "text",
            required: false,
            description: "Optional private network name for segmenting this app",
          },
        ],
      };
    }

    if (typeId === "machine") {
      const regions = await this.regionOptions();
      return {
        fields: [
          ...appPicker("Fly app to create the machine in"),
          { key: "name", label: "Machine Name", kind: "text", required: false },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: "iad",
          },
          {
            key: "image",
            label: "Docker Image",
            kind: "text",
            required: true,
            description: "e.g. registry.fly.io/my-app:latest or nginx:alpine",
          },
          {
            key: "size",
            label: "Size",
            kind: "select",
            required: true,
            defaultValue: "shared-cpu-1x",
            options: MACHINE_SIZES.map((s) => ({
              id: s.id,
              label: s.id,
              description: `${s.cpus} ${s.cpuKind} vCPU, ${s.memoryMb} MB`,
            })),
          },
          {
            key: "memoryMb",
            label: "Memory (MB)",
            kind: "number",
            required: false,
            description:
              "Override the preset's memory, in 256 MB steps. Leave blank for the preset default.",
            minValue: 256,
          },
        ],
      };
    }

    if (typeId === "volume") {
      const regions = await this.regionOptions();
      return {
        fields: [
          ...appPicker("Fly app the volume belongs to"),
          { key: "name", label: "Volume Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: "iad",
          },
          {
            key: "sizeGb",
            label: "Size (GB)",
            kind: "number",
            required: true,
            defaultValue: "1",
            minValue: 1,
            maxValue: 500,
          },
          {
            key: "autoBackupEnabled",
            label: "Automatic Snapshots",
            kind: "select",
            required: false,
            defaultValue: "true",
            options: [
              { id: "true", label: "Enabled (daily)" },
              { id: "false", label: "Disabled" },
            ],
          },
          {
            key: "snapshotRetention",
            label: "Snapshot Retention (days)",
            kind: "number",
            required: false,
            defaultValue: "5",
            minValue: 1,
            maxValue: 60,
          },
        ],
      };
    }

    if (typeId === "certificate") {
      return {
        fields: [
          ...appPicker("Fly app to request the certificate for"),
          {
            key: "hostname",
            label: "Hostname",
            kind: "text",
            required: true,
            description: "A custom domain pointed at the app, e.g. www.example.com",
          },
        ],
      };
    }

    if (typeId === "ip-allocation") {
      const regions = await this.regionOptions();
      return {
        fields: [
          ...appPicker("Fly app to assign the address to"),
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "shared_v4",
            options: IP_TYPES.map((t) => ({
              id: t.id,
              label: t.label,
              description: t.description,
            })),
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: false,
            regions,
            description: "Static egress addresses are allocated per region",
            showWhen: { fieldKey: "type", fieldValues: ["egress_pair"] },
          },
          {
            key: "network",
            label: "Private Network",
            kind: "text",
            required: false,
            description: "Custom 6PN network for a Flycast address. Leave blank for the default.",
            showWhen: { fieldKey: "type", fieldValues: ["private_v6"] },
          },
          {
            key: "serviceName",
            label: "Service Name",
            kind: "text",
            required: false,
            description: "Optional: bind the address to one service of the app",
          },
        ],
      };
    }

    if (typeId === "app-secret") {
      return {
        fields: [
          ...appPicker("Fly app the secret belongs to"),
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description:
              "Exposed to Machines as an environment variable of the same name, e.g. DATABASE_URL",
          },
          { key: "value", label: "Value", kind: "password", required: true },
        ],
      };
    }

    if (typeId === "postgres-cluster") {
      const regions = await this.regionOptions({ requireMpg: true });
      return {
        fields: [
          {
            key: "name",
            label: "Cluster Name",
            kind: "text",
            required: false,
            description: "Leave blank to have Fly generate one",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: "iad",
          },
          {
            key: "plan",
            label: "Plan",
            kind: "select",
            required: true,
            defaultValue: "basic",
            options: MPG_PLANS,
            description: "Selects CPU, memory, and high-availability sizing",
          },
          {
            key: "pgMajorVersion",
            label: "Postgres Version",
            kind: "select",
            required: false,
            defaultValue: "17",
            options: [
              { id: "17", label: "Postgres 17" },
              { id: "16", label: "Postgres 16" },
            ],
          },
          {
            key: "diskSizeGb",
            label: "Disk (GB)",
            kind: "number",
            required: false,
            defaultValue: "10",
            minValue: 10,
            maxValue: 1000,
          },
          {
            key: "poolMode",
            label: "Pooler Mode",
            kind: "select",
            required: false,
            defaultValue: "transaction",
            options: [
              { id: "transaction", label: "Transaction" },
              { id: "session", label: "Session" },
            ],
          },
          {
            key: "postgisEnabled",
            label: "PostGIS",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "false", label: "Disabled" },
              { id: "true", label: "Enabled" },
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
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    if (typeId === "app") {
      const body = {
        app_name: fields["name"],
        org_slug: this.orgSlug,
        ...(fields["network"] ? { network: fields["network"] } : {}),
      };
      await this.fetch<{ id: string }>("/v1/apps", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const app = await this.fetch<FlyApp>(`/v1/apps/${fields["name"]}`);
      return this.mapApp(app, accountId);
    }

    if (typeId === "postgres-cluster") {
      const body: Record<string, unknown> = {
        org_slug: this.orgSlug,
        region: fields["region"],
        plan: fields["plan"] || "basic",
      };
      if (fields["name"]) body["name"] = fields["name"];
      if (fields["pgMajorVersion"]) body["pg_major_version"] = fields["pgMajorVersion"];
      if (fields["diskSizeGb"]) body["disk_size_gb"] = Number(fields["diskSizeGb"]);
      if (fields["poolMode"]) body["pool_mode"] = fields["poolMode"];
      if (fields["postgisEnabled"]) body["postgis_enabled"] = fields["postgisEnabled"] === "true";
      const data = await this.fetch<{ data: FlyPostgresCluster }>("/v1/postgres", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return mapPostgresCluster(data.data, accountId);
    }

    const parentAppName = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const appName = fields["appName"] || parentAppName;

    if (typeId === "machine") {
      if (!appName) throw new Error("Fly plugin: appName is required to create a machine");
      const config: Record<string, unknown> = { image: fields["image"] };
      const size = MACHINE_SIZES.find((s) => s.id === fields["size"]);
      if (size) {
        const memory = Number(fields["memoryMb"]);
        config["guest"] = {
          cpu_kind: size.cpuKind,
          cpus: size.cpus,
          memory_mb: Number.isFinite(memory) && memory > 0 ? memory : size.memoryMb,
        };
      }
      const body: Record<string, unknown> = { region: fields["region"], config };
      if (fields["name"]) body["name"] = fields["name"];

      const data = await this.fetch<FlyMachine>(`/v1/apps/${appName}/machines`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return this.mapMachine(data, appName, accountId);
    }

    if (typeId === "volume") {
      if (!appName) throw new Error("Fly plugin: appName is required to create a volume");
      const body: Record<string, unknown> = {
        name: fields["name"],
        region: fields["region"],
        size_gb: Number(fields["sizeGb"] || 1),
      };
      if (fields["autoBackupEnabled"]) {
        body["auto_backup_enabled"] = fields["autoBackupEnabled"] === "true";
      }
      if (fields["snapshotRetention"]) {
        body["snapshot_retention"] = Number(fields["snapshotRetention"]);
      }
      const data = await this.fetch<Record<string, unknown>>(`/v1/apps/${appName}/volumes`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const now = new Date().toISOString();
      return {
        id: `${accountId}:volume:${appName}/${String(data["id"])}`,
        pluginId: "fly",
        resourceTypeId: "volume",
        accountId,
        displayName: String(data["name"] ?? fields["name"]),
        fields: {
          name: String(data["name"] ?? fields["name"]),
          state: String(data["state"] ?? "created"),
          sizeGb: Number(data["size_gb"] ?? fields["sizeGb"]),
          region: String(data["region"] ?? fields["region"]),
          encrypted: data["encrypted"] === true,
          attachedMachineId: "",
          appName,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${appName}/${String(data["id"])}`,
        parentResourceId: `${accountId}:app:${appName}`,
        createdAt: String(data["created_at"] ?? now),
        updatedAt: now,
      };
    }

    if (typeId === "certificate") {
      const hostname = fields["hostname"];
      if (!appName) throw new Error("Fly plugin: appName is required to create a certificate");
      if (!hostname) throw new Error("Fly plugin: hostname is required to create a certificate");

      const data = await this.fetch<FlyCertificate>(`/v1/apps/${appName}/certificates/acme`, {
        method: "POST",
        body: JSON.stringify({ hostname }),
      });
      return this.mapCertificate(data, appName, accountId);
    }

    if (typeId === "ip-allocation") {
      if (!appName) throw new Error("Fly plugin: appName is required to assign an IP");
      const type = fields["type"] || "shared_v4";
      const body: Record<string, unknown> = { type, org_slug: this.orgSlug };
      if (fields["region"] && type.startsWith("egress")) body["region"] = fields["region"];
      if (fields["network"] && type === "private_v6") body["network"] = fields["network"];
      if (fields["serviceName"]) body["service_name"] = fields["serviceName"];
      const data = await this.fetch<FlyIpAssignment & { ip_pair?: { v4?: string; v6?: string } }>(
        `/v1/apps/${appName}/ip_assignments`,
        { method: "POST", body: JSON.stringify(body) },
      );
      // An egress pair comes back as `ip_pair` with `ip` null; the v4 half
      // stands in for the pair (both are listed separately afterwards).
      const ip = data.ip || data.ip_pair?.v4 || data.ip_pair?.v6 || "";
      return this.mapIpAllocation({ ...data, ip }, appName, accountId);
    }

    if (typeId === "app-secret") {
      const name = fields["name"];
      if (!appName) throw new Error("Fly plugin: appName is required to create a secret");
      if (!name) throw new Error("Fly plugin: name is required to create a secret");
      const data = await this.fetch<FlyAppSecret>(
        `/v1/apps/${appName}/secrets/${encodeURIComponent(name)}`,
        { method: "POST", body: JSON.stringify({ value: fields["value"] ?? "" }) },
      );
      return this.mapSecret({ ...data, name: data.name || name }, appName, accountId);
    }

    throw new Error(`Fly plugin: createResource not supported for type "${typeId}"`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "volume") {
      const parts = parseVolumeId(resourceId);
      const base = `/v1/apps/${parts.appName}/volumes/${parts.volumeId}`;
      if (fields["sizeGb"] !== undefined && fields["sizeGb"] !== "") {
        const current = await this.fetch<FlyVolume>(base);
        const target = Number(fields["sizeGb"]);
        if (!Number.isFinite(target) || target < (current.size_gb ?? 0)) {
          throw new Error(
            `Fly volumes can only grow: ${parts.volumeId} is ${String(current.size_gb)} GB.`,
          );
        }
        if (target > (current.size_gb ?? 0)) {
          await this.fetch<unknown>(`${base}/extend`, {
            method: "PUT",
            body: JSON.stringify({ size_gb: target }),
          });
        }
      }
      const settings: Record<string, unknown> = {};
      if (fields["autoBackupEnabled"] !== undefined) {
        settings["auto_backup_enabled"] = fields["autoBackupEnabled"] === "true";
      }
      if (fields["snapshotRetention"] !== undefined && fields["snapshotRetention"] !== "") {
        settings["snapshot_retention"] = Number(fields["snapshotRetention"]);
      }
      if (Object.keys(settings).length > 0) {
        await this.fetch<unknown>(base, { method: "PUT", body: JSON.stringify(settings) });
      }
      return this.getResource(typeId, resourceId, accountId);
    }

    if (typeId === "app-secret") {
      const parts = parseAppChildId(resourceId);
      if (fields["value"]) {
        await this.fetch<FlyAppSecret>(
          `/v1/apps/${parts.appName}/secrets/${encodeURIComponent(parts.childId)}`,
          { method: "POST", body: JSON.stringify({ value: fields["value"] }) },
        );
      }
      return this.getResource(typeId, resourceId, accountId);
    }

    throw new Error(`Fly plugin: updateResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId === "app") {
      const appName = resourceId.split(":").pop();
      if (!appName) throw new Error("Cannot parse app name");
      await this.fetch<unknown>(`/v1/apps/${appName}`, { method: "DELETE" });
      return;
    }

    if (typeId === "machine") {
      const parts = parseMachineId(resourceId);
      await this.fetch<unknown>(`/v1/apps/${parts.appName}/machines/${parts.machineId}`, {
        method: "DELETE",
      });
      return;
    }

    if (typeId === "volume") {
      const parts = parseVolumeId(resourceId);
      await this.fetch<unknown>(`/v1/apps/${parts.appName}/volumes/${parts.volumeId}`, {
        method: "DELETE",
      });
      return;
    }

    if (typeId === "certificate") {
      const parts = parseAppChildId(resourceId);
      await this.fetch<unknown>(
        `/v1/apps/${parts.appName}/certificates/${encodeURIComponent(parts.childId)}`,
        {
          method: "DELETE",
        },
      );
      return;
    }

    if (typeId === "ip-allocation") {
      const parts = parseAppChildId(resourceId);
      await this.fetch<unknown>(
        `/v1/apps/${parts.appName}/ip_assignments/${encodeURIComponent(parts.childId)}`,
        { method: "DELETE" },
      );
      return;
    }

    if (typeId === "app-secret") {
      const parts = parseAppChildId(resourceId);
      await this.fetch<unknown>(
        `/v1/apps/${parts.appName}/secrets/${encodeURIComponent(parts.childId)}`,
        { method: "DELETE" },
      );
      return;
    }

    if (typeId === "postgres-cluster") {
      const clusterId = resourceId.split(":").slice(2).join(":");
      await this.fetch<unknown>(`/v1/postgres/${encodeURIComponent(clusterId)}`, {
        method: "DELETE",
      });
      return;
    }

    throw new Error(`Fly plugin: deleteResource not supported for type "${typeId}"`);
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "machine" && MACHINE_ACTIONS.has(actionId)) {
      const parts = parseMachineId(resourceId);
      await this.fetch<unknown>(
        `/v1/apps/${parts.appName}/machines/${parts.machineId}/${actionId}`,
        { method: "POST" },
      );
      return;
    }
    if (typeId === "volume" && actionId === "snapshot") {
      const parts = parseVolumeId(resourceId);
      await this.fetch<unknown>(`/v1/apps/${parts.appName}/volumes/${parts.volumeId}/snapshots`, {
        method: "POST",
      });
      return;
    }
    if (typeId === "certificate" && actionId === "check") {
      const parts = parseAppChildId(resourceId);
      await this.fetch<unknown>(
        `/v1/apps/${parts.appName}/certificates/${encodeURIComponent(parts.childId)}/check`,
        { method: "POST" },
      );
      return;
    }
    if (typeId === "postgres-cluster" && actionId === "backup") {
      const clusterId = resourceId.split(":").slice(2).join(":");
      await this.fetch<unknown>(`/v1/postgres/${encodeURIComponent(clusterId)}/backups`, {
        method: "POST",
        body: JSON.stringify({ type: "full" }),
      });
      return;
    }
    throw new Error(`Fly plugin: invokeAction "${actionId}" not supported for type "${typeId}"`);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "app" || formatId !== "deploy-token") {
      throw new Error(`Fly plugin: credential format "${formatId}" not supported for "${typeId}"`);
    }
    const appName = resourceId.split(":").pop() ?? "";
    const data = await this.fetch<{ token?: string }>(`/v1/apps/${appName}/deploy_token`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const token = data.token ?? "";
    return {
      content: token,
      filename: `${appName}-deploy-token.txt`,
      mimeType: "text/plain",
      fields: [{ label: "FLY_API_TOKEN", value: token, sensitive: true }],
      warning:
        "Save this token now: Fly does not show it again. Revoke it from the app's Tokens page in the Fly dashboard.",
    };
  }

  /**
   * Two sources: application output (stdout/stderr) from
   * `GET https://api.fly.io/api/v1/apps/{app}/logs`, the endpoint `fly logs`
   * uses (described in Fly's "Logs API options" guide; it returns the latest
   * 100 lines of the last 24 hours and takes `instance=<machine id>`), and,
   * for machines, the Machines API's lifecycle events (launch, start, stop,
   * exit with code), newest last.
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId === "app") {
      const appName = resourceId.split(":").pop() ?? "";
      const text = await this.fetchAppLogs(appName, undefined, params.tailLines ?? 100);
      return { text, containers: ["logs"], activeContainer: "logs" };
    }
    if (typeId !== "machine") return { text: "", containers: [], activeContainer: "" };
    const parts = parseMachineId(resourceId);
    const containers = ["logs", "events"];
    if (params.container !== "events") {
      const text = await this.fetchAppLogs(parts.appName, parts.machineId, params.tailLines ?? 100);
      return { text, containers, activeContainer: "logs" };
    }
    const limit = Math.min(Math.max(params.tailLines ?? 50, 1), 50);
    const events = await this.fetch<FlyMachineEvent[]>(
      `/v1/apps/${parts.appName}/machines/${parts.machineId}/events?limit=${limit}`,
    );
    const lines = [...(events ?? [])]
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
      .map((e) => {
        const ts = e.timestamp ? new Date(e.timestamp).toISOString() : "?";
        const exit = (e.request as { exit_event?: { exit_code?: number } } | undefined)?.exit_event;
        const exitNote = exit?.exit_code != null ? `  exit_code=${exit.exit_code}` : "";
        return `${ts}  ${e.type ?? "event"}  ${e.status ?? ""}  (${e.source ?? "?"})${exitNote}`;
      });
    const text =
      lines.length > 0 ? lines.join("\n") + "\n" : "No events recorded for this machine yet.\n";
    return { text, containers, activeContainer: "events" };
  }

  /** Latest app log lines, formatted like `fly logs`, oldest first. */
  private async fetchAppLogs(
    appName: string,
    machineId: string | undefined,
    tailLines: number,
  ): Promise<string> {
    const u = new URL(`https://api.fly.io/api/v1/apps/${encodeURIComponent(appName)}/logs`);
    if (machineId) u.searchParams.set("instance", machineId);
    const data = await jsonRestFetch<FlyLogsResponse>({
      vendor: "Fly",
      url: u.toString(),
      errorPath: `/api/v1/apps/${appName}/logs`,
      headers: { Authorization: `Bearer ${this.token}` },
      ...(this.services?.http
        ? {
            http: this.services.http,
            ...(this.caCert ? { caCert: this.caCert } : {}),
          }
        : {}),
    });
    const lines = (data.data ?? [])
      .map((d) => d.attributes ?? {})
      .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")))
      .map((e) => {
        const instance = e.instance ?? e.meta?.instance ?? "";
        const region = e.region ?? e.meta?.region ?? "";
        const level = e.level ? ` ${e.level}` : "";
        return `${e.timestamp ?? ""} ${instance}[${region}]${level}: ${e.message ?? ""}`.trimEnd();
      })
      .slice(-Math.max(1, tailLines));
    return lines.length > 0 ? lines.join("\n") + "\n" : "No log output in the last 24 hours.\n";
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "volume" && targetTypeId === "machine") {
      const [volume, machine] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const volumeRegion = String(volume.fields["region"] ?? "");
      const machineRegion = String(machine.fields["region"] ?? "");
      if (volumeRegion && machineRegion && volumeRegion !== machineRegion) {
        throw new Error(
          `Volume region ${volumeRegion} does not match machine region ${machineRegion} — Fly volumes must be in the same region as the machine.`,
        );
      }
      const machineParts = parseMachineId(machine.id);
      const volumeParts = parseVolumeId(volume.id);
      if (volumeParts.appName !== machineParts.appName) {
        throw new Error(
          `Volume app ${volumeParts.appName} does not match machine app ${machineParts.appName} — Fly volumes can only mount on machines of the same app.`,
        );
      }
      // Fetch current machine config so we can preserve image/env/etc.
      const current = await this.fetch<FlyMachine>(
        `/v1/apps/${machineParts.appName}/machines/${machineParts.machineId}`,
      );
      const config = (current.config ?? {}) as Record<string, unknown>;
      const existingMounts = Array.isArray(config["mounts"])
        ? (config["mounts"] as Array<Record<string, unknown>>)
        : [];
      if (existingMounts.some((m) => String(m["volume"] ?? "") === volumeParts.volumeId)) {
        return; // already mounted
      }
      const newMounts = [
        ...existingMounts,
        { volume: volumeParts.volumeId, path: `/mnt/${String(volume.fields["name"] ?? "data")}` },
      ];
      await this.fetch(`/v1/apps/${machineParts.appName}/machines/${machineParts.machineId}`, {
        method: "POST",
        body: JSON.stringify({ config: { ...config, mounts: newMounts } }),
      });
      return;
    }
    if (sourceTypeId === "postgres-cluster" && targetTypeId === "app") {
      // Records the cluster/app relationship only: it sets no DATABASE_URL
      // secret. Idempotent (200 when already attached).
      const clusterId = sourceResourceId.split(":").slice(2).join(":");
      const appName = targetResourceId.split(":").slice(2).join(":");
      if (!clusterId || !appName) {
        throw new Error("Cannot determine the Postgres cluster or app to attach");
      }
      await this.fetch<unknown>(`/v1/postgres/${encodeURIComponent(clusterId)}/attachments`, {
        method: "POST",
        body: JSON.stringify({ app_name: appName }),
      });
      return;
    }
    throw new Error(
      `Fly plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  /**
   * Volumes: list snapshots. Managed Postgres: databases, users, and
   * backups. Each list is stashed as JSON under a `__…__` field for the
   * synchronous renderer, and dropped silently when its call fails (a
   * cluster that is still provisioning answers 503 on the pg-admin routes).
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const extra: Record<string, string> = {};
    const stash = async (key: string, load: () => Promise<unknown[] | undefined>) => {
      try {
        const rows = await load();
        if (rows) extra[key] = JSON.stringify(rows);
      } catch {
        /* optional panel */
      }
    };

    if (resource.resourceTypeId === "volume") {
      const parts = parseVolumeId(resource.id);
      await stash("__snapshots__", () =>
        this.fetch<FlyVolumeSnapshot[]>(
          `/v1/apps/${parts.appName}/volumes/${parts.volumeId}/snapshots`,
        ),
      );
    } else if (resource.resourceTypeId === "postgres-cluster") {
      const base = `/v1/postgres/${encodeURIComponent(resource.externalId ?? "")}`;
      if (resource.fields["status"] === "ready") {
        await Promise.all([
          stash(
            "__databases__",
            async () => (await this.fetch<{ data?: unknown[] }>(`${base}/databases`)).data,
          ),
          stash(
            "__users__",
            async () => (await this.fetch<{ data?: unknown[] }>(`${base}/users`)).data,
          ),
          stash(
            "__backups__",
            async () => (await this.fetch<{ data?: unknown[] }>(`${base}/backups`)).data,
          ),
        ]);
      }
    } else {
      return resource;
    }
    return { ...resource, fields: { ...resource.fields, ...extra } };
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    if (resourceTypeId === "app") {
      return [
        {
          label: "Status",
          value: String(f["status"] ?? "unknown"),
          variant: f["status"] === "deployed" ? "status-healthy" : "status-degraded",
        },
        { label: "Machines", value: String(f["machineCount"] ?? 0) },
        { label: "Volumes", value: String(f["volumeCount"] ?? 0) },
      ];
    }

    if (resourceTypeId === "machine") {
      const stateVariant = machineStateToDashboardVariant(String(f["state"] ?? "unknown"));
      return [
        { label: "State", value: String(f["state"] ?? "unknown"), variant: stateVariant },
        { label: "Region", value: formatRegion(String(f["region"] ?? "")) },
        ...(f["image"] ? [{ label: "Image", value: String(f["image"]) }] : []),
      ];
    }

    if (resourceTypeId === "volume") {
      return [
        { label: "Size", value: `${String(f["sizeGb"])} GB` },
        { label: "Region", value: formatRegion(String(f["region"] ?? "")) },
        { label: "State", value: String(f["state"] ?? "unknown") },
      ];
    }

    if (resourceTypeId === "certificate") {
      return [
        { label: "Hostname", value: String(f["hostname"] ?? "") },
        { label: "Configured", value: f["configured"] ? "Yes" : "No" },
        ...(f["expires"] ? [{ label: "Expires", value: String(f["expires"]) }] : []),
      ];
    }

    if (resourceTypeId === "postgres-cluster") {
      const status = String(f["status"] ?? "unknown");
      const dot = postgresStatusDot(status);
      return [
        {
          label: "Status",
          value: status,
          variant:
            dot === "healthy"
              ? "status-healthy"
              : dot === "error"
                ? "status-error"
                : "status-degraded",
        },
        ...(f["plan"] ? [{ label: "Plan", value: String(f["plan"]) }] : []),
        ...(f["region"] ? [{ label: "Region", value: formatRegion(String(f["region"])) }] : []),
      ];
    }

    if (resourceTypeId === "ip-allocation") {
      return [
        { label: "Address", value: String(f["address"] ?? "") },
        ...(f["type"] ? [{ label: "Type", value: String(f["type"]) }] : []),
        ...(f["region"] ? [{ label: "Region", value: formatRegion(String(f["region"])) }] : []),
      ];
    }

    return [];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "machine" && resourceTypeId !== "app" && resourceTypeId !== "volume") {
      return [];
    }

    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const appName = String(
      resourceTypeId === "app" ? resource.fields["name"] : resource.fields["appName"],
    );
    if (!appName) return [];

    const now = Date.now();
    const start = Math.floor((timeRange?.startMs ?? now - 3_600_000) / 1000);
    const end = Math.floor((timeRange?.endMs ?? now) / 1000);
    const step = "60s";

    const url = `https://api.fly.io/prometheus/${encodeURIComponent(this.orgSlug)}/api/v1/query_range`;

    interface PromResp {
      data?: {
        result?: Array<{
          metric: Record<string, string>;
          values: [number, string][];
        }>;
      };
    }

    const fetchPromql = async (
      query: string,
      label: string,
      unit: string,
    ): Promise<MetricSeries | null> => {
      try {
        const u = new URL(url);
        u.searchParams.set("query", query);
        u.searchParams.set("start", String(start));
        u.searchParams.set("end", String(end));
        u.searchParams.set("step", step);
        const data = await jsonRestFetch<PromResp>({
          vendor: "Fly",
          url: u.toString(),
          errorPath: `/prometheus/${this.orgSlug}/api/v1/query_range`,
          headers: { Authorization: `Bearer ${this.token}` },
          ...(this.services?.http
            ? {
                http: this.services.http,
                ...(this.caCert ? { caCert: this.caCert } : {}),
              }
            : {}),
        });
        // Sum across all returned series (when multiple machines match).
        const points = new Map<number, number>();
        for (const series of data.data?.result ?? []) {
          for (const [ts, v] of series.values) {
            const value = Number(v);
            if (!Number.isFinite(value)) continue;
            const tsMs = Math.round(ts * 1000);
            points.set(tsMs, (points.get(tsMs) ?? 0) + value);
          }
        }
        if (points.size === 0) return null;
        return {
          label,
          unit,
          points: [...points.entries()]
            .sort(([a], [b]) => a - b)
            .map(([timestamp, value]) => ({ timestamp, value })),
        };
      } catch {
        return null;
      }
    };

    // Metric names and units per https://fly.io/docs/monitoring/metrics/.
    if (resourceTypeId === "volume") {
      const volumeId = parseVolumeId(resource.id).volumeId;
      const labels = `app="${appName}",id="${volumeId}"`;
      const series = await Promise.all([
        fetchPromql(`max(fly_volume_used_pct{${labels}})`, "Disk Used", "%"),
        fetchPromql(`max(fly_volume_size_bytes{${labels}})`, "Volume Size", "bytes"),
      ]);
      return series.filter((s): s is MetricSeries => s != null);
    }

    // The `instance` label carries the Machine ID (not the Machines API's
    // per-version `instance_id`), the same id the logs API filters on.
    const machineFilter =
      resourceTypeId === "machine" ? `,instance="${parseMachineId(resource.id).machineId}"` : "";
    const labels = `app="${appName}"${machineFilter}`;
    // `fly_instance_cpu` counts centiseconds, so its per-second rate / 100 is cores.
    const queries: Array<[string, string, string]> = [
      [
        `sum(rate(fly_instance_cpu{${labels},mode!="idle"}[1m])) by (instance) / 100`,
        "CPU",
        "cores",
      ],
      [
        `avg(fly_instance_memory_mem_total{${labels}} - fly_instance_memory_mem_available{${labels}}) by (instance)`,
        "Memory Used",
        "bytes",
      ],
      [
        `avg(fly_instance_memory_mem_available{${labels}}) by (instance)`,
        "Available Memory",
        "bytes",
      ],
      [`avg(fly_instance_load_average{${labels},minutes="1"}) by (instance)`, "Load (1m)", ""],
      [
        `sum(rate(fly_instance_net_recv_bytes{${labels}}[1m])) by (instance)`,
        "Network In",
        "bytes/s",
      ],
      [
        `sum(rate(fly_instance_net_sent_bytes{${labels}}[1m])) by (instance)`,
        "Network Out",
        "bytes/s",
      ],
      [`sum(rate(fly_app_http_responses_count{${labels}}[1m]))`, "HTTP Requests", "req/s"],
      [`sum(rate(fly_app_http_responses_count{${labels},status=~"5.."}[1m]))`, "HTTP 5xx", "req/s"],
      [
        `histogram_quantile(0.95, sum(rate(fly_app_http_response_time_seconds_bucket{${labels}}[1m])) by (le))`,
        "Response Time p95",
        "s",
      ],
      [`sum(fly_app_concurrency{${labels}})`, "Concurrency", "requests"],
      [
        `histogram_quantile(0.95, sum(rate(fly_app_connect_time_seconds_bucket{${labels}}[1m])) by (le))`,
        "Connect Time p95",
        "s",
      ],
      [`sum(rate(fly_app_tcp_connects_count{${labels}}[1m]))`, "TCP Connects", "conn/s"],
      // CPU performance: time throttled after the burst quota ran out, the
      // remaining burst balance and the baseline quota, all per Fly's docs
      // in centiseconds (balance, throttle) or CPUs (baseline).
      [
        `sum(rate(fly_instance_cpu_throttle{${labels}}[1m])) by (instance) / 100`,
        "CPU Throttled",
        "cores",
      ],
      [`min(fly_instance_cpu_balance{${labels}}) / 100`, "CPU Burst Balance", "s"],
      [`sum(fly_instance_cpu_baseline{${labels}}) by (instance)`, "CPU Baseline", "cores"],
      // Disk counters come from /proc/diskstats: sectors are 512 bytes, and
      // the root disk (vdb) and any mounted volume (vdc) are summed.
      [
        `sum(rate(fly_instance_disk_sectors_read{${labels}}[1m])) by (instance) * 512`,
        "Disk Read",
        "bytes/s",
      ],
      [
        `sum(rate(fly_instance_disk_sectors_written{${labels}}[1m])) by (instance) * 512`,
        "Disk Write",
        "bytes/s",
      ],
      [
        `sum(rate(fly_instance_disk_reads_completed{${labels}}[1m])) by (instance)`,
        "Disk Read IOPS",
        "ops/s",
      ],
      [
        `sum(rate(fly_instance_disk_writes_completed{${labels}}[1m])) by (instance)`,
        "Disk Write IOPS",
        "ops/s",
      ],
      [
        `max(100 * (1 - fly_instance_filesystem_blocks_avail{${labels},mount="/"} / fly_instance_filesystem_blocks{${labels},mount="/"}))`,
        "Root Disk Used",
        "%",
      ],
      [
        `sum(fly_instance_memory_swap_total{${labels}} - fly_instance_memory_swap_free{${labels}}) by (instance)`,
        "Swap Used",
        "bytes",
      ],
      [`sum(fly_instance_filefd_allocated{${labels}}) by (instance)`, "Open File Descriptors", ""],
      // Edge (Fly Proxy) series carry no `instance` label, so they only
      // exist at app scope.
      ...(resourceTypeId === "app"
        ? ([
            [`sum(rate(fly_edge_http_responses_count{${labels}}[1m]))`, "Edge Requests", "req/s"],
            [
              `sum(rate(fly_edge_http_responses_count{${labels},status=~"5.."}[1m]))`,
              "Edge 5xx",
              "req/s",
            ],
            [
              `histogram_quantile(0.95, sum(rate(fly_edge_http_response_time_seconds_bucket{${labels}}[1m])) by (le))`,
              "Edge Response Time p95",
              "s",
            ],
            [`sum(rate(fly_edge_data_out{${labels}}[1m]))`, "Edge Data Out", "bytes/s"],
            [`sum(rate(fly_edge_data_in{${labels}}[1m]))`, "Edge Data In", "bytes/s"],
            [
              `sum(rate(fly_edge_tls_handshake_errors{${labels}}[1m]))`,
              "TLS Handshake Errors",
              "errors/s",
            ],
          ] as Array<[string, string, string]>)
        : []),
    ];
    const series = await Promise.all(queries.map(([q, l, u]) => fetchPromql(q, l, u)));
    return series.filter((s): s is MetricSeries => s != null);
  }

  /* ------------------------------------------------------------------ */
  /*  PluginClient: rendering                                           */
  /* ------------------------------------------------------------------ */

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    // Apps and machines declare `supportsMetrics`; the Prometheus range query
    // in `fetchMetricSeries` defaults to the last hour.
    return withMetricsCapability(
      this.renderDetailInner(resource),
      this.resourceTypes,
      resource.resourceTypeId,
      3_600_000,
    );
  }

  private renderDetailInner(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;

    if (resource.resourceTypeId === "app") {
      return {
        title: resource.displayName,
        subtitle: joinSubtitle("app", fields["organization"]),
        status: {
          kind: "status-dot",
          status: fields["status"] === "deployed" ? "healthy" : "degraded",
        },
        sections: [
          {
            kind: "section",
            title: "Overview",
            children: [
              {
                kind: "key-value-list",
                items: [
                  { key: "Name", value: String(fields["name"] ?? "") },
                  { key: "Status", value: String(fields["status"] ?? "") },
                  { key: "Organization", value: String(fields["organization"] ?? "") },
                  { key: "Machines", value: String(fields["machineCount"] ?? 0) },
                  { key: "Volumes", value: String(fields["volumeCount"] ?? 0) },
                  ...(fields["network"]
                    ? [{ key: "Network", value: String(fields["network"]) }]
                    : []),
                  ...(fields["networkCidr"]
                    ? [{ key: "Network CIDR", value: String(fields["networkCidr"]) }]
                    : []),
                ],
              },
            ],
          },
        ],
        headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
        logs: { defaultTailLines: 100 },
      };
    }

    if (resource.resourceTypeId === "machine") {
      const state = String(fields["state"] ?? "unknown");
      const cordoned = fields["cordoned"] === true;
      // Stop/Start header actions for the lifecycle pair (see the type's
      // `lifecycle` declaration); Start also resumes a suspended machine.
      const lifecycleActions: ActionNode[] = [];
      if (state === "started") {
        lifecycleActions.push(
          {
            kind: "action",
            label: "Restart",
            action: {
              type: "plugin-action",
              actionId: "restart",
              confirmMessage: "Restart this machine? In-flight requests to it will be dropped.",
              successMessage: "Restart requested.",
            },
          },
          {
            kind: "action",
            label: "Suspend",
            action: {
              type: "plugin-action",
              actionId: "suspend",
              confirmMessage:
                "Suspend this machine? Its memory is snapshotted so the next start can resume instead of cold-booting.",
              successMessage: "Suspend requested.",
            },
          },
          {
            kind: "action",
            label: cordoned ? "Uncordon" : "Cordon",
            action: {
              type: "plugin-action",
              actionId: cordoned ? "uncordon" : "cordon",
              ...(cordoned
                ? {}
                : {
                    confirmMessage:
                      "Cordon this machine? The Fly Proxy stops routing requests to it until it is uncordoned.",
                  }),
              successMessage: cordoned ? "Services re-enabled." : "Machine cordoned.",
            },
          },
          {
            kind: "action",
            label: "Stop",
            action: {
              type: "plugin-action",
              actionId: "stop",
              confirmMessage:
                "Stop this machine? Compute billing stops while it is stopped; rootfs storage keeps billing.",
              successMessage: "Stop requested.",
            },
            variant: "danger",
          },
        );
      } else if (state === "stopped" || state === "suspended") {
        lifecycleActions.push({
          kind: "action",
          label: "Start",
          action: {
            type: "plugin-action",
            actionId: "start",
            successMessage: "Start requested.",
          },
        });
      }
      const compute =
        fields["cpus"] !== undefined && fields["cpus"] !== ""
          ? `${String(fields["cpus"])} ${String(fields["cpuKind"] ?? "")} vCPU, ${String(fields["memoryMb"] ?? "?")} MB`
          : "";
      return {
        title: resource.displayName,
        subtitle: joinSubtitle("machine", formatRegion(String(fields["region"] ?? ""))),
        status: { kind: "status-dot", status: machineStateToDot(state) },
        sections: [
          {
            kind: "section",
            title: "Details",
            children: [
              {
                kind: "key-value-list",
                items: [
                  ...(fields["name"] ? [{ key: "Name", value: String(fields["name"]) }] : []),
                  { key: "State", value: state },
                  { key: "Region", value: formatRegion(String(fields["region"] ?? "")) },
                  ...(fields["image"] ? [{ key: "Image", value: String(fields["image"]) }] : []),
                  ...(compute ? [{ key: "Compute", value: compute }] : []),
                  { key: "App", value: String(fields["appName"] ?? "") },
                  ...(fields["instanceId"]
                    ? [{ key: "Instance ID", value: String(fields["instanceId"]) }]
                    : []),
                  ...(resource.resolvedOutputs["privateIp"]
                    ? [{ key: "Private IP", value: resource.resolvedOutputs["privateIp"] }]
                    : []),
                  ...(cordoned ? [{ key: "Cordoned", value: "Yes (not receiving traffic)" }] : []),
                  ...(fields["hostStatus"] && fields["hostStatus"] !== "ok"
                    ? [{ key: "Host Status", value: String(fields["hostStatus"]) }]
                    : []),
                ],
              },
            ],
          },
        ],
        headerActions: [
          ...lifecycleActions,
          { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ],
        logs: { defaultTailLines: 100 },
      };
    }

    if (resource.resourceTypeId === "certificate") {
      return {
        title: resource.displayName,
        subtitle: joinSubtitle("certificate", fields["appName"]),
        status: {
          kind: "status-dot",
          status: fields["configured"] === true ? "healthy" : "degraded",
        },
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
          {
            kind: "action",
            label: "Check DNS",
            action: {
              type: "plugin-action",
              actionId: "check",
              successMessage: "DNS re-checked. Refresh to see the validation result.",
            },
          },
          { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ],
      };
    }

    if (resource.resourceTypeId === "postgres-cluster") {
      return renderPostgresClusterDetail(resource);
    }

    if (resource.resourceTypeId === "app-secret" || resource.resourceTypeId === "ip-allocation") {
      const isSecret = resource.resourceTypeId === "app-secret";
      return {
        title: resource.displayName,
        subtitle: joinSubtitle(isSecret ? "secret" : "IP address", fields["appName"]),
        status: { kind: "status-dot", status: "healthy" },
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

    // volume or fallback
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Details",
        children: [
          {
            kind: "key-value-list",
            items: labeledFieldItems(
              Object.fromEntries(Object.entries(fields).filter(([k]) => !k.startsWith("__"))),
              this.resourceTypes,
              resource.resourceTypeId,
            ),
          },
        ],
      },
    ];
    const snapshots = parseJsonList<FlyVolumeSnapshot>(fields["__snapshots__"]);
    if (snapshots.length > 0) {
      sections.push({
        kind: "section",
        title: "Snapshots",
        children: [
          {
            kind: "table",
            columns: [
              { key: "id", label: "Snapshot", mono: true },
              { key: "status", label: "Status" },
              { key: "size", label: "Size (bytes)" },
              { key: "created", label: "Created" },
              { key: "retention", label: "Retention (days)" },
            ],
            rows: snapshots.map((snap) => ({
              cells: {
                id: snap.id ?? "",
                status: snap.status ?? "",
                size: snap.size != null ? String(snap.size) : "",
                created: snap.created_at ?? "",
                retention: snap.retention_days != null ? String(snap.retention_days) : "",
              },
            })),
          },
        ],
      });
    }
    return {
      title: resource.displayName,
      subtitle: joinSubtitle("volume", formatRegion(String(fields["region"] ?? ""))),
      status: {
        kind: "status-dot",
        status: fields["state"] === "created" ? "healthy" : "error",
      },
      sections,
      headerActions: [
        ...(resource.resourceTypeId === "volume"
          ? [
              {
                kind: "action" as const,
                label: "Snapshot Now",
                action: {
                  type: "plugin-action" as const,
                  actionId: "snapshot",
                  successMessage: "Snapshot requested.",
                },
              },
            ]
          : []),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    let status: ResourceStatus = "info";
    if (resource.resourceTypeId === "machine") {
      status = machineStateToDot(String(resource.fields["state"] ?? "unknown"));
    } else if (resource.resourceTypeId === "app") {
      status = resource.fields["status"] === "deployed" ? "healthy" : "degraded";
    } else if (resource.resourceTypeId === "volume") {
      status = resource.fields["state"] === "created" ? "healthy" : "error";
    } else if (resource.resourceTypeId === "certificate") {
      status = resource.fields["configured"] === true ? "healthy" : "degraded";
    } else if (resource.resourceTypeId === "postgres-cluster") {
      status = postgresStatusDot(String(resource.fields["status"] ?? ""));
    } else if (
      resource.resourceTypeId === "app-secret" ||
      resource.resourceTypeId === "ip-allocation"
    ) {
      status = "healthy";
    }

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Private: list helpers                                              */
  /* ------------------------------------------------------------------ */

  private async listApps(accountId: string): Promise<ResourceInstance[]> {
    // Without `limit` the endpoint returns every app in one response.
    const data = await this.fetch<{ apps: FlyApp[]; total_apps: number }>(
      `/v1/apps?org_slug=${encodeURIComponent(this.orgSlug)}`,
    );
    // Older list responses omit `status`; treat a listed app as deployed
    // rather than flagging every row as pending.
    return (data.apps ?? []).map((app) =>
      this.mapApp({ ...app, status: app.status ?? "deployed" }, accountId),
    );
  }

  /** Run `load` for every app in the org, dropping apps whose call fails. */
  private async perApp(
    accountId: string,
    load: (appName: string) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const apps = await this.listApps(accountId);
    const batches = await Promise.all(
      apps.map(async (app) => {
        try {
          return await load(String(app.fields["name"]));
        } catch {
          return [];
        }
      }),
    );
    return batches.flat();
  }

  private async listAllMachines(accountId: string): Promise<ResourceInstance[]> {
    return this.perApp(accountId, async (appName) => {
      const machines = await this.fetch<FlyMachine[]>(`/v1/apps/${appName}/machines`);
      return (machines ?? []).map((m) => this.mapMachine(m, appName, accountId));
    });
  }

  private async listAllVolumes(accountId: string): Promise<ResourceInstance[]> {
    return this.perApp(accountId, async (appName) => {
      const volumes = await this.fetch<FlyVolume[]>(`/v1/apps/${appName}/volumes`);
      return (volumes ?? []).map((v) => this.mapVolume(v, appName, accountId));
    });
  }

  private async listAllCertificates(accountId: string): Promise<ResourceInstance[]> {
    return this.perApp(accountId, async (appName) => {
      const certs: FlyCertificate[] = [];
      let cursor = "";
      // `limit` caps at 500; follow `next_cursor` for apps with more hostnames.
      for (let page = 0; page < 20; page++) {
        const qs = `limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const data = await this.fetch<FlyCertificate[] | FlyCertificateListResponse>(
          `/v1/apps/${appName}/certificates?${qs}`,
        );
        if (Array.isArray(data)) {
          certs.push(...data);
          break;
        }
        certs.push(...(data.certificates ?? []));
        if (!data.next_cursor) break;
        cursor = data.next_cursor;
      }
      return certs.map((cert) => this.mapCertificate(cert, appName, accountId));
    });
  }

  private async listIpAllocationsForApp(
    appName: string,
    accountId: string,
  ): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ ips?: FlyIpAssignment[] }>(
      `/v1/apps/${appName}/ip_assignments`,
    );
    return (data.ips ?? []).map((ip) => this.mapIpAllocation(ip, appName, accountId));
  }

  private async listAllIpAllocations(accountId: string): Promise<ResourceInstance[]> {
    return this.perApp(accountId, (appName) => this.listIpAllocationsForApp(appName, accountId));
  }

  private async listAllSecrets(accountId: string): Promise<ResourceInstance[]> {
    // Values are never requested (`show_secrets` stays off): only names and digests.
    return this.perApp(accountId, async (appName) => {
      const data = await this.fetch<{ secrets?: FlyAppSecret[] }>(`/v1/apps/${appName}/secrets`);
      return (data.secrets ?? []).map((sec) => this.mapSecret(sec, appName, accountId));
    });
  }

  private async listPostgresClusters(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ data?: FlyPostgresCluster[] }>(
      `/v1/postgres?org_slug=${encodeURIComponent(this.orgSlug)}`,
    );
    return (data.data ?? []).map((c) => mapPostgresCluster(c, accountId));
  }

  /* ------------------------------------------------------------------ */
  /*  Private: mappers                                                   */
  /* ------------------------------------------------------------------ */

  private mapApp(app: FlyApp, accountId: string): ResourceInstance {
    const fields: Record<string, string | number | boolean> = {
      name: app.name,
      status: app.status ?? "pending",
      organization: app.organization?.slug ?? "",
      machineCount: app.machine_count ?? 0,
      volumeCount: app.volume_count ?? 0,
      network: app.network ?? "",
    };
    if (app.network_cidr) fields["networkCidr"] = app.network_cidr;
    return {
      id: `${accountId}:app:${app.name}`,
      pluginId: "fly",
      resourceTypeId: "app",
      accountId,
      displayName: app.name,
      fields,
      resolvedOutputs: { appName: app.name },
      secretStates: [],
      externalId: app.name,
      createdAt: app.created_at ?? new Date().toISOString(),
      updatedAt: app.created_at ?? new Date().toISOString(),
    };
  }

  private mapMachine(m: FlyMachine, appName: string, accountId: string): ResourceInstance {
    const fields: Record<string, string | number | boolean> = {
      name: m.name ?? "",
      state: m.state ?? "created",
      region: m.region ?? "",
      image: m.config?.image ?? m.image_ref?.repository ?? "",
      appName,
      instanceId: m.instance_id ?? "",
    };
    const guest = m.config?.guest;
    if (guest?.cpu_kind) fields["cpuKind"] = guest.cpu_kind;
    if (guest?.cpus != null) fields["cpus"] = guest.cpus;
    if (guest?.memory_mb != null) fields["memoryMb"] = guest.memory_mb;
    if (m.cordoned != null) fields["cordoned"] = m.cordoned;
    if (m.host_status) fields["hostStatus"] = m.host_status;
    return {
      id: `${accountId}:machine:${appName}/${m.id}`,
      pluginId: "fly",
      resourceTypeId: "machine",
      accountId,
      displayName: m.name || m.id,
      fields,
      resolvedOutputs: {
        privateIp: m.private_ip ?? "",
      },
      secretStates: [],
      externalId: `${appName}/${m.id}`,
      createdAt: m.created_at ?? new Date().toISOString(),
      updatedAt: m.updated_at ?? m.created_at ?? new Date().toISOString(),
    };
  }

  private mapVolume(v: FlyVolume, appName: string, accountId: string): ResourceInstance {
    const fields: Record<string, string | number | boolean> = {
      name: v.name ?? "",
      state: v.state ?? "created",
      sizeGb: v.size_gb ?? 0,
      region: v.region ?? "",
      encrypted: v.encrypted ?? true,
      attachedMachineId: v.attached_machine_id ?? "",
      appName,
    };
    if (v.zone) fields["zone"] = v.zone;
    if (v.auto_backup_enabled != null) fields["autoBackupEnabled"] = v.auto_backup_enabled;
    if (v.snapshot_retention != null) fields["snapshotRetention"] = v.snapshot_retention;
    if (v.bytes_used != null) fields["bytesUsed"] = v.bytes_used;
    if (v.bytes_total != null) fields["bytesTotal"] = v.bytes_total;
    if (v.host_status) fields["hostStatus"] = v.host_status;
    return {
      id: `${accountId}:volume:${appName}/${v.id}`,
      pluginId: "fly",
      resourceTypeId: "volume",
      accountId,
      displayName: v.name || v.id,
      fields,
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${appName}/${v.id}`,
      createdAt: v.created_at ?? new Date().toISOString(),
      updatedAt: v.created_at ?? new Date().toISOString(),
    };
  }

  /**
   * Handles both the list shape (`CertificateSummary`: flat `acme_*` flags)
   * and the detail shape (`CertificateDetail`: `certificates[]` entries with
   * issuer and expiry, plus `validation` / `validation_errors`).
   */
  private mapCertificate(
    cert: FlyCertificate,
    appName: string,
    accountId: string,
  ): ResourceInstance {
    const hostname = cert.hostname ?? cert.id ?? "";
    const entries = cert.certificates ?? [];
    const active = entries.find((e) => e.status === "active") ?? entries[0];
    const issued = active?.issued ?? [];
    const expiries = [active?.expires_at, ...issued.map((i) => i.expires_at)].filter(
      (x): x is string => Boolean(x),
    );
    const fields: Record<string, string | number | boolean> = {
      hostname,
      appName,
      status: cert.status ?? "",
      configured: cert.configured ?? false,
      acmeDnsConfigured: cert.acme_dns_configured ?? cert.validation?.dns_configured ?? false,
      certificateAuthority:
        issued.find((i) => i.certificate_authority)?.certificate_authority ?? active?.issuer ?? "",
      expires: expiries.sort()[0] ?? "",
      dnsProvider: cert.dns_provider ?? "",
    };
    const alpn = cert.acme_alpn_configured ?? cert.validation?.alpn_configured;
    if (alpn != null) fields["acmeAlpnConfigured"] = alpn;
    const http = cert.acme_http_configured ?? cert.validation?.http_configured;
    if (http != null) fields["acmeHttpConfigured"] = http;
    const ownership = cert.ownership_txt_configured ?? cert.validation?.ownership_txt_configured;
    if (ownership != null) fields["ownershipTxtConfigured"] = ownership;
    if (active?.source) {
      fields["source"] = active.source;
    } else if (cert.has_custom_certificate || cert.has_fly_certificate) {
      fields["source"] = cert.has_custom_certificate ? "custom" : "fly";
    }
    const errors = (cert.validation_errors ?? [])
      .map((e) => e.message ?? e.code ?? "")
      .filter(Boolean);
    if (errors.length > 0) fields["validationErrors"] = errors.join("; ");
    return {
      id: `${accountId}:certificate:${appName}/${hostname}`,
      pluginId: "fly",
      resourceTypeId: "certificate",
      accountId,
      displayName: hostname,
      fields,
      resolvedOutputs: { hostname },
      secretStates: [],
      externalId: `${appName}/${hostname}`,
      parentResourceId: `${accountId}:app:${appName}`,
      createdAt: cert.created_at ?? new Date().toISOString(),
      updatedAt: cert.updated_at ?? cert.created_at ?? new Date().toISOString(),
    };
  }

  /**
   * `IPAssignment` carries no type, so it is derived: a network marks a
   * Flycast address, `egress` / `shared` flag those kinds, and the address
   * family settles the rest.
   */
  private mapIpAllocation(
    ip: FlyIpAssignment,
    appName: string,
    accountId: string,
  ): ResourceInstance {
    const address = ip.ip ?? "";
    const isPrivate = ip.network != null;
    const type = isPrivate
      ? "private_v6"
      : ip.egress
        ? address.includes(":")
          ? "egress_v6"
          : "egress_v4"
        : ip.shared
          ? "shared_v4"
          : address.includes(":")
            ? "v6"
            : "v4";
    const fields: Record<string, string | number | boolean> = {
      address,
      appName,
      type,
      region: ip.region ?? "",
      network: ip.network?.name ?? "",
      shared: ip.shared ?? false,
      egress: ip.egress ?? false,
      private: isPrivate,
    };
    if (ip.service_name) fields["serviceName"] = ip.service_name;
    if (ip.created_at) fields["createdAt"] = ip.created_at;
    return {
      id: `${accountId}:ip-allocation:${appName}/${address}`,
      pluginId: "fly",
      resourceTypeId: "ip-allocation",
      accountId,
      displayName: address,
      fields,
      resolvedOutputs: { address },
      secretStates: [],
      externalId: `${appName}/${address}`,
      parentResourceId: `${accountId}:app:${appName}`,
      createdAt: ip.created_at ?? new Date().toISOString(),
      updatedAt: ip.created_at ?? new Date().toISOString(),
    };
  }

  private mapSecret(sec: FlyAppSecret, appName: string, accountId: string): ResourceInstance {
    const name = sec.name ?? "";
    const fields: Record<string, string | number | boolean> = { name, appName };
    if (sec.digest) fields["digest"] = sec.digest;
    if (sec.created_at) fields["createdAt"] = sec.created_at;
    if (sec.updated_at) fields["updatedAt"] = sec.updated_at;
    const created = sec.created_at ?? new Date().toISOString();
    return {
      id: `${accountId}:app-secret:${appName}/${name}`,
      pluginId: "fly",
      resourceTypeId: "app-secret",
      accountId,
      displayName: name,
      fields,
      resolvedOutputs: { secretName: name },
      secretStates: [],
      externalId: `${appName}/${name}`,
      parentResourceId: `${accountId}:app:${appName}`,
      createdAt: created,
      updatedAt: sec.updated_at ?? created,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function machineStateToDot(state: string): ResourceStatus {
  switch (state) {
    case "started":
      return "healthy";
    case "created":
    case "starting":
    case "replacing":
      return "provisioning";
    case "stopping":
    case "suspended":
      return "degraded";
    case "stopped":
    case "destroyed":
      return "error";
    default:
      return "info";
  }
}

function machineStateToDashboardVariant(
  state: string,
): "status-healthy" | "status-degraded" | "status-error" {
  switch (state) {
    case "started":
      return "status-healthy";
    case "stopped":
    case "destroyed":
      return "status-error";
    default:
      return "status-degraded";
  }
}

/** Parse `accountId:machine:appName/machineId` */
function parseMachineId(resourceId: string): { appName: string; machineId: string } {
  const externalId = resourceId.split(":").slice(2).join(":");
  const slashIdx = externalId.indexOf("/");
  if (slashIdx === -1) throw new Error(`Cannot parse machine resource ID: ${resourceId}`);
  return {
    appName: externalId.substring(0, slashIdx),
    machineId: externalId.substring(slashIdx + 1),
  };
}

/** Parse `accountId:volume:appName/volumeId` */
function parseVolumeId(resourceId: string): { appName: string; volumeId: string } {
  const externalId = resourceId.split(":").slice(2).join(":");
  const slashIdx = externalId.indexOf("/");
  if (slashIdx === -1) throw new Error(`Cannot parse volume resource ID: ${resourceId}`);
  return {
    appName: externalId.substring(0, slashIdx),
    volumeId: externalId.substring(slashIdx + 1),
  };
}

function parseAppChildId(resourceId: string): { appName: string; childId: string } {
  const externalId = resourceId.split(":").slice(2).join(":");
  const slashIdx = externalId.indexOf("/");
  if (slashIdx === -1) throw new Error(`Cannot parse Fly child resource ID: ${resourceId}`);
  return {
    appName: externalId.substring(0, slashIdx),
    childId: externalId.substring(slashIdx + 1),
  };
}

/* ------------------------------------------------------------------ */
/*  Fly API types                                                       */
/* ------------------------------------------------------------------ */

interface FlyApp {
  id: string;
  name: string;
  status?: string;
  organization?: { name: string; slug: string };
  machine_count?: number;
  volume_count?: number;
  network?: string;
  network_cidr?: string;
  created_at?: string;
}

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  instance_id?: string;
  private_ip?: string;
  cordoned?: boolean;
  host_status?: string;
  config?: {
    image?: string;
    guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number };
  };
  image_ref?: { repository?: string; tag?: string };
  created_at?: string;
  updated_at?: string;
  events?: unknown[];
}

interface FlyMachineEvent {
  id?: string;
  type?: string;
  status?: string;
  source?: string;
  timestamp?: number;
  request?: unknown;
}

interface FlyVolume {
  id: string;
  name: string;
  state: string;
  size_gb: number;
  region: string;
  zone?: string;
  encrypted?: boolean;
  attached_machine_id?: string;
  blocks?: number;
  block_size?: number;
  blocks_free?: number;
  bytes_used?: number;
  bytes_total?: number;
  host_status?: string;
  snapshot_retention?: number;
  auto_backup_enabled?: boolean;
  created_at?: string;
}

interface FlyVolumeSnapshot {
  id?: string;
  status?: string;
  size?: number;
  volume_size?: number;
  retention_days?: number;
  created_at?: string;
}

/**
 * Union of the Machines API's `CertificateSummary` (list) and
 * `CertificateDetail` (get / create / check) shapes.
 */
interface FlyCertificate {
  id?: string;
  hostname?: string;
  status?: string;
  configured?: boolean;
  acme_dns_configured?: boolean;
  acme_alpn_configured?: boolean;
  acme_http_configured?: boolean;
  ownership_txt_configured?: boolean;
  acme_requested?: boolean;
  has_custom_certificate?: boolean;
  has_fly_certificate?: boolean;
  dns_provider?: string;
  certificates?: Array<{
    source?: string;
    status?: string;
    issuer?: string;
    expires_at?: string;
    created_at?: string;
    issued?: Array<{ certificate_authority?: string; expires_at?: string; type?: string }>;
  }>;
  validation?: {
    alpn_configured?: boolean;
    dns_configured?: boolean;
    http_configured?: boolean;
    ownership_txt_configured?: boolean;
  };
  validation_errors?: Array<{ code?: string; message?: string }>;
  created_at?: string;
  updated_at?: string;
}

interface FlyCertificateListResponse {
  certificates?: FlyCertificate[];
  next_cursor?: string;
}

interface FlyIpAssignment {
  ip?: string | null;
  region?: string;
  shared?: boolean;
  egress?: boolean;
  service_name?: string;
  network?: { name?: string; org_slug?: string } | null;
  created_at?: string;
}

interface FlyAppSecret {
  name?: string;
  digest?: string;
  created_at?: string;
  updated_at?: string;
}

function parseJsonList<T>(raw: unknown): T[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
