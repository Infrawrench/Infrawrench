import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  ResourceStatus,
  DashboardStat,
  MetricSeries,
  StorageObject,
  CostFetchRange,
  CostRow,
} from "@infrawrench/plugin-base";
import {
  createApiClient,
  type Api,
  type Branch,
  type Database,
  type DataAPIReponse,
  type ProjectListItem,
  type Role,
  ConsumptionHistoryGranularity,
  EndpointType,
  BucketAccessLevel,
  CredentialScope,
  NeonAuthOauthProviderId,
  NeonAuthSupportedAuthProvider,
} from "@neondatabase/api-client";
import { fetchNeonCostData } from "./cost-data.js";
import { parseBranchExternalId, externalIdOf, type BranchRef } from "./services/common.js";
import {
  listAllSnapshots,
  createSnapshot as createSnapshotResource,
  restoreSnapshot,
} from "./services/snapshots.js";
import {
  BucketLocator,
  buildBucketResource,
  buildCredentialResource,
  deleteBucketObject,
  fetchBranchStorage,
  listAllBuckets,
  listAllCredentials,
  listBucketObjects,
  locateBucket,
  uploadBucketObject,
} from "./services/storage.js";
import { listAllAiGateways, listAllFunctions } from "./services/functions.js";
import {
  buildAuthResource,
  buildDomainResource,
  buildOauthProviderResource,
  fetchAuthSnapshot,
  listAllAuth,
  listAllAuthDomains,
  listAllOauthProviders,
} from "./services/auth.js";

const NEON_REGIONS: Record<string, { location: string; flag: string }> = {
  "aws-us-east-1": { location: "Virginia, USA", flag: "🇺🇸" },
  "aws-us-east-2": { location: "Ohio, USA", flag: "🇺🇸" },
  "aws-us-west-2": { location: "Oregon, USA", flag: "🇺🇸" },
  "aws-eu-central-1": { location: "Frankfurt, Germany", flag: "🇩🇪" },
  "aws-eu-west-1": { location: "Ireland", flag: "🇮🇪" },
  "aws-eu-west-2": { location: "London, UK", flag: "🇬🇧" },
  "aws-ap-southeast-1": { location: "Singapore", flag: "🇸🇬" },
  "aws-ap-southeast-2": { location: "Sydney, Australia", flag: "🇦🇺" },
  "aws-ap-northeast-1": { location: "Tokyo, Japan", flag: "🇯🇵" },
  "aws-sa-east-1": { location: "São Paulo, Brazil", flag: "🇧🇷" },
  "azure-eastus2": { location: "East US 2 (Azure)", flag: "🇺🇸" },
  "azure-westeurope": { location: "West Europe (Azure)", flag: "🇪🇺" },
};

/**
 * `fetchMetricSeries` asks Neon's consumption API for the last 24 hours when
 * the host does not pass a range, so that is what the chart's time-range label
 * has to say.
 */
const NEON_METRICS = { defaultTimeRangeMs: 24 * 3_600_000 };

/**
 * Neon's credential scopes are fine-grained, but users pick a job to do rather
 * than a scope list — so the create form offers bundles and we expand them here.
 */
const SCOPE_BUNDLES: Array<{ id: string; label: string; scopes: CredentialScope[] }> = [
  {
    id: "storage-rw",
    label: "Object Storage — read & write",
    scopes: [CredentialScope.StorageRead, CredentialScope.StorageWrite],
  },
  {
    id: "storage-ro",
    label: "Object Storage — read only",
    scopes: [CredentialScope.StorageRead],
  },
  {
    id: "ai-gateway",
    label: "AI Gateway — invoke models",
    scopes: [CredentialScope.AiGatewayInvoke],
  },
  {
    id: "functions",
    label: "Functions — invoke",
    scopes: [CredentialScope.FunctionsInvoke],
  },
  {
    id: "all",
    label: "All branch services",
    scopes: [
      CredentialScope.StorageRead,
      CredentialScope.StorageWrite,
      CredentialScope.AiGatewayInvoke,
      CredentialScope.FunctionsInvoke,
    ],
  },
];

/**
 * Neon plugin client.
 * Manages Neon serverless Postgres projects, branches, endpoints, databases, and roles
 * via the official Neon control-plane SDK (@neondatabase/api-client).
 */
export class NeonClient implements PluginClient {
  private readonly api: Api<unknown>;
  /** Maps bucket name → branch, since the host's storage browser passes only a name. */
  private readonly bucketLocator = new BucketLocator();

  constructor(credentials: Record<string, string>, _services?: HostServices) {
    const key = credentials["apiKey"];
    if (!key) throw new Error("Neon plugin: missing apiKey credential");
    this.api = createApiClient({ apiKey: key });
  }

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
      case "neon-data-api":
        return this.listAllDataApis(accountId);
      case "neon-snapshot":
        return listAllSnapshots(this.api, accountId, await this.fetchAllProjects());
      case "neon-bucket":
        return listAllBuckets(
          this.api,
          accountId,
          await this.fetchAllProjects(),
          this.bucketLocator,
        );
      case "neon-credential":
        return listAllCredentials(this.api, accountId, await this.fetchAllProjects());
      case "neon-function":
        return listAllFunctions(this.api, accountId, await this.fetchAllProjects());
      case "neon-ai-gateway":
        return listAllAiGateways(this.api, accountId, await this.fetchAllProjects());
      case "neon-auth":
        return listAllAuth(this.api, accountId, await this.fetchAllProjects());
      case "neon-auth-oauth-provider":
        return listAllOauthProviders(this.api, accountId, await this.fetchAllProjects());
      case "neon-auth-domain":
        return listAllAuthDomains(this.api, accountId, await this.fetchAllProjects());
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

    if (typeId === "neon-data-api") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "url") return String(resource.fields["url"] ?? "");
    }

    if (
      typeId === "neon-credential" &&
      (outputKey === "apiToken" || outputKey === "s3SecretAccessKey")
    ) {
      // Neon returns the token and S3 secret only in the create response and has
      // no endpoint to read them back, so there is nothing to resolve later.
      throw new Error(
        "Neon plugin: credential secrets are shown only once, when the credential is created. Create a new credential to get fresh values.",
      );
    }

    // The remaining new types resolve straight from values captured at list time.
    if (
      typeId === "neon-snapshot" ||
      typeId === "neon-bucket" ||
      typeId === "neon-credential" ||
      typeId === "neon-function" ||
      typeId === "neon-ai-gateway" ||
      typeId === "neon-auth"
    ) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const value = resource.resolvedOutputs[outputKey];
      if (typeof value === "string" && value) return value;
    }

    throw new Error(`Neon plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "neon-project": {
        const regionInfo = NEON_REGIONS[String(f["region"] ?? "")];
        return [
          {
            label: "Region",
            value: regionInfo
              ? `${regionInfo.flag} ${String(f["region"])}`
              : String(f["region"] ?? ""),
          },
          { label: "PG Version", value: String(f["pgVersion"] ?? "") },
        ];
      }
      case "neon-endpoint": {
        const state = String(f["currentState"] ?? "unknown");
        const variant =
          state === "active" ? "status-healthy" : state === "idle" ? "status-degraded" : "default";
        return [
          { label: "State", value: state, variant },
          { label: "Type", value: String(f["type"] ?? "") },
          {
            label: "Compute",
            value: `${String(f["autoscalingMinCu"])}–${String(f["autoscalingMaxCu"])} CU`,
          },
        ];
      }
      case "neon-branch": {
        const state = String(f["currentState"] ?? "unknown");
        const variant = state === "ready" ? "status-healthy" : "status-degraded";
        return [
          { label: "State", value: state, variant },
          ...(f["primary"] ? [{ label: "Primary", value: "Yes" }] : []),
        ];
      }
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    // Neon metrics are project-scoped — resolve the project ID
    let projectId: string;
    if (resourceTypeId === "neon-project") {
      projectId = resourceId.split(":").pop() ?? "";
    } else {
      // For branches/endpoints/databases, extract project ID from the resource
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      projectId = String(resource.fields["projectId"] ?? resourceId.split(":")[2] ?? "");
    }
    if (!projectId) return [];

    const now = Date.now();
    const startMs = timeRange?.startMs ?? now - 24 * 3_600_000; // last 24h
    const endMs = timeRange?.endMs ?? now;
    const from = new Date(startMs).toISOString();
    const to = new Date(endMs).toISOString();

    try {
      const resp = await this.api.getConsumptionHistoryPerProject({
        project_ids: [projectId],
        from,
        to,
        granularity: ConsumptionHistoryGranularity.Hourly,
      });
      const projectEntry = (resp.data.projects ?? []).find((p) => p.project_id === projectId);
      const periods = projectEntry?.periods ?? [];
      if (periods.length === 0) return [];

      // Flatten timeframes across all returned periods.
      const timeframes = periods.flatMap((p) => p.consumption ?? []);
      if (timeframes.length === 0) return [];

      const activeTimeSeries: MetricSeries = {
        label: "Active Time",
        unit: "s",
        points: timeframes.map((t) => ({
          timestamp: new Date(t.timeframe_start).getTime(),
          value: t.active_time_seconds,
        })),
      };

      const storageSeries: MetricSeries = {
        label: "Storage",
        unit: "bytes",
        points: timeframes.map((t) => ({
          timestamp: new Date(t.timeframe_start).getTime(),
          value: t.synthetic_storage_size_bytes,
        })),
      };

      const writtenSeries: MetricSeries = {
        label: "Data Written",
        unit: "bytes",
        points: timeframes.map((t) => ({
          timestamp: new Date(t.timeframe_start).getTime(),
          value: t.written_data_bytes,
        })),
      };

      return [activeTimeSeries, storageSeries, writtenSeries];
    } catch {
      return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchNeonCostData(this.api, range);
  }

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
      case "neon-data-api":
        return this.renderDataApiDetail(resource);
      case "neon-snapshot":
        return this.renderSnapshotDetail(resource);
      case "neon-bucket":
        return this.renderBucketDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  private renderSnapshotDetail(resource: ResourceInstance): DetailViewSchema {
    const detail = this.renderGenericDetail(resource);
    detail.headerActions = [
      {
        kind: "action",
        label: "Restore",
        action: {
          type: "plugin-action",
          actionId: "restore",
          confirmMessage:
            "Restore this snapshot into a new branch? The branch is created unfinalized so you can inspect the data before moving computes onto it.",
          successMessage: "Restore started — a new branch is being created.",
        },
      },
    ];
    // A snapshot is immutable data, not a running thing with a lifecycle state.
    delete detail.status;
    return detail;
  }

  private renderBucketDetail(resource: ResourceInstance): DetailViewSchema {
    const detail = this.renderGenericDetail(resource);
    const bucketName = String(resource.fields["name"] ?? resource.displayName);
    if (bucketName) detail.storageBrowser = { bucketName };
    delete detail.status;
    return detail;
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const stateField = resource.fields["currentState"];
    const status = typeof stateField === "string" ? mapNeonState(stateField) : ("info" as const);

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  /**
   * Project + branch pickers for the branch-scoped types. Returns nothing when the
   * user is already creating from inside a branch (or a branch-scoped parent such
   * as `neon-auth`), since the scope is implied.
   */
  private async branchScopedCreateFields(
    parentResourceId?: string,
  ): Promise<CreateResourceConfig["fields"]> {
    if (parentResourceId) return [];

    const projects = await this.fetchAllProjects();
    const projectOptions = projects.map((p) => ({ id: p.id, label: p.name }));

    let branchOptions: Array<{ id: string; label: string }> = [];
    const firstProject = projectOptions[0];
    if (firstProject) {
      const branches = await this.api.listProjectBranches({ projectId: firstProject.id });
      branchOptions = branches.data.branches.map((b) => ({
        id: b.id,
        label: `${b.name}${isDefaultBranch(b) ? " (primary)" : ""}`,
      }));
    }

    return [
      {
        key: "projectId",
        label: "Project",
        kind: "select",
        required: true,
        options: projectOptions,
        ...(firstProject ? { defaultValue: firstProject.id } : {}),
      },
      {
        key: "branchId",
        label: "Branch",
        kind: "select",
        required: true,
        options: branchOptions,
        ...(branchOptions[0] ? { defaultValue: branchOptions[0].id } : {}),
      },
    ];
  }

  /** Resolve the branch a create targets, from the parent resource or the form fields. */
  private resolveCreateBranchRef(
    fields: Record<string, string>,
    parentResourceId?: string,
  ): BranchRef {
    if (parentResourceId) {
      const ref = parseBranchExternalId(externalIdOf(parentResourceId));
      if (ref.projectId && ref.branchId) return ref;
    }
    const projectId = fields["projectId"] ?? "";
    const branchId = fields["branchId"] ?? "";
    if (!projectId || !branchId) {
      throw new Error("Neon plugin: a project and branch are required");
    }
    return { projectId, branchId };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "neon-snapshot") {
      const fields = await this.branchScopedCreateFields(parentResourceId);
      fields.push({
        key: "name",
        label: "Snapshot Name",
        kind: "text",
        required: false,
        placeholder: "Leave blank to let Neon name it",
      });
      return { fields };
    }

    if (typeId === "neon-bucket") {
      const fields = await this.branchScopedCreateFields(parentResourceId);
      fields.push(
        { key: "name", label: "Bucket Name", kind: "text", required: true },
        {
          key: "accessLevel",
          label: "Access Level",
          kind: "select",
          required: true,
          options: [
            { id: "private", label: "Private — all access requires credentials" },
            { id: "public_read", label: "Public read — anyone can read objects" },
          ],
          defaultValue: "private",
        },
      );
      return { fields };
    }

    if (typeId === "neon-credential") {
      const fields = await this.branchScopedCreateFields(parentResourceId);
      fields.push(
        { key: "name", label: "Name", kind: "text", required: false },
        {
          key: "scopes",
          label: "Grants",
          kind: "select",
          required: true,
          description: "What this credential is allowed to do on the branch.",
          options: SCOPE_BUNDLES.map((b) => ({ id: b.id, label: b.label })),
          defaultValue: "storage-rw",
        },
      );
      return { fields };
    }

    if (typeId === "neon-auth") {
      const fields = await this.branchScopedCreateFields(parentResourceId);
      fields.push({
        key: "databaseName",
        label: "Database",
        kind: "text",
        required: false,
        description: "Database to hold the neon_auth schema. Defaults to the branch's own default.",
      });
      return { fields };
    }

    if (typeId === "neon-auth-oauth-provider") {
      const fields = await this.branchScopedCreateFields(parentResourceId);
      fields.push(
        {
          key: "providerId",
          label: "Provider",
          kind: "select",
          required: true,
          options: [
            { id: "google", label: "Google" },
            { id: "github", label: "GitHub" },
            { id: "microsoft", label: "Microsoft" },
            { id: "vercel", label: "Vercel" },
          ],
          defaultValue: "google",
        },
        {
          key: "clientId",
          label: "Client ID",
          kind: "text",
          required: false,
          description: "Leave blank to use Neon's shared development credentials.",
        },
        { key: "clientSecret", label: "Client Secret", kind: "password", required: false },
        {
          key: "microsoftTenantId",
          label: "Microsoft Tenant ID",
          kind: "text",
          required: false,
          showWhen: { fieldKey: "providerId", fieldValue: "microsoft" },
        },
      );
      return { fields };
    }

    if (typeId === "neon-auth-domain") {
      const fields = await this.branchScopedCreateFields(parentResourceId);
      fields.push({
        key: "domain",
        label: "Domain",
        kind: "text",
        required: true,
        placeholder: "https://app.example.com",
      });
      return { fields };
    }

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
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        // List projects so the user can pick which one to branch from
        const projects = await this.fetchAllProjects();
        const projectOptions = projects.map((p) => ({
          id: p.id,
          label: p.name,
        }));
        fields.push({
          key: "projectId",
          label: "Project",
          kind: "select",
          required: true,
          options: projectOptions,
          ...(projectOptions[0] ? { defaultValue: projectOptions[0].id } : {}),
        });
      }
      fields.push({ key: "name", label: "Branch Name", kind: "text", required: true });
      return { fields };
    }

    if (typeId === "neon-database") {
      // Parent is neon-branch; its resource ID is `{accountId}:neon-branch:{projectId}/{branchId}`.
      const parentExternalId = parentResourceId
        ? parentResourceId.split(":").slice(2).join(":")
        : "";
      const [parentProjectId, parentBranchId] = parentExternalId.split("/");

      const fields: CreateResourceConfig["fields"] = [];
      let scopedProjectId = parentProjectId ?? "";
      let scopedBranchId = parentBranchId ?? "";

      if (!parentResourceId) {
        // List projects so the user can pick project → branch → create database
        const projects = await this.fetchAllProjects();
        const projectOptions = projects.map((p) => ({
          id: p.id,
          label: p.name,
        }));

        // Pre-fetch branches for the first project if available
        let branchOptions: Array<{ id: string; label: string }> = [];
        if (projectOptions[0]) {
          const firstProjectId = projectOptions[0].id;
          const branches = await this.api.listProjectBranches({ projectId: firstProjectId });
          branchOptions = branches.data.branches.map((b) => ({
            id: b.id,
            label: `${b.name}${isDefaultBranch(b) ? " (primary)" : ""}`,
          }));
        }

        fields.push({
          key: "projectId",
          label: "Project",
          kind: "select",
          required: true,
          options: projectOptions,
          ...(projectOptions[0] ? { defaultValue: projectOptions[0].id } : {}),
        });
        fields.push({
          key: "branchId",
          label: "Branch",
          kind: "select",
          required: true,
          options: branchOptions,
          ...(branchOptions[0] ? { defaultValue: branchOptions[0].id } : {}),
        });

        scopedProjectId = projectOptions[0]?.id ?? "";
        scopedBranchId = branchOptions[0]?.id ?? "";
      }

      // List roles from the scoped project/branch for the owner field
      let roleOptions: Array<{ id: string; label: string }> = [];
      if (scopedProjectId && scopedBranchId) {
        try {
          const roles = await this.api.listProjectBranchRoles(scopedProjectId, scopedBranchId);
          roleOptions = roles.data.roles.map((r) => ({ id: r.name, label: r.name }));
        } catch {
          /* some branches may not have roles accessible */
        }
      }

      fields.push({ key: "name", label: "Database Name", kind: "text", required: true });
      fields.push({
        key: "ownerName",
        label: "Owner Role",
        kind: "select",
        required: true,
        options:
          roleOptions.length > 0 ? roleOptions : [{ id: "neondb_owner", label: "neondb_owner" }],
        defaultValue: roleOptions[0]?.id ?? "neondb_owner",
      });

      return { fields };
    }

    if (typeId === "neon-role") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        const projects = await this.fetchAllProjects();
        const branchOptions: { id: string; label: string }[] = [];
        for (const p of projects) {
          try {
            const branches = await this.api.listProjectBranches({ projectId: p.id });
            for (const b of branches.data.branches) {
              branchOptions.push({ id: `${p.id}/${b.id}`, label: `${p.name} / ${b.name}` });
            }
          } catch {
            /* skip */
          }
        }
        fields.push({
          key: "projectBranch",
          label: "Project / Branch",
          kind: "select",
          required: true,
          options: branchOptions,
          ...(branchOptions[0] ? { defaultValue: branchOptions[0].id } : {}),
        });
      }
      fields.push({ key: "name", label: "Role Name", kind: "text", required: true });
      return { fields };
    }

    if (typeId === "neon-endpoint") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        const projects = await this.fetchAllProjects();
        const branchOptions: { id: string; label: string }[] = [];
        for (const p of projects) {
          try {
            const branches = await this.api.listProjectBranches({ projectId: p.id });
            for (const b of branches.data.branches) {
              branchOptions.push({ id: `${p.id}/${b.id}`, label: `${p.name} / ${b.name}` });
            }
          } catch {
            /* skip */
          }
        }
        fields.push({
          key: "projectBranch",
          label: "Project / Branch",
          kind: "select",
          required: true,
          options: branchOptions,
          ...(branchOptions[0] ? { defaultValue: branchOptions[0].id } : {}),
        });
      }
      fields.push({
        key: "type",
        label: "Endpoint Type",
        kind: "select",
        required: true,
        options: [
          { id: "read_write", label: "Read-Write" },
          { id: "read_only", label: "Read-Only" },
        ],
        defaultValue: "read_write",
      });
      return { fields };
    }

    if (typeId === "neon-data-api") {
      const fields: CreateResourceConfig["fields"] = [];
      if (!parentResourceId) {
        const databases = await this.listAllDatabases("create");
        const options = databases.map((db) => ({
          id: `${String(db.fields["projectId"])}/${String(db.fields["branchId"])}/${String(
            db.fields["name"],
          )}`,
          label: `${String(db.fields["projectId"])} / ${String(
            db.fields["branchId"],
          )} / ${String(db.fields["name"])}`,
        }));
        fields.push({
          key: "databaseRef",
          label: "Database",
          kind: "select",
          required: true,
          options,
          ...(options[0] ? { defaultValue: options[0].id } : {}),
        });
      }
      fields.push({
        key: "authProvider",
        label: "Auth Provider",
        kind: "select",
        required: false,
        options: [
          { id: "", label: "Default" },
          { id: "external", label: "External JWT" },
          { id: "neon_auth", label: "Neon Auth" },
        ],
        defaultValue: "",
      });
      fields.push({ key: "providerName", label: "Provider Name", kind: "text", required: false });
      fields.push({ key: "jwksUrl", label: "JWKS URL", kind: "text", required: false });
      fields.push({ key: "jwtAudience", label: "JWT Audience", kind: "text", required: false });
      fields.push({
        key: "anonymousRole",
        label: "Anonymous Role",
        kind: "text",
        required: false,
        defaultValue: "anonymous",
      });
      fields.push({
        key: "schemas",
        label: "Schemas",
        kind: "string-list",
        required: false,
        defaultValue: "public",
      });
      fields.push({
        key: "corsAllowedOrigins",
        label: "CORS Allowed Origins",
        kind: "text",
        required: false,
      });
      return { fields };
    }

    throw new Error(`Neon plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    if (typeId === "neon-snapshot") {
      const ref = this.resolveCreateBranchRef(fields, parentResourceId);
      return createSnapshotResource(this.api, accountId, ref, fields["name"] ?? "");
    }

    if (typeId === "neon-bucket") {
      const ref = this.resolveCreateBranchRef(fields, parentResourceId);
      const name = fields["name"] ?? "";
      const accessLevel =
        fields["accessLevel"] === "public_read"
          ? BucketAccessLevel.PublicRead
          : BucketAccessLevel.Private;

      const resp = await this.api.createProjectBranchBucket(ref.projectId, ref.branchId, {
        name,
        access_level: accessLevel,
      });
      const storage = await fetchBranchStorage(this.api, ref);
      this.bucketLocator.remember(name, ref);
      return buildBucketResource(accountId, ref, resp.data.bucket, storage);
    }

    if (typeId === "neon-credential") {
      const ref = this.resolveCreateBranchRef(fields, parentResourceId);
      const bundle = SCOPE_BUNDLES.find((b) => b.id === fields["scopes"]) ?? SCOPE_BUNDLES[0]!;
      const name = fields["name"] ?? "";

      const resp = await this.api.createCredential(ref.projectId, ref.branchId, {
        ...(name ? { name } : {}),
        scopes: bundle.scopes,
        principal_type: "user",
      });

      // This is the only moment the token and S3 secret exist in a response;
      // surface them as resolved outputs so the host can store them now.
      const created = resp.data;
      const resource = buildCredentialResource(accountId, ref, {
        token_id: created.token_id,
        token_id_short: created.token_id_short,
        ...(created.name ? { name: created.name } : {}),
        scopes: created.scopes,
        principal_type: "user",
        created_at: created.created_at,
        ...(created.expires_at ? { expires_at: created.expires_at } : {}),
      });
      resource.resolvedOutputs = {
        ...resource.resolvedOutputs,
        apiToken: created.api_token,
        s3SecretAccessKey: created.s3_secret_access_key,
      };
      return resource;
    }

    if (typeId === "neon-auth") {
      const ref = this.resolveCreateBranchRef(fields, parentResourceId);
      const databaseName = fields["databaseName"] ?? "";
      await this.api.createNeonAuth(ref.projectId, ref.branchId, {
        auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
        ...(databaseName ? { database_name: databaseName } : {}),
      });

      // Re-read so the resource carries the same shape as a listed one.
      const snapshot = await fetchAuthSnapshot(this.api, ref);
      if (!snapshot) throw new Error("Neon plugin: auth was enabled but could not be read back");
      return buildAuthResource(accountId, ref, snapshot);
    }

    if (typeId === "neon-auth-oauth-provider") {
      const ref = this.resolveCreateBranchRef(fields, parentResourceId);
      const clientId = fields["clientId"] ?? "";
      const clientSecret = fields["clientSecret"] ?? "";
      const tenantId = fields["microsoftTenantId"] ?? "";

      const resp = await this.api.addBranchNeonAuthOauthProvider(ref.projectId, ref.branchId, {
        id: (fields["providerId"] ?? "google") as NeonAuthOauthProviderId,
        ...(clientId ? { client_id: clientId } : {}),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        ...(tenantId ? { microsoft_tenant_id: tenantId } : {}),
      });
      return buildOauthProviderResource(accountId, ref, resp.data);
    }

    if (typeId === "neon-auth-domain") {
      const ref = this.resolveCreateBranchRef(fields, parentResourceId);
      const domain = fields["domain"] ?? "";
      await this.api.addBranchNeonAuthTrustedDomain(ref.projectId, ref.branchId, {
        domain,
        auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
      });
      return buildDomainResource(accountId, ref, {
        domain,
        auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
      });
    }

    // Parent resource IDs:
    //   neon-project → `{accountId}:neon-project:{projectId}`
    //   neon-branch  → `{accountId}:neon-branch:{projectId}/{branchId}`
    const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    if (typeId === "neon-project") {
      const pgVersion = Number(fields["pgVersion"] ?? 17);
      const response = await this.api.createProject({
        project: {
          name: fields["name"] ?? "",
          region_id: fields["region"] ?? "",
          pg_version: pgVersion,
        },
      });
      const p = response.data.project;
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
      // Parent is neon-project; recover its externalId (the projectId) when the
      // form was opened from the project detail page.
      const projectId = fields["projectId"] || parentExternalId;
      if (!projectId) throw new Error("Neon plugin: projectId is required to create a branch");

      const response = await this.api.createProjectBranch(projectId, {
        branch: { name: fields["name"] ?? "" },
        endpoints: [{ type: EndpointType.ReadWrite }],
      });
      const b = response.data.branch;
      return {
        id: `${accountId}:neon-branch:${projectId}/${b.id}`,
        pluginId: "neon",
        resourceTypeId: "neon-branch",
        accountId,
        displayName: b.name,
        fields: {
          name: b.name,
          projectId: b.project_id,
          primary: isDefaultBranch(b),
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
      // Parent is neon-branch; its externalId is `{projectId}/{branchId}`.
      const [parentProjectId, parentBranchId] = parentExternalId.split("/");
      const projectId = fields["projectId"] || parentProjectId || "";
      const branchId = fields["branchId"] || parentBranchId || "";
      if (!projectId || !branchId)
        throw new Error("Neon plugin: projectId and branchId are required to create a database");

      const response = await this.api.createProjectBranchDatabase(projectId, branchId, {
        database: {
          name: fields["name"] ?? "",
          owner_name: fields["ownerName"] ?? "neondb_owner",
        },
      });
      const db = response.data.database;
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

    if (typeId === "neon-role") {
      // Parent is neon-branch; its externalId is `{projectId}/{branchId}`.
      const pb = (fields["projectBranch"] || parentExternalId).split("/");
      const projectId = pb[0] ?? "";
      const branchId = pb[1] ?? "";
      if (!projectId || !branchId)
        throw new Error("Neon plugin: projectBranch is required to create a role");
      const response = await this.api.createProjectBranchRole(projectId, branchId, {
        role: { name: fields["name"] ?? "" },
      });
      const r = response.data.role;
      return {
        id: `${accountId}:neon-role:${projectId}/${branchId}/${r.name}`,
        pluginId: "neon",
        resourceTypeId: "neon-role",
        accountId,
        displayName: r.name,
        fields: {
          name: r.name,
          projectId,
          branchId,
          protected: r.protected ?? false,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: r.name,
        parentResourceId: `${accountId}:neon-branch:${projectId}/${branchId}`,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }

    if (typeId === "neon-endpoint") {
      // Parent is neon-branch; its externalId is `{projectId}/{branchId}`.
      const pb = (fields["projectBranch"] || parentExternalId).split("/");
      const projectId = pb[0] ?? "";
      const branchId = pb[1] ?? "";
      if (!projectId || !branchId)
        throw new Error("Neon plugin: projectBranch is required to create an endpoint");
      const endpointType =
        fields["type"] === "read_only" ? EndpointType.ReadOnly : EndpointType.ReadWrite;
      const response = await this.api.createProjectEndpoint(projectId, {
        endpoint: {
          branch_id: branchId,
          type: endpointType,
        },
      });
      const ep = response.data.endpoint;
      return {
        id: `${accountId}:neon-endpoint:${projectId}/${ep.id}`,
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
        parentResourceId: `${accountId}:neon-branch:${projectId}/${branchId}`,
        createdAt: ep.created_at,
        updatedAt: ep.updated_at,
      };
    }

    if (typeId === "neon-data-api") {
      const [parentProjectId, parentBranchId, ...parentDbParts] = parentExternalId.split("/");
      const selected = fields["databaseRef"]?.split("/") ?? [];
      const projectId = fields["projectId"] || parentProjectId || selected[0] || "";
      const branchId = fields["branchId"] || parentBranchId || selected[1] || "";
      const databaseName =
        fields["databaseName"] || parentDbParts.join("/") || selected.slice(2).join("/") || "";
      if (!projectId || !branchId || !databaseName) {
        throw new Error("Neon plugin: project, branch, and database are required for Data API");
      }

      const schemas = parseCsv(fields["schemas"]);
      const settings: NonNullable<
        Parameters<typeof this.api.createProjectBranchDataApi>[3]
      >["settings"] = {};
      if (fields["anonymousRole"]) settings.db_anon_role = fields["anonymousRole"];
      if (schemas.length > 0) settings.db_schemas = schemas;
      if (fields["corsAllowedOrigins"]) {
        settings.server_cors_allowed_origins = fields["corsAllowedOrigins"];
      }

      const body: Parameters<typeof this.api.createProjectBranchDataApi>[3] = {};
      if (fields["authProvider"]) {
        body.auth_provider = fields["authProvider"] === "neon_auth" ? "neon_auth" : "external";
      }
      if (fields["providerName"]) body.provider_name = fields["providerName"];
      if (fields["jwksUrl"]) body.jwks_url = fields["jwksUrl"];
      if (fields["jwtAudience"]) body.jwt_audience = fields["jwtAudience"];
      if (Object.keys(settings).length > 0) body.settings = settings;

      const response = await this.api.createProjectBranchDataApi(
        projectId,
        branchId,
        databaseName,
        body,
      );
      const dataApi = {
        url: response.data.url,
        status: "created",
        settings: body.settings ?? null,
      };
      return this.buildDataApiResource(accountId, projectId, branchId, databaseName, dataApi);
    }

    throw new Error(`Neon plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    if (typeId === "neon-snapshot") {
      // externalId: {projectId}/{snapshotId}
      const [projectId, snapshotId] = externalIdOf(resourceId).split("/");
      if (!projectId || !snapshotId) throw new Error("Neon plugin: cannot parse snapshot ID");
      await this.api.deleteSnapshot(projectId, snapshotId);
      return;
    }

    if (typeId === "neon-bucket") {
      const { ref, name } = this.parseBranchScoped(resourceId, "bucket");
      await this.api.deleteProjectBranchBucket(ref.projectId, ref.branchId, name);
      return;
    }

    if (typeId === "neon-credential") {
      const { ref, name } = this.parseBranchScoped(resourceId, "credential");
      await this.api.revokeCredential(ref.projectId, ref.branchId, name);
      return;
    }

    if (typeId === "neon-function") {
      const { ref, name } = this.parseBranchScoped(resourceId, "function");
      await this.api.deleteProjectBranchFunction(ref.projectId, ref.branchId, name);
      return;
    }

    if (typeId === "neon-auth") {
      const ref = parseBranchExternalId(externalIdOf(resourceId));
      if (!ref.projectId || !ref.branchId) throw new Error("Neon plugin: cannot parse auth ID");
      // Leave the neon_auth schema in place: disabling the integration shouldn't
      // drop the user's auth tables.
      await this.api.disableNeonAuth(ref.projectId, ref.branchId, { delete_data: false });
      return;
    }

    if (typeId === "neon-auth-oauth-provider") {
      const { ref, name } = this.parseBranchScoped(resourceId, "OAuth provider");
      await this.api.deleteBranchNeonAuthOauthProvider(
        ref.projectId,
        ref.branchId,
        name as NeonAuthOauthProviderId,
      );
      return;
    }

    if (typeId === "neon-auth-domain") {
      const { ref, name } = this.parseBranchScoped(resourceId, "trusted domain");
      // Neon keys the delete by auth provider, which we captured when listing.
      const resource = await this.getResource(typeId, resourceId, accountId);
      const authProvider = String(
        resource.fields["authProvider"] ?? NeonAuthSupportedAuthProvider.BetterAuth,
      ) as NeonAuthSupportedAuthProvider;
      await this.api.deleteBranchNeonAuthTrustedDomain(ref.projectId, ref.branchId, {
        auth_provider: authProvider,
        domains: [{ domain: name }],
      });
      return;
    }

    if (typeId === "neon-project") {
      const projectId = resourceId.split(":").pop();
      if (!projectId) throw new Error("Neon plugin: cannot parse project ID");
      await this.api.deleteProject(projectId);
      return;
    }

    if (typeId === "neon-branch") {
      // externalId format: branchId, resource ID format: {accountId}:neon-branch:{projectId}/{branchId}
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Neon plugin: cannot parse branch ID");
      const [projectId, branchId] = compound.split("/");
      if (!projectId || !branchId) throw new Error("Neon plugin: cannot parse branch ID");
      await this.api.deleteProjectBranch({ projectId, branchId });
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
      if (!projectId || !branchId) throw new Error("Neon plugin: cannot parse database ID");
      await this.api.deleteProjectBranchDatabase(projectId, branchId, dbName);
      return;
    }

    if (typeId === "neon-endpoint") {
      // resource ID format: {accountId}:neon-endpoint:{projectId}/{endpointId}
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Neon plugin: cannot parse endpoint ID");
      const [projectId, endpointId] = compound.split("/");
      if (!projectId || !endpointId) throw new Error("Neon plugin: cannot parse endpoint ID");
      await this.api.deleteProjectEndpoint(projectId, endpointId);
      return;
    }

    if (typeId === "neon-role") {
      // resource ID format: {accountId}:neon-role:{projectId}/{branchId}/{roleName}
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Neon plugin: cannot parse role ID");
      const parts = compound.split("/");
      if (parts.length < 3) throw new Error("Neon plugin: cannot parse role ID");
      const [projectId, branchId, ...roleParts] = parts;
      const roleName = roleParts.join("/");
      if (!projectId || !branchId) throw new Error("Neon plugin: cannot parse role ID");
      await this.api.deleteProjectBranchRole(projectId, branchId, roleName);
      return;
    }

    if (typeId === "neon-data-api") {
      const compound = resourceId.split(":").pop();
      if (!compound) throw new Error("Neon plugin: cannot parse Data API ID");
      const parts = compound.split("/");
      if (parts.length < 3) throw new Error("Neon plugin: cannot parse Data API ID");
      const [projectId, branchId, ...dbParts] = parts;
      const databaseName = dbParts.join("/");
      if (!projectId || !branchId || !databaseName) {
        throw new Error("Neon plugin: cannot parse Data API ID");
      }
      await this.api.deleteProjectBranchDataApi(projectId, branchId, databaseName);
      return;
    }

    throw new Error(`Neon plugin: deleteResource not supported for type "${typeId}"`);
  }

  /**
   * Split a `{accountId}:{typeId}:{projectId}/{branchId}/{name}` id, where `name`
   * may itself contain slashes.
   */
  private parseBranchScoped(
    resourceIdValue: string,
    label: string,
  ): { ref: BranchRef; name: string } {
    const parts = externalIdOf(resourceIdValue).split("/");
    const [projectId, branchId, ...rest] = parts;
    const name = rest.join("/");
    if (!projectId || !branchId || !name) {
      throw new Error(`Neon plugin: cannot parse ${label} ID`);
    }
    return { ref: { projectId, branchId }, name };
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const ref = await this.resolveBucketRef(bucket);
    return listBucketObjects(this.api, ref, bucket, prefix);
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    const ref = await this.resolveBucketRef(bucket);
    await uploadBucketObject(this.api, ref, bucket, key, file, file.type || undefined);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const ref = await this.resolveBucketRef(bucket);
    // S3 has no folders; a zero-byte object with a trailing slash is the marker.
    const folderKey = key.endsWith("/") ? key : `${key}/`;
    await uploadBucketObject(this.api, ref, bucket, folderKey, new Blob([]));
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const ref = await this.resolveBucketRef(bucket);
    await deleteBucketObject(this.api, ref, bucket, key);
  }

  /** The host's storage browser knows only a bucket name, so map it back to a branch. */
  private async resolveBucketRef(bucket: string): Promise<BranchRef> {
    const cached = this.bucketLocator.lookup(bucket);
    if (cached) return cached;
    return locateBucket(this.api, "", await this.fetchAllProjects(), this.bucketLocator, bucket);
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "neon-snapshot" && actionId === "restore") {
      const [projectId, snapshotId] = externalIdOf(resourceId).split("/");
      if (!projectId || !snapshotId) throw new Error("Neon plugin: cannot parse snapshot ID");
      await restoreSnapshot(this.api, projectId, snapshotId);
      return;
    }

    if (typeId === "neon-endpoint" && (actionId === "start" || actionId === "suspend")) {
      // resource ID format: {accountId}:neon-endpoint:{projectId}/{endpointId}
      const [projectId, endpointId] = externalIdOf(resourceId).split("/");
      if (!projectId || !endpointId) throw new Error("Neon plugin: cannot parse endpoint ID");
      if (actionId === "start") await this.api.startProjectEndpoint(projectId, endpointId);
      else await this.api.suspendProjectEndpoint(projectId, endpointId);
      return;
    }

    throw new Error(`Neon plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  /**
   * Fetch every project across pagination. The SDK requires a query argument; we
   * page until no further cursor is returned.
   */
  private async fetchAllProjects(): Promise<ProjectListItem[]> {
    const results: ProjectListItem[] = [];
    let cursor: string | undefined;
    // Cap iterations to avoid runaway pagination loops against unexpected responses.
    for (let i = 0; i < 50; i++) {
      const resp = await this.api.listProjects(cursor ? { cursor } : {});
      results.push(...resp.data.projects);
      const next = resp.data.pagination?.cursor;
      if (!next || resp.data.projects.length === 0) break;
      cursor = next;
    }
    return results;
  }

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.fetchAllProjects();
    return projects.map((p) => ({
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
    const projects = await this.fetchAllProjects();
    const results: ResourceInstance[] = [];
    for (const p of projects) {
      try {
        const resp = await this.api.listProjectBranches({ projectId: p.id });
        for (const b of resp.data.branches) {
          results.push({
            id: `${accountId}:neon-branch:${p.id}/${b.id}`,
            pluginId: "neon",
            resourceTypeId: "neon-branch",
            accountId,
            displayName: b.name,
            fields: {
              name: b.name,
              projectId: b.project_id,
              primary: isDefaultBranch(b),
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
    const projects = await this.fetchAllProjects();
    const results: ResourceInstance[] = [];
    for (const p of projects) {
      try {
        const resp = await this.api.listProjectEndpoints(p.id);
        for (const ep of resp.data.endpoints) {
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
    const projects = await this.fetchAllProjects();
    const results: ResourceInstance[] = [];
    for (const p of projects) {
      try {
        const branchResp = await this.api.listProjectBranches({ projectId: p.id });
        for (const b of branchResp.data.branches) {
          try {
            const dbResp = await this.api.listProjectBranchDatabases(p.id, b.id);
            for (const db of dbResp.data.databases) {
              results.push(this.buildDatabaseResource(accountId, p.id, b.id, db));
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

  private buildDatabaseResource(
    accountId: string,
    projectId: string,
    branchId: string,
    db: Database,
  ): ResourceInstance {
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

  private async listAllRoles(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.fetchAllProjects();
    const results: ResourceInstance[] = [];
    for (const p of projects) {
      try {
        const branchResp = await this.api.listProjectBranches({ projectId: p.id });
        for (const b of branchResp.data.branches) {
          try {
            const roleResp = await this.api.listProjectBranchRoles(p.id, b.id);
            for (const r of roleResp.data.roles) {
              results.push(this.buildRoleResource(accountId, p.id, b.id, r));
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

  private async listAllDataApis(accountId: string): Promise<ResourceInstance[]> {
    const databases = await this.listAllDatabases(accountId);
    const results: ResourceInstance[] = [];
    for (const db of databases) {
      const projectId = String(db.fields["projectId"] ?? "");
      const branchId = String(db.fields["branchId"] ?? "");
      const databaseName = String(db.fields["name"] ?? "");
      if (!projectId || !branchId || !databaseName) continue;
      try {
        const resp = await this.api.getProjectBranchDataApi(projectId, branchId, databaseName);
        results.push(
          this.buildDataApiResource(accountId, projectId, branchId, databaseName, resp.data),
        );
      } catch {
        /* Data API is disabled or unavailable for this database. */
      }
    }
    return results;
  }

  private buildDataApiResource(
    accountId: string,
    projectId: string,
    branchId: string,
    databaseName: string,
    dataApi: Pick<DataAPIReponse, "url" | "status" | "settings" | "available_schemas">,
  ): ResourceInstance {
    return {
      id: `${accountId}:neon-data-api:${projectId}/${branchId}/${databaseName}`,
      pluginId: "neon",
      resourceTypeId: "neon-data-api",
      accountId,
      displayName: databaseName,
      fields: {
        url: dataApi.url,
        status: dataApi.status,
        projectId,
        branchId,
        database: databaseName,
        schemas: (dataApi.available_schemas ?? dataApi.settings?.db_schemas ?? []).join(", "),
        anonymousRole: dataApi.settings?.db_anon_role ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: databaseName,
      parentResourceId: `${accountId}:neon-database:${projectId}/${branchId}/${databaseName}`,
      createdAt: "",
      updatedAt: "",
    };
  }

  private buildRoleResource(
    accountId: string,
    projectId: string,
    branchId: string,
    r: Role,
  ): ResourceInstance {
    return {
      id: `${accountId}:neon-role:${projectId}/${branchId}/${r.name}`,
      pluginId: "neon",
      resourceTypeId: "neon-role",
      accountId,
      displayName: r.name,
      fields: {
        name: r.name,
        projectId,
        branchId,
        protected: r.protected ?? false,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: r.name,
      parentResourceId: `${accountId}:neon-branch:${projectId}/${branchId}`,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private async resolveDatabaseConnectionString(
    resourceId: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource("neon-database", resourceId, accountId);
    const projectId = String(resource.fields["projectId"] ?? "");
    const branchId = String(resource.fields["branchId"] ?? "");
    const dbName = String(resource.fields["name"] ?? "");

    const roleName = String(resource.fields["ownerName"] ?? "neondb_owner");

    const resp = await this.api.getConnectionUri({
      projectId,
      branch_id: branchId,
      database_name: dbName,
      role_name: roleName,
    });
    return resp.data.uri;
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

    const branchResp = await this.api.listProjectBranches({ projectId });
    const primary =
      branchResp.data.branches.find((b) => isDefaultBranch(b)) ?? branchResp.data.branches[0];
    if (!primary) throw new Error("Neon plugin: no branches found on project");

    const dbResp = await this.api.listProjectBranchDatabases(projectId, primary.id);
    const db = dbResp.data.databases[0];
    if (!db) throw new Error("Neon plugin: no databases found on primary branch");

    const resp = await this.api.getConnectionUri({
      projectId,
      branch_id: primary.id,
      database_name: db.name,
      role_name: db.owner_name,
    });
    return resp.data.uri;
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

    const dbResp = await this.api.listProjectBranchDatabases(projectId, branchId);
    const db = dbResp.data.databases[0];
    if (!db) throw new Error("Neon plugin: no databases found on this branch");

    const resp = await this.api.getConnectionUri({
      projectId,
      branch_id: branchId,
      database_name: db.name,
      role_name: db.owner_name,
    });
    return resp.data.uri;
  }

  private async resolveRolePassword(resourceId: string, accountId: string): Promise<string> {
    const resource = await this.getResource("neon-role", resourceId, accountId);
    const projectId = String(resource.fields["projectId"] ?? "");
    const branchId = String(resource.fields["branchId"] ?? "");
    const roleName = String(resource.fields["name"] ?? "");

    const resp = await this.api.getProjectBranchRolePassword(projectId, branchId, roleName);
    return resp.data.password;
  }

  async rerollOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<void> {
    if (outputKey !== "connectionString" && outputKey !== "password") {
      throw new Error(`Neon plugin: cannot reroll output "${outputKey}" for type "${typeId}"`);
    }

    // Resolve project/branch/role from the resource shape. neon-database and
    // neon-branch both reset the owner of the first database; neon-role resets
    // itself; neon-project resets the owner of the primary branch's default db.
    let projectId: string;
    let branchId: string;
    let roleName: string;

    if (typeId === "neon-role") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      projectId = String(resource.fields["projectId"] ?? "");
      branchId = String(resource.fields["branchId"] ?? "");
      roleName = String(resource.fields["name"] ?? "");
    } else if (typeId === "neon-database") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      projectId = String(resource.fields["projectId"] ?? "");
      branchId = String(resource.fields["branchId"] ?? "");
      roleName = String(resource.fields["ownerName"] ?? "neondb_owner");
    } else if (typeId === "neon-branch") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      projectId = String(resource.fields["projectId"] ?? "");
      branchId = String(resource.externalId ?? "");
      const dbResp = await this.api.listProjectBranchDatabases(projectId, branchId);
      const db = dbResp.data.databases[0];
      if (!db) throw new Error("Neon plugin: no databases on branch to reroll");
      roleName = db.owner_name;
    } else if (typeId === "neon-project") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      projectId = String(resource.externalId ?? "");
      const branchResp = await this.api.listProjectBranches({ projectId });
      const primary =
        branchResp.data.branches.find((b) => isDefaultBranch(b)) ?? branchResp.data.branches[0];
      if (!primary) throw new Error("Neon plugin: no branches to reroll");
      branchId = primary.id;
      const dbResp = await this.api.listProjectBranchDatabases(projectId, branchId);
      const db = dbResp.data.databases[0];
      if (!db) throw new Error("Neon plugin: no databases on primary branch to reroll");
      roleName = db.owner_name;
    } else {
      throw new Error(`Neon plugin: rerollOutput not supported for type "${typeId}"`);
    }

    if (!projectId || !branchId || !roleName) {
      throw new Error("Neon plugin: project/branch/role required to reset password");
    }

    await this.api.resetProjectBranchRolePassword(projectId, branchId, roleName);
  }

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
      metricsCapability: NEON_METRICS,
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
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      // Branch metrics are the project's — `fetchMetricSeries` resolves the
      // parent project id from the branch and asks for the same consumption
      // series. Both types declare `supportsMetrics`, so both need the tab.
      metricsCapability: NEON_METRICS,
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
                {
                  key: "Suspend Timeout",
                  value: suspendTimeout === "—" ? "—" : `${suspendTimeout}s`,
                },
              ],
            },
          ],
        },
      ],
      headerActions: [
        // Start only from "idle", Suspend only from "active" — transitional
        // states ("init" and friends) get neither: the API would reject or
        // race the in-flight transition, so wait for Refresh to settle it.
        ...(state === "idle"
          ? [
              {
                kind: "action" as const,
                label: "Start",
                action: {
                  type: "plugin-action" as const,
                  actionId: "start",
                  successMessage: "Start requested — the compute is warming up.",
                },
              },
            ]
          : state === "active"
            ? [
                {
                  kind: "action" as const,
                  label: "Suspend",
                  action: {
                    type: "plugin-action" as const,
                    actionId: "suspend",
                    confirmMessage:
                      "Suspend this compute endpoint? Open connections drop; the next connection wakes it (or a scheduled start does).",
                    successMessage: "Suspend requested.",
                  },
                  variant: "danger" as const,
                },
              ]
            : []),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderDatabaseDetail(resource: ResourceInstance): DetailViewSchema {
    const cs = resource.secretStates.find((s) => s.fieldKey === "connectionString");
    const resolvedCs = resource.resolvedOutputs["connectionString"];

    const connectionValue = cs
      ? {
          kind: "secret-placeholder" as const,
          fieldKey: "connectionString",
          resolution: cs.resolution,
        }
      : (resolvedCs ?? "(unavailable)");

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
                  value: connectionValue,
                  sensitive: true,
                  copyable:
                    typeof connectionValue === "string" && connectionValue !== "(unavailable)",
                },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
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
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDataApiDetail(resource: ResourceInstance): DetailViewSchema {
    const status = String(resource.fields["status"] ?? "unknown");
    return {
      title: resource.displayName,
      subtitle: `Data API · ${status}`,
      status: { kind: "status-dot", status: mapNeonState(status) },
      sections: [
        {
          kind: "section",
          title: "Data API",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "URL", value: String(resource.fields["url"] ?? "—"), copyable: true },
                { key: "Status", value: status },
                { key: "Database", value: String(resource.fields["database"] ?? "—") },
                { key: "Project ID", value: String(resource.fields["projectId"] ?? "—") },
                { key: "Branch ID", value: String(resource.fields["branchId"] ?? "—") },
                { key: "Schemas", value: String(resource.fields["schemas"] ?? "—") || "—" },
                {
                  key: "Anonymous Role",
                  value: String(resource.fields["anonymousRole"] ?? "—") || "—",
                },
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
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}

/**
 * Neon used to mark the project's main branch with `primary: true`. That flag is
 * deprecated in favor of `default`; older API responses may still set only one,
 * so accept either signal.
 */
function isDefaultBranch(branch: Branch | { default?: boolean; primary?: boolean }): boolean {
  return branch.default === true || branch.primary === true;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapNeonState(state: string): ResourceStatus {
  switch (state.toLowerCase()) {
    case "active":
    case "ready":
    case "created":
    case "enabled":
      return "healthy";
    case "idle":
      return "healthy";
    case "init":
    case "starting":
      return "provisioning";
    case "stopping":
      return "degraded";
    case "stopped":
      return "info";
    case "error":
    case "failed":
      return "error";
    default:
      return "info";
  }
}
