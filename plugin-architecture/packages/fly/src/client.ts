import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  ResourceStatus,
  ResourceTypeDefinition,
  DashboardStat,
} from "@infrawrench/plugin-base";
import { labeledFieldItems, labeledOutputItems } from "@infrawrench/plugin-base";

/**
 * Fly.io plugin client.
 * Created per account (per API token + org slug) by the host.
 */
export class FlyClient implements PluginClient {
  private readonly token: string;
  private readonly orgSlug: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly baseUrl = "https://api.machines.dev";

  private static readonly REGION_INFO: Record<string, { location: string; flag: string }> = {
    ams: { location: "Amsterdam, Netherlands", flag: "\u{1F1F3}\u{1F1F1}" },
    arn: { location: "Stockholm, Sweden", flag: "\u{1F1F8}\u{1F1EA}" },
    atl: { location: "Atlanta, Georgia (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    bog: { location: "Bogot\u00e1, Colombia", flag: "\u{1F1E8}\u{1F1F4}" },
    bom: { location: "Mumbai, India", flag: "\u{1F1EE}\u{1F1F3}" },
    bos: { location: "Boston, Massachusetts (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    cdg: { location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    den: { location: "Denver, Colorado (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    dfw: { location: "Dallas, Texas (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    ewr: { location: "Secaucus, NJ (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    eze: { location: "Buenos Aires, Argentina", flag: "\u{1F1E6}\u{1F1F7}" },
    fra: { location: "Frankfurt, Germany", flag: "\u{1F1E9}\u{1F1EA}" },
    gdl: { location: "Guadalajara, Mexico", flag: "\u{1F1F2}\u{1F1FD}" },
    gig: { location: "Rio de Janeiro, Brazil", flag: "\u{1F1E7}\u{1F1F7}" },
    gru: { location: "S\u00e3o Paulo, Brazil", flag: "\u{1F1E7}\u{1F1F7}" },
    hkg: { location: "Hong Kong", flag: "\u{1F1ED}\u{1F1F0}" },
    iad: { location: "Ashburn, Virginia (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    jnb: { location: "Johannesburg, South Africa", flag: "\u{1F1FF}\u{1F1E6}" },
    lax: { location: "Los Angeles, California (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    lhr: { location: "London, United Kingdom", flag: "\u{1F1EC}\u{1F1E7}" },
    mad: { location: "Madrid, Spain", flag: "\u{1F1EA}\u{1F1F8}" },
    mia: { location: "Miami, Florida (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    nrt: { location: "Tokyo, Japan", flag: "\u{1F1EF}\u{1F1F5}" },
    ord: { location: "Chicago, Illinois (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    otp: { location: "Bucharest, Romania", flag: "\u{1F1F7}\u{1F1F4}" },
    phx: { location: "Phoenix, Arizona (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    qro: { location: "Quer\u00e9taro, Mexico", flag: "\u{1F1F2}\u{1F1FD}" },
    scl: { location: "Santiago, Chile", flag: "\u{1F1E8}\u{1F1F1}" },
    sea: { location: "Seattle, Washington (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    sin: { location: "Singapore", flag: "\u{1F1F8}\u{1F1EC}" },
    sjc: { location: "San Jose, California (US)", flag: "\u{1F1FA}\u{1F1F8}" },
    syd: { location: "Sydney, Australia", flag: "\u{1F1E6}\u{1F1FA}" },
    waw: { location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
    yul: { location: "Montreal, Canada", flag: "\u{1F1E8}\u{1F1E6}" },
    yyz: { location: "Toronto, Canada", flag: "\u{1F1E8}\u{1F1E6}" },
  };

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Fly plugin: missing apiToken credential");
    this.token = token;
    this.orgSlug = credentials["orgSlug"] ?? "personal";
    this.resourceTypes = resourceTypes;
  }

  /* ------------------------------------------------------------------ */
  /*  HTTP helpers                                                       */
  /* ------------------------------------------------------------------ */

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Fly API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  /* ------------------------------------------------------------------ */
  /*  PluginClient — core contract                                       */
  /* ------------------------------------------------------------------ */

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "app":
        return this.listApps(accountId);
      case "machine":
        return this.listAllMachines(accountId);
      case "volume":
        return this.listAllVolumes(accountId);
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
    throw new Error(`Fly plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "app") {
      return {
        fields: [{ key: "name", label: "App Name", kind: "text", required: true }],
      };
    }

    if (typeId === "machine") {
      const regions = Object.entries(FlyClient.REGION_INFO).map(([code, info]) => ({
        id: code,
        label: code.toUpperCase(),
        location: info.location,
        flag: info.flag,
      }));

      return {
        fields: [
          { key: "appName", label: "App Name", kind: "text", required: true },
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
    if (typeId === "app") {
      const body = {
        app_name: fields["name"],
        org_slug: this.orgSlug,
      };
      await this.fetch<{ id: string }>("/v1/apps", {
        method: "POST",
        body: JSON.stringify(body),
      });
      // Fetch the created app to get full details
      const app = await this.fetch<FlyApp>(`/v1/apps/${fields["name"]}`);
      return this.mapApp(app, accountId);
    }

    if (typeId === "machine") {
      const appName = fields["appName"];
      if (!appName) throw new Error("Fly plugin: appName is required to create a machine");
      const body: Record<string, unknown> = {
        region: fields["region"],
        config: {
          image: fields["image"],
        },
      };
      if (fields["name"]) body["name"] = fields["name"];

      const data = await this.fetch<FlyMachine>(`/v1/apps/${appName}/machines`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return this.mapMachine(data, appName, accountId);
    }

    throw new Error(`Fly plugin: createResource not supported for type "${typeId}"`);
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

    throw new Error(`Fly plugin: deleteResource not supported for type "${typeId}"`);
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

    return [];
  }

  /* ------------------------------------------------------------------ */
  /*  PluginClient — rendering                                           */
  /* ------------------------------------------------------------------ */

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;

    if (resource.resourceTypeId === "app") {
      return {
        title: resource.displayName,
        subtitle: `app · ${String(fields["organization"] ?? "")}`,
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
                ],
              },
            ],
          },
        ],
        headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      };
    }

    if (resource.resourceTypeId === "machine") {
      const state = String(fields["state"] ?? "unknown");
      return {
        title: resource.displayName,
        subtitle: `machine · ${formatRegion(String(fields["region"] ?? ""))}`,
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
                  { key: "App", value: String(fields["appName"] ?? "") },
                  ...(fields["instanceId"]
                    ? [{ key: "Instance ID", value: String(fields["instanceId"]) }]
                    : []),
                  ...(resource.resolvedOutputs["privateIp"]
                    ? [{ key: "Private IP", value: resource.resolvedOutputs["privateIp"] }]
                    : []),
                ],
              },
            ],
          },
        ],
        headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      };
    }

    // volume or fallback
    return {
      title: resource.displayName,
      subtitle: `volume · ${formatRegion(String(fields["region"] ?? ""))}`,
      status: {
        kind: "status-dot",
        status: fields["state"] === "created" ? "healthy" : "error",
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
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    let status: ResourceStatus = "unknown";
    if (resource.resourceTypeId === "machine") {
      status = machineStateToDot(String(resource.fields["state"] ?? "unknown"));
    } else if (resource.resourceTypeId === "app") {
      status = resource.fields["status"] === "deployed" ? "healthy" : "degraded";
    } else if (resource.resourceTypeId === "volume") {
      status = resource.fields["state"] === "created" ? "healthy" : "error";
    }

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Private — list helpers                                              */
  /* ------------------------------------------------------------------ */

  private async listApps(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ apps: FlyAppListEntry[]; total_apps: number }>(
      `/v1/apps?org_slug=${encodeURIComponent(this.orgSlug)}`,
    );
    return (data.apps ?? []).map((app) => this.mapAppListEntry(app, accountId));
  }

  private async listAllMachines(accountId: string): Promise<ResourceInstance[]> {
    const apps = await this.listApps(accountId);
    const results: ResourceInstance[] = [];
    // Fetch machines for each app in parallel
    const batches = await Promise.all(
      apps.map(async (app) => {
        const appName = String(app.fields["name"]);
        try {
          const machines = await this.fetch<FlyMachine[]>(`/v1/apps/${appName}/machines`);
          return (machines ?? []).map((m) => this.mapMachine(m, appName, accountId));
        } catch {
          return [];
        }
      }),
    );
    for (const batch of batches) results.push(...batch);
    return results;
  }

  private async listAllVolumes(accountId: string): Promise<ResourceInstance[]> {
    const apps = await this.listApps(accountId);
    const results: ResourceInstance[] = [];
    const batches = await Promise.all(
      apps.map(async (app) => {
        const appName = String(app.fields["name"]);
        try {
          const volumes = await this.fetch<FlyVolume[]>(`/v1/apps/${appName}/volumes`);
          return (volumes ?? []).map((v) => this.mapVolume(v, appName, accountId));
        } catch {
          return [];
        }
      }),
    );
    for (const batch of batches) results.push(...batch);
    return results;
  }

  /* ------------------------------------------------------------------ */
  /*  Private — mappers                                                   */
  /* ------------------------------------------------------------------ */

  private mapApp(app: FlyApp, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:app:${app.name}`,
      pluginId: "fly",
      resourceTypeId: "app",
      accountId,
      displayName: app.name,
      fields: {
        name: app.name,
        status: app.status ?? "pending",
        organization: app.organization?.slug ?? "",
        machineCount: app.machine_count ?? 0,
        volumeCount: app.volume_count ?? 0,
        network: app.network ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: app.name,
      createdAt: app.created_at ?? new Date().toISOString(),
      updatedAt: app.created_at ?? new Date().toISOString(),
    };
  }

  private mapAppListEntry(app: FlyAppListEntry, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:app:${app.name}`,
      pluginId: "fly",
      resourceTypeId: "app",
      accountId,
      displayName: app.name,
      fields: {
        name: app.name,
        status: "deployed",
        organization: "",
        machineCount: app.machine_count ?? 0,
        volumeCount: app.volume_count ?? 0,
        network: app.network ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: app.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private mapMachine(m: FlyMachine, appName: string, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:machine:${appName}/${m.id}`,
      pluginId: "fly",
      resourceTypeId: "machine",
      accountId,
      displayName: m.name || m.id,
      fields: {
        name: m.name ?? "",
        state: m.state ?? "created",
        region: m.region ?? "",
        image: m.config?.image ?? m.image_ref?.repository ?? "",
        appName,
        instanceId: m.instance_id ?? "",
      },
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
    return {
      id: `${accountId}:volume:${appName}/${v.id}`,
      pluginId: "fly",
      resourceTypeId: "volume",
      accountId,
      displayName: v.name || v.id,
      fields: {
        name: v.name ?? "",
        state: v.state ?? "created",
        sizeGb: v.size_gb ?? 0,
        region: v.region ?? "",
        encrypted: v.encrypted ?? true,
        attachedMachineId: v.attached_machine_id ?? "",
        appName,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${appName}/${v.id}`,
      createdAt: v.created_at ?? new Date().toISOString(),
      updatedAt: v.created_at ?? new Date().toISOString(),
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
      return "unknown";
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

function formatRegion(code: string): string {
  const info = FlyClient["REGION_INFO"][code];
  if (!info) return code;
  return `${code} (${info.location})`;
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

/* ------------------------------------------------------------------ */
/*  Fly API types                                                       */
/* ------------------------------------------------------------------ */

interface FlyApp {
  id: string;
  name: string;
  status: string;
  organization?: { name: string; slug: string };
  machine_count?: number;
  volume_count?: number;
  network?: string;
  created_at?: string;
}

interface FlyAppListEntry {
  id: string;
  name: string;
  machine_count?: number;
  volume_count?: number;
  network?: string;
}

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  instance_id?: string;
  private_ip?: string;
  config?: { image?: string };
  image_ref?: { repository?: string; tag?: string };
  created_at?: string;
  updated_at?: string;
  events?: unknown[];
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
  snapshot_retention?: number;
  auto_backup_enabled?: boolean;
  created_at?: string;
}
