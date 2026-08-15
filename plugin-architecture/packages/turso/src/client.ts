import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  DashboardStat,
  CostFetchRange,
  CostRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, jsonRestFetch } from "@infrawrench/plugin-base";
import { fetchTursoCostData } from "./cost-data.js";
import { createClient as createTursoApiClient } from "@tursodatabase/api";
import type {
  ApiToken,
  Database,
  DatabaseInstance,
  Group,
  Location,
  LocationKeys,
  OrganizationMember,
} from "@tursodatabase/api";

type TursoApiClient = ReturnType<typeof createTursoApiClient>;

interface TursoInvite {
  ID?: number;
  Email?: string;
  Username?: string;
  Role?: string;
  Token?: string;
  Accepted?: boolean;
  email?: string;
  username?: string;
  role?: string;
  token?: string;
  accepted?: boolean;
}

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
  private readonly token: string;
  private readonly services: HostServices | undefined;
  private readonly api: TursoApiClient;

  constructor(credentials: Record<string, string>, _services?: HostServices) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("Turso plugin: missing apiToken credential");
    this.token = token;

    const org = credentials["organizationName"];
    if (!org) throw new Error("Turso plugin: missing organizationName credential");
    this.orgName = org;
    this.services = _services;

    this.api = createTursoApiClient({ org, token });
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Turso",
      url: `https://api.turso.tech${path}`,
      errorPath: path,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      },
      ...(options ? { init: options } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "turso-database":
        return this.listDatabases(accountId);
      case "turso-group":
        return this.listGroups(accountId);
      case "turso-database-instance":
        return this.listDatabaseInstances(accountId);
      case "turso-location":
        return this.listLocations(accountId);
      case "turso-api-token":
        return this.listApiTokens(accountId);
      case "turso-organization-member":
        return this.listOrganizationMembers(accountId);
      case "turso-organization-invite":
        return this.listOrganizationInvites(accountId);
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

    if (typeId === "turso-database-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "hostname") return String(resource.fields["hostname"] ?? "");
      if (outputKey === "instanceName") return String(resource.fields["name"] ?? "");
    }

    if (typeId === "turso-location") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "locationCode") return String(resource.fields["code"] ?? "");
    }

    if (typeId === "turso-api-token") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "tokenName") return String(resource.fields["name"] ?? "");
    }

    if (typeId === "turso-organization-member") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "username") return String(resource.fields["username"] ?? "");
      if (outputKey === "email") return String(resource.fields["email"] ?? "");
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

    if (resourceTypeId === "turso-database-instance") {
      return [
        { label: "Database", value: String(f["database"] ?? "") },
        { label: "Type", value: String(f["type"] ?? "") },
        { label: "Region", value: formatLocation(String(f["region"] ?? "")) },
      ];
    }

    if (resourceTypeId === "turso-organization-member") {
      return [
        { label: "Role", value: String(f["role"] ?? "") },
        { label: "Email", value: String(f["email"] ?? "") },
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
      case "turso-database-instance":
        return this.renderDatabaseInstanceDetail(resource);
      case "turso-location":
        return this.renderLocationDetail(resource);
      case "turso-api-token":
        return this.renderApiTokenDetail(resource);
      case "turso-organization-member":
        return this.renderOrganizationMemberDetail(resource);
      case "turso-organization-invite":
        return this.renderOrganizationInviteDetail(resource);
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

    if (typeId === "turso-organization-invite") {
      return {
        fields: [
          { key: "email", label: "Email", kind: "text", required: true },
          {
            key: "role",
            label: "Role",
            kind: "select",
            required: true,
            options: [
              { id: "member", label: "member" },
              { id: "viewer", label: "viewer" },
              { id: "admin", label: "admin" },
            ],
            defaultValue: "member",
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
    if (typeId === "turso-organization-invite") {
      return this.createOrganizationInvite(accountId, fields);
    }
    throw new Error(`Turso plugin: cannot create type "${typeId}"`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "turso-organization-member") {
      const username = resourceId.split(":").slice(2).join(":");
      const role = fields["role"];
      if (!username) throw new Error("Turso plugin: missing member username");
      if (!role) throw new Error("Turso plugin: missing member role");
      const data = await this.fetch<{ member: OrganizationMember }>(
        `/v1/organizations/${encodeURIComponent(this.orgName)}/members/${encodeURIComponent(username)}`,
        { method: "PATCH", body: JSON.stringify({ role }) },
      );
      return this.mapOrganizationMember(accountId, data.member, new Date().toISOString());
    }

    throw new Error(`Turso plugin: cannot update type "${typeId}"`);
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
    if (typeId === "turso-api-token") {
      await this.api.apiTokens.revoke(externalId);
      return;
    }
    if (typeId === "turso-organization-member") {
      await this.fetch(
        `/v1/organizations/${encodeURIComponent(this.orgName)}/members/${encodeURIComponent(externalId)}`,
        { method: "DELETE" },
      );
      return;
    }
    if (typeId === "turso-organization-invite") {
      await this.fetch(
        `/v1/organizations/${encodeURIComponent(this.orgName)}/invites/${encodeURIComponent(externalId)}`,
        { method: "DELETE" },
      );
      return;
    }
    throw new Error(`Turso plugin: cannot delete type "${typeId}"`);
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchTursoCostData(<T>(path: string) => this.fetch<T>(path), this.orgName, range);
  }

  async invalidateDatabaseAuthTokens(resourceId: string): Promise<void> {
    const databaseName = resourceId.split(":").slice(2).join(":");
    await this.fetch(
      `/v1/organizations/${encodeURIComponent(this.orgName)}/databases/${encodeURIComponent(databaseName)}/auth/rotate`,
      { method: "POST" },
    );
  }

  async invalidateGroupAuthTokens(resourceId: string): Promise<void> {
    const groupName = resourceId.split(":").slice(2).join(":");
    await this.fetch(
      `/v1/organizations/${encodeURIComponent(this.orgName)}/groups/${encodeURIComponent(groupName)}/auth/rotate`,
      { method: "POST" },
    );
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

    const tokenData = await this.api.databases.createToken(dbName);

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

  private async listDatabaseInstances(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    const instanceGroups = await Promise.all(
      databases.map(async (db) => ({
        database: db.name,
        instances: await this.api.databases.listInstances(db.name),
      })),
    );
    const now = new Date().toISOString();

    return instanceGroups.flatMap(({ database, instances }) =>
      instances.map((instance) => this.mapDatabaseInstance(accountId, database, instance, now)),
    );
  }

  private mapDatabaseInstance(
    accountId: string,
    database: string,
    instance: DatabaseInstance,
    now: string,
  ): ResourceInstance {
    return {
      id: `${accountId}:turso-database-instance:${database}:${instance.name}`,
      pluginId: "turso",
      resourceTypeId: "turso-database-instance",
      accountId,
      displayName: `${database}/${instance.name}`,
      externalId: `${database}:${instance.name}`,
      fields: {
        database,
        name: instance.name,
        uuid: instance.uuid,
        type: instance.type,
        region: instance.region,
        hostname: instance.hostname,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listLocations(accountId: string): Promise<ResourceInstance[]> {
    const locations = await this.api.locations.list();
    const now = new Date().toISOString();

    return locations.map((location) => this.mapLocation(accountId, location, now));
  }

  private mapLocation(accountId: string, location: Location, now: string): ResourceInstance {
    return {
      id: `${accountId}:turso-location:${location.code}`,
      pluginId: "turso",
      resourceTypeId: "turso-location",
      accountId,
      displayName: location.description,
      externalId: String(location.code),
      fields: {
        code: location.code,
        description: location.description,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listApiTokens(accountId: string): Promise<ResourceInstance[]> {
    const tokens = await this.api.apiTokens.list();
    const now = new Date().toISOString();

    return tokens.map((token) => this.mapApiToken(accountId, token, now));
  }

  private mapApiToken(accountId: string, token: ApiToken, now: string): ResourceInstance {
    return {
      id: `${accountId}:turso-api-token:${token.name}`,
      pluginId: "turso",
      resourceTypeId: "turso-api-token",
      accountId,
      displayName: token.name,
      externalId: token.name,
      fields: {
        id: token.id,
        name: token.name,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listOrganizationMembers(accountId: string): Promise<ResourceInstance[]> {
    const members = await this.api.organizations.members();
    const now = new Date().toISOString();

    return members.map((member) => this.mapOrganizationMember(accountId, member, now));
  }

  private async listOrganizationInvites(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ invites?: TursoInvite[] }>(
      `/v1/organizations/${encodeURIComponent(this.orgName)}/invites`,
    );
    const now = new Date().toISOString();
    return (data.invites ?? []).map((invite) => this.mapOrganizationInvite(accountId, invite, now));
  }

  private mapOrganizationMember(
    accountId: string,
    member: OrganizationMember,
    now: string,
  ): ResourceInstance {
    return {
      id: `${accountId}:turso-organization-member:${member.username}`,
      pluginId: "turso",
      resourceTypeId: "turso-organization-member",
      accountId,
      displayName: member.username,
      externalId: member.username,
      fields: {
        username: member.username,
        email: member.email,
        role: member.role,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
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

  private async createOrganizationInvite(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const email = fields["email"];
    const role = fields["role"] || "member";
    if (!email) throw new Error("Turso plugin: missing invite email");

    const data = await this.fetch<{ invited: TursoInvite }>(
      `/v1/organizations/${encodeURIComponent(this.orgName)}/invites`,
      {
        method: "POST",
        body: JSON.stringify({ email, role }),
      },
    );

    return this.mapOrganizationInvite(accountId, data.invited, new Date().toISOString());
  }

  private mapOrganizationInvite(
    accountId: string,
    invite: TursoInvite,
    now: string,
  ): ResourceInstance {
    const email = invite.email ?? invite.Email ?? "";
    const username = invite.username ?? invite.Username ?? "";
    const externalId = email || username;
    return {
      id: `${accountId}:turso-organization-invite:${externalId}`,
      pluginId: "turso",
      resourceTypeId: "turso-organization-invite",
      accountId,
      displayName: email || username,
      externalId,
      fields: {
        email,
        username,
        role: invite.role ?? invite.Role ?? "",
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

  private renderDatabaseInstanceDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Turso Database Instance", resource.fields["database"]),
      status: {
        kind: "status-dot",
        status: resource.fields["type"] === "primary" ? "healthy" : "info",
      },
      sections: [
        {
          kind: "section",
          title: "Instance",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Database", value: String(resource.fields["database"] ?? "—") },
                { key: "Name", value: String(resource.fields["name"] ?? "—") },
                { key: "UUID", value: String(resource.fields["uuid"] ?? "—") },
                { key: "Type", value: String(resource.fields["type"] ?? "—") },
                { key: "Region", value: formatLocation(String(resource.fields["region"] ?? "")) },
                { key: "Hostname", value: String(resource.fields["hostname"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderLocationDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: "Turso Location",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Location",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Code", value: String(resource.fields["code"] ?? "—") },
                { key: "Description", value: String(resource.fields["description"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderApiTokenDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: "Turso API Token",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Token",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "ID", value: String(resource.fields["id"] ?? "—") },
                { key: "Name", value: String(resource.fields["name"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderOrganizationMemberDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: "Turso Organization Member",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Member",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Username", value: String(resource.fields["username"] ?? "—") },
                { key: "Email", value: String(resource.fields["email"] ?? "—") },
                { key: "Role", value: String(resource.fields["role"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderOrganizationInviteDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: "Turso Organization Invite",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Invite",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Email", value: String(resource.fields["email"] ?? "—") },
                { key: "Username", value: String(resource.fields["username"] ?? "—") },
                { key: "Role", value: String(resource.fields["role"] ?? "—") },
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
