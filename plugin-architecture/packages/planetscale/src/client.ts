import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  CostFetchRange,
  CostRow,
  DashboardStat,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  RegionOption,
  SelectOption,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, joinSubtitle, jsonRestFetch } from "@infrawrench/plugin-base";
import { fetchPlanetScaleCostData } from "./cost-data.js";
import { fetchBranchMetrics, PS_METRICS_CAPABILITY } from "./metrics.js";
import { fetchInsightsLog } from "./insights-log.js";

type Engine = "mysql" | "postgresql" | "neki";

interface PsRegion {
  slug: string;
  display_name: string;
  location?: string;
  enabled?: boolean;
  mysql_supported?: boolean;
  postgresql_supported?: boolean;
  current_default?: boolean;
}

interface PsDatabase {
  id: string;
  name: string;
  notes: string;
  kind?: Engine;
  plan?: string;
  region: PsRegion;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  branches_count?: number;
  default_branch?: string;
  deletion_protected?: boolean;
  require_approval_for_deploy?: boolean;
  restrict_branch_region?: boolean;
  production_branch_web_console?: boolean;
  insights_raw_queries?: boolean;
  allow_data_branching?: boolean;
  foreign_keys_enabled?: boolean;
  automatic_migrations?: boolean;
  migration_framework?: string;
  migration_table_name?: string;
  development_branches_limit?: number;
}

interface PsBranch {
  id: string;
  name: string;
  kind?: Engine;
  parent_branch: string;
  mysql_address: string;
  mysql_edge_address: string;
  production: boolean;
  ready: boolean;
  safe_migrations: boolean;
  deletion_protected?: boolean;
  cluster_name?: string;
  region?: { slug?: string };
  schema_last_updated_at: string;
  created_at: string;
  updated_at: string;
}

interface PsPassword {
  id: string;
  name: string;
  access_host_url: string;
  role?: string;
  username: string;
  plain_text?: string;
  cidrs?: string[];
  expired?: boolean;
  replica?: boolean;
  renewable?: boolean;
  expires_at?: string;
  last_used_at?: string;
  database_branch: { name: string };
  created_at: string;
}

/** Postgres branch role (`.../branches/{branch}/roles`). */
interface PsRole {
  id: string;
  name: string;
  username?: string;
  password?: string;
  access_host_url?: string;
  database_name?: string;
  inherited_roles?: string[];
  default?: boolean;
  expired?: boolean;
  expires_at?: string | null;
  created_at?: string;
  query_safety_settings?: {
    require_where_on_delete?: string;
    require_where_on_update?: string;
  };
}

interface PsDeployRequest {
  id: string;
  number: number;
  branch: string;
  into_branch: string;
  approved: boolean;
  state?: string;
  deployment_state?: string;
  notes?: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  deployed_at?: string;
  deployment?: {
    state?: string;
    finished_at?: string;
    queued_at?: string;
    ready_to_cutover_at?: string;
    started_at?: string;
    deployable?: boolean;
    deploy_operations?: unknown[];
    deploy_operation_summaries?: unknown[];
  };
}

interface PsBackup {
  id: string;
  name: string;
  state?: string;
  size?: number;
  protected?: boolean;
  required?: boolean;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  expires_at?: string;
  backup_policy?: { name?: string; display_name?: string } | null;
}

interface PsWebhook {
  id: string;
  url: string;
  enabled?: boolean;
  events?: string[];
  authorization_header_configured?: boolean;
  last_sent_at?: string | null;
  last_sent_success?: boolean | null;
  created_at?: string;
}

interface PsClusterSku {
  name: string;
  display_name?: string;
  cpu?: string | number;
  ram?: number;
  enabled?: boolean;
  development?: boolean;
  production?: boolean;
  sort_order?: number;
}

/** Events a database webhook can subscribe to (PlanetScale API spec, October 2026). */
const WEBHOOK_EVENTS = [
  "branch.ready",
  "branch.anomaly",
  "branch.out_of_memory",
  "branch.primary_promoted",
  "branch.primary_switchover_imminent",
  "branch.schema_recommendation",
  "branch.sleeping",
  "branch.start_maintenance",
  "backup.failed",
  "backup.succeeded",
  "cluster.storage",
  "database.access_request",
  "deploy_request.opened",
  "deploy_request.queued",
  "deploy_request.in_progress",
  "deploy_request.pending_cutover",
  "deploy_request.schema_applied",
  "deploy_request.errored",
  "deploy_request.reverted",
  "deploy_request.closed",
  "keyspace.storage",
];

/** Fallback region table, used when the organization's region list can't be read. */
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

/**
 * Settings the database Edit form writes, mapped to the PATCH body keys.
 * `foreignKeysEnabled` reads back as `foreign_keys_enabled` but is written
 * as `allow_foreign_key_constraints`.
 */
const DATABASE_BOOL_SETTINGS: Array<[string, keyof PsDatabase, string]> = [
  ["deletionProtected", "deletion_protected", "deletion_protected"],
  ["requireApprovalForDeploy", "require_approval_for_deploy", "require_approval_for_deploy"],
  ["restrictBranchRegion", "restrict_branch_region", "restrict_branch_region"],
  ["productionBranchWebConsole", "production_branch_web_console", "production_branch_web_console"],
  ["insightsRawQueries", "insights_raw_queries", "insights_raw_queries"],
  ["allowDataBranching", "allow_data_branching", "allow_data_branching"],
  ["foreignKeysEnabled", "foreign_keys_enabled", "allow_foreign_key_constraints"],
  ["automaticMigrations", "automatic_migrations", "automatic_migrations"],
];
const DATABASE_STRING_SETTINGS: Array<[string, keyof PsDatabase, string]> = [
  ["defaultBranch", "default_branch", "default_branch"],
  ["migrationFramework", "migration_framework", "migration_framework"],
  ["migrationTableName", "migration_table_name", "migration_table_name"],
];

export class PlanetScaleClient implements PluginClient {
  private readonly tokenId: string;
  private readonly tokenSecret: string;
  private readonly orgName: string;
  private readonly baseUrl = "https://api.planetscale.com/v1";
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const id = credentials["serviceTokenId"];
    if (!id) throw new Error("PlanetScale plugin: missing serviceTokenId credential");
    this.tokenId = id;

    const secret = credentials["serviceTokenSecret"];
    if (!secret) throw new Error("PlanetScale plugin: missing serviceTokenSecret credential");
    this.tokenSecret = secret;

    const org = credentials["organizationName"];
    if (!org) throw new Error("PlanetScale plugin: missing organizationName credential");
    this.orgName = org;

    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "PlanetScale",
      url: `${this.baseUrl}${path}`,
      errorPath: path,
      headers: {
        Authorization: `${this.tokenId}:${this.tokenSecret}`,
        Accept: "application/json",
      },
      ...(options ? { init: options } : {}),
      ...(this.caCert && this.services?.http
        ? { caCert: this.caCert, http: this.services.http }
        : {}),
    });
  }

  private dbPath(databaseName: string): string {
    return `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}`;
  }

  private branchPath(databaseName: string, branchName: string): string {
    return `${this.dbPath(databaseName)}/branches/${enc(branchName)}`;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "ps-database":
        return this.listDatabases(accountId);
      case "ps-branch":
        return this.listAllBranches(accountId);
      case "ps-password":
        return this.listAllPasswords(accountId);
      case "ps-role":
        return this.listAllRoles(accountId);
      case "ps-deploy-request":
        return this.listAllDeployRequests(accountId);
      case "ps-backup":
        return this.listAllBackups(accountId);
      case "ps-webhook":
        return this.listAllWebhooks(accountId);
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
    if (typeId === "ps-role" && outputKey === "connectionString") {
      // PlanetScale returns a role's password only when it is created or
      // reset, so there is nothing to read back later.
      throw new Error(
        "PlanetScale plugin: a role's password is shown only when the role is created. Reset the role's password or create a new role to get a fresh connection string.",
      );
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

    if (typeId === "ps-password" || typeId === "ps-role") {
      if (outputKey === "username") return String(resource.fields["username"] ?? "");
      if (outputKey === "host") return String(resource.fields["host"] ?? "");
    }

    if (typeId === "ps-deploy-request") {
      if (outputKey === "deployRequestNumber") return String(resource.fields["number"] ?? "");
      if (outputKey === "sourceBranch") return String(resource.fields["branch"] ?? "");
      if (outputKey === "targetBranch") return String(resource.fields["intoBranch"] ?? "");
    }

    if (typeId === "ps-backup") {
      if (outputKey === "backupName") return String(resource.fields["name"] ?? "");
      if (outputKey === "backupId") return String(resource.fields["id"] ?? "");
    }

    if (typeId === "ps-webhook" && outputKey === "url") {
      return String(resource.fields["url"] ?? "");
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
      case "ps-password":
        return this.renderPasswordDetail(resource);
      case "ps-role":
        return this.renderRoleDetail(resource);
      case "ps-deploy-request":
        return this.renderDeployRequestDetail(resource);
      case "ps-backup":
        return this.renderBackupDetail(resource);
      case "ps-webhook":
        return this.renderWebhookDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          status: { kind: "status-dot", status: "info" },
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
        status: { kind: "status-dot", status: databaseStatus(state) },
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
      status: { kind: "status-dot", status: "info" },
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "ps-database") {
      const [regions, mysqlSizes, postgresSizes] = await Promise.all([
        this.fetchRegionOptions(),
        this.fetchClusterSizeOptions("mysql"),
        this.fetchClusterSizeOptions("postgresql"),
      ]);
      const defaultRegion =
        regions.find((r) => r.id === "us-east")?.id ?? regions[0]?.id ?? "us-east";

      return {
        fields: [
          { key: "name", label: "Database Name", kind: "text", required: true },
          {
            key: "kind",
            label: "Engine",
            kind: "select",
            required: true,
            options: [
              { id: "mysql", label: "Vitess (MySQL-compatible)" },
              { id: "postgresql", label: "Postgres" },
            ],
            defaultValue: "mysql",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: defaultRegion,
            // Not every region runs both engines; the picker hides the
            // ones the chosen engine can't use.
            filterByFieldKey: "kind",
          },
          clusterSizeField("clusterSizeMysql", "mysql", mysqlSizes),
          clusterSizeField("clusterSizePostgres", "postgresql", postgresSizes),
        ],
      };
    }

    if (typeId === "ps-branch") {
      // When created from a database detail page, the database is inherited from the parent
      // and we only need to collect the branch name + parent branch.
      const parentExternalId = parentResourceId
        ? parentResourceId.split(":").slice(2).join(":")
        : "";

      // Fetch databases to populate the parent selector, then
      // fetch branches from the first database to offer a "from" branch
      const databases = await this.fetchDatabases();
      const dbOptions = databases.map((db) => ({
        id: db.name,
        label: db.name,
      }));

      // For the parent branch selector, we list branches of the first database
      // (or the inherited parent database, if provided).
      const parentBranchOptions: { id: string; label: string }[] = [];
      const branchSourceDb = parentExternalId || databases[0]?.name || "";
      if (branchSourceDb) {
        const branches = await this.fetchBranches(branchSourceDb);
        for (const b of branches) {
          parentBranchOptions.push({ id: b.name, label: b.name });
        }
      }

      return {
        fields: [
          ...(parentResourceId
            ? []
            : [
                {
                  key: "databaseName",
                  label: "Database",
                  kind: "select" as const,
                  required: true,
                  options: dbOptions,
                  ...(dbOptions[0] ? { defaultValue: dbOptions[0].id } : {}),
                },
              ]),
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
          {
            key: "seedData",
            label: "Data",
            kind: "select",
            required: false,
            description:
              "Schema only, or seed the branch with data from the parent's latest backup (Vitess databases with data branching on).",
            options: [
              { id: "", label: "Schema only" },
              { id: "last_successful_backup", label: "Data from the latest backup" },
            ],
            defaultValue: "",
          },
          {
            key: "deletionProtected",
            label: "Deletion Protection",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "Off" },
              { id: "true", label: "On" },
            ],
            defaultValue: "false",
          },
        ],
      };
    }

    if (typeId === "ps-password") {
      const parent = parentResourceId ? PlanetScaleClient.parseBranchId(parentResourceId) : null;
      return {
        fields: [
          ...(parent ? [] : await this.branchPickerFields("mysql")),
          { key: "name", label: "Password Name", kind: "text", required: false },
          {
            key: "role",
            label: "Role",
            kind: "select",
            required: false,
            defaultValue: "reader",
            options: [
              { id: "reader", label: "Reader" },
              { id: "writer", label: "Writer" },
              { id: "readwriter", label: "Read/Write" },
              { id: "admin", label: "Admin" },
            ],
          },
          { key: "ttl", label: "TTL seconds", kind: "number", required: false },
          {
            key: "replica",
            label: "Route to Replicas",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "No, use the primary" },
              { id: "true", label: "Yes, read-only replica connections" },
            ],
            defaultValue: "false",
          },
          {
            key: "cidrs",
            label: "Allowed CIDRs",
            kind: "string-list",
            required: false,
            addLabel: "Add CIDR",
          },
        ],
      };
    }

    if (typeId === "ps-role") {
      const parent = parentResourceId ? PlanetScaleClient.parseBranchId(parentResourceId) : null;
      return {
        fields: [
          ...(parent ? [] : await this.branchPickerFields("postgresql")),
          { key: "name", label: "Role Name", kind: "text", required: false },
          {
            key: "inheritedRoles",
            label: "Grants",
            kind: "policy-picker",
            required: false,
            description: "Built-in Postgres roles this role inherits. Leave empty for none.",
            policies: POSTGRES_INHERITED_ROLES.map((role) => ({
              id: role.id,
              label: role.id,
              description: role.description,
            })),
          },
          {
            key: "ttl",
            label: "Expires After (seconds)",
            kind: "number",
            required: false,
            description: "Leave blank for a role that never expires.",
          },
          safetyField("requireWhereOnDelete", "Require WHERE on DELETE"),
          safetyField("requireWhereOnUpdate", "Require WHERE on UPDATE"),
        ],
      };
    }

    if (typeId === "ps-backup") {
      const parent = parentResourceId ? PlanetScaleClient.parseBranchId(parentResourceId) : null;
      return {
        fields: [
          ...(parent ? [] : await this.branchPickerFields()),
          { key: "name", label: "Backup Name", kind: "text", required: false },
          {
            key: "retentionValue",
            label: "Keep For",
            kind: "number",
            required: true,
            minValue: 1,
            maxValue: 1000,
            defaultValue: "7",
          },
          {
            key: "retentionUnit",
            label: "Unit",
            kind: "select",
            required: true,
            options: ["hour", "day", "week", "month", "year"].map((u) => ({
              id: u,
              label: `${u[0]!.toUpperCase()}${u.slice(1)}s`,
            })),
            defaultValue: "day",
          },
        ],
      };
    }

    if (typeId === "ps-webhook") {
      const parentDb = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
      const databases = parentDb ? [] : await this.fetchDatabases();
      return {
        fields: [
          ...(parentDb
            ? []
            : [
                {
                  key: "databaseName",
                  label: "Database",
                  kind: "select" as const,
                  required: true,
                  options: databases.map((db) => ({ id: db.name, label: db.name })),
                  ...(databases[0] ? { defaultValue: databases[0].name } : {}),
                },
              ]),
          {
            key: "url",
            label: "URL",
            kind: "text",
            required: true,
            placeholder: "https://example.com/planetscale",
          },
          {
            key: "events",
            label: "Events",
            kind: "policy-picker",
            required: true,
            policies: WEBHOOK_EVENTS.map((event) => ({
              id: event,
              label: event,
              category: event.split(".")[0] ?? "",
            })),
          },
          {
            key: "authorizationHeader",
            label: "Authorization Header",
            kind: "password",
            required: false,
            description: "Optional value PlanetScale sends verbatim as the Authorization header.",
          },
        ],
      };
    }

    throw new Error(`PlanetScale plugin: no create config for type "${typeId}"`);
  }

  /**
   * Database + branch pickers for types created outside a branch's detail
   * page. Branch options are `{database}/{branch}` so a single pick carries
   * both halves; `engine` narrows the list to the branches the type applies to.
   */
  private async branchPickerFields(engine?: Engine): Promise<CreateResourceConfig["fields"]> {
    const databases = (await this.fetchDatabases()).filter(
      (db) => !engine || (db.kind ?? "mysql") === engine,
    );
    const lists = await Promise.all(
      databases.map(async (db) =>
        (await this.fetchBranches(db.name)).map((b) => ({
          id: `${db.name}/${b.name}`,
          label: `${db.name} / ${b.name}`,
          ...(b.production ? { description: "production" } : {}),
        })),
      ),
    );
    const options = lists.flat();
    return [
      {
        key: "branchRef",
        label: "Branch",
        kind: "select",
        required: true,
        options,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
      },
    ];
  }

  /** Branch a create targets: the parent resource, a `branchRef` pick, or explicit fields. */
  private static resolveBranchTarget(
    fields: Record<string, string>,
    parentResourceId?: string,
  ): { databaseName: string; branchName: string } {
    if (parentResourceId) return PlanetScaleClient.parseBranchId(parentResourceId);
    const ref = fields["branchRef"] ?? "";
    const slash = ref.indexOf("/");
    const databaseName = slash > 0 ? ref.slice(0, slash) : (fields["databaseName"] ?? "");
    const branchName = slash > 0 ? ref.slice(slash + 1) : (fields["branchName"] ?? "");
    if (!databaseName || !branchName) {
      throw new Error("PlanetScale plugin: a database and branch are required.");
    }
    return { databaseName, branchName };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "ps-database":
        return this.createDatabase(accountId, fields);
      case "ps-branch":
        return this.createBranch(accountId, fields, parentResourceId);
      case "ps-password":
        return this.createPassword(accountId, fields, parentResourceId);
      case "ps-role":
        return this.createRole(accountId, fields, parentResourceId);
      case "ps-backup":
        return this.createBackup(accountId, fields, parentResourceId);
      case "ps-webhook":
        return this.createWebhook(accountId, fields, parentResourceId);
      default:
        throw new Error(`PlanetScale plugin: cannot create type "${typeId}"`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "ps-database") {
      await this.fetch(this.dbPath(externalId), { method: "DELETE" });
      return;
    }

    if (typeId === "ps-branch") {
      const { databaseName, branchName } = PlanetScaleClient.parseBranchId(resourceId);
      await this.fetch(this.branchPath(databaseName, branchName), { method: "DELETE" });
      return;
    }

    if (typeId === "ps-password" || typeId === "ps-role" || typeId === "ps-backup") {
      const { databaseName, branchName, passwordId } =
        PlanetScaleClient.parsePasswordId(resourceId);
      const collection =
        typeId === "ps-password" ? "passwords" : typeId === "ps-role" ? "roles" : "backups";
      await this.fetch(
        `${this.branchPath(databaseName, branchName)}/${collection}/${enc(passwordId)}`,
        { method: "DELETE" },
      );
      return;
    }

    if (typeId === "ps-webhook") {
      const { databaseName, id } = PlanetScaleClient.parseDatabaseScopedId(resourceId);
      await this.fetch(`${this.dbPath(databaseName)}/webhooks/${enc(id)}`, { method: "DELETE" });
      return;
    }

    throw new Error(`PlanetScale plugin: cannot delete type "${typeId}"`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "ps-password") {
      const { databaseName, branchName, passwordId } =
        PlanetScaleClient.parsePasswordId(resourceId);
      const body: Record<string, unknown> = {};
      if (fields["name"] !== undefined) body["name"] = fields["name"];
      if (fields["cidrs"] !== undefined) body["cidrs"] = splitList(fields["cidrs"]);

      const data = await this.fetch<{ data: PsPassword }>(
        `${this.branchPath(databaseName, branchName)}/passwords/${enc(passwordId)}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );

      return this.toPasswordResource(
        data.data,
        databaseName,
        branchName,
        accountId,
        new Date().toISOString(),
      );
    }

    if (typeId === "ps-role") {
      const { databaseName, branchName, passwordId } =
        PlanetScaleClient.parsePasswordId(resourceId);
      const body: Record<string, unknown> = {};
      if (fields["name"]) body["name"] = fields["name"];
      if (fields["requireWhereOnDelete"]) {
        body["require_where_on_delete"] = fields["requireWhereOnDelete"];
      }
      if (fields["requireWhereOnUpdate"]) {
        body["require_where_on_update"] = fields["requireWhereOnUpdate"];
      }
      const data = await this.fetch<{ data?: PsRole } & PsRole>(
        `${this.branchPath(databaseName, branchName)}/roles/${enc(passwordId)}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      return this.toRoleResource(
        unwrap(data),
        databaseName,
        branchName,
        accountId,
        new Date().toISOString(),
      );
    }

    if (typeId === "ps-database") {
      const databaseName = resourceId.split(":").slice(2).join(":");
      const current = await this.fetch<PsDatabase>(this.dbPath(databaseName));
      const body: Record<string, unknown> = {};
      // Send only what changed: Vitess-only settings are rejected on Postgres
      // databases, and the form submits every field.
      for (const [key, readKey, writeKey] of DATABASE_BOOL_SETTINGS) {
        const value = fields[key];
        if (value === undefined || value === "") continue;
        const next = value === "true";
        if (next !== (current[readKey] === true)) body[writeKey] = next;
      }
      for (const [key, readKey, writeKey] of DATABASE_STRING_SETTINGS) {
        const value = fields[key]?.trim();
        if (value === undefined || value === "") continue;
        if (value !== String(current[readKey] ?? "")) body[writeKey] = value;
      }
      const limit = fields["developmentBranchesLimit"];
      if (limit && Number(limit) !== Number(current.development_branches_limit ?? NaN)) {
        body["development_branches_limit"] = Number(limit);
      }
      const updated =
        Object.keys(body).length > 0
          ? await this.fetch<PsDatabase>(this.dbPath(databaseName), {
              method: "PATCH",
              body: JSON.stringify(body),
            })
          : current;
      return this.toDatabaseResource(unwrap(updated), accountId, new Date().toISOString());
    }

    if (typeId === "ps-branch") {
      const { databaseName, branchName } = PlanetScaleClient.parseBranchId(resourceId);
      const body: Record<string, unknown> = {};
      if (fields["deletionProtected"] !== undefined && fields["deletionProtected"] !== "") {
        body["deletion_protected"] = fields["deletionProtected"] === "true";
      }
      const data = await this.fetch<PsBranch>(this.branchPath(databaseName, branchName), {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return this.toBranchResource(unwrap(data), databaseName, accountId, new Date().toISOString());
    }

    if (typeId === "ps-backup") {
      const { databaseName, branchName, passwordId } =
        PlanetScaleClient.parsePasswordId(resourceId);
      const data = await this.fetch<PsBackup>(
        `${this.branchPath(databaseName, branchName)}/backups/${enc(passwordId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ protected: fields["protected"] === "true" }),
        },
      );
      return this.toBackupResource(
        unwrap(data),
        databaseName,
        branchName,
        accountId,
        new Date().toISOString(),
      );
    }

    if (typeId === "ps-webhook") {
      const { databaseName, id } = PlanetScaleClient.parseDatabaseScopedId(resourceId);
      const body: Record<string, unknown> = {};
      if (fields["url"]) body["url"] = fields["url"];
      if (fields["events"] !== undefined) body["events"] = parseEventList(fields["events"]);
      if (fields["enabled"] !== undefined && fields["enabled"] !== "") {
        body["enabled"] = fields["enabled"] === "true";
      }
      // A write-only secret: blank means keep the current header.
      if (fields["authorizationHeader"]) {
        body["authorization_header"] = fields["authorizationHeader"];
      }
      const data = await this.fetch<PsWebhook>(`${this.dbPath(databaseName)}/webhooks/${enc(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return this.toWebhookResource(unwrap(data), databaseName, accountId);
    }

    throw new Error(`PlanetScale plugin: cannot update type "${typeId}"`);
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "ps-branch" && targetTypeId === "ps-branch") {
      const [source, target] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const sourceDb = String(source.fields["databaseName"] ?? "");
      const targetDb = String(target.fields["databaseName"] ?? "");
      const sourceBranch = String(source.fields["name"] ?? "");
      const targetBranch = String(target.fields["name"] ?? "");

      if (!sourceDb || !targetDb || !sourceBranch || !targetBranch) {
        throw new Error("PlanetScale plugin: missing branch identity for deploy request.");
      }
      if (sourceDb !== targetDb) {
        throw new Error(
          "PlanetScale plugin: deploy requests require branches in the same database.",
        );
      }
      if (sourceBranch === targetBranch) {
        throw new Error("PlanetScale plugin: cannot create a deploy request into the same branch.");
      }

      await this.fetch<{ data: PsDeployRequest }>(`${this.dbPath(sourceDb)}/deploy-requests`, {
        method: "POST",
        body: JSON.stringify({
          branch: sourceBranch,
          into_branch: targetBranch,
          notes: "Created by Infrawrench resource association.",
        }),
      });
      return;
    }

    throw new Error(
      `PlanetScale plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "ps-branch") {
      const path = this.branchPath(...branchParts(resourceId));
      switch (actionId) {
        case "promote":
          await this.fetch(`${path}/promote`, { method: "POST" });
          return;
        case "demote":
          await this.fetch(`${path}/demote`, { method: "POST" });
          return;
        case "enable-safe-migrations":
          await this.fetch(`${path}/safe-migrations`, { method: "POST" });
          return;
        case "disable-safe-migrations":
          await this.fetch(`${path}/safe-migrations`, { method: "DELETE" });
          return;
      }
    }

    if (typeId === "ps-deploy-request") {
      const { databaseName, number } = PlanetScaleClient.parseDeployRequestId(resourceId);
      const path = `${this.dbPath(databaseName)}/deploy-requests/${enc(number)}`;
      const post: Record<string, string> = {
        deploy: "deploy",
        apply: "apply-deploy",
        cancel: "cancel",
        "skip-revert": "skip-revert",
        revert: "revert",
      };
      const suffix = post[actionId];
      if (suffix) {
        await this.fetch(`${path}/${suffix}`, { method: "POST" });
        return;
      }
      if (actionId === "close") {
        await this.fetch(path, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
        return;
      }
    }

    if (typeId === "ps-password" && actionId === "renew") {
      await this.renewPassword(resourceId, accountId);
      return;
    }

    if (typeId === "ps-role" && (actionId === "renew" || actionId === "reset-password")) {
      const { databaseName, branchName, passwordId } =
        PlanetScaleClient.parsePasswordId(resourceId);
      const suffix = actionId === "renew" ? "renew" : "reset";
      await this.fetch(
        `${this.branchPath(databaseName, branchName)}/roles/${enc(passwordId)}/${suffix}`,
        { method: "POST" },
      );
      return;
    }

    if (typeId === "ps-webhook" && actionId === "test") {
      const { databaseName, id } = PlanetScaleClient.parseDatabaseScopedId(resourceId);
      await this.fetch(`${this.dbPath(databaseName)}/webhooks/${enc(id)}/test`, {
        method: "POST",
      });
      return;
    }

    throw new Error(`PlanetScale plugin: unknown action "${actionId}" for type "${typeId}"`);
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
      const status = databaseStatus(state);
      const variant: DashboardStat["variant"] =
        status === "healthy"
          ? "status-healthy"
          : status === "provisioning" || status === "degraded"
            ? "status-degraded"
            : "status-error";
      return [
        { label: "Region", value: region },
        { label: "State", value: state, variant },
        ...(resource.fields["kind"]
          ? [{ label: "Engine", value: engineLabel(String(resource.fields["kind"])) }]
          : []),
      ];
    }

    if (resourceTypeId === "ps-branch") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const production = resource.fields["production"] === true;
      const ready = resource.fields["ready"] === true;
      return [
        { label: "Production", value: production ? "Yes" : "No" },
        { label: "Ready", value: ready ? "Yes" : "No" },
        ...(resource.fields["clusterName"]
          ? [{ label: "Cluster", value: String(resource.fields["clusterName"]) }]
          : []),
      ];
    }

    if (resourceTypeId === "ps-password") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      return [
        { label: "Role", value: String(resource.fields["role"] ?? "") },
        {
          label: "Expired",
          value: resource.fields["expired"] === true ? "Yes" : "No",
          variant: resource.fields["expired"] === true ? "status-error" : "status-healthy",
        },
      ];
    }

    if (resourceTypeId === "ps-deploy-request") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      return [
        { label: "State", value: String(resource.fields["state"] ?? "") },
        { label: "Approved", value: resource.fields["approved"] === true ? "Yes" : "No" },
      ];
    }

    if (resourceTypeId === "ps-backup") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      return [
        { label: "State", value: String(resource.fields["state"] ?? "") },
        { label: "Size", value: String(resource.fields["size"] ?? "") },
      ];
    }

    // Default: count databases
    const databases = await this.fetchDatabases();
    return [
      { label: "Version", value: "PlanetScale" },
      { label: "Databases", value: String(databases.length) },
    ];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "ps-branch") return [];
    const { databaseName, branchName } = PlanetScaleClient.parseBranchId(resourceId);
    return fetchBranchMetrics(
      <T>(path: string) => this.fetch<T>(path),
      this.branchPath(databaseName, branchName),
      timeRange,
    );
  }

  /** Branch Logs tab: Insights query errors and latency anomalies. */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "ps-branch") return { text: "", containers: [], activeContainer: "" };
    const { databaseName, branchName } = PlanetScaleClient.parseBranchId(resourceId);
    return fetchInsightsLog(
      <T>(path: string) => this.fetch<T>(path),
      this.branchPath(databaseName, branchName),
      params,
    );
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    // Bind preserves the generic signature of the private fetch helper so the
    // cost module reuses the token auth + optional CA/bastion routing.
    return fetchPlanetScaleCostData(this.fetch.bind(this), this.orgName, range);
  }

  private async fetchDatabases(): Promise<PsDatabase[]> {
    const data = await this.fetch<{ data: PsDatabase[] }>(
      `/organizations/${enc(this.orgName)}/databases`,
    );
    return data.data ?? [];
  }

  /** Org regions for the database picker, tagged with the engines each one runs. */
  private async fetchRegionOptions(): Promise<RegionOption[]> {
    try {
      const data = await this.fetch<{ data?: PsRegion[] }>(
        `/organizations/${enc(this.orgName)}/regions?per_page=100`,
      );
      const regions = (data.data ?? []).filter((r) => r.enabled !== false);
      if (regions.length > 0) {
        return regions.map((r) => {
          const engines = [
            ...(r.mysql_supported !== false ? ["mysql"] : []),
            ...(r.postgresql_supported ? ["postgresql"] : []),
          ];
          return {
            id: r.slug,
            label: r.slug,
            location: r.location || r.display_name || PS_REGIONS[r.slug]?.location || r.slug,
            ...(PS_REGIONS[r.slug] ? { flag: PS_REGIONS[r.slug]!.flag } : {}),
            availableFor: engines,
          };
        });
      }
    } catch {
      /* fall back to the static table */
    }
    return Object.entries(PS_REGIONS).map(([id, info]) => ({
      id,
      label: id,
      location: info.location,
      flag: info.flag,
    }));
  }

  /** Cluster sizes the organization can provision for one engine. */
  private async fetchClusterSizeOptions(engine: Engine): Promise<SelectOption[]> {
    const skus = await this.fetch<PsClusterSku[] | { data?: PsClusterSku[] }>(
      `/organizations/${enc(this.orgName)}/cluster-size-skus?engine=${engine}`,
    ).catch(() => [] as PsClusterSku[]);
    const list = Array.isArray(skus) ? skus : (skus.data ?? []);
    return list
      .filter((sku) => sku.enabled !== false)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((sku) => {
        const parts = [
          sku.cpu !== undefined && sku.cpu !== "" ? `${String(sku.cpu)} vCPU` : "",
          typeof sku.ram === "number" && sku.ram > 0 ? formatBytes(sku.ram) : "",
          sku.development && !sku.production ? "development only" : "",
        ].filter(Boolean);
        return {
          id: sku.name,
          label: sku.display_name || sku.name,
          ...(parts.length > 0 ? { description: parts.join(" · ") } : {}),
        };
      });
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    const now = new Date().toISOString();
    return databases.map((db) => this.toDatabaseResource(db, accountId, now));
  }

  private toDatabaseResource(db: PsDatabase, accountId: string, now: string): ResourceInstance {
    return {
      id: `${accountId}:ps-database:${db.name}`,
      pluginId: "planetscale",
      resourceTypeId: "ps-database",
      accountId,
      displayName: db.name,
      externalId: db.name,
      fields: {
        name: db.name,
        kind: db.kind ?? "mysql",
        region: db.region?.slug ?? "",
        state: db.state ?? "",
        plan: db.plan ?? "",
        branchesCount: db.branches_count ?? 0,
        htmlUrl: db.html_url ?? "",
        createdAt: db.created_at ?? "",
        updatedAt: db.updated_at ?? "",
        defaultBranch: db.default_branch ?? "",
        deletionProtected: db.deletion_protected === true,
        requireApprovalForDeploy: db.require_approval_for_deploy === true,
        restrictBranchRegion: db.restrict_branch_region === true,
        productionBranchWebConsole: db.production_branch_web_console === true,
        insightsRawQueries: db.insights_raw_queries === true,
        allowDataBranching: db.allow_data_branching === true,
        foreignKeysEnabled: db.foreign_keys_enabled === true,
        automaticMigrations: db.automatic_migrations === true,
        migrationFramework: db.migration_framework ?? "",
        migrationTableName: db.migration_table_name ?? "",
        ...(db.development_branches_limit !== undefined
          ? { developmentBranchesLimit: db.development_branches_limit }
          : {}),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async createDatabase(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const kind = (fields["kind"] || "mysql") as Engine;
    const clusterSize =
      kind === "postgresql" ? fields["clusterSizePostgres"] : fields["clusterSizeMysql"];
    const body: Record<string, unknown> = {
      name: fields["name"],
      region: fields["region"],
      ...(clusterSize ? { cluster_size: clusterSize } : {}),
      ...(fields["kind"] ? { kind } : {}),
    };
    const data = await this.fetch<PsDatabase | { data: PsDatabase }>(
      `/organizations/${enc(this.orgName)}/databases`,
      { method: "POST", body: JSON.stringify(body) },
    );

    const db = unwrap(data);
    return this.toDatabaseResource(
      { ...db, state: db.state ?? "ready", kind: db.kind ?? kind },
      accountId,
      new Date().toISOString(),
    );
  }

  private async fetchBranches(databaseName: string): Promise<PsBranch[]> {
    const data = await this.fetch<{ data: PsBranch[] }>(`${this.dbPath(databaseName)}/branches`);
    return data.data ?? [];
  }

  private async listAllBranches(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    const now = new Date().toISOString();

    const branchLists = await Promise.all(
      databases.map(async (db) => {
        const branches = await this.fetchBranches(db.name);
        return branches.map((b) =>
          this.toBranchResource(
            { ...b, kind: b.kind ?? db.kind ?? "mysql" },
            db.name,
            accountId,
            now,
          ),
        );
      }),
    );

    return branchLists.flat();
  }

  private async listAllPasswords(accountId: string): Promise<ResourceInstance[]> {
    // Passwords are a Vitess concept; Postgres branches use roles.
    const branches = (await this.listAllBranches(accountId)).filter(
      (b) => (b.fields["kind"] ?? "mysql") === "mysql",
    );
    const now = new Date().toISOString();

    const passwordLists = await Promise.all(
      branches.map(async (branch) => {
        const dbName = String(branch.fields["databaseName"] ?? "");
        const branchName = String(branch.fields["name"] ?? "");
        const passwords = await this.fetchPasswords(dbName, branchName);
        return passwords.map((password) =>
          this.toPasswordResource(password, dbName, branchName, accountId, now),
        );
      }),
    );

    return passwordLists.flat();
  }

  private async fetchPasswords(databaseName: string, branchName: string): Promise<PsPassword[]> {
    const data = await this.fetch<{ data: PsPassword[] }>(
      `${this.branchPath(databaseName, branchName)}/passwords`,
    );
    return data.data ?? [];
  }

  private toPasswordResource(
    password: PsPassword,
    databaseName: string,
    branchName: string,
    accountId: string,
    now: string,
  ): ResourceInstance {
    return {
      id: `${accountId}:ps-password:${databaseName}/${branchName}/${password.id}`,
      pluginId: "planetscale",
      resourceTypeId: "ps-password",
      accountId,
      displayName: password.name,
      externalId: `${databaseName}/${branchName}/${password.id}`,
      parentResourceId: `${accountId}:ps-branch:${databaseName}/${branchName}`,
      fields: {
        name: password.name,
        organization: this.orgName,
        databaseName,
        branchName,
        role: password.role ?? "",
        username: password.username ?? "",
        host: password.access_host_url ?? "",
        expired: password.expired === true,
        replica: password.replica === true,
        renewable: password.renewable === true,
        cidrs: (password.cidrs ?? []).join(", "),
        createdAt: password.created_at ?? "",
        expiresAt: password.expires_at ?? "",
        lastUsedAt: password.last_used_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listAllRoles(accountId: string): Promise<ResourceInstance[]> {
    const branches = (await this.listAllBranches(accountId)).filter(
      (b) => b.fields["kind"] === "postgresql",
    );
    const now = new Date().toISOString();
    const lists = await Promise.all(
      branches.map(async (branch) => {
        const dbName = String(branch.fields["databaseName"] ?? "");
        const branchName = String(branch.fields["name"] ?? "");
        const data = await this.fetch<{ data?: PsRole[] }>(
          `${this.branchPath(dbName, branchName)}/roles`,
        );
        return (data.data ?? []).map((role) =>
          this.toRoleResource(role, dbName, branchName, accountId, now),
        );
      }),
    );
    return lists.flat();
  }

  private toRoleResource(
    role: PsRole,
    databaseName: string,
    branchName: string,
    accountId: string,
    now: string,
  ): ResourceInstance {
    const inherited = role.inherited_roles ?? [];
    return {
      id: `${accountId}:ps-role:${databaseName}/${branchName}/${role.id}`,
      pluginId: "planetscale",
      resourceTypeId: "ps-role",
      accountId,
      displayName: role.name || role.username || role.id,
      externalId: `${databaseName}/${branchName}/${role.id}`,
      parentResourceId: `${accountId}:ps-branch:${databaseName}/${branchName}`,
      fields: {
        id: role.id,
        name: role.name ?? "",
        organization: this.orgName,
        databaseName,
        branchName,
        username: role.username ?? "",
        host: role.access_host_url ?? "",
        inheritedRoles: inherited.join(", "),
        superuser: inherited.includes("postgres"),
        default: role.default === true,
        expired: role.expired === true,
        requireWhereOnDelete: role.query_safety_settings?.require_where_on_delete ?? "",
        requireWhereOnUpdate: role.query_safety_settings?.require_where_on_update ?? "",
        createdAt: role.created_at ?? "",
        expiresAt: role.expires_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: role.created_at || now,
      updatedAt: now,
    };
  }

  private async createRole(
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const { databaseName, branchName } = PlanetScaleClient.resolveBranchTarget(
      fields,
      parentResourceId,
    );
    const body: Record<string, unknown> = {};
    if (fields["name"]) body["name"] = fields["name"];
    if (fields["ttl"]) body["ttl"] = Number(fields["ttl"]);
    const inherited = parseEventList(fields["inheritedRoles"]);
    if (inherited.length > 0) body["inherited_roles"] = inherited;
    if (fields["requireWhereOnDelete"]) {
      body["require_where_on_delete"] = fields["requireWhereOnDelete"];
    }
    if (fields["requireWhereOnUpdate"]) {
      body["require_where_on_update"] = fields["requireWhereOnUpdate"];
    }

    const data = await this.fetch<PsRole | { data: PsRole }>(
      `${this.branchPath(databaseName, branchName)}/roles`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const role = unwrap(data);
    const resource = this.toRoleResource(
      role,
      databaseName,
      branchName,
      accountId,
      new Date().toISOString(),
    );
    // The only response that ever carries the password.
    if (role.password && role.username && role.access_host_url) {
      resource.resolvedOutputs = {
        ...resource.resolvedOutputs,
        connectionString: postgresUrl(role.username, role.password, role.access_host_url),
      };
    }
    return resource;
  }

  private async listAllDeployRequests(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    const now = new Date().toISOString();

    const requestLists = await Promise.all(
      databases.map(async (db) => {
        const requests = await this.fetchDeployRequests(db.name);
        return requests.map((request) =>
          this.toDeployRequestResource(request, db.name, accountId, now),
        );
      }),
    );

    return requestLists.flat();
  }

  private async fetchDeployRequests(databaseName: string): Promise<PsDeployRequest[]> {
    const data = await this.fetch<{ data: PsDeployRequest[] }>(
      `${this.dbPath(databaseName)}/deploy-requests`,
    );
    return data.data ?? [];
  }

  private toDeployRequestResource(
    request: PsDeployRequest,
    databaseName: string,
    accountId: string,
    now: string,
  ): ResourceInstance {
    const state = request.deployed_at
      ? "deployed"
      : request.closed_at || request.state === "closed"
        ? "closed"
        : "open";

    return {
      id: `${accountId}:ps-deploy-request:${databaseName}/${request.number}`,
      pluginId: "planetscale",
      resourceTypeId: "ps-deploy-request",
      accountId,
      displayName: `#${request.number} ${request.branch} -> ${request.into_branch}`,
      externalId: `${databaseName}/${request.number}`,
      parentResourceId: `${accountId}:ps-database:${databaseName}`,
      fields: {
        number: request.number,
        databaseName,
        branch: request.branch ?? "",
        intoBranch: request.into_branch ?? "",
        approved: request.approved === true,
        state,
        deploymentState: request.deployment_state ?? request.deployment?.state ?? "",
        notes: request.notes ?? "",
        deployable: request.deployment?.deployable === true,
        htmlUrl: request.html_url ?? "",
        createdAt: request.created_at ?? "",
        updatedAt: request.updated_at ?? "",
        deployedAt: request.deployed_at ?? "",
        closedAt: request.closed_at ?? "",
        deploymentStartedAt: request.deployment?.started_at ?? "",
        deploymentFinishedAt: request.deployment?.finished_at ?? "",
        deployOperationCount:
          request.deployment?.deploy_operation_summaries?.length ??
          request.deployment?.deploy_operations?.length ??
          0,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async listAllBackups(accountId: string): Promise<ResourceInstance[]> {
    const branches = await this.listAllBranches(accountId);
    const now = new Date().toISOString();

    const backupLists = await Promise.all(
      branches.map(async (branch) => {
        const dbName = String(branch.fields["databaseName"] ?? "");
        const branchName = String(branch.fields["name"] ?? "");
        const backups = await this.fetchBackups(dbName, branchName);
        return backups.map((backup) =>
          this.toBackupResource(backup, dbName, branchName, accountId, now),
        );
      }),
    );

    return backupLists.flat();
  }

  private async fetchBackups(databaseName: string, branchName: string): Promise<PsBackup[]> {
    const data = await this.fetch<{ data: PsBackup[] }>(
      `${this.branchPath(databaseName, branchName)}/backups`,
    );
    return data.data ?? [];
  }

  private toBackupResource(
    backup: PsBackup,
    databaseName: string,
    branchName: string,
    accountId: string,
    now: string,
  ): ResourceInstance {
    return {
      id: `${accountId}:ps-backup:${databaseName}/${branchName}/${backup.id}`,
      pluginId: "planetscale",
      resourceTypeId: "ps-backup",
      accountId,
      displayName: backup.name,
      externalId: `${databaseName}/${branchName}/${backup.id}`,
      parentResourceId: `${accountId}:ps-branch:${databaseName}/${branchName}`,
      fields: {
        id: backup.id,
        name: backup.name,
        databaseName,
        branchName,
        state: backup.state ?? "",
        size: backup.size ?? 0,
        protected: backup.protected === true,
        required: backup.required === true,
        policyName: backup.backup_policy?.display_name ?? backup.backup_policy?.name ?? "",
        createdAt: backup.created_at ?? "",
        startedAt: backup.started_at ?? "",
        completedAt: backup.completed_at ?? "",
        expiresAt: backup.expires_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async createBackup(
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const { databaseName, branchName } = PlanetScaleClient.resolveBranchTarget(
      fields,
      parentResourceId,
    );
    const body: Record<string, unknown> = {
      ...(fields["name"] ? { name: fields["name"] } : {}),
      ...(fields["retentionValue"] ? { retention_value: Number(fields["retentionValue"]) } : {}),
      ...(fields["retentionUnit"] ? { retention_unit: fields["retentionUnit"] } : {}),
    };
    const data = await this.fetch<PsBackup | { data: PsBackup }>(
      `${this.branchPath(databaseName, branchName)}/backups`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return this.toBackupResource(
      unwrap(data),
      databaseName,
      branchName,
      accountId,
      new Date().toISOString(),
    );
  }

  private async listAllWebhooks(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.fetchDatabases();
    const lists = await Promise.all(
      databases.map(async (db) => {
        const data = await this.fetch<{ data?: PsWebhook[] }>(`${this.dbPath(db.name)}/webhooks`);
        return (data.data ?? []).map((hook) => this.toWebhookResource(hook, db.name, accountId));
      }),
    );
    return lists.flat();
  }

  private toWebhookResource(
    hook: PsWebhook,
    databaseName: string,
    accountId: string,
  ): ResourceInstance {
    const now = new Date().toISOString();
    return {
      id: `${accountId}:ps-webhook:${databaseName}/${hook.id}`,
      pluginId: "planetscale",
      resourceTypeId: "ps-webhook",
      accountId,
      displayName: hook.url,
      externalId: `${databaseName}/${hook.id}`,
      parentResourceId: `${accountId}:ps-database:${databaseName}`,
      fields: {
        url: hook.url,
        databaseName,
        events: (hook.events ?? []).join(", "),
        enabled: hook.enabled !== false,
        authorizationHeaderConfigured: hook.authorization_header_configured === true,
        lastSentAt: hook.last_sent_at ?? "",
        ...(hook.last_sent_success !== undefined && hook.last_sent_success !== null
          ? { lastSentSuccess: hook.last_sent_success }
          : {}),
        createdAt: hook.created_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: hook.created_at || now,
      updatedAt: now,
    };
  }

  private async createWebhook(
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const databaseName = parentResourceId
      ? parentResourceId.split(":").slice(2).join(":")
      : (fields["databaseName"] ?? "");
    if (!databaseName) throw new Error("PlanetScale plugin: a database is required.");
    const url = (fields["url"] ?? "").trim();
    if (!url) throw new Error("PlanetScale plugin: a webhook URL is required.");
    const body: Record<string, unknown> = {
      url,
      enabled: true,
      events: parseEventList(fields["events"]),
      ...(fields["authorizationHeader"]
        ? { authorization_header: fields["authorizationHeader"] }
        : {}),
    };
    const data = await this.fetch<PsWebhook | { data: PsWebhook }>(
      `${this.dbPath(databaseName)}/webhooks`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return this.toWebhookResource(unwrap(data), databaseName, accountId);
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
        id: branch.id ?? "",
        name: branch.name,
        organization: this.orgName,
        databaseName,
        kind: branch.kind ?? "mysql",
        parentBranch: branch.parent_branch ?? "",
        region: branch.region?.slug ?? "",
        clusterName: branch.cluster_name ?? "",
        production: branch.production,
        ready: branch.ready,
        safeMigrations: branch.safe_migrations,
        deletionProtected: branch.deletion_protected === true,
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
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const dbName = fields["databaseName"] ?? parentExternalId;
    const data = await this.fetch<PsBranch | { data: PsBranch }>(
      `${this.dbPath(dbName)}/branches`,
      {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"],
          parent_branch: fields["parentBranch"],
          ...(fields["seedData"] ? { seed_data: fields["seedData"] } : {}),
          ...(fields["deletionProtected"] === "true" ? { deletion_protected: true } : {}),
        }),
      },
    );

    const branch = unwrap(data);
    const now = new Date().toISOString();
    return this.toBranchResource(branch, dbName, accountId, now);
  }

  private async createPassword(
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    let target: { databaseName: string; branchName: string };
    try {
      target = PlanetScaleClient.resolveBranchTarget(fields, parentResourceId);
    } catch {
      throw new Error("PlanetScale plugin: password creation requires a database and branch.");
    }
    const { databaseName, branchName } = target;

    const body: Record<string, unknown> = {};
    if (fields["name"]) body["name"] = fields["name"];
    if (fields["role"]) body["role"] = fields["role"];
    if (fields["ttl"]) body["ttl"] = Number(fields["ttl"]);
    if (fields["replica"] === "true") body["replica"] = true;
    if (fields["cidrs"]) body["cidrs"] = splitList(fields["cidrs"]);

    const data = await this.fetch<{ data: PsPassword } | PsPassword>(
      `${this.branchPath(databaseName, branchName)}/passwords`,
      { method: "POST", body: JSON.stringify(body) },
    );

    return this.toPasswordResource(
      unwrap(data),
      databaseName,
      branchName,
      accountId,
      new Date().toISOString(),
    );
  }

  /**
   * Vitess branches mint a branch password (MySQL URL); Postgres branches mint
   * a role (Postgres URL). Either way it is a new credential each time, since
   * PlanetScale only reveals a secret in the response that creates it.
   */
  private async resolveBranchConnectionString(resourceId: string): Promise<string> {
    const { databaseName: dbName, branchName } = PlanetScaleClient.parseBranchId(resourceId);
    const path = this.branchPath(dbName, branchName);
    const branch = await this.fetch<PsBranch | { data: PsBranch }>(path)
      .then(unwrap)
      .catch(() => null);

    if (branch?.kind === "postgresql") {
      const role = unwrap(
        await this.fetch<PsRole | { data: PsRole }>(`${path}/roles`, {
          method: "POST",
          body: JSON.stringify({ name: `infrawrench-${Date.now()}` }),
        }),
      );
      return postgresUrl(role.username ?? "", role.password ?? "", role.access_host_url ?? "");
    }

    const pw = unwrap(
      await this.fetch<{ data: PsPassword } | PsPassword>(`${path}/passwords`, {
        method: "POST",
        body: JSON.stringify({ name: `infrawrench-${Date.now()}` }),
      }),
    );
    const user = encodeURIComponent(pw.username);
    const pass = encodeURIComponent(pw.plain_text ?? "");
    const host = pw.access_host_url;

    return `mysql://${user}:${pass}@${host}/${dbName}`;
  }

  async renewPassword(resourceId: string, accountId: string): Promise<ResourceInstance> {
    const { databaseName, branchName, passwordId } = PlanetScaleClient.parsePasswordId(resourceId);
    const data = await this.fetch<{ data: PsPassword } | PsPassword>(
      `${this.branchPath(databaseName, branchName)}/passwords/${enc(passwordId)}/renew`,
      { method: "POST" },
    );
    return this.toPasswordResource(
      unwrap(data),
      databaseName,
      branchName,
      accountId,
      new Date().toISOString(),
    );
  }

  async promoteBranch(resourceId: string): Promise<void> {
    await this.invokeAction("ps-branch", resourceId, "promote", "");
  }

  async closeDeployRequest(resourceId: string): Promise<void> {
    await this.invokeAction("ps-deploy-request", resourceId, "close", "");
  }

  async applyDeployRequest(resourceId: string): Promise<void> {
    await this.invokeAction("ps-deploy-request", resourceId, "apply", "");
  }

  private static parseBranchId(resourceId: string): { databaseName: string; branchName: string } {
    const externalId = resourceId.split(":").slice(2).join(":");
    const parts = externalId.split("/");
    const databaseName = parts[0] ?? "";
    const branchName = parts.slice(1).join("/");
    if (!databaseName || !branchName) {
      throw new Error("PlanetScale plugin: cannot parse branch resource id.");
    }
    return { databaseName, branchName };
  }

  private static parsePasswordId(resourceId: string): {
    databaseName: string;
    branchName: string;
    passwordId: string;
  } {
    const externalId = resourceId.split(":").slice(2).join(":");
    const parts = externalId.split("/");
    const databaseName = parts[0] ?? "";
    const branchName = parts[1] ?? "";
    const passwordId = parts.slice(2).join("/");
    if (!databaseName || !branchName || !passwordId) {
      throw new Error("PlanetScale plugin: cannot parse password resource id.");
    }
    return { databaseName, branchName, passwordId };
  }

  private static parseDatabaseScopedId(resourceId: string): { databaseName: string; id: string } {
    const externalId = resourceId.split(":").slice(2).join(":");
    const slash = externalId.indexOf("/");
    const databaseName = slash > 0 ? externalId.slice(0, slash) : "";
    const id = slash > 0 ? externalId.slice(slash + 1) : "";
    if (!databaseName || !id) {
      throw new Error("PlanetScale plugin: cannot parse resource id.");
    }
    return { databaseName, id };
  }

  private static parseDeployRequestId(resourceId: string): {
    databaseName: string;
    number: string;
  } {
    const externalId = resourceId.split(":").slice(2).join(":");
    const parts = externalId.split("/");
    const databaseName = parts[0] ?? "";
    const number = parts.slice(1).join("/");
    if (!databaseName || !number) {
      throw new Error("PlanetScale plugin: cannot parse deploy request resource id.");
    }
    return { databaseName, number };
  }

  private renderDatabaseDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const state = String(f["state"] ?? "");
    const vitess = (f["kind"] ?? "mysql") === "mysql";
    const onOff = (key: string): string => (f[key] === true ? "On" : "Off");
    return {
      title: resource.displayName,
      subtitle: joinSubtitle(
        `PlanetScale ${engineLabel(String(f["kind"] ?? "mysql"))} Database`,
        formatRegion(String(f["region"] ?? "")),
      ),
      status: { kind: "status-dot", status: databaseStatus(state) },
      sections: [
        {
          kind: "section",
          title: "Overview",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Engine", value: engineLabel(String(f["kind"] ?? "mysql")) },
                { key: "Region", value: formatRegion(String(f["region"] ?? "—")) },
                { key: "State", value: state || "—" },
                ...(f["plan"] ? [{ key: "Plan", value: String(f["plan"]) }] : []),
                { key: "Default Branch", value: String(f["defaultBranch"] ?? "") || "—" },
                ...(f["htmlUrl"] ? [{ key: "Dashboard", value: String(f["htmlUrl"]) }] : []),
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Updated", value: String(f["updatedAt"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Settings",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Deletion Protection", value: onOff("deletionProtected") },
                { key: "Require Deploy Approval", value: onOff("requireApprovalForDeploy") },
                { key: "Restrict Branch Region", value: onOff("restrictBranchRegion") },
                { key: "Production Web Console", value: onOff("productionBranchWebConsole") },
                { key: "Insights Full Queries", value: onOff("insightsRawQueries") },
                ...(vitess
                  ? [
                      { key: "Data Branching", value: onOff("allowDataBranching") },
                      { key: "Foreign Keys", value: onOff("foreignKeysEnabled") },
                      { key: "Copy Migration Data", value: onOff("automaticMigrations") },
                      {
                        key: "Migration Framework",
                        value: String(f["migrationFramework"] ?? "") || "—",
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(f["htmlUrl"]
          ? [
              {
                kind: "action" as const,
                label: "Open in PlanetScale",
                action: { type: "open-url" as const, url: String(f["htmlUrl"]) },
              },
            ]
          : []),
      ],
    };
  }

  private renderBranchDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const ready = f["ready"] === true;
    const production = f["production"] === true;
    const postgres = f["kind"] === "postgresql";
    const safe = f["safeMigrations"] === true;

    const actions: DetailViewSchema["headerActions"] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      production
        ? {
            kind: "action",
            label: "Demote to Development",
            action: {
              type: "plugin-action",
              actionId: "demote",
              confirmMessage:
                "Demote this production branch to a development branch? It loses production protections such as automatic backups and high availability.",
              successMessage: "Branch demoted.",
            },
          }
        : {
            kind: "action",
            label: "Promote to Production",
            action: {
              type: "plugin-action",
              actionId: "promote",
              confirmMessage: "Promote this branch to production?",
              successMessage: "Branch promoted.",
            },
          },
    ];
    // Safe migrations (deploy requests only, no direct DDL) is a Vitess feature.
    if (!postgres && production) {
      actions.push(
        safe
          ? {
              kind: "action",
              label: "Disable Safe Migrations",
              action: {
                type: "plugin-action",
                actionId: "disable-safe-migrations",
                confirmMessage:
                  "Disable safe migrations? Direct DDL will be allowed on this production branch.",
                successMessage: "Safe migrations disabled.",
              },
            }
          : {
              kind: "action",
              label: "Enable Safe Migrations",
              action: {
                type: "plugin-action",
                actionId: "enable-safe-migrations",
                successMessage: "Safe migrations enabled.",
              },
            },
      );
    }

    return {
      title: resource.displayName,
      subtitle: joinSubtitle("PlanetScale Branch", f["databaseName"]),
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
                { key: "Database", value: String(f["databaseName"] ?? "—") },
                { key: "Engine", value: engineLabel(String(f["kind"] ?? "mysql")) },
                { key: "Production", value: production ? "Yes" : "No" },
                { key: "Ready", value: ready ? "Yes" : "No" },
                ...(postgres
                  ? []
                  : [{ key: "Safe Migrations", value: safe ? "Enabled" : "Disabled" }]),
                {
                  key: "Deletion Protection",
                  value: f["deletionProtected"] === true ? "On" : "Off",
                },
                ...(f["clusterName"] ? [{ key: "Cluster", value: String(f["clusterName"]) }] : []),
                ...(f["region"]
                  ? [{ key: "Region", value: formatRegion(String(f["region"])) }]
                  : []),
                ...(f["parentBranch"]
                  ? [{ key: "Branched From", value: String(f["parentBranch"]) }]
                  : []),
                { key: "Created", value: String(f["createdAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: actions,
      sqlEditor: {
        connectionStringOutputKey: "connectionString",
        defaultQuery: postgres
          ? "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema');"
          : "SHOW TABLES;",
      },
      metricsCapability: PS_METRICS_CAPABILITY,
      logs: { defaultTailLines: 50 },
    };
  }

  private renderPasswordDetail(resource: ResourceInstance): DetailViewSchema {
    const expired = resource.fields["expired"] === true;
    return {
      title: resource.displayName,
      subtitle: joinSubtitle(
        "PlanetScale Password",
        [resource.fields["databaseName"], resource.fields["branchName"]].filter(Boolean).join("/"),
      ),
      status: { kind: "status-dot", status: expired ? "error" : "healthy" },
      sections: [
        {
          kind: "section",
          title: "Password",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Database", value: String(resource.fields["databaseName"] ?? "—") },
                { key: "Branch", value: String(resource.fields["branchName"] ?? "—") },
                { key: "Role", value: String(resource.fields["role"] ?? "—") },
                { key: "Username", value: String(resource.fields["username"] ?? "—") },
                { key: "Host", value: String(resource.fields["host"] ?? "—") },
                { key: "Replica", value: resource.fields["replica"] === true ? "Yes" : "No" },
                { key: "Allowed CIDRs", value: String(resource.fields["cidrs"] ?? "") || "Any" },
                { key: "Expired", value: expired ? "Yes" : "No" },
                { key: "Expires", value: String(resource.fields["expiresAt"] ?? "") || "Never" },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") },
                { key: "Last Used", value: String(resource.fields["lastUsedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(resource.fields["renewable"] === true
          ? [
              {
                kind: "action" as const,
                label: "Renew",
                action: {
                  type: "plugin-action" as const,
                  actionId: "renew",
                  successMessage: "Password renewed for another TTL period.",
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderRoleDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const expired = f["expired"] === true;
    return {
      title: resource.displayName,
      subtitle: joinSubtitle(
        "PlanetScale Postgres Role",
        [f["databaseName"], f["branchName"]].filter(Boolean).join("/"),
      ),
      status: { kind: "status-dot", status: expired ? "error" : "healthy" },
      sections: [
        {
          kind: "section",
          title: "Role",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Username", value: String(f["username"] ?? "") || "—" },
                { key: "Host", value: String(f["host"] ?? "") || "—" },
                { key: "Inherited Roles", value: String(f["inheritedRoles"] ?? "") || "None" },
                { key: "Default Role", value: f["default"] === true ? "Yes" : "No" },
                {
                  key: "Require WHERE on DELETE",
                  value: String(f["requireWhereOnDelete"] ?? "") || "—",
                },
                {
                  key: "Require WHERE on UPDATE",
                  value: String(f["requireWhereOnUpdate"] ?? "") || "—",
                },
                { key: "Expires", value: String(f["expiresAt"] ?? "") || "Never" },
                { key: "Created", value: String(f["createdAt"] ?? "") || "—" },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Renew",
          action: {
            type: "plugin-action",
            actionId: "renew",
            successMessage: "Role renewed for another TTL period.",
          },
        },
        {
          kind: "action",
          label: "Reset Password",
          action: {
            type: "plugin-action",
            actionId: "reset-password",
            confirmMessage:
              "Reset this role's password? Clients using the current password stop connecting until they are given the new one.",
            successMessage: "Password reset. Create a new role to receive a password you can copy.",
          },
          variant: "danger",
        },
      ],
    };
  }

  private renderDeployRequestDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const state = String(f["state"] ?? "open");
    const deploymentState = String(f["deploymentState"] ?? "");
    const open = state === "open";

    const action = (
      label: string,
      actionId: string,
      successMessage: string,
      confirmMessage?: string,
      danger?: boolean,
    ) => ({
      kind: "action" as const,
      label,
      action: {
        type: "plugin-action" as const,
        actionId,
        successMessage,
        ...(confirmMessage ? { confirmMessage } : {}),
      },
      ...(danger ? { variant: "danger" as const } : {}),
    });

    const actions: DetailViewSchema["headerActions"] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
    if (open && deploymentState === "ready") {
      actions.push(
        action(
          "Deploy",
          "deploy",
          "Deploy request queued.",
          `Queue deploy request #${String(f["number"] ?? "")} for deployment into ${String(f["intoBranch"] ?? "")}?`,
        ),
      );
    }
    if (deploymentState === "pending_cutover") {
      actions.push(
        action(
          "Apply Changes",
          "apply",
          "Cutover started.",
          "Apply the staged schema changes now? This is the cutover for a gated deployment.",
        ),
      );
    }
    if (["queued", "submitting", "in_progress", "pending_cutover"].includes(deploymentState)) {
      actions.push(
        action("Cancel Deploy", "cancel", "Deployment cancelled.", "Cancel this deployment?", true),
      );
    }
    if (deploymentState === "complete_pending_revert") {
      actions.push(
        action(
          "Skip Revert Period",
          "skip-revert",
          "Revert window closed.",
          "End the revert window now? The deployed schema becomes permanent.",
        ),
        action(
          "Revert",
          "revert",
          "Revert started.",
          "Revert this deployment and restore the previous schema?",
          true,
        ),
      );
    }
    if (
      open &&
      !["queued", "submitting", "in_progress", "pending_cutover"].includes(deploymentState)
    ) {
      actions.push(
        action(
          "Close",
          "close",
          "Deploy request closed.",
          "Close this deploy request without deploying?",
        ),
      );
    }

    return {
      title: resource.displayName,
      subtitle: joinSubtitle("PlanetScale Deploy Request", f["databaseName"]),
      status: {
        kind: "status-dot",
        status:
          state === "deployed"
            ? "healthy"
            : deploymentState.includes("error")
              ? "error"
              : state === "closed"
                ? "degraded"
                : "info",
      },
      sections: [
        {
          kind: "section",
          title: "Deploy Request",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Number", value: String(f["number"] ?? "—") },
                { key: "Database", value: String(f["databaseName"] ?? "—") },
                { key: "Branch", value: String(f["branch"] ?? "—") },
                { key: "Into Branch", value: String(f["intoBranch"] ?? "—") },
                { key: "State", value: state },
                { key: "Deployment", value: deploymentState.replace(/_/g, " ") || "—" },
                { key: "Approved", value: f["approved"] === true ? "Yes" : "No" },
                { key: "Deployable", value: f["deployable"] === true ? "Yes" : "No" },
                { key: "Operations", value: String(f["deployOperationCount"] ?? 0) },
                ...(f["notes"] ? [{ key: "Notes", value: String(f["notes"]) }] : []),
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Deployed", value: String(f["deployedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: actions,
    };
  }

  private renderBackupDetail(resource: ResourceInstance): DetailViewSchema {
    const state = String(resource.fields["state"] ?? "");
    return {
      title: resource.displayName,
      subtitle: joinSubtitle(
        "PlanetScale Backup",
        [resource.fields["databaseName"], resource.fields["branchName"]].filter(Boolean).join("/"),
      ),
      status: {
        kind: "status-dot",
        status: state === "success" ? "healthy" : state === "failed" ? "error" : "info",
      },
      sections: [
        {
          kind: "section",
          title: "Backup",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Database", value: String(resource.fields["databaseName"] ?? "—") },
                { key: "Branch", value: String(resource.fields["branchName"] ?? "—") },
                { key: "State", value: state || "—" },
                { key: "Size", value: String(resource.fields["size"] ?? "—") },
                { key: "Protected", value: resource.fields["protected"] === true ? "Yes" : "No" },
                { key: "Required", value: resource.fields["required"] === true ? "Yes" : "No" },
                ...(resource.fields["policyName"]
                  ? [{ key: "Policy", value: String(resource.fields["policyName"]) }]
                  : []),
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") },
                { key: "Started", value: String(resource.fields["startedAt"] ?? "—") },
                { key: "Completed", value: String(resource.fields["completedAt"] ?? "—") },
                { key: "Expires", value: String(resource.fields["expiresAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderWebhookDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const enabled = f["enabled"] !== false;
    const lastOk = f["lastSentSuccess"];
    return {
      title: String(f["url"] ?? resource.displayName),
      subtitle: joinSubtitle("PlanetScale Webhook", f["databaseName"]),
      status: {
        kind: "status-dot",
        status: !enabled ? "info" : lastOk === false ? "error" : "healthy",
      },
      sections: [
        {
          kind: "section",
          title: "Webhook",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "URL", value: String(f["url"] ?? "—"), copyable: true },
                { key: "Enabled", value: enabled ? "Yes" : "No" },
                { key: "Events", value: String(f["events"] ?? "") || "—" },
                {
                  key: "Authorization Header",
                  value: f["authorizationHeaderConfigured"] === true ? "Set" : "Not set",
                },
                { key: "Last Delivery", value: String(f["lastSentAt"] ?? "") || "Never" },
                ...(typeof lastOk === "boolean"
                  ? [{ key: "Last Delivery Result", value: lastOk ? "Succeeded" : "Failed" }]
                  : []),
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Send Test Event",
          action: {
            type: "plugin-action",
            actionId: "test",
            successMessage: "Test event sent.",
          },
        },
      ],
    };
  }
}

/** Built-in roles a PlanetScale Postgres role can inherit (API spec enum, minus Neki-only ones). */
const POSTGRES_INHERITED_ROLES: Array<{ id: string; description: string }> = [
  { id: "pg_read_all_data", description: "Read every table, view and sequence" },
  { id: "pg_write_all_data", description: "Write every table, view and sequence" },
  { id: "pg_monitor", description: "Read monitoring views and functions" },
  { id: "pg_read_all_settings", description: "Read every configuration setting" },
  { id: "pg_read_all_stats", description: "Read every pg_stat_* view" },
  { id: "pg_stat_scan_tables", description: "Run monitoring functions that lock tables" },
  { id: "pg_signal_backend", description: "Cancel or terminate other sessions" },
  { id: "pg_maintain", description: "VACUUM, ANALYZE, REINDEX and similar on any relation" },
  { id: "pg_checkpoint", description: "Run CHECKPOINT" },
  { id: "pg_create_subscription", description: "Create logical replication subscriptions" },
  { id: "pg_use_reserved_connections", description: "Use reserved connection slots" },
  { id: "postgres", description: "Full administrative access (superuser equivalent)" },
];

function enc(s: string): string {
  return encodeURIComponent(s);
}

function branchParts(resourceId: string): [string, string] {
  const externalId = resourceId.split(":").slice(2).join(":");
  const slash = externalId.indexOf("/");
  if (slash <= 0) throw new Error("PlanetScale plugin: cannot parse branch resource id.");
  return [externalId.slice(0, slash), externalId.slice(slash + 1)];
}

/** Single-object responses arrive bare; some older routes wrap them in `{ data }`. */
function unwrap<T>(value: T | { data: T }): T {
  if (value && typeof value === "object" && "data" in value) {
    const inner = (value as { data: unknown }).data;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as T;
  }
  return value as T;
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Policy pickers submit a JSON array; the Edit form submits a comma list. */
function parseEventList(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* fall through to the comma form */
    }
  }
  return splitList(trimmed);
}

function postgresUrl(username: string, password: string, host: string): string {
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:5432/postgres?sslmode=require`;
}

function engineLabel(kind: string): string {
  if (kind === "postgresql") return "Postgres";
  if (kind === "neki") return "Neki (sharded Postgres)";
  return "Vitess";
}

function databaseStatus(state: string): "healthy" | "provisioning" | "degraded" | "error" {
  switch (state) {
    case "ready":
      return "healthy";
    case "pending":
    case "importing":
    case "import_ready":
    case "awaiting_import":
    case "awakening":
      return "provisioning";
    case "sleeping":
    case "sleep_in_progress":
      return "degraded";
    default:
      return "error";
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${units[i]}`;
}

function clusterSizeField(key: string, engine: Engine, options: SelectOption[]) {
  return {
    key,
    label: "Cluster Size",
    kind: "select" as const,
    required: true,
    options,
    ...(options[0] ? { defaultValue: options[0].id } : {}),
    showWhen: { fieldKey: "kind", fieldValue: engine },
  };
}

function safetyField(key: string, label: string) {
  return {
    key,
    label,
    kind: "select" as const,
    required: false,
    description: "Block or warn on statements without a WHERE clause.",
    options: [
      { id: "", label: "Default" },
      { id: "off", label: "Off" },
      { id: "warn", label: "Warn" },
      { id: "on", label: "Block" },
    ],
    defaultValue: "",
  };
}
