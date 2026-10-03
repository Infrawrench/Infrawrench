import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  DashboardStat,
  MetricSeries,
  CostFetchRange,
  CostRow,
  QuotaUsage,
  SectionNode,
} from "@infrawrench/plugin-base";
import { joinSubtitle, jsonRestFetch } from "@infrawrench/plugin-base";
import { fetchTursoCostData } from "./cost-data.js";
import { fetchTursoQuotas } from "./quotas.js";
import { fetchDatabaseUsageSeries, mapLimit, TURSO_METRICS_CAPABILITY } from "./metrics.js";
import { createClient as createTursoApiClient } from "@tursodatabase/api";
import type { DatabaseInstance, Location, OrganizationMember } from "@tursodatabase/api";

type TursoApiClient = ReturnType<typeof createTursoApiClient>;

/** `GET /v2/organizations/{org}/invites` item (v1 invites were retired in April 2026). */
interface TursoInvite {
  id?: number;
  email?: string;
  role?: string;
  created_at?: string;
}

/**
 * Raw database object from `GET /v1/organizations/{org}/databases`. Read
 * directly rather than through the SDK, whose mapper drops
 * `delete_protection` and `parent`. Field casing is Turso's own (mixed).
 */
interface TursoDatabaseRecord {
  Name: string;
  DbId?: string;
  Hostname?: string;
  block_reads?: boolean;
  block_writes?: boolean;
  regions?: string[];
  primaryRegion?: string;
  group?: string;
  version?: string;
  sleeping?: boolean;
  archived?: boolean;
  is_schema?: boolean;
  schema?: string;
  delete_protection?: boolean;
  parent?: { id?: string; name?: string; branched_at?: string } | null;
}

/** `GET/PATCH .../databases/{db}/configuration`. */
interface TursoDatabaseConfiguration {
  size_limit?: string;
  block_reads?: boolean;
  block_writes?: boolean;
  delete_protection?: boolean;
  allowed_ips?: string[];
  allowed_aws_vpc_ids?: string[];
}

/** Raw group object, read directly for `uuid`, `archived` and `delete_protection`. */
interface TursoGroupRecord {
  name: string;
  uuid?: string;
  version?: string;
  locations?: string[];
  primary?: string;
  archived?: boolean;
  delete_protection?: boolean;
}

/** `GET /v1/organizations/{org}/api-tokens` item: every token in the org, with its owner. */
interface TursoOrgApiToken {
  id: string;
  name: string;
  organization?: string;
  group?: string;
  scopes?: string[];
  owner?: { username?: string; email?: string };
  created_at?: string;
}

interface TursoUsageObject {
  rows_read?: number;
  rows_written?: number;
  storage_bytes?: number;
  bytes_synced?: number;
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
  // Turso Cloud's AWS locations, which replaced the Fly ones above for new
  // groups (the older codes still appear on groups that have not migrated).
  "aws-us-east-1": { location: "Virginia, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  "aws-us-east-2": { location: "Ohio, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  "aws-us-west-2": { location: "Oregon, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  "aws-eu-west-1": { location: "Ireland", flag: "\u{1F1EE}\u{1F1EA}" },
  "aws-ap-south-1": { location: "Mumbai, India", flag: "\u{1F1EE}\u{1F1F3}" },
  "aws-ap-northeast-1": { location: "Tokyo, Japan", flag: "\u{1F1EF}\u{1F1F5}" },
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

  /** `/v1/organizations/{org}` prefix shared by every org-scoped route. */
  private get orgPath(): string {
    return `/v1/organizations/${encodeURIComponent(this.orgName)}`;
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

    if (typeId === "turso-organization-invite") {
      const resource = await this.getResource(typeId, resourceId, accountId);
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
      const stats: DashboardStat[] = [
        { label: "Group", value: String(f["group"] ?? "") },
        {
          label: "Region",
          value: formatLocation(String(f["primaryRegion"] ?? "")),
        },
      ];
      // Usage is a separate call; a failure (plan without usage, transient
      // error) just leaves the card without the usage figures.
      const usage = await this.fetchDatabaseUsage(String(f["name"] ?? "")).catch(() => null);
      if (usage) {
        stats.push(
          { label: "Rows Read", value: formatCount(usage.rows_read) },
          { label: "Rows Written", value: formatCount(usage.rows_written) },
          { label: "Storage", value: formatBytes(usage.storage_bytes) },
        );
      }
      if (sleeping) stats.push({ label: "Status", value: "sleeping", variant: "status-degraded" });
      if (f["blockWrites"] === true) {
        stats.push({ label: "Writes", value: "blocked", variant: "status-error" });
      }
      return stats;
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

  /**
   * Pull the current month's usage and the top queries for the detail page.
   * Both are best-effort: Turso answers usage and stats per database, and a
   * failure on either just leaves that section out.
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "turso-database") return resource;
    const name = String(resource.fields["name"] ?? "");
    if (!name) return resource;
    const [usage, stats] = await Promise.all([
      this.fetchDatabaseUsage(name).catch(() => null),
      this.fetch<{ top_queries?: TopQuery[] }>(
        `${this.orgPath}/databases/${encodeURIComponent(name)}/stats`,
      ).catch(() => null),
    ]);
    const fields = { ...resource.fields };
    if (usage) {
      fields["usageRowsRead"] = usage.rows_read ?? 0;
      fields["usageRowsWritten"] = usage.rows_written ?? 0;
      fields["usageStorageBytes"] = usage.storage_bytes ?? 0;
      fields["usageBytesSynced"] = usage.bytes_synced ?? 0;
    }
    if (stats?.top_queries) fields["topQueries"] = JSON.stringify(stats.top_queries);
    return { ...resource, fields };
  }

  /** Daily usage for a database, one usage request per day (see `metrics.ts`). */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "turso-database") return [];
    const name = resourceId.split(":").slice(2).join(":");
    if (!name) return [];
    return fetchDatabaseUsageSeries(
      <T>(path: string) => this.fetch<T>(path),
      `${this.orgPath}/databases/${encodeURIComponent(name)}`,
      timeRange,
    );
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    return fetchTursoQuotas(<T>(path: string) => this.fetch<T>(path), this.orgName);
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
      const blocked =
        resource.fields["blockReads"] === true || resource.fields["blockWrites"] === true;
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: blocked ? "error" : sleeping ? "degraded" : "healthy",
        },
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
      const [groups, databases] = await Promise.all([
        this.fetchGroups(),
        this.fetchDatabases().catch(() => [] as TursoDatabaseRecord[]),
      ]);
      const groupOptions = groups.map((g) => ({
        id: g.name,
        label: g.name,
        ...(g.primary ? { description: formatLocation(g.primary) } : {}),
      }));
      const sourceOptions = [
        { id: "", label: "Empty database" },
        ...databases.map((db) => ({
          id: db.Name,
          label: db.Name,
          ...(db.group ? { description: db.group } : {}),
        })),
      ];

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
            key: "seedDatabase",
            label: "Copy From",
            kind: "select",
            required: false,
            description:
              "Branch an existing database instead of starting empty. The copy lands in the group above.",
            options: sourceOptions,
            defaultValue: "",
          },
          {
            key: "seedTimestamp",
            label: "Point in Time",
            kind: "datetime",
            required: false,
            description:
              "Restore the copy as of this moment (point-in-time recovery). Leave blank for the latest data. The window depends on your plan.",
            showWhen: { fieldKey: "seedDatabase", fieldValuesNot: [""] },
          },
          {
            key: "sizeLimit",
            label: "Size Limit",
            kind: "text",
            required: false,
            placeholder: "1gb",
            description: "Optional maximum size, in bytes or with a unit (256mb, 1gb).",
          },
          {
            key: "isSchema",
            label: "Schema Database",
            kind: "select",
            required: false,
            description:
              "Multi-DB schemas are only available to existing paid organizations; Turso rejects this for new ones.",
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes, use as a multi-tenant schema" },
            ],
            defaultValue: "false",
            showWhen: { fieldKey: "seedDatabase", fieldValue: "" },
          },
        ],
      };
    }

    if (typeId === "turso-group") {
      // Ask Turso which locations it offers today rather than trusting the
      // static table: new groups can only be placed in the current set.
      const live = await this.api.locations.list().catch(() => [] as Location[]);
      const codes =
        live.length > 0
          ? live.map((l) => ({ id: String(l.code), description: l.description }))
          : Object.entries(TURSO_LOCATIONS).map(([id, info]) => ({
              id,
              description: info.location,
            }));
      const locationOptions = codes.map(({ id, description }) => ({
        id,
        label: id,
        location: TURSO_LOCATIONS[id]?.location ?? description,
        ...(TURSO_LOCATIONS[id] ? { flag: TURSO_LOCATIONS[id].flag } : {}),
      }));
      const defaultLocation =
        locationOptions.find((l) => l.id === "aws-us-east-1")?.id ?? locationOptions[0]?.id;

      return {
        fields: [
          { key: "name", label: "Group Name", kind: "text", required: true },
          {
            key: "location",
            label: "Primary Location",
            kind: "region-picker",
            required: true,
            regions: locationOptions,
            ...(defaultLocation ? { defaultValue: defaultLocation } : {}),
          },
          {
            key: "extensions",
            label: "SQLite Extensions",
            kind: "select",
            required: false,
            description: "Enable Turso's bundled SQLite extensions (vector, crypto, fuzzy...).",
            options: [
              { id: "", label: "None" },
              { id: "all", label: "All bundled extensions" },
            ],
            defaultValue: "",
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
      if (role === "owner") {
        throw new Error("Turso plugin: ownership can't be granted through the API");
      }
      const data = await this.fetch<{ member: OrganizationMember }>(
        `${this.orgPath}/members/${encodeURIComponent(username)}`,
        { method: "PATCH", body: JSON.stringify({ role }) },
      );
      return this.mapOrganizationMember(accountId, data.member, new Date().toISOString());
    }

    if (typeId === "turso-database") {
      const name = resourceId.split(":").slice(2).join(":");
      if (!name) throw new Error("Turso plugin: missing database name");
      await this.updateDatabaseConfiguration(name, fields);
      return this.getResource(typeId, resourceId, accountId);
    }

    if (typeId === "turso-group") {
      const name = resourceId.split(":").slice(2).join(":");
      if (!name) throw new Error("Turso plugin: missing group name");
      if (fields["deleteProtection"] !== undefined) {
        await this.fetch(`${this.orgPath}/groups/${encodeURIComponent(name)}/configuration`, {
          method: "PATCH",
          body: JSON.stringify({ delete_protection: isTrue(fields["deleteProtection"]) }),
        });
      }
      return this.getResource(typeId, resourceId, accountId);
    }

    throw new Error(`Turso plugin: cannot update type "${typeId}"`);
  }

  /**
   * Write only what actually changed. The Edit form submits every editable
   * field, and `allowed_ips: []` *clears* the allow-list, so a blind PATCH
   * from a form that failed to load the current list would silently open the
   * database to the internet. Diffing against a fresh read prevents that.
   */
  private async updateDatabaseConfiguration(
    name: string,
    fields: Record<string, string>,
  ): Promise<void> {
    const path = `${this.orgPath}/databases/${encodeURIComponent(name)}/configuration`;
    const current = await this.fetch<TursoDatabaseConfiguration>(path);
    const body: TursoDatabaseConfiguration = {};

    const flags: Array<[string, "delete_protection" | "block_reads" | "block_writes"]> = [
      ["deleteProtection", "delete_protection"],
      ["blockReads", "block_reads"],
      ["blockWrites", "block_writes"],
    ];
    for (const [key, apiKey] of flags) {
      const value = fields[key];
      if (value === undefined) continue;
      const next = isTrue(value);
      if (next !== (current[apiKey] === true)) body[apiKey] = next;
    }

    const sizeLimit = fields["sizeLimit"];
    if (sizeLimit !== undefined && sizeLimit.trim() !== (current.size_limit ?? "")) {
      // Turso reports "no limit" as "0"; an emptied field asks for that back.
      body.size_limit = sizeLimit.trim() || "0";
    }

    const lists: Array<[string, "allowed_ips" | "allowed_aws_vpc_ids"]> = [
      ["allowedIps", "allowed_ips"],
      ["allowedAwsVpcIds", "allowed_aws_vpc_ids"],
    ];
    for (const [key, apiKey] of lists) {
      const value = fields[key];
      if (value === undefined) continue;
      const next = splitList(value);
      if (next.join(",") !== (current[apiKey] ?? []).join(",")) body[apiKey] = next;
    }

    if (Object.keys(body).length === 0) return;
    await this.fetch(path, { method: "PATCH", body: JSON.stringify(body) });
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
      // Org-level revocation is keyed by token id, not name.
      await this.fetch(`${this.orgPath}/api-tokens/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "turso-organization-member") {
      await this.fetch(`${this.orgPath}/members/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "turso-organization-invite") {
      await this.fetch(
        `/v2/organizations/${encodeURIComponent(this.orgName)}/invites/${encodeURIComponent(externalId)}`,
        { method: "DELETE" },
      );
      return;
    }
    throw new Error(`Turso plugin: cannot delete type "${typeId}"`);
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "turso-database" && actionId === "rotate-tokens") {
      await this.invalidateDatabaseAuthTokens(resourceId);
      return;
    }
    if (typeId === "turso-group") {
      const name = encodeURIComponent(resourceId.split(":").slice(2).join(":"));
      if (actionId === "rotate-tokens") {
        await this.invalidateGroupAuthTokens(resourceId);
        return;
      }
      if (actionId === "unarchive") {
        await this.fetch(`${this.orgPath}/groups/${name}/unarchive`, { method: "POST" });
        return;
      }
      if (actionId === "update-version") {
        await this.fetch(`${this.orgPath}/groups/${name}/update`, { method: "POST" });
        return;
      }
    }
    throw new Error(`Turso plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchTursoCostData(<T>(path: string) => this.fetch<T>(path), this.orgName, range);
  }

  async invalidateDatabaseAuthTokens(resourceId: string): Promise<void> {
    const databaseName = resourceId.split(":").slice(2).join(":");
    await this.fetch(`${this.orgPath}/databases/${encodeURIComponent(databaseName)}/auth/rotate`, {
      method: "POST",
    });
  }

  async invalidateGroupAuthTokens(resourceId: string): Promise<void> {
    const groupName = resourceId.split(":").slice(2).join(":");
    await this.fetch(`${this.orgPath}/groups/${encodeURIComponent(groupName)}/auth/rotate`, {
      method: "POST",
    });
  }

  private async fetchDatabaseUsage(name: string): Promise<TursoUsageObject | null> {
    if (!name) return null;
    const data = await this.fetch<{ database?: { total?: TursoUsageObject } }>(
      `${this.orgPath}/databases/${encodeURIComponent(name)}/usage`,
    );
    return data.database?.total ?? null;
  }

  private async fetchDatabases(): Promise<TursoDatabaseRecord[]> {
    const data = await this.fetch<{ databases?: TursoDatabaseRecord[] }>(
      `${this.orgPath}/databases`,
    );
    return data.databases ?? [];
  }

  private async fetchDatabaseConfiguration(
    name: string,
  ): Promise<TursoDatabaseConfiguration | null> {
    return this.fetch<TursoDatabaseConfiguration>(
      `${this.orgPath}/databases/${encodeURIComponent(name)}/configuration`,
    ).catch(() => null);
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    // The size limit and network allow-lists live only on the configuration
    // route, and the Edit form needs them to show the current values.
    const configs = await mapLimit(databases, 8, (db) => this.fetchDatabaseConfiguration(db.Name));
    const now = new Date().toISOString();

    return databases.map((db, i) => this.mapDatabase(accountId, db, configs[i] ?? null, now));
  }

  private mapDatabase(
    accountId: string,
    db: TursoDatabaseRecord,
    config: TursoDatabaseConfiguration | null,
    now: string,
  ): ResourceInstance {
    return {
      id: `${accountId}:turso-database:${db.Name}`,
      pluginId: "turso",
      resourceTypeId: "turso-database",
      accountId,
      displayName: db.Name,
      externalId: db.Name,
      fields: {
        name: db.Name,
        dbId: db.DbId ?? "",
        hostname: db.Hostname ?? "",
        group: db.group ?? "",
        primaryRegion: db.primaryRegion ?? "",
        regions: (db.regions ?? []).join(", "),
        version: db.version ?? "",
        isSchema: db.is_schema === true,
        schema: db.schema || "",
        parent: db.parent?.name ?? "",
        branchedAt: db.parent?.branched_at ?? "",
        sleeping: db.sleeping === true,
        archived: db.archived === true,
        deleteProtection: (config?.delete_protection ?? db.delete_protection) === true,
        blockReads: (config?.block_reads ?? db.block_reads) === true,
        blockWrites: (config?.block_writes ?? db.block_writes) === true,
        sizeLimit: config?.size_limit && config.size_limit !== "0" ? config.size_limit : "",
        allowedIps: (config?.allowed_ips ?? []).join(", "),
        allowedAwsVpcIds: (config?.allowed_aws_vpc_ids ?? []).join(", "),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
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
    const seedDatabase = fields["seedDatabase"] ?? "";
    const seedTimestamp = fields["seedTimestamp"] ?? "";
    const sizeLimit = (fields["sizeLimit"] ?? "").trim();

    const body: Record<string, unknown> = {
      name,
      ...(group ? { group } : {}),
      ...(sizeLimit ? { size_limit: sizeLimit } : {}),
      ...(seedDatabase
        ? {
            seed: {
              type: "database",
              name: seedDatabase,
              ...(seedTimestamp ? { timestamp: seedTimestamp } : {}),
            },
          }
        : fields["isSchema"] === "true"
          ? { is_schema: true }
          : {}),
    };

    const data = await this.fetch<{ database: { DbId?: string; Hostname?: string; Name: string } }>(
      `${this.orgPath}/databases`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const created = data.database;

    return this.mapDatabase(
      accountId,
      {
        Name: created.Name,
        ...(created.DbId ? { DbId: created.DbId } : {}),
        ...(created.Hostname ? { Hostname: created.Hostname } : {}),
        ...(group ? { group } : {}),
        is_schema: !seedDatabase && fields["isSchema"] === "true",
        ...(seedDatabase ? { parent: { name: seedDatabase } } : {}),
      },
      sizeLimit ? { size_limit: sizeLimit } : null,
      new Date().toISOString(),
    );
  }

  private async fetchGroups(): Promise<TursoGroupRecord[]> {
    const data = await this.fetch<{ groups?: TursoGroupRecord[] }>(`${this.orgPath}/groups`);
    return data.groups ?? [];
  }

  private async listGroups(accountId: string): Promise<ResourceInstance[]> {
    const groups = await this.fetchGroups();
    const now = new Date().toISOString();
    return groups.map((g) => this.mapGroup(accountId, g, now));
  }

  private mapGroup(accountId: string, g: TursoGroupRecord, now: string): ResourceInstance {
    return {
      id: `${accountId}:turso-group:${g.name}`,
      pluginId: "turso",
      resourceTypeId: "turso-group",
      accountId,
      displayName: g.name,
      externalId: g.name,
      fields: {
        name: g.name,
        uuid: g.uuid ?? "",
        primaryLocation: g.primary ?? "",
        locations: (g.locations ?? []).join(", "),
        version: g.version ?? "",
        archived: g.archived === true,
        deleteProtection: g.delete_protection === true,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listDatabaseInstances(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    const instanceGroups = await Promise.all(
      databases.map(async (db) => ({
        database: db.Name,
        instances: await this.api.databases.listInstances(db.Name),
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

  /**
   * Org-level listing: every token in the organization with its owner (admins
   * see all, members their own), unlike `/v1/auth/api-tokens`, which only
   * ever shows the caller's.
   */
  private async listApiTokens(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ tokens?: TursoOrgApiToken[] }>(`${this.orgPath}/api-tokens`);
    const now = new Date().toISOString();

    return (data.tokens ?? []).map((token) => this.mapApiToken(accountId, token, now));
  }

  private mapApiToken(accountId: string, token: TursoOrgApiToken, now: string): ResourceInstance {
    return {
      id: `${accountId}:turso-api-token:${token.id}`,
      pluginId: "turso",
      resourceTypeId: "turso-api-token",
      accountId,
      displayName: token.name,
      externalId: token.id,
      fields: {
        id: token.id,
        name: token.name,
        group: token.group ?? "",
        scopes: (token.scopes ?? []).join(", "),
        ownerUsername: token.owner?.username ?? "",
        ownerEmail: token.owner?.email ?? "",
        createdAt: token.created_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: token.created_at || now,
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
      `/v2/organizations/${encodeURIComponent(this.orgName)}/invites`,
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

    const data = await this.fetch<{ group: TursoGroupRecord }>(`${this.orgPath}/groups`, {
      method: "POST",
      body: JSON.stringify({
        name,
        location,
        ...(fields["extensions"] === "all" ? { extensions: "all" } : {}),
      }),
    });

    return this.mapGroup(accountId, data.group, new Date().toISOString());
  }

  private async createOrganizationInvite(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const email = fields["email"];
    const role = fields["role"] || "member";
    if (!email) throw new Error("Turso plugin: missing invite email");

    const data = await this.fetch<{ invited: TursoInvite }>(
      `/v2/organizations/${encodeURIComponent(this.orgName)}/invites`,
      {
        method: "POST",
        body: JSON.stringify({ email, role }),
      },
    );

    return this.mapOrganizationInvite(
      accountId,
      { ...data.invited, email: data.invited?.email ?? email },
      new Date().toISOString(),
    );
  }

  private mapOrganizationInvite(
    accountId: string,
    invite: TursoInvite,
    now: string,
  ): ResourceInstance {
    // v2 deletes an invite by email, so the email is the external id.
    const email = invite.email ?? "";
    return {
      id: `${accountId}:turso-organization-invite:${email}`,
      pluginId: "turso",
      resourceTypeId: "turso-organization-invite",
      accountId,
      displayName: email,
      externalId: email,
      fields: {
        email,
        role: invite.role ?? "",
        createdAt: invite.created_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: invite.created_at || now,
      updatedAt: now,
    };
  }
  private renderDatabaseDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const regions = String(f["regions"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(formatLocation)
      .join(", ");
    const blocked = f["blockReads"] === true || f["blockWrites"] === true;

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Connection",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Hostname", value: String(f["hostname"] ?? "—") },
              {
                key: "Connection String",
                value: `libsql://${String(f["hostname"] ?? "")}`,
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
              { key: "Group", value: String(f["group"] ?? "—") },
              {
                key: "Primary Region",
                value: formatLocation(String(f["primaryRegion"] ?? "")),
              },
              { key: "Regions", value: regions || "—" },
              { key: "Version", value: String(f["version"] ?? "") || "—" },
              ...(f["isSchema"] === true ? [{ key: "Schema Database", value: "Yes" }] : []),
              ...(f["schema"] ? [{ key: "Parent Schema", value: String(f["schema"]) }] : []),
              ...(f["parent"]
                ? [
                    {
                      key: "Branched From",
                      value: f["branchedAt"]
                        ? `${String(f["parent"])} (${String(f["branchedAt"])})`
                        : String(f["parent"]),
                    },
                  ]
                : []),
              {
                key: "Status",
                value:
                  f["archived"] === true
                    ? "Archived"
                    : f["sleeping"] === true
                      ? "Sleeping"
                      : "Active",
              },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Protection & Access",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Delete Protection", value: f["deleteProtection"] === true ? "On" : "Off" },
              { key: "Reads", value: f["blockReads"] === true ? "Blocked" : "Allowed" },
              { key: "Writes", value: f["blockWrites"] === true ? "Blocked" : "Allowed" },
              { key: "Size Limit", value: String(f["sizeLimit"] ?? "") || "None" },
              { key: "Allowed IPs", value: String(f["allowedIps"] ?? "") || "Any" },
              {
                key: "Allowed AWS VPC Endpoints",
                value: String(f["allowedAwsVpcIds"] ?? "") || "Any",
              },
            ],
          },
        ],
      },
    ];

    if (f["usageRowsRead"] !== undefined) {
      sections.push({
        kind: "section",
        title: "Usage (current billing month)",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Rows Read", value: formatCount(Number(f["usageRowsRead"])) },
              { key: "Rows Written", value: formatCount(Number(f["usageRowsWritten"])) },
              { key: "Storage", value: formatBytes(Number(f["usageStorageBytes"])) },
              { key: "Bytes Synced", value: formatBytes(Number(f["usageBytesSynced"])) },
            ],
          },
        ],
      });
    }

    const topQueries = parseTopQueries(f["topQueries"]);
    if (topQueries.length > 0) {
      sections.push({
        kind: "section",
        title: "Top Queries",
        children: [
          {
            kind: "table",
            columns: [
              { key: "query", label: "Query", width: "wide", mono: true },
              { key: "rowsRead", label: "Rows Read", width: "narrow" },
              { key: "rowsWritten", label: "Rows Written", width: "narrow" },
            ],
            rows: topQueries.map((q) => ({
              cells: {
                query: q.query ?? "",
                rowsRead: formatCount(q.rows_read),
                rowsWritten: formatCount(q.rows_written),
              },
            })),
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: `Turso Database · ${String(f["group"] || "default")}`,
      status: {
        kind: "status-dot",
        status: blocked ? "error" : f["sleeping"] === true ? "degraded" : "healthy",
      },
      sections,
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Rotate Auth Tokens",
          action: {
            type: "plugin-action",
            actionId: "rotate-tokens",
            confirmMessage:
              "Invalidate every auth token issued for this database? Clients using an existing token are disconnected until they get a new one.",
            successMessage: "Database auth tokens rotated.",
          },
          variant: "danger",
        },
      ],
      metricsCapability: TURSO_METRICS_CAPABILITY,
      sqlEditor: {
        connectionStringOutputKey: "connectionString",
        defaultQuery: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
      },
    };
  }

  private renderGroupDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const locations = String(f["locations"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(formatLocation)
      .join("\n");
    const archived = f["archived"] === true;

    return {
      title: resource.displayName,
      subtitle: "Turso Group",
      status: { kind: "status-dot", status: archived ? "degraded" : "info" },
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
                  value: formatLocation(String(f["primaryLocation"] ?? "")),
                },
                { key: "Locations", value: locations || "—" },
                { key: "Version", value: String(f["version"] ?? "") || "—" },
                { key: "Delete Protection", value: f["deleteProtection"] === true ? "On" : "Off" },
                { key: "Status", value: archived ? "Archived" : "Active" },
                ...(f["uuid"] ? [{ key: "UUID", value: String(f["uuid"]) }] : []),
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(archived
          ? [
              {
                kind: "action" as const,
                label: "Unarchive",
                action: {
                  type: "plugin-action" as const,
                  actionId: "unarchive",
                  successMessage: "Unarchive requested; the group's databases are waking up.",
                },
              },
            ]
          : []),
        {
          kind: "action",
          label: "Update libSQL Version",
          action: {
            type: "plugin-action",
            actionId: "update-version",
            confirmMessage:
              "Upgrade every database in this group to the latest libSQL server version? Databases restart briefly.",
            successMessage: "Version update started.",
          },
        },
        {
          kind: "action",
          label: "Rotate Auth Tokens",
          action: {
            type: "plugin-action",
            actionId: "rotate-tokens",
            confirmMessage:
              "Invalidate every auth token issued for this group and its databases? Clients using an existing token are disconnected until they get a new one.",
            successMessage: "Group auth tokens rotated.",
          },
          variant: "danger",
        },
      ],
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
                {
                  key: "Owner",
                  value:
                    [resource.fields["ownerUsername"], resource.fields["ownerEmail"]]
                      .filter(Boolean)
                      .join(" \u00B7 ") || "—",
                },
                { key: "Group", value: String(resource.fields["group"] ?? "") || "All groups" },
                { key: "Scopes", value: String(resource.fields["scopes"] ?? "") || "Unrestricted" },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "") || "—" },
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
                { key: "Role", value: String(resource.fields["role"] ?? "—") },
                { key: "Invited", value: String(resource.fields["createdAt"] ?? "") || "—" },
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

interface TopQuery {
  query?: string;
  rows_read?: number;
  rows_written?: number;
}

function parseTopQueries(value: unknown): TopQuery[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as TopQuery[]) : [];
  } catch {
    return [];
  }
}

function isTrue(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "on";
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatCount(value: number | undefined): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

function formatBytes(value: number | undefined): string {
  let n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i += 1;
  }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}
