import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  DashboardStat,
} from "@infrawrench/plugin-base";
import { createClient as createTursoApiClient } from "@tursodatabase/api";
import type { Database, Group, LocationKeys } from "@tursodatabase/api";

type TursoApiClient = ReturnType<typeof createTursoApiClient>;

const TURSO_LOCATIONS: Record<string, { location: string; flag: string }> = {
  ams: { location: "Amsterdam, Netherlands", flag: "\u{1F1F3}\u{1F1F1}" },
  arn: { location: "Stockholm, Sweden", flag: "\u{1F1F8}\u{1F1EA}" },
  bog: { location: "Bogot\u{00E1}, Colombia", flag: "\u{1F1E8}\u{1F1F4}" },
  bom: { location: "Mumbai, India", flag: "\u{1F1EE}\u{1F1F3}" },
  bos: { location: "Boston, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  cdg: { location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
  den: { location: "Denver, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  dfw: { location: "Dallas, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  ewr: { location: "Newark, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  fra: { location: "Frankfurt, Germany", flag: "\u{1F1E9}\u{1F1EA}" },
  gdl: { location: "Guadalajara, Mexico", flag: "\u{1F1F2}\u{1F1FD}" },
  gig: { location: "Rio de Janeiro, Brazil", flag: "\u{1F1E7}\u{1F1F7}" },
  gru: { location: "S\u{00E3}o Paulo, Brazil", flag: "\u{1F1E7}\u{1F1F7}" },
  hkg: { location: "Hong Kong", flag: "\u{1F1ED}\u{1F1F0}" },
  iad: { location: "Ashburn, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  jnb: { location: "Johannesburg, South Africa", flag: "\u{1F1FF}\u{1F1E6}" },
  lax: { location: "Los Angeles, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  lhr: { location: "London, UK", flag: "\u{1F1EC}\u{1F1E7}" },
  mad: { location: "Madrid, Spain", flag: "\u{1F1EA}\u{1F1F8}" },
  mia: { location: "Miami, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  nrt: { location: "Tokyo, Japan", flag: "\u{1F1EF}\u{1F1F5}" },
  ord: { location: "Chicago, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  otp: { location: "Bucharest, Romania", flag: "\u{1F1F7}\u{1F1F4}" },
  phx: { location: "Phoenix, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  qro: { location: "Quer\u{00E9}taro, Mexico", flag: "\u{1F1F2}\u{1F1FD}" },
  scl: { location: "Santiago, Chile", flag: "\u{1F1E8}\u{1F1F1}" },
  sea: { location: "Seattle, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  sin: { location: "Singapore", flag: "\u{1F1F8}\u{1F1EC}" },
  sjc: { location: "San Jose, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  syd: { location: "Sydney, Australia", flag: "\u{1F1E6}\u{1F1FA}" },
  waw: { location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
  yul: { location: "Montreal, Canada", flag: "\u{1F1E8}\u{1F1E6}" },
  yyz: { location: "Toronto, Canada", flag: "\u{1F1E8}\u{1F1E6}" },
};

function formatLocation(code: string): string {
  const info = TURSO_LOCATIONS[code];
  return info ? `${info.flag} ${info.location} (${code})` : code;
}

/**
 * Turso plugin client.
 * Manages Turso databases and groups via the Turso Platform API.
 */
export class TursoClient implements PluginClient {
  private readonly orgName: string;
  private readonly api: TursoApiClient;

  constructor(credentials: Record<string, string>, _services?: HostServices) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Turso plugin: missing apiToken credential");

    const org = credentials["organizationName"];
    if (!org) throw new Error("Turso plugin: missing organizationName credential");
    this.orgName = org;

    this.api = createTursoApiClient({ org, token });
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "turso-database":
        return this.listDatabases(accountId);
      case "turso-group":
        return this.listGroups(accountId);
      default:
        throw new Error(`Turso plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Turso plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "turso-database") {
      if (outputKey === "connectionString") {
        return this.resolveDatabaseConnectionString(resourceId, accountId);
      }
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "hostname") return String(resource.fields["hostname"] ?? "");
      if (outputKey === "dbName") return String(resource.fields["name"] ?? "");
    }

    if (typeId === "turso-group") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "groupName") return String(resource.fields["name"] ?? "");
      if (outputKey === "primaryLocation") return String(resource.fields["primaryLocation"] ?? "");
    }

    throw new Error(`Turso plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    if (resourceTypeId === "turso-database") {
      const sleeping = f["sleeping"] === true || f["sleeping"] === "true";
      return [
        { label: "Group", value: String(f["group"] ?? "") },
        {
          label: "Region",
          value: formatLocation(String(f["primaryRegion"] ?? "")),
        },
        { label: "Version", value: String(f["version"] ?? "") },
        ...(sleeping
          ? [{ label: "Status", value: "sleeping", variant: "status-degraded" as const }]
          : []),
      ];
    }

    if (resourceTypeId === "turso-group") {
      return [
        { label: "Primary", value: formatLocation(String(f["primaryLocation"] ?? "")) },
        { label: "Locations", value: String(f["locations"] ?? "") },
        { label: "Version", value: String(f["version"] ?? "") },
      ];
    }

    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "turso-database":
        return this.renderDatabaseDetail(resource);
      case "turso-group":
        return this.renderGroupDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "turso-database") {
      const sleeping = resource.fields["sleeping"] === true;
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: sleeping ? "degraded" : "healthy" },
      };
    }

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "turso-database") {
      const groups = await this.fetchGroups();
      const groupOptions = groups.map((g) => ({
        id: g.name,
        label: g.name,
      }));

      return {
        fields: [
          { key: "name", label: "Database Name", kind: "text", required: true },
          {
            key: "group",
            label: "Group",
            kind: "select",
            required: true,
            options: groupOptions,
            ...(groupOptions[0] ? { defaultValue: groupOptions[0].id } : {}),
          },
          {
            key: "isSchema",
            label: "Schema Database",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes \u2014 use as a multi-tenant schema" },
            ],
            defaultValue: "false",
          },
        ],
      };
    }

    if (typeId === "turso-group") {
      const locationOptions = Object.entries(TURSO_LOCATIONS).map(([id, info]) => ({
        id,
        label: id,
        location: info.location,
        flag: info.flag,
      }));

      return {
        fields: [
          { key: "name", label: "Group Name", kind: "text", required: true },
          {
            key: "location",
            label: "Primary Location",
            kind: "region-picker",
            required: true,
            regions: locationOptions,
            defaultValue: "iad",
          },
        ],
      };
    }

    throw new Error(`Turso plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "turso-database") {
      return this.createDatabase(accountId, fields);
    }
    if (typeId === "turso-group") {
      return this.createGroup(accountId, fields);
    }
    throw new Error(`Turso plugin: cannot create type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "turso-database") {
      await this.api.databases.delete(externalId);
      return;
    }
    if (typeId === "turso-group") {
      await this.api.groups.delete(externalId);
      return;
    }
    throw new Error(`Turso plugin: cannot delete type "${typeId}"`);
  }

  private async fetchDatabases(): Promise<Database[]> {
    return this.api.databases.list();
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    const now = new Date().toISOString();

    return databases.map((db) => ({
      id: `${accountId}:turso-database:${db.name}`,
      pluginId: "turso",
      resourceTypeId: "turso-database",
      accountId,
      displayName: db.name,
      externalId: db.name,
      fields: {
        name: db.name,
        hostname: db.hostname,
        group: db.group ?? "",
        primaryRegion: db.primaryRegion ?? "",
        regions: (db.regions ?? []).join(", "),
        version: db.version,
        isSchema: db.is_schema,
        schema: db.schema || "",
        sleeping: db.sleeping,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    }));
  }

  private async resolveDatabaseConnectionString(
    resourceId: string,
    _accountId: string,
  ): Promise<string> {
    const dbName = resourceId.split(":").slice(2).join(":");

    // Create a non-expiring auth token for this database
    const tokenData = await this.api.databases.createToken(dbName);

    // Return as libsql URL with auth token in query parameter
    // The driver will parse this to extract url and authToken
    const hostname = `${dbName}-${this.orgName}.turso.io`;
    return `libsql://${hostname}?authToken=${encodeURIComponent(tokenData.jwt)}`;
  }

  private async createDatabase(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"];
    if (!name) throw new Error("Turso plugin: missing database name");
    const group = fields["group"];

    const options: Parameters<typeof this.api.databases.create>[1] = {
      ...(group ? { group } : {}),
      ...(fields["isSchema"] === "true" ? { is_schema: true } : {}),
    };

    const created = await this.api.databases.create(name, options);

    const now = new Date().toISOString();
    return {
      id: `${accountId}:turso-database:${created.name}`,
      pluginId: "turso",
      resourceTypeId: "turso-database",
      accountId,
      displayName: created.name,
      externalId: created.name,
      fields: {
        name: created.name,
        hostname: created.hostname,
        group: group ?? "",
        primaryRegion: "",
        regions: "",
        version: "",
        isSchema: fields["isSchema"] === "true",
        schema: "",
        sleeping: false,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async fetchGroups(): Promise<Group[]> {
    return this.api.groups.list();
  }

  private async listGroups(accountId: string): Promise<ResourceInstance[]> {
    const groups = await this.fetchGroups();
    const now = new Date().toISOString();

    return groups.map((g) => ({
      id: `${accountId}:turso-group:${g.name}`,
      pluginId: "turso",
      resourceTypeId: "turso-group",
      accountId,
      displayName: g.name,
      externalId: g.name,
      fields: {
        name: g.name,
        primaryLocation: g.primary,
        locations: g.locations.join(", "),
        version: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    }));
  }

  private async createGroup(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"];
    const location = fields["location"];
    if (!name) throw new Error("Turso plugin: missing group name");
    if (!location) throw new Error("Turso plugin: missing group location");

    const g = await this.api.groups.create(name, location as keyof LocationKeys);

    const now = new Date().toISOString();
    return {
      id: `${accountId}:turso-group:${g.name}`,
      pluginId: "turso",
      resourceTypeId: "turso-group",
      accountId,
      displayName: g.name,
      externalId: g.name,
      fields: {
        name: g.name,
        primaryLocation: g.primary,
        locations: (g.locations ?? []).join(", "),
        version: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private renderDatabaseDetail(resource: ResourceInstance): DetailViewSchema {
    const regions = String(resource.fields["regions"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(formatLocation)
      .join(", ");

    return {
      title: resource.displayName,
      subtitle: `Turso Database \u00B7 ${String(resource.fields["group"] ?? "default")}`,
      status: {
        kind: "status-dot",
        status: resource.fields["sleeping"] === true ? "degraded" : "healthy",
      },
      sections: [
        {
          kind: "section",
          title: "Connection",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Hostname", value: String(resource.fields["hostname"] ?? "\u2014") },
                {
                  key: "Connection String",
                  value: `libsql://${String(resource.fields["hostname"] ?? "")}`,
                  sensitive: true,
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Configuration",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Group", value: String(resource.fields["group"] ?? "\u2014") },
                {
                  key: "Primary Region",
                  value: formatLocation(String(resource.fields["primaryRegion"] ?? "")),
                },
                { key: "Regions", value: regions || "\u2014" },
                { key: "Version", value: String(resource.fields["version"] ?? "\u2014") },
                ...(resource.fields["isSchema"] === true
                  ? [{ key: "Schema Database", value: "Yes" }]
                  : []),
                ...(resource.fields["schema"]
                  ? [{ key: "Parent Schema", value: String(resource.fields["schema"]) }]
                  : []),
                {
                  key: "Status",
                  value: resource.fields["sleeping"] === true ? "Sleeping" : "Active",
                },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      sqlEditor: {
        connectionStringOutputKey: "connectionString",
        defaultQuery: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
      },
    };
  }

  private renderGroupDetail(resource: ResourceInstance): DetailViewSchema {
    const locations = String(resource.fields["locations"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(formatLocation)
      .join("\n");

    return {
      title: resource.displayName,
      subtitle: "Turso Group",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Configuration",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Primary Location",
                  value: formatLocation(String(resource.fields["primaryLocation"] ?? "")),
                },
                { key: "Locations", value: locations || "\u2014" },
                { key: "Version", value: String(resource.fields["version"] ?? "\u2014") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: resource.resourceTypeId,
      status: { kind: "status-dot", status: "info" },
      sections: [],
      headerActions: [],
    };
  }
}
