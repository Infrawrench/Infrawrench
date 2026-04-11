import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  DashboardStat,
} from "@infrawrench/plugin-base";

// PlanetScale API response types
interface PsRegion {
  slug: string;
  display_name: string;
}

interface PsDatabase {
  id: string;
  name: string;
  notes: string;
  region: PsRegion;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface PsBranch {
  id: string;
  name: string;
  parent_branch: string;
  mysql_address: string;
  mysql_edge_address: string;
  production: boolean;
  ready: boolean;
  safe_migrations: boolean;
  schema_last_updated_at: string;
  created_at: string;
  updated_at: string;
}

interface PsPassword {
  id: string;
  name: string;
  access_host_url: string;
  username: string;
  plain_text: string;
  database_branch: { name: string };
  created_at: string;
}

// PlanetScale regions
const PS_REGIONS: Record<string, { location: string; flag: string }> = {
  "us-east": { location: "AWS us-east-1 (N. Virginia)", flag: "\u{1F1FA}\u{1F1F8}" },
  "us-west": { location: "AWS us-west-2 (Oregon)", flag: "\u{1F1FA}\u{1F1F8}" },
  "eu-west": { location: "AWS eu-west-1 (Ireland)", flag: "\u{1F1EE}\u{1F1EA}" },
  "eu-central": { location: "AWS eu-central-1 (Frankfurt)", flag: "\u{1F1E9}\u{1F1EA}" },
  "ap-south": { location: "AWS ap-south-1 (Mumbai)", flag: "\u{1F1EE}\u{1F1F3}" },
  "ap-southeast": { location: "AWS ap-southeast-1 (Singapore)", flag: "\u{1F1F8}\u{1F1EC}" },
  "ap-northeast": { location: "AWS ap-northeast-1 (Tokyo)", flag: "\u{1F1EF}\u{1F1F5}" },
  "sa-east": { location: "AWS sa-east-1 (S\u{00E3}o Paulo)", flag: "\u{1F1E7}\u{1F1F7}" },
  "ap-southeast-2": { location: "AWS ap-southeast-2 (Sydney)", flag: "\u{1F1E6}\u{1F1FA}" },
};

function formatRegion(slug: string): string {
  const info = PS_REGIONS[slug];
  return info ? `${info.flag} ${info.location}` : slug;
}

// Client
export class PlanetScaleClient implements PluginClient {
  private readonly tokenId: string;
  private readonly tokenSecret: string;
  private readonly orgName: string;
  private readonly baseUrl = "https://api.planetscale.com/v1";

  constructor(credentials: Record<string, string>, _services?: HostServices) {
    const id = credentials["serviceTokenId"];
    if (!id) throw new Error("PlanetScale plugin: missing serviceTokenId credential");
    this.tokenId = id;

    const secret = credentials["serviceTokenSecret"];
    if (!secret) throw new Error("PlanetScale plugin: missing serviceTokenSecret credential");
    this.tokenSecret = secret;

    const org = credentials["organizationName"];
    if (!org) throw new Error("PlanetScale plugin: missing organizationName credential");
    this.orgName = org;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `${this.tokenId}:${this.tokenSecret}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`PlanetScale API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "ps-database":
        return this.listDatabases(accountId);
      case "ps-branch":
        return this.listAllBranches(accountId);
      default:
        throw new Error(`PlanetScale plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`PlanetScale plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "ps-branch" && outputKey === "connectionString") {
      return this.resolveBranchConnectionString(resourceId);
    }

    const resource = await this.getResource(typeId, resourceId, accountId);

    if (typeId === "ps-database") {
      if (outputKey === "databaseName") return String(resource.fields["name"] ?? "");
      if (outputKey === "region") return String(resource.fields["region"] ?? "");
    }

    if (typeId === "ps-branch") {
      if (outputKey === "branchName") return String(resource.fields["name"] ?? "");
      if (outputKey === "databaseName") return String(resource.fields["databaseName"] ?? "");
    }

    throw new Error(
      `PlanetScale plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "ps-database":
        return this.renderDatabaseDetail(resource);
      case "ps-branch":
        return this.renderBranchDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          status: { kind: "status-dot", status: "unknown" },
          sections: [],
          headerActions: [],
        };
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "ps-database") {
      const state = String(resource.fields["state"] ?? "");
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status:
            state === "ready" ? "healthy" : state === "awaiting_import" ? "provisioning" : "error",
        },
      };
    }

    if (resource.resourceTypeId === "ps-branch") {
      const ready = resource.fields["ready"] === true;
      const production = resource.fields["production"] === true;
      return {
        id: resource.id,
        label: `${resource.displayName}${production ? " (production)" : ""}`,
        status: {
          kind: "status-dot",
          status: ready ? "healthy" : "provisioning",
        },
      };
    }

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "unknown" },
    };
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "ps-database") {
      const regionOptions = Object.entries(PS_REGIONS).map(([id, info]) => ({
        id,
        label: id,
        location: info.location,
        flag: info.flag,
      }));

      return {
        fields: [
          { key: "name", label: "Database Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: regionOptions,
            defaultValue: "us-east",
          },
        ],
      };
    }

    if (typeId === "ps-branch") {
      // Fetch databases to populate the parent selector, then
      // fetch branches from the first database to offer a "from" branch
      const databases = await this.fetchDatabases();
      const dbOptions = databases.map((db) => ({
        id: db.name,
        label: db.name,
      }));

      // For the parent branch selector, we list branches of the first database
      // The host will use the selected database when creating
      const parentBranchOptions: { id: string; label: string }[] = [];
      const firstDb = databases[0];
      if (firstDb) {
        const branches = await this.fetchBranches(firstDb.name);
        for (const b of branches) {
          parentBranchOptions.push({ id: b.name, label: b.name });
        }
      }

      return {
        fields: [
          {
            key: "database",
            label: "Database",
            kind: "select",
            required: true,
            options: dbOptions,
            ...(dbOptions[0] ? { defaultValue: dbOptions[0].id } : {}),
          },
          { key: "name", label: "Branch Name", kind: "text", required: true },
          {
            key: "parentBranch",
            label: "Branch From",
            kind: "select",
            required: true,
            options: parentBranchOptions,
            ...(parentBranchOptions.find((b) => b.id === "main")
              ? { defaultValue: "main" }
              : parentBranchOptions[0]
                ? { defaultValue: parentBranchOptions[0].id }
                : {}),
          },
        ],
      };
    }

    throw new Error(`PlanetScale plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "ps-database") {
      return this.createDatabase(accountId, fields);
    }
    if (typeId === "ps-branch") {
      return this.createBranch(accountId, fields);
    }
    throw new Error(`PlanetScale plugin: cannot create type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "ps-database") {
      await this.fetch(`/organizations/${enc(this.orgName)}/databases/${enc(externalId)}`, {
        method: "DELETE",
      });
      return;
    }

    if (typeId === "ps-branch") {
      // externalId format: databaseName/branchName
      const parts = externalId.split("/");
      const dbName = parts[0] ?? "";
      const branchName = parts.slice(1).join("/");
      await this.fetch(
        `/organizations/${enc(this.orgName)}/databases/${enc(dbName)}/branches/${enc(branchName)}`,
        { method: "DELETE" },
      );
      return;
    }

    throw new Error(`PlanetScale plugin: cannot delete type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId === "ps-database") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const region = String(resource.fields["region"] ?? "");
      const state = String(resource.fields["state"] ?? "");
      const variant: DashboardStat["variant"] =
        state === "ready"
          ? "status-healthy"
          : state === "awaiting_import"
            ? "status-degraded"
            : "status-error";
      return [
        { label: "Region", value: region },
        { label: "State", value: state, variant },
      ];
    }

    if (resourceTypeId === "ps-branch") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const production = resource.fields["production"] === true;
      const ready = resource.fields["ready"] === true;
      return [
        { label: "Production", value: production ? "Yes" : "No" },
        { label: "Ready", value: ready ? "Yes" : "No" },
      ];
    }

    // Default: count databases
    const databases = await this.fetchDatabases();
    return [
      { label: "Version", value: "PlanetScale" },
      { label: "Databases", value: String(databases.length) },
    ];
  }

  private async fetchDatabases(): Promise<PsDatabase[]> {
    const data = await this.fetch<{ data: PsDatabase[] }>(
      `/organizations/${enc(this.orgName)}/databases`,
    );
    return data.data ?? [];
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    const now = new Date().toISOString();

    return databases.map((db) => ({
      id: `${accountId}:ps-database:${db.name}`,
      pluginId: "planetscale",
      resourceTypeId: "ps-database",
      accountId,
      displayName: db.name,
      externalId: db.name,
      fields: {
        name: db.name,
        region: db.region?.slug ?? "",
        state: db.state,
        htmlUrl: db.html_url ?? "",
        createdAt: db.created_at ?? "",
        updatedAt: db.updated_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    }));
  }

  private async createDatabase(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const data = await this.fetch<{ data: PsDatabase }>(
      `/organizations/${enc(this.orgName)}/databases`,
      {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"],
          region: fields["region"],
        }),
      },
    );

    const db = data.data;
    const now = new Date().toISOString();
    return {
      id: `${accountId}:ps-database:${db.name}`,
      pluginId: "planetscale",
      resourceTypeId: "ps-database",
      accountId,
      displayName: db.name,
      externalId: db.name,
      fields: {
        name: db.name,
        region: db.region?.slug ?? "",
        state: db.state ?? "ready",
        htmlUrl: db.html_url ?? "",
        createdAt: db.created_at ?? "",
        updatedAt: db.updated_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async fetchBranches(databaseName: string): Promise<PsBranch[]> {
    const data = await this.fetch<{ data: PsBranch[] }>(
      `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/branches`,
    );
    return data.data ?? [];
  }

  private async listAllBranches(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    const now = new Date().toISOString();

    const branchLists = await Promise.all(
      databases.map(async (db) => {
        const branches = await this.fetchBranches(db.name);
        return branches.map((b) => this.toBranchResource(b, db.name, accountId, now));
      }),
    );

    return branchLists.flat();
  }

  private toBranchResource(
    branch: PsBranch,
    databaseName: string,
    accountId: string,
    now: string,
  ): ResourceInstance {
    return {
      id: `${accountId}:ps-branch:${databaseName}/${branch.name}`,
      pluginId: "planetscale",
      resourceTypeId: "ps-branch",
      accountId,
      displayName: branch.name,
      externalId: `${databaseName}/${branch.name}`,
      parentResourceId: `${accountId}:ps-database:${databaseName}`,
      fields: {
        name: branch.name,
        databaseName,
        parentBranch: branch.parent_branch ?? "",
        production: branch.production,
        ready: branch.ready,
        safeMigrations: branch.safe_migrations,
        createdAt: branch.created_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async createBranch(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const dbName = fields["database"] ?? "";
    const data = await this.fetch<{ data: PsBranch }>(
      `/organizations/${enc(this.orgName)}/databases/${enc(dbName)}/branches`,
      {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"],
          parent_branch: fields["parentBranch"],
        }),
      },
    );

    const branch = data.data;
    const now = new Date().toISOString();
    return this.toBranchResource(branch, dbName, accountId, now);
  }

  private async resolveBranchConnectionString(resourceId: string): Promise<string> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const parts = externalId.split("/");
    const dbName = parts[0] ?? "";
    const branchName = parts.slice(1).join("/");

    // Create a connection password for this branch
    const data = await this.fetch<{ data: PsPassword }>(
      `/organizations/${enc(this.orgName)}/databases/${enc(dbName)}/branches/${enc(branchName)}/passwords`,
      {
        method: "POST",
        body: JSON.stringify({ name: `infrawrench-${Date.now()}` }),
      },
    );

    const pw = data.data;
    const user = encodeURIComponent(pw.username);
    const pass = encodeURIComponent(pw.plain_text);
    const host = pw.access_host_url;

    return `mysql://${user}:${pass}@${host}/${dbName}`;
  }

  private renderDatabaseDetail(resource: ResourceInstance): DetailViewSchema {
    const state = String(resource.fields["state"] ?? "");
    return {
      title: resource.displayName,
      subtitle: `PlanetScale Database \u00B7 ${formatRegion(String(resource.fields["region"] ?? ""))}`,
      status: {
        kind: "status-dot",
        status:
          state === "ready" ? "healthy" : state === "awaiting_import" ? "provisioning" : "error",
      },
      sections: [
        {
          kind: "section",
          title: "Overview",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Region",
                  value: formatRegion(String(resource.fields["region"] ?? "\u2014")),
                },
                { key: "State", value: state || "\u2014" },
                ...(resource.fields["htmlUrl"]
                  ? [{ key: "Dashboard", value: String(resource.fields["htmlUrl"]) }]
                  : []),
                { key: "Created", value: String(resource.fields["createdAt"] ?? "\u2014") },
                { key: "Updated", value: String(resource.fields["updatedAt"] ?? "\u2014") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderBranchDetail(resource: ResourceInstance): DetailViewSchema {
    const ready = resource.fields["ready"] === true;
    const production = resource.fields["production"] === true;

    return {
      title: resource.displayName,
      subtitle: `PlanetScale Branch \u00B7 ${String(resource.fields["databaseName"] ?? "")}`,
      status: {
        kind: "status-dot",
        status: ready ? "healthy" : "provisioning",
      },
      sections: [
        {
          kind: "section",
          title: "Branch Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Database", value: String(resource.fields["databaseName"] ?? "\u2014") },
                { key: "Production", value: production ? "Yes" : "No" },
                { key: "Ready", value: ready ? "Yes" : "No" },
                {
                  key: "Safe Migrations",
                  value: resource.fields["safeMigrations"] === true ? "Enabled" : "Disabled",
                },
                ...(resource.fields["parentBranch"]
                  ? [{ key: "Branched From", value: String(resource.fields["parentBranch"]) }]
                  : []),
                { key: "Created", value: String(resource.fields["createdAt"] ?? "\u2014") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      sqlEditor: {
        connectionStringOutputKey: "connectionString",
        defaultQuery: "SHOW TABLES;",
      },
    };
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
