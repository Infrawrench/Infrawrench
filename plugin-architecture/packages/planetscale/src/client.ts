import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  DashboardStat,
} from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

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

interface PsDeployRequest {
  id: string;
  number: number;
  branch: string;
  into_branch: string;
  approved: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  deployed_at?: string;
  deployment?: {
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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "ps-database":
        return this.listDatabases(accountId);
      case "ps-branch":
        return this.listAllBranches(accountId);
      case "ps-password":
        return this.listAllPasswords(accountId);
      case "ps-deploy-request":
        return this.listAllDeployRequests(accountId);
      case "ps-backup":
        return this.listAllBackups(accountId);
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

    if (typeId === "ps-password") {
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
      if (outputKey === "backupId") return String(resource.externalId ?? "");
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
      case "ps-deploy-request":
        return this.renderDeployRequestDetail(resource);
      case "ps-backup":
        return this.renderBackupDetail(resource);
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
      status: { kind: "status-dot", status: "info" },
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
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
        ],
      };
    }

    throw new Error(`PlanetScale plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    if (typeId === "ps-database") {
      return this.createDatabase(accountId, fields);
    }
    if (typeId === "ps-branch") {
      return this.createBranch(accountId, fields, parentResourceId);
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

    if (typeId === "ps-password") {
      const { databaseName, branchName, passwordId } =
        PlanetScaleClient.parsePasswordId(resourceId);
      await this.fetch(
        `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/branches/${enc(branchName)}/passwords/${enc(passwordId)}`,
        { method: "DELETE" },
      );
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
      if (fields["cidrs"] !== undefined) {
        body["cidrs"] = fields["cidrs"]
          .split(",")
          .map((cidr) => cidr.trim())
          .filter(Boolean);
      }

      const data = await this.fetch<{ data: PsPassword }>(
        `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/branches/${enc(branchName)}/passwords/${enc(passwordId)}`,
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

      await this.fetch<{ data: PsDeployRequest }>(
        `/organizations/${enc(this.orgName)}/databases/${enc(sourceDb)}/deploy-requests`,
        {
          method: "POST",
          body: JSON.stringify({
            branch: sourceBranch,
            into_branch: targetBranch,
            notes: "Created by Infrawrench resource association.",
          }),
        },
      );
      return;
    }

    throw new Error(
      `PlanetScale plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
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

  private async listAllPasswords(accountId: string): Promise<ResourceInstance[]> {
    const branches = await this.listAllBranches(accountId);
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
      `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/branches/${enc(branchName)}/passwords`,
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
      `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/deploy-requests`,
    );
    return data.data ?? [];
  }

  private toDeployRequestResource(
    request: PsDeployRequest,
    databaseName: string,
    accountId: string,
    now: string,
  ): ResourceInstance {
    const state = request.deployed_at ? "deployed" : request.closed_at ? "closed" : "open";

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
      `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/branches/${enc(branchName)}/backups`,
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
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const dbName = fields["databaseName"] ?? parentExternalId;
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

    const data = await this.fetch<{ data: PsPassword }>(
      `/organizations/${enc(this.orgName)}/databases/${enc(dbName)}/branches/${enc(branchName)}/passwords`,
      {
        method: "POST",
        body: JSON.stringify({ name: `infrawrench-${Date.now()}` }),
      },
    );

    const pw = data.data;
    const user = encodeURIComponent(pw.username);
    const pass = encodeURIComponent(pw.plain_text ?? "");
    const host = pw.access_host_url;

    return `mysql://${user}:${pass}@${host}/${dbName}`;
  }

  async renewPassword(resourceId: string, accountId: string): Promise<ResourceInstance> {
    const { databaseName, branchName, passwordId } = PlanetScaleClient.parsePasswordId(resourceId);
    const data = await this.fetch<{ data: PsPassword }>(
      `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/branches/${enc(branchName)}/passwords/${enc(passwordId)}/renew`,
      { method: "POST" },
    );
    return this.toPasswordResource(
      data.data,
      databaseName,
      branchName,
      accountId,
      new Date().toISOString(),
    );
  }

  async promoteBranch(resourceId: string): Promise<void> {
    const { databaseName, branchName } = PlanetScaleClient.parseBranchId(resourceId);
    await this.fetch(
      `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/branches/${enc(branchName)}/promote`,
      { method: "POST" },
    );
  }

  async closeDeployRequest(resourceId: string): Promise<void> {
    const { databaseName, number } = PlanetScaleClient.parseDeployRequestId(resourceId);
    await this.fetch(
      `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/deploy-requests/${enc(number)}`,
      { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
    );
  }

  async applyDeployRequest(resourceId: string): Promise<void> {
    const { databaseName, number } = PlanetScaleClient.parseDeployRequestId(resourceId);
    await this.fetch(
      `/organizations/${enc(this.orgName)}/databases/${enc(databaseName)}/deploy-requests/${enc(number)}/apply-deploy`,
      { method: "POST" },
    );
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

  private renderPasswordDetail(resource: ResourceInstance): DetailViewSchema {
    const expired = resource.fields["expired"] === true;
    return {
      title: resource.displayName,
      subtitle: `PlanetScale Password · ${String(resource.fields["databaseName"] ?? "")}/${String(resource.fields["branchName"] ?? "")}`,
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
                { key: "Expired", value: expired ? "Yes" : "No" },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") },
                { key: "Last Used", value: String(resource.fields["lastUsedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDeployRequestDetail(resource: ResourceInstance): DetailViewSchema {
    const state = String(resource.fields["state"] ?? "open");
    return {
      title: resource.displayName,
      subtitle: `PlanetScale Deploy Request · ${String(resource.fields["databaseName"] ?? "")}`,
      status: {
        kind: "status-dot",
        status: state === "deployed" ? "healthy" : state === "closed" ? "degraded" : "info",
      },
      sections: [
        {
          kind: "section",
          title: "Deploy Request",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Number", value: String(resource.fields["number"] ?? "—") },
                { key: "Database", value: String(resource.fields["databaseName"] ?? "—") },
                { key: "Branch", value: String(resource.fields["branch"] ?? "—") },
                { key: "Into Branch", value: String(resource.fields["intoBranch"] ?? "—") },
                { key: "State", value: state },
                { key: "Approved", value: resource.fields["approved"] === true ? "Yes" : "No" },
                { key: "Deployable", value: resource.fields["deployable"] === true ? "Yes" : "No" },
                { key: "Operations", value: String(resource.fields["deployOperationCount"] ?? 0) },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") },
                { key: "Deployed", value: String(resource.fields["deployedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderBackupDetail(resource: ResourceInstance): DetailViewSchema {
    const state = String(resource.fields["state"] ?? "");
    return {
      title: resource.displayName,
      subtitle: `PlanetScale Backup · ${String(resource.fields["databaseName"] ?? "")}/${String(resource.fields["branchName"] ?? "")}`,
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
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
