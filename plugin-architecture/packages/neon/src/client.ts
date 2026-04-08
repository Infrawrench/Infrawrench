import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";

/**
 * Neon API response types — minimal shapes for the fields we use.
 */
interface NeonProject {
  id: string;
  name: string;
  region_id: string;
  pg_version: number;
  created_at: string;
  updated_at: string;
}

interface NeonBranch {
  id: string;
  project_id: string;
  name: string;
  primary: boolean;
  current_state: string;
  created_at: string;
  updated_at: string;
}

interface NeonEndpoint {
  id: string;
  project_id: string;
  branch_id: string;
  host: string;
  current_state: string;
  type: string;
  autoscaling_limit_min_cu: number;
  autoscaling_limit_max_cu: number;
  suspend_timeout_seconds: number;
  created_at: string;
  updated_at: string;
}

interface NeonDatabase {
  id: number;
  branch_id: string;
  name: string;
  owner_name: string;
  created_at: string;
  updated_at: string;
}

interface NeonRole {
  branch_id: string;
  name: string;
  protected: boolean;
  created_at: string;
  updated_at: string;
}

const NEON_REGIONS: Record<string, { location: string; flag: string }> = {
  "aws-us-east-1":      { location: "Virginia, USA",         flag: "🇺🇸" },
  "aws-us-east-2":      { location: "Ohio, USA",             flag: "🇺🇸" },
  "aws-us-west-2":      { location: "Oregon, USA",           flag: "🇺🇸" },
  "aws-eu-central-1":   { location: "Frankfurt, Germany",    flag: "🇩🇪" },
  "aws-eu-west-1":      { location: "Ireland",               flag: "🇮🇪" },
  "aws-eu-west-2":      { location: "London, UK",            flag: "🇬🇧" },
  "aws-ap-southeast-1": { location: "Singapore",             flag: "🇸🇬" },
  "aws-ap-southeast-2": { location: "Sydney, Australia",     flag: "🇦🇺" },
  "aws-ap-northeast-1": { location: "Tokyo, Japan",          flag: "🇯🇵" },
  "aws-sa-east-1":      { location: "São Paulo, Brazil",     flag: "🇧🇷" },
  "azure-eastus2":      { location: "East US 2 (Azure)",     flag: "🇺🇸" },
  "azure-westeurope":   { location: "West Europe (Azure)",   flag: "🇪🇺" },
};

/**
 * Neon plugin client.
 * Manages Neon serverless Postgres projects, branches, endpoints, databases, and roles
 * via the Neon public API (https://console.neon.tech/api/v2).
 */
export class NeonClient implements PluginClient {
  private readonly apiKey: string;
  private readonly baseUrl = "https://console.neon.tech/api/v2";

  constructor(credentials: Record<string, string>, _services?: HostServices) {
    const key = credentials["apiKey"];
    if (!key) throw new Error("Neon plugin: missing apiKey credential");
    this.apiKey = key;
  }

  // ─── API helper ─────────────────────────────────────────────────────────────

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Neon API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  // ─── PluginClient: core ─────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "neon-project":
        return this.listProjects(accountId);
      case "neon-branch":
        return this.listAllBranches(accountId);
      case "neon-endpoint":
        return this.listAllEndpoints(accountId);
      case "neon-database":
        return this.listAllDatabases(accountId);
      case "neon-role":
        return this.listAllRoles(accountId);
      default:
        throw new Error(`Neon plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Neon plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "neon-project") {
      if (outputKey === "connectionString") {
        return this.resolveProjectConnectionString(resourceId, accountId);
      }
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "projectId") return String(resource.externalId ?? "");
      if (outputKey === "region") return String(resource.fields["region"] ?? "");
      if (outputKey === "pgVersion") return String(resource.fields["pgVersion"] ?? "");
    }

    if (typeId === "neon-branch") {
      if (outputKey === "connectionString") {
        return this.resolveBranchConnectionString(resourceId, accountId);
      }
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "branchId") return String(resource.externalId ?? "");
      if (outputKey === "projectId") return String(resource.fields["projectId"] ?? "");
    }

    if (typeId === "neon-endpoint") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "host") return String(resource.fields["host"] ?? "");
      if (outputKey === "endpointId") return String(resource.externalId ?? "");
    }

    if (typeId === "neon-database") {
      if (outputKey === "connectionString") {
        return this.resolveDatabaseConnectionString(resourceId, accountId);
      }
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "host") return String(resource.fields["host"] ?? "");
      if (outputKey === "database") return String(resource.fields["name"] ?? "");
    }

    if (typeId === "neon-role") {
      if (outputKey === "password") {
        return this.resolveRolePassword(resourceId, accountId);
      }
    }

    throw new Error(`Neon plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // ─── PluginClient: views ────────────────────────────────────────────────────

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "neon-project":
        return this.renderProjectDetail(resource);
      case "neon-branch":
        return this.renderBranchDetail(resource);
      case "neon-endpoint":
        return this.renderEndpointDetail(resource);
      case "neon-database":
        return this.renderDatabaseDetail(resource);
      case "neon-role":
        return this.renderRoleDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const stateField = resource.fields["currentState"];
    const status = typeof stateField === "string"
      ? mapNeonState(stateField)
      : "unknown" as const;

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  // ─── PluginClient: create ───────────────────────────────────────────────────

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "neon-project") {
      const regions = Object.entries(NEON_REGIONS).map(([id, info]) => ({
        id,
        label: id,
        location: info.location,
        flag: info.flag,
      }));

      return {
        fields: [
          { key: "name", label: "Project Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            defaultValue: "aws-us-east-2",
          },
          {
            key: "pgVersion",
            label: "PostgreSQL Version",
            kind: "select",
            required: true,
            options: [
              { id: "17", label: "PostgreSQL 17" },
              { id: "16", label: "PostgreSQL 16" },
              { id: "15", label: "PostgreSQL 15" },
              { id: "14", label: "PostgreSQL 14" },
            ],
            defaultValue: "17",
          },
        ],
      };
    }

    if (typeId === "neon-branch") {
      // List projects so the user can pick which one to branch from
      const projects = await this.fetch<{ projects: NeonProject[] }>("/projects");
      const projectOptions = projects.projects.map((p) => ({
        id: p.id,
        label: p.name,
      }));

      return {
        fields: [
          {
            key: "projectId",
            label: "Project",
            kind: "select",
            required: true,
            options: projectOptions,
            ...(projectOptions[0] ? { defaultValue: projectOptions[0].id } : {}),
          },
          { key: "name", label: "Branch Name", kind: "text", required: true },
        ],
      };
    }

    if (typeId === "neon-database") {
      // List projects so the user can pick project → branch → create database
      const projects = await this.fetch<{ projects: NeonProject[] }>("/projects");
      const projectOptions = projects.projects.map((p) => ({
        id: p.id,
        label: p.name,
      }));

      // Pre-fetch branches for the first project if available
      let branchOptions: Array<{ id: string; label: string }> = [];
      if (projectOptions[0]) {
        const branches = await this.fetch<{ branches: NeonBranch[] }>(
          `/projects/${projectOptions[0].id}/branches`,
        );
        branchOptions = branches.branches.map((b) => ({
          id: b.id,
          label: `${b.name}${b.primary ? " (primary)" : ""}`,
        }));
      }

      // List roles from the first branch for the owner field
      let roleOptions: Array<{ id: string; label: string }> = [];
      if (projectOptions[0] && branchOptions[0]) {
        try {
          const roles = await this.fetch<{ roles: NeonRole[] }>(
            `/projects/${projectOptions[0].id}/branches/${branchOptions[0].id}/roles`,
          );
          roleOptions = roles.roles.map((r) => ({ id: r.name, label: r.name }));
        } catch {
          /* some branches may not have roles accessible */
        }
      }

      return {
        fields: [
          {
            key: "projectId",
            label: "Project",
            kind: "select",
            required: true,
            options: projectOptions,
            ...(projectOptions[0] ? { defaultValue: projectOptions[0].id } : {}),
          },
          {
            key: "branchId",
            label: "Branch",
            kind: "select",
            required: true,
            options: branchOptions,
            ...(branchOptions[0] ? { defaultValue: branchOptions[0].id } : {}),
          },
          { key: "name", label: "Database Name", kind: "text", required: true },
          {
            key: "ownerName",
            label: "Owner Role",
            kind: "select",
            required: true,
            options: roleOptions.length > 0 ? roleOptions : [{ id: "neondb_owner", label: "neondb_owner" }],
            defaultValue: roleOptions[0]?.id ?? "neondb_owner",
          },
        ],
      };
    }

    throw new Error(`Neon plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "neon-project") {
      const data = await this.fetch<{ project: NeonProject }>("/projects", {
        method: "POST",
        body: JSON.stringify({
          project: {
            name: fields["name"],
            region_id: fields["region"],
            pg_version: Number(fields["pgVersion"] ?? 17),
          },
        }),
      });
      const p = data.project;
      return {
        id: `${accountId}:neon-project:${p.id}`,
        pluginId: "neon",
        resourceTypeId: "neon-project",
        accountId,
        displayName: p.name,
        fields: {
          name: p.name,
          region: p.region_id,
          pgVersion: String(p.pg_version),
          createdAt: p.created_at,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: p.id,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      };
    }

    if (typeId === "neon-branch") {
      const projectId = fields["projectId"];
      if (!projectId) throw new Error("Neon plugin: projectId is required to create a branch");

      const data = await this.fetch<{ branch: NeonBranch }>(
        `/projects/${projectId}/branches`,
        {
          method: "POST",
          body: JSON.stringify({
            branch: { name: fields["name"] },
            endpoints: [{ type: "read_write" }],
          }),
        },
      );
      const b = data.branch;
      return {
        id: `${accountId}:neon-branch:${projectId}/${b.id}`,
        pluginId: "neon",
        resourceTypeId: "neon-branch",
        accountId,
        displayName: b.name,
        fields: {
          name: b.name,
          projectId: b.project_id,
          primary: b.primary,
          currentState: b.current_state,
          createdAt: b.created_at,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: b.id,
        parentResourceId: `${accountId}:neon-project:${projectId}`,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
      };
    }

    if (typeId === "neon-database") {
      const projectId = fields["projectId"];
      const branchId = fields["branchId"];
      if (!projectId || !branchId)
        throw new Error("Neon plugin: projectId and branchId are required to create a database");

      const data = await this.fetch<{ database: NeonDatabase }>(
        `/projects/${projectId}/branches/${branchId}/databases`,
        {
          method: "POST",
          body: JSON.stringify({
            database: {
              name: fields["name"],
              owner_name: fields["ownerName"] ?? "neondb_owner",
            },
          }),
        },
      );
      const db = data.database;
      return {
        id: `${accountId}:neon-database:${projectId}/${branchId}/${db.name}`,
        pluginId: "neon",
        resourceTypeId: "neon-database",
        accountId,
        displayName: db.name,
        fields: {
          name: db.name,
          projectId,
          branchId: db.branch_id,
          ownerName: db.owner_name,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: String(db.id),
        parentResourceId: `${accountId}:neon-branch:${projectId}/${branchId}`,
        createdAt: db.created_at,
        updatedAt: db.updated_at,
      };
    }

    throw new Error(`Neon plugin: createResource not supported for type "${typeId}"`);
  }

  // ─── PluginClient: delete ───────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId === "neon-project") {
      const projectId = resourceId.split(":").pop();
      if (!projectId) throw new Error("Neon plugin: cannot parse project ID");
      await this.fetch<unknown>(`/projects/${projectId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "neon-branch") {
      // externalId format: branchId, resource ID format: {accountId}:neon-branch:{projectId}/{branchId}
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Neon plugin: cannot parse branch ID");
      const [projectId, branchId] = compound.split("/");
      if (!projectId || !branchId) throw new Error("Neon plugin: cannot parse branch ID");
      await this.fetch<unknown>(`/projects/${projectId}/branches/${branchId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "neon-database") {
      // resource ID format: {accountId}:neon-database:{projectId}/{branchId}/{dbName}
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Neon plugin: cannot parse database ID");
      const parts = compound.split("/");
      if (parts.length < 3) throw new Error("Neon plugin: cannot parse database ID");
      const [projectId, branchId, ...dbParts] = parts;
      const dbName = dbParts.join("/");
      await this.fetch<unknown>(
        `/projects/${projectId}/branches/${branchId}/databases/${encodeURIComponent(dbName)}`,
        { method: "DELETE" },
      );
      return;
    }

    throw new Error(`Neon plugin: deleteResource not supported for type "${typeId}"`);
  }

  // ─── Private: list helpers ──────────────────────────────────────────────────

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ projects: NeonProject[] }>("/projects");
    return data.projects.map((p) => ({
      id: `${accountId}:neon-project:${p.id}`,
      pluginId: "neon",
      resourceTypeId: "neon-project",
      accountId,
      displayName: p.name,
      fields: {
        name: p.name,
        region: p.region_id,
        pgVersion: String(p.pg_version),
        createdAt: p.created_at,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: p.id,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }));
  }

  private async listAllBranches(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.fetch<{ projects: NeonProject[] }>("/projects");
    const results: ResourceInstance[] = [];
    for (const p of projects.projects) {
      try {
        const data = await this.fetch<{ branches: NeonBranch[] }>(
          `/projects/${p.id}/branches`,
        );
        for (const b of data.branches) {
          results.push({
            id: `${accountId}:neon-branch:${p.id}/${b.id}`,
            pluginId: "neon",
            resourceTypeId: "neon-branch",
            accountId,
            displayName: b.name,
            fields: {
              name: b.name,
              projectId: b.project_id,
              primary: b.primary,
              currentState: b.current_state,
              createdAt: b.created_at,
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: b.id,
            parentResourceId: `${accountId}:neon-project:${p.id}`,
            createdAt: b.created_at,
            updatedAt: b.updated_at,
          });
        }
      } catch {
        /* skip projects we can't read branches for */
      }
    }
    return results;
  }

  private async listAllEndpoints(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.fetch<{ projects: NeonProject[] }>("/projects");
    const results: ResourceInstance[] = [];
    for (const p of projects.projects) {
      try {
        const data = await this.fetch<{ endpoints: NeonEndpoint[] }>(
          `/projects/${p.id}/endpoints`,
        );
        for (const ep of data.endpoints) {
          results.push({
            id: `${accountId}:neon-endpoint:${p.id}/${ep.id}`,
            pluginId: "neon",
            resourceTypeId: "neon-endpoint",
            accountId,
            displayName: ep.host,
            fields: {
              host: ep.host,
              projectId: ep.project_id,
              branchId: ep.branch_id,
              currentState: ep.current_state,
              type: ep.type,
              autoscalingMinCu: String(ep.autoscaling_limit_min_cu),
              autoscalingMaxCu: String(ep.autoscaling_limit_max_cu),
              suspendTimeout: String(ep.suspend_timeout_seconds),
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: ep.id,
            parentResourceId: `${accountId}:neon-branch:${p.id}/${ep.branch_id}`,
            createdAt: ep.created_at,
            updatedAt: ep.updated_at,
          });
        }
      } catch {
        /* skip */
      }
    }
    return results;
  }

  private async listAllDatabases(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.fetch<{ projects: NeonProject[] }>("/projects");
    const results: ResourceInstance[] = [];
    for (const p of projects.projects) {
      try {
        const branchData = await this.fetch<{ branches: NeonBranch[] }>(
          `/projects/${p.id}/branches`,
        );
        for (const b of branchData.branches) {
          try {
            const dbData = await this.fetch<{ databases: NeonDatabase[] }>(
              `/projects/${p.id}/branches/${b.id}/databases`,
            );
            for (const db of dbData.databases) {
              results.push({
                id: `${accountId}:neon-database:${p.id}/${b.id}/${db.name}`,
                pluginId: "neon",
                resourceTypeId: "neon-database",
                accountId,
                displayName: db.name,
                fields: {
                  name: db.name,
                  projectId: p.id,
                  branchId: b.id,
                  ownerName: db.owner_name,
                },
                resolvedOutputs: {},
                secretStates: [],
                externalId: String(db.id),
                parentResourceId: `${accountId}:neon-branch:${p.id}/${b.id}`,
                createdAt: db.created_at,
                updatedAt: db.updated_at,
              });
            }
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip */
      }
    }
    return results;
  }

  private async listAllRoles(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.fetch<{ projects: NeonProject[] }>("/projects");
    const results: ResourceInstance[] = [];
    for (const p of projects.projects) {
      try {
        const branchData = await this.fetch<{ branches: NeonBranch[] }>(
          `/projects/${p.id}/branches`,
        );
        for (const b of branchData.branches) {
          try {
            const roleData = await this.fetch<{ roles: NeonRole[] }>(
              `/projects/${p.id}/branches/${b.id}/roles`,
            );
            for (const r of roleData.roles) {
              results.push({
                id: `${accountId}:neon-role:${p.id}/${b.id}/${r.name}`,
                pluginId: "neon",
                resourceTypeId: "neon-role",
                accountId,
                displayName: r.name,
                fields: {
                  name: r.name,
                  projectId: p.id,
                  branchId: b.id,
                  protected: r.protected,
                },
                resolvedOutputs: {},
                secretStates: [],
                externalId: r.name,
                parentResourceId: `${accountId}:neon-branch:${p.id}/${b.id}`,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
              });
            }
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip */
      }
    }
    return results;
  }

  // ─── Private: resolve helpers ───────────────────────────────────────────────

  private async resolveDatabaseConnectionString(
    resourceId: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource("neon-database", resourceId, accountId);
    const projectId = String(resource.fields["projectId"] ?? "");
    const branchId = String(resource.fields["branchId"] ?? "");
    const dbName = String(resource.fields["name"] ?? "");

    // Get the role name for this database
    const roleName = String(resource.fields["ownerName"] ?? "neondb_owner");

    // Neon provides a connection_uri endpoint
    const data = await this.fetch<{ uri: string }>(
      `/projects/${projectId}/connection_uri?branch_id=${encodeURIComponent(branchId)}&database_name=${encodeURIComponent(dbName)}&role_name=${encodeURIComponent(roleName)}`,
    );
    return data.uri;
  }

  /**
   * Resolve a connection string for a project by finding the primary branch's
   * default database and returning its connection URI.
   */
  private async resolveProjectConnectionString(
    resourceId: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource("neon-project", resourceId, accountId);
    const projectId = String(resource.externalId ?? "");

    // Find the primary branch
    const branchData = await this.fetch<{ branches: NeonBranch[] }>(
      `/projects/${projectId}/branches`,
    );
    const primary = branchData.branches.find((b) => b.primary) ?? branchData.branches[0];
    if (!primary) throw new Error("Neon plugin: no branches found on project");

    // Find the first database on that branch
    const dbData = await this.fetch<{ databases: NeonDatabase[] }>(
      `/projects/${projectId}/branches/${primary.id}/databases`,
    );
    const db = dbData.databases[0];
    if (!db) throw new Error("Neon plugin: no databases found on primary branch");

    // Get a connection URI via Neon's connection_uri endpoint
    const data = await this.fetch<{ uri: string }>(
      `/projects/${projectId}/connection_uri?branch_id=${encodeURIComponent(primary.id)}&database_name=${encodeURIComponent(db.name)}&role_name=${encodeURIComponent(db.owner_name)}`,
    );
    return data.uri;
  }

  /**
   * Resolve a connection string for a branch by finding the first database
   * on that branch and returning its connection URI.
   */
  private async resolveBranchConnectionString(
    resourceId: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource("neon-branch", resourceId, accountId);
    const projectId = String(resource.fields["projectId"] ?? "");
    const branchId = String(resource.externalId ?? "");

    // Find the first database on this branch
    const dbData = await this.fetch<{ databases: NeonDatabase[] }>(
      `/projects/${projectId}/branches/${branchId}/databases`,
    );
    const db = dbData.databases[0];
    if (!db) throw new Error("Neon plugin: no databases found on this branch");

    // Get a connection URI via Neon's connection_uri endpoint
    const data = await this.fetch<{ uri: string }>(
      `/projects/${projectId}/connection_uri?branch_id=${encodeURIComponent(branchId)}&database_name=${encodeURIComponent(db.name)}&role_name=${encodeURIComponent(db.owner_name)}`,
    );
    return data.uri;
  }

  private async resolveRolePassword(
    resourceId: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource("neon-role", resourceId, accountId);
    const projectId = String(resource.fields["projectId"] ?? "");
    const branchId = String(resource.fields["branchId"] ?? "");
    const roleName = String(resource.fields["name"] ?? "");

    const data = await this.fetch<{ password: string }>(
      `/projects/${projectId}/branches/${branchId}/roles/${encodeURIComponent(roleName)}/reveal_password`,
    );
    return data.password;
  }

  // ─── Private: detail renderers ──────────────────────────────────────────────

  private renderProjectDetail(resource: ResourceInstance): DetailViewSchema {
    const regionId = String(resource.fields["region"] ?? "");
    const regionInfo = NEON_REGIONS[regionId];
    const regionLabel = regionInfo
      ? `${regionInfo.flag} ${regionInfo.location} (${regionId})`
      : regionId;

    return {
      title: resource.displayName,
      subtitle: `Neon Project · ${regionLabel}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Project Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Project ID", value: String(resource.externalId ?? "—") },
                { key: "Region", value: regionLabel },
                { key: "PostgreSQL Version", value: String(resource.fields["pgVersion"] ?? "—") },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Open in Neon Console",
          action: {
            type: "open-url",
            url: `https://console.neon.tech/app/projects/${String(resource.externalId ?? "")}`,
          },
        },
      ],
    };
  }

  private renderBranchDetail(resource: ResourceInstance): DetailViewSchema {
    const isPrimary = resource.fields["primary"] === true;
    const state = String(resource.fields["currentState"] ?? "unknown");

    return {
      title: resource.displayName,
      subtitle: `Branch${isPrimary ? " (primary)" : ""} · ${state}`,
      status: { kind: "status-dot", status: mapNeonState(state) },
      sections: [
        {
          kind: "section",
          title: "Branch Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Branch ID", value: String(resource.externalId ?? "—") },
                { key: "Project ID", value: String(resource.fields["projectId"] ?? "—") },
                { key: "Primary", value: isPrimary ? "Yes" : "No" },
                { key: "State", value: state },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderEndpointDetail(resource: ResourceInstance): DetailViewSchema {
    const state = String(resource.fields["currentState"] ?? "unknown");
    const minCu = String(resource.fields["autoscalingMinCu"] ?? "—");
    const maxCu = String(resource.fields["autoscalingMaxCu"] ?? "—");
    const suspendTimeout = String(resource.fields["suspendTimeout"] ?? "—");

    return {
      title: String(resource.fields["host"] ?? resource.displayName),
      subtitle: `Endpoint · ${state}`,
      status: { kind: "status-dot", status: mapNeonState(state) },
      sections: [
        {
          kind: "section",
          title: "Endpoint Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Host", value: String(resource.fields["host"] ?? "—"), copyable: true },
                { key: "Endpoint ID", value: String(resource.externalId ?? "—") },
                { key: "Type", value: String(resource.fields["type"] ?? "—") },
                { key: "State", value: state },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Autoscaling",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Min Compute Units", value: minCu },
                { key: "Max Compute Units", value: maxCu },
                { key: "Suspend Timeout", value: suspendTimeout === "—" ? "—" : `${suspendTimeout}s` },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderDatabaseDetail(resource: ResourceInstance): DetailViewSchema {
    const cs = resource.secretStates.find((s) => s.fieldKey === "connectionString");

    return {
      title: resource.displayName,
      subtitle: `Database · ${String(resource.fields["ownerName"] ?? "")}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Database Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(resource.fields["name"] ?? "—") },
                { key: "Owner", value: String(resource.fields["ownerName"] ?? "—") },
                { key: "Project ID", value: String(resource.fields["projectId"] ?? "—") },
                { key: "Branch ID", value: String(resource.fields["branchId"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Connection",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Connection String",
                  value: cs
                    ? { kind: "secret-placeholder", fieldKey: "connectionString", resolution: cs.resolution }
                    : "(resolve via output)",
                  sensitive: true,
                },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderRoleDetail(resource: ResourceInstance): DetailViewSchema {
    const isProtected = resource.fields["protected"] === true;

    return {
      title: resource.displayName,
      subtitle: `Role${isProtected ? " (protected)" : ""}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Role Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(resource.fields["name"] ?? "—") },
                { key: "Protected", value: isProtected ? "Yes" : "No" },
                { key: "Project ID", value: String(resource.fields["projectId"] ?? "—") },
                { key: "Branch ID", value: String(resource.fields["branchId"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: resource.resourceTypeId,
      status: { kind: "status-dot", status: "unknown" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(resource.fields).map(([key, value]) => ({
                key,
                value: String(value),
              })),
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapNeonState(
  state: string,
): "healthy" | "degraded" | "error" | "unknown" | "provisioning" {
  switch (state.toLowerCase()) {
    case "active":
    case "ready":
      return "healthy";
    case "idle":
      return "healthy";
    case "init":
    case "starting":
      return "provisioning";
    case "stopping":
      return "degraded";
    case "stopped":
      return "unknown";
    case "error":
    case "failed":
      return "error";
    default:
      return "unknown";
  }
}
