import type {
  ActionNode,
  PluginClient,
  SectionNode,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SqlTableMeta,
  ResourceStatus,
  ResourceTypeDefinition,
  DashboardStat,
  CreateResourceConfig,
  HostServices,
  ChatMessage,
  ChatStreamEvent,
  CostFetchRange,
  CostRow,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  CredentialFieldOption,
  WarehouseLoadRequest,
  WarehouseLoadResult,
  WarehouseSetupGuide,
} from "@infrawrench/plugin-base";
import {
  labeledFieldItems,
  labeledOutputItems,
  streamOpenAiSseChat,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { fetchDatabricksCostData } from "./cost-data.js";
import {
  databricksPrincipal,
  databricksSetupGuide,
  listDatabricksTargetOptions,
  loadDatabricksRows,
  type ApiFn as SinkApiFn,
} from "./warehouse-sink.js";
import type { ListerContext } from "./resource-listers.js";
import {
  listClusters,
  listSqlWarehouses,
  listServingEndpoints,
  listJobs,
  listModelVersions,
  listPipelines,
  listCatalogs,
  listSchemas,
  listTables,
  listApps,
  listClusterPolicies,
  listDashboards,
  listFunctions,
  listNodeTypes,
  listRegisteredModels,
  listRepos,
  listSecretScopes,
  listSqlQueries,
  listVectorSearchEndpoints,
  listVectorSearchIndexes,
  listVolumes,
  listWorkspaceObjects,
  lakebaseProjectToResource,
  listLakebaseBranches,
  listLakebaseProjects,
} from "./resource-listers.js";
import { WAREHOUSE_SIZES } from "./resources/sql-warehouse.js";
import {
  CLUSTER_ID,
  bucketSeconds,
  clusterEventLines,
  clusterWorkerSeries,
  jobRunSeries,
  nodeTimelineSeries,
  nodeTimelineSql,
  pipelineEventLines,
  servedEntityNames,
  servingEndpointSeries,
  warehouseQuerySeries,
} from "./observability.js";
import type { ClusterEvent, JobRun, PipelineEvent, QueryInfo } from "./observability.js";

/**
 * Default Metrics window per type: what `fetchMetricSeries` reads when the
 * host passes no range. Serving endpoints are a current-value scrape, so they
 * declare none.
 */
const METRIC_WINDOWS: Record<string, number> = {
  "databricks-cluster": 6 * 3_600_000,
  "databricks-sql-warehouse": 24 * 3_600_000,
  "databricks-job": 7 * 86_400_000,
};

/** Types with a Logs tab; each has a branch in `getLogs`. */
const LOG_TYPES = new Set([
  "databricks-cluster",
  "databricks-serving-endpoint",
  "databricks-pipeline",
]);

export class DatabricksClient implements PluginClient {
  private readonly host: string;
  private readonly token: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    this.resourceTypes = resourceTypes;
    let host = credentials["host"] ?? "";
    // Normalize: ensure https:// prefix, strip trailing slash
    if (!host.startsWith("https://") && !host.startsWith("http://")) {
      host = `https://${host}`;
    }
    host = host.replace(/\/+$/, "");
    this.host = host;

    this.token = credentials["token"] ?? "";
    if (!this.token) {
      throw new Error("Databricks plugin: missing personal access token");
    }

    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private async api<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    // Some endpoints return 200 with empty body
    const text = await this.request(method, path, body);
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  /** Raw response body, for the endpoints that answer in text (metrics export). */
  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<string> {
    const url = path.startsWith("http") ? path : `${this.host}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
    const requestBody =
      body && (method === "POST" || method === "PUT" || method === "PATCH")
        ? JSON.stringify(body)
        : undefined;

    // Route through the host's HTTPS agent when a custom CA is configured.
    // Self-hosted Databricks workspaces commonly sit behind private TLS CAs.
    if (this.caCert && this.services?.http) {
      const result = await this.services.http.request({
        url,
        method,
        headers,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
        caCert: this.caCert,
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Databricks ${method} ${path} failed: ${result.status} ${result.body}`);
      }
      return result.body ?? "";
    }

    const init: RequestInit = { method, headers };
    if (requestBody !== undefined) {
      init.body = requestBody;
    }

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Databricks ${method} ${path} failed: ${res.status} ${text}`);
    }
    return res.text();
  }

  // -------------------------------------------------------------------------
  // Warehouse sink: cost exports load into a UC table (see warehouse-sink.ts).
  // -------------------------------------------------------------------------

  private get sinkApi(): SinkApiFn {
    return <T>(method: string, path: string, body?: Record<string, unknown>) =>
      this.api<T>(method, path, body);
  }

  listWarehouseTargetOptions(
    _accountId: string,
    fieldKey: string,
    target: Record<string, string>,
  ): Promise<CredentialFieldOption[]> {
    return listDatabricksTargetOptions(this.sinkApi, fieldKey, target);
  }

  loadWarehouseRows(
    _accountId: string,
    request: WarehouseLoadRequest,
  ): Promise<WarehouseLoadResult> {
    return loadDatabricksRows(this.sinkApi, request);
  }

  async describeWarehouseSetup(
    _accountId: string,
    target: Record<string, string>,
  ): Promise<WarehouseSetupGuide> {
    return databricksSetupGuide(target, await databricksPrincipal(this.sinkApi));
  }

  private makeId(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  private get ctx(): ListerContext {
    return {
      api: <T>(method: string, path: string, body?: Record<string, unknown>) =>
        this.api<T>(method, path, body),
      id: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      now: () => new Date().toISOString(),
      host: this.host,
    };
  }

  private static readonly LISTERS: Record<
    string,
    (ctx: ListerContext, accountId: string) => Promise<ResourceInstance[]>
  > = {
    "databricks-cluster": listClusters,
    "databricks-sql-warehouse": listSqlWarehouses,
    "databricks-serving-endpoint": listServingEndpoints,
    "databricks-job": listJobs,
    "databricks-pipeline": listPipelines,
    "databricks-cluster-policy": listClusterPolicies,
    "databricks-node-type": listNodeTypes,
    "databricks-workspace-object": listWorkspaceObjects,
    "databricks-repo": listRepos,
    "databricks-dashboard": listDashboards,
    "databricks-sql-query": listSqlQueries,
    "databricks-catalog": listCatalogs,
    "databricks-registered-model": listRegisteredModels,
    "databricks-model-version": async () => [],
    "databricks-vector-search-endpoint": listVectorSearchEndpoints,
    "databricks-app": listApps,
    "databricks-secret-scope": listSecretScopes,
    "databricks-lakebase-project": listLakebaseProjects,
  };

  private static resourceField(resource: ResourceInstance, fieldKey: string): string {
    return String(resource.fields[fieldKey] ?? resource.externalId ?? "").trim();
  }

  private async getSingleTaskJobSettings(jobId: number): Promise<Record<string, unknown>> {
    const job = await this.api<{ settings?: Record<string, unknown> }>(
      "GET",
      `/api/2.2/jobs/get?job_id=${encodeURIComponent(String(jobId))}`,
    );
    const settings = { ...(job.settings ?? {}) };
    const tasks = settings["tasks"];
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error("Databricks plugin: job has no task to update.");
    }
    if (tasks.length > 1) {
      throw new Error(
        "Databricks plugin: job has multiple tasks; select a task before attaching compute.",
      );
    }
    settings["tasks"] = tasks.map((task) => ({ ...(task as Record<string, unknown>) }));
    return settings;
  }

  private async getPipelineSpec(pipelineId: string): Promise<Record<string, unknown>> {
    const pipeline = await this.api<{ spec?: Record<string, unknown> }>(
      "GET",
      `/api/2.0/pipelines/${encodeURIComponent(pipelineId)}`,
    );
    return { ...(pipeline.spec ?? {}) };
  }

  private async getServingEndpointConfig(name: string): Promise<Record<string, unknown>> {
    const endpoint = await this.api<{ config?: Record<string, unknown> }>(
      "GET",
      `/api/2.0/serving-endpoints/${encodeURIComponent(name)}`,
    );
    return { ...(endpoint.config ?? {}) };
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    // Child resource types need parent context
    if (typeId === "databricks-schema") {
      // List schemas for all catalogs
      const catalogs = await listCatalogs(this.ctx, accountId);
      const results: ResourceInstance[] = [];
      for (const cat of catalogs) {
        try {
          const schemas = await listSchemas(this.ctx, accountId, String(cat.fields["name"]));
          results.push(...schemas);
        } catch {
          // Skip catalogs we can't access
        }
      }
      return results;
    }

    if (typeId === "databricks-table") {
      // List tables for all schemas in all catalogs
      const catalogs = await listCatalogs(this.ctx, accountId);
      const results: ResourceInstance[] = [];
      for (const cat of catalogs) {
        try {
          const schemas = await listSchemas(this.ctx, accountId, String(cat.fields["name"]));
          for (const schema of schemas) {
            try {
              const tables = await listTables(
                this.ctx,
                accountId,
                String(schema.fields["catalogName"]),
                String(schema.fields["name"]),
              );
              results.push(...tables);
            } catch {
              // Skip schemas we can't access
            }
          }
        } catch {
          // Skip catalogs we can't access
        }
      }
      return results;
    }

    if (typeId === "databricks-volume" || typeId === "databricks-function") {
      const catalogs = await listCatalogs(this.ctx, accountId);
      const results: ResourceInstance[] = [];
      for (const cat of catalogs) {
        try {
          const schemas = await listSchemas(this.ctx, accountId, String(cat.fields["name"]));
          for (const schema of schemas) {
            try {
              const catalogName = String(schema.fields["catalogName"]);
              const schemaName = String(schema.fields["name"]);
              const resources =
                typeId === "databricks-volume"
                  ? await listVolumes(this.ctx, accountId, catalogName, schemaName)
                  : await listFunctions(this.ctx, accountId, catalogName, schemaName);
              results.push(...resources);
            } catch {
              // Skip schemas where this principal cannot browse the child object type.
            }
          }
        } catch {
          // Skip catalogs we can't access.
        }
      }
      return results;
    }

    if (typeId === "databricks-vector-search-index") {
      const endpoints = await listVectorSearchEndpoints(this.ctx, accountId);
      const results: ResourceInstance[] = [];
      for (const endpoint of endpoints) {
        try {
          results.push(
            ...(await listVectorSearchIndexes(
              this.ctx,
              accountId,
              String(endpoint.fields["name"]),
            )),
          );
        } catch {
          // Skip endpoints where index listing is not allowed.
        }
      }
      return results;
    }

    if (typeId === "databricks-lakebase-branch") {
      const projects = await listLakebaseProjects(this.ctx, accountId);
      const perProject = await Promise.all(
        projects.map(async (project) => {
          try {
            return await listLakebaseBranches(this.ctx, accountId, String(project.externalId));
          } catch {
            // Skip projects whose branches this principal cannot read.
            return [];
          }
        }),
      );
      return perProject.flat();
    }

    if (typeId === "databricks-model-version") {
      const models = await listRegisteredModels(this.ctx, accountId);
      const results: ResourceInstance[] = [];
      for (const model of models) {
        try {
          results.push(...(await listModelVersions(this.ctx, accountId, String(model.externalId))));
        } catch {
          // Skip models where version listing is not allowed.
        }
      }
      return results;
    }

    const lister = DatabricksClient.LISTERS[typeId];
    if (!lister) throw new Error(`Databricks plugin: unknown resource type "${typeId}"`);
    return lister(this.ctx, accountId);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) {
      throw new Error(`Databricks plugin: resource ${typeId}/${resourceId} not found`);
    }
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value === undefined) {
      throw new Error(
        `Databricks plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    }
    return String(value);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "databricks-sql-warehouse": {
        const state = String(f.state ?? "unknown");
        return [
          {
            label: "State",
            value: state,
            variant:
              state === "RUNNING"
                ? "status-healthy"
                : state === "STOPPED"
                  ? "status-error"
                  : "status-degraded",
          },
        ];
      }
      case "databricks-job": {
        return [{ label: "State", value: String(f.state ?? "unknown") }];
      }
      case "databricks-pipeline": {
        return [{ label: "State", value: String(f.state ?? "unknown") }];
      }
      case "databricks-cluster": {
        const state = String(f.state ?? "unknown");
        return [
          {
            label: "State",
            value: state,
            variant:
              state === "RUNNING"
                ? "status-healthy"
                : state === "TERMINATED" || state === "ERROR"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Node Type", value: String(f.nodeTypeId ?? "") },
          { label: "Workers", value: String(f.numWorkers ?? 0) },
        ];
      }
      case "databricks-catalog": {
        const stats: DashboardStat[] = [{ label: "Owner", value: String(f.owner ?? "") }];
        if (f.catalogType) stats.push({ label: "Type", value: String(f.catalogType) });
        if (f.schemaCount != null) stats.push({ label: "Schemas", value: String(f.schemaCount) });
        return stats;
      }
      case "databricks-schema": {
        const stats: DashboardStat[] = [{ label: "Catalog", value: String(f.catalogName ?? "") }];
        if (f.owner) stats.push({ label: "Owner", value: String(f.owner) });
        if (f.tableCount != null) stats.push({ label: "Tables", value: String(f.tableCount) });
        return stats;
      }
      case "databricks-table": {
        return [
          { label: "Type", value: String(f.tableType ?? "") },
          { label: "Schema", value: String(f.schemaName ?? "") },
          ...(f.dataSourceFormat ? [{ label: "Format", value: String(f.dataSourceFormat) }] : []),
          ...(f.columnCount != null ? [{ label: "Columns", value: String(f.columnCount) }] : []),
        ];
      }
      case "databricks-cluster-policy": {
        return [
          { label: "Creator", value: String(f.creatorUserName ?? "") },
          { label: "Default", value: f.isDefault ? "Yes" : "No" },
          ...(f.maxClustersPerUser
            ? [{ label: "Max/User", value: String(f.maxClustersPerUser) }]
            : []),
        ];
      }
      case "databricks-node-type": {
        return [
          { label: "Category", value: String(f.category ?? "") },
          { label: "Cores", value: String(f.numCores ?? 0) },
          { label: "Memory", value: `${String(f.memoryMb ?? 0)} MB` },
        ];
      }
      case "databricks-dashboard": {
        return [
          { label: "State", value: String(f.lifecycleState ?? "") },
          ...(f.warehouseId ? [{ label: "Warehouse", value: String(f.warehouseId) }] : []),
        ];
      }
      case "databricks-sql-query": {
        return [
          ...(f.catalog ? [{ label: "Catalog", value: String(f.catalog) }] : []),
          ...(f.schema ? [{ label: "Schema", value: String(f.schema) }] : []),
          ...(f.owner ? [{ label: "Owner", value: String(f.owner) }] : []),
        ];
      }
      case "databricks-volume": {
        return [
          { label: "Type", value: String(f.volumeType ?? "") },
          { label: "Schema", value: String(f.schemaName ?? "") },
          ...(f.storageLocation ? [{ label: "Storage", value: String(f.storageLocation) }] : []),
        ];
      }
      case "databricks-function": {
        return [
          { label: "Return", value: String(f.dataType ?? "") },
          { label: "Body", value: String(f.routineBody ?? "") },
          ...(f.owner ? [{ label: "Owner", value: String(f.owner) }] : []),
        ];
      }
      case "databricks-registered-model": {
        return [
          { label: "Schema", value: String(f.schemaName ?? "") },
          ...(f.owner ? [{ label: "Owner", value: String(f.owner) }] : []),
          ...(f.aliasCount != null ? [{ label: "Aliases", value: String(f.aliasCount) }] : []),
        ];
      }
      case "databricks-model-version": {
        return [
          { label: "Model", value: String(f.fullName ?? "") },
          { label: "Version", value: String(f.version ?? "") },
          ...(f.status ? [{ label: "Status", value: String(f.status) }] : []),
        ];
      }
      case "databricks-vector-search-endpoint": {
        return [
          { label: "State", value: String(f.state ?? "") },
          ...(f.endpointType ? [{ label: "Type", value: String(f.endpointType) }] : []),
        ];
      }
      case "databricks-vector-search-index": {
        return [
          { label: "Endpoint", value: String(f.endpointName ?? "") },
          { label: "Type", value: String(f.indexType ?? "") },
          ...(f.indexSubtype ? [{ label: "Subtype", value: String(f.indexSubtype) }] : []),
        ];
      }
      case "databricks-app": {
        return [
          { label: "App", value: String(f.appStatus ?? "") },
          ...(f.computeStatus ? [{ label: "Compute", value: String(f.computeStatus) }] : []),
          ...(f.computeSize ? [{ label: "Size", value: String(f.computeSize) }] : []),
        ];
      }
      case "databricks-lakebase-project": {
        return [
          { label: "Postgres", value: String(f.pgVersion ?? "") },
          { label: "Compute", value: `${String(f.minCu ?? 0)}-${String(f.maxCu ?? 0)} CU` },
          {
            label: "Scale to zero",
            value: f.suspendTimeoutSeconds ? `${Number(f.suspendTimeoutSeconds) / 60} min` : "Off",
          },
        ];
      }
      case "databricks-lakebase-branch": {
        return [
          { label: "State", value: String(f.state ?? "") },
          ...(f.isDefault ? [{ label: "Default", value: "Yes" }] : []),
        ];
      }
      case "databricks-secret-scope": {
        return [
          { label: "Backend", value: String(f.backendType ?? "") },
          ...(f.keyVaultDnsName ? [{ label: "Key Vault", value: String(f.keyVaultDnsName) }] : []),
        ];
      }
      default:
        return [];
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? fields["lastRunState"] ?? "");

    const statusMap: Record<string, ResourceStatus> = {
      RUNNING: "healthy",
      IDLE: "healthy",
      STOPPED: "degraded",
      STOPPING: "degraded",
      PENDING: "provisioning",
      STARTING: "provisioning",
      RESTARTING: "provisioning",
      RESIZING: "provisioning",
      RESETTING: "provisioning",
      TERMINATING: "degraded",
      TERMINATED: "error",
      ERROR: "error",
      FAILED: "error",
      DELETED: "error",
      DELETING: "error",
      SUCCEEDED: "healthy",
      SUCCESS: "healthy",
      READY: "healthy",
      INIT: "provisioning",
      ARCHIVED: "degraded",
    };
    const dotStatus = statusMap[state] ?? "info";

    const typeLabels: Record<string, string> = {
      "databricks-cluster": "Cluster",
      "databricks-sql-warehouse": "SQL Warehouse",
      "databricks-serving-endpoint": "Model Serving Endpoint",
      "databricks-job": "Job",
      "databricks-pipeline": "Pipeline",
      "databricks-cluster-policy": "Cluster Policy",
      "databricks-node-type": "Node Type",
      "databricks-workspace-object": "Workspace Object",
      "databricks-repo": "Git Folder",
      "databricks-dashboard": "AI/BI Dashboard",
      "databricks-sql-query": "SQL Query",
      "databricks-catalog": "Catalog",
      "databricks-schema": "Schema",
      "databricks-table": "Table",
      "databricks-volume": "Volume",
      "databricks-function": "Function",
      "databricks-registered-model": "Registered Model",
      "databricks-vector-search-endpoint": "Vector Search Endpoint",
      "databricks-vector-search-index": "Vector Search Index",
      "databricks-app": "App",
      "databricks-secret-scope": "Secret Scope",
      "databricks-lakebase-project": "Lakebase Project",
      "databricks-lakebase-branch": "Lakebase Branch",
    };
    const typeLabel = typeLabels[resource.resourceTypeId] ?? resource.resourceTypeId;

    const detail: DetailViewSchema = {
      title: resource.displayName,
      subtitle: `${typeLabel} \u00B7 Databricks`,
      status: state
        ? { kind: "status-dot", status: dotStatus, label: state }
        : { kind: "status-dot", status: "info" },
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
        ...(() => {
          const outputItems = labeledOutputItems(
            resource.resolvedOutputs,
            this.resourceTypes,
            resource.resourceTypeId,
          );
          return outputItems.length > 0
            ? [
                {
                  kind: "section" as const,
                  title: "Outputs",
                  children: [{ kind: "key-value-list" as const, items: outputItems }],
                },
              ]
            : [];
        })(),
      ],
      headerActions: [
        ...this.lifecycleActions(resource),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };

    const runsSection = this.recentRunsSection(fields);
    if (runsSection) detail.sections.push(runsSection);

    if (resource.resourceTypeId === "databricks-serving-endpoint") {
      const ready = String(fields["state"] ?? "") === "READY";
      detail.chatPanel = {
        tabLabel: "Playground",
        subtitle: `Chat with ${resource.displayName}`,
        greeting:
          "Send a prompt to test this serving endpoint. The full conversation is sent each turn.",
        inputPlaceholder: "Send a message…",
        ...(ready
          ? {}
          : {
              disabledReason: "Endpoint isn't READY yet. Wait for it to come online and reload.",
            }),
      };
    }

    if (LOG_TYPES.has(resource.resourceTypeId)) {
      detail.logs = { defaultTailLines: 200 };
    }

    return withMetricsCapability(
      detail,
      this.resourceTypes,
      resource.resourceTypeId,
      METRIC_WINDOWS[resource.resourceTypeId],
    );
  }

  /**
   * State-dependent operational buttons. Each dispatches to `invokeAction`;
   * the cluster/warehouse/app start and stop ids double as the `lifecycle`
   * pair the sleep/wake scheduler uses.
   */
  private lifecycleActions(resource: ResourceInstance): ActionNode[] {
    const f = resource.fields;
    const action = (
      label: string,
      actionId: string,
      opts: { confirm?: string; success?: string; danger?: boolean } = {},
    ): ActionNode => ({
      kind: "action",
      label,
      ...(opts.danger ? { variant: "danger" as const } : {}),
      action: {
        type: "plugin-action",
        actionId,
        ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
        successMessage: opts.success ?? `${label} requested.`,
      },
    });
    switch (resource.resourceTypeId) {
      case "databricks-cluster": {
        const state = String(f["state"] ?? "");
        if (state === "TERMINATED" || state === "ERROR") return [action("Start", "start")];
        if (state === "RUNNING" || state === "RESIZING") {
          return [
            action("Restart", "restart", {
              confirm: "Restart this cluster? Running notebooks and jobs on it are interrupted.",
            }),
            action("Terminate", "terminate", {
              confirm:
                "Terminate this cluster? Its configuration is kept and it can be started again.",
              danger: true,
            }),
          ];
        }
        return [];
      }
      case "databricks-sql-warehouse": {
        const state = String(f["state"] ?? "");
        if (state === "STOPPED") return [action("Start", "start")];
        if (state === "RUNNING" || state === "STARTING") {
          return [
            action("Stop", "stop", {
              confirm: "Stop this warehouse? Running queries are cancelled.",
              danger: true,
            }),
          ];
        }
        return [];
      }
      case "databricks-job":
        return [
          action("Run now", "run-now", { success: "Run started." }),
          action("Cancel runs", "cancel-all-runs", {
            confirm: "Cancel every active run of this job?",
            success: "Cancellation requested.",
          }),
        ];
      case "databricks-pipeline": {
        const state = String(f["state"] ?? "");
        if (state === "RUNNING") {
          return [
            action("Stop", "stop", {
              confirm: "Stop the active update of this pipeline?",
              danger: true,
            }),
          ];
        }
        return [
          action("Start update", "start-update", { success: "Update started." }),
          action("Full refresh", "full-refresh", {
            confirm:
              "Run a full refresh? Every table in the pipeline is truncated and recomputed from the source data.",
            success: "Full refresh started.",
          }),
        ];
      }
      case "databricks-app": {
        const compute = String(f["computeStatus"] ?? "");
        if (compute === "STOPPED" || compute === "ERROR") return [action("Start", "start")];
        if (compute === "ACTIVE" || compute === "UPDATING") {
          return [
            action("Stop", "stop", {
              confirm: "Stop this app? Its URL stops serving until the app is started again.",
              danger: true,
            }),
          ];
        }
        return [];
      }
      default:
        return [];
    }
  }

  /**
   * Recent runs of a job, read by `enrichDetail` from
   * `GET /api/2.2/jobs/runs/list` and stashed as JSON in `__recentRuns`.
   */
  private recentRunsSection(fields: Record<string, unknown>): SectionNode | null {
    const raw = fields["__recentRuns"];
    if (typeof raw !== "string" || !raw) return null;
    let runs: Array<Record<string, unknown>> = [];
    try {
      runs = JSON.parse(raw) as Array<Record<string, unknown>>;
    } catch {
      return null;
    }
    return {
      kind: "section",
      title: `Recent runs (${runs.length})`,
      children:
        runs.length === 0
          ? [{ kind: "text", variant: "muted", content: "This job has not run yet." }]
          : [
              {
                kind: "table",
                columns: [
                  { key: "run", label: "Run" },
                  { key: "state", label: "State" },
                  { key: "result", label: "Result" },
                  { key: "trigger", label: "Trigger" },
                  { key: "started", label: "Started" },
                  { key: "duration", label: "Duration" },
                ],
                rows: runs.map((r) => ({
                  cells: {
                    run: String(r["runId"] ?? ""),
                    state: String(r["state"] ?? ""),
                    result: String(r["result"] || "-"),
                    trigger: String(r["trigger"] || "-"),
                    started: String(r["started"] || "-"),
                    duration: String(r["duration"] || "-"),
                  },
                })),
                emphasizeFirstColumn: true,
              },
            ],
    };
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "databricks-job") return resource;
    const jobId = String(resource.fields["jobId"] ?? resource.externalId ?? "");
    if (!jobId) return resource;
    try {
      const data = await this.api<{ runs?: Array<Record<string, unknown>> }>(
        "GET",
        `/api/2.2/jobs/runs/list?job_id=${encodeURIComponent(jobId)}&limit=10`,
      );
      const runs = (data.runs ?? []).map((r) => {
        const state = (r["state"] as Record<string, unknown> | undefined) ?? {};
        const status = (r["status"] as Record<string, unknown> | undefined) ?? {};
        const termination =
          (status["termination_details"] as Record<string, unknown> | undefined) ?? {};
        const start = Number(r["start_time"] ?? 0);
        const end = Number(r["end_time"] ?? 0);
        const durationMs = Number(r["run_duration"] ?? 0) || (start && end ? end - start : 0);
        return {
          runId: String(r["run_id"] ?? ""),
          state: String(status["state"] ?? state["life_cycle_state"] ?? ""),
          result: String(termination["code"] ?? state["result_state"] ?? ""),
          trigger: String(r["trigger"] ?? ""),
          started: start ? new Date(start).toISOString().replace("T", " ").slice(0, 19) : "",
          duration: durationMs ? formatDuration(durationMs) : "",
        };
      });
      return { ...resource, fields: { ...resource.fields, __recentRuns: JSON.stringify(runs) } };
    } catch {
      return resource;
    }
  }

  /**
   * Metrics per type; see `observability.ts` for where each series comes
   * from. A failed source drops its series rather than the whole tab, so a
   * workspace without system-table grants still charts cluster worker counts.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (!externalId) return [];
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs =
      timeRange?.startMs ?? endMs - (METRIC_WINDOWS[resourceTypeId] ?? 24 * 3_600_000);
    const id = encodeURIComponent(externalId);
    switch (resourceTypeId) {
      case "databricks-serving-endpoint": {
        const body = await this.request("GET", `/api/2.0/serving-endpoints/${id}/metrics`);
        return servingEndpointSeries(body, Date.now());
      }
      case "databricks-cluster": {
        const [events, nodes] = await Promise.allSettled([
          this.clusterEvents(externalId, startMs, endMs),
          this.nodeTimeline(externalId, startMs, endMs),
        ]);
        return [
          ...(nodes.status === "fulfilled" ? nodes.value : []),
          ...(events.status === "fulfilled" ? clusterWorkerSeries(events.value) : []),
        ];
      }
      case "databricks-sql-warehouse": {
        const queries = await this.queryHistory(externalId, startMs, endMs);
        return warehouseQuerySeries(queries, startMs, endMs);
      }
      case "databricks-job": {
        const runs: JobRun[] = [];
        let pageToken = "";
        // runs/list caps `limit` at 25; eight pages is 200 runs, enough for
        // an hourly job over a week without walking a busy job's whole history.
        for (let page = 0; page < 8; page++) {
          const data = await this.api<{ runs?: JobRun[]; next_page_token?: string }>(
            "GET",
            `/api/2.2/jobs/runs/list?job_id=${id}&limit=25&start_time_from=${Math.floor(startMs)}` +
              `&start_time_to=${Math.ceil(endMs)}` +
              (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""),
          );
          runs.push(...(data.runs ?? []));
          if (!data.next_page_token) break;
          pageToken = data.next_page_token;
        }
        return jobRunSeries(runs);
      }
      default:
        return [];
    }
  }

  /** Cluster activity events in a window, newest first, up to 1,000. */
  private async clusterEvents(
    clusterId: string,
    startMs?: number,
    endMs?: number,
    max = 1000,
  ): Promise<ClusterEvent[]> {
    const events: ClusterEvent[] = [];
    let pageToken = "";
    while (events.length < max) {
      const data = await this.api<{ events?: ClusterEvent[]; next_page_token?: string }>(
        "POST",
        "/api/2.1/clusters/events",
        {
          cluster_id: clusterId,
          order: "DESC",
          page_size: Math.min(500, max - events.length),
          ...(startMs !== undefined ? { start_time: Math.floor(startMs) } : {}),
          ...(endMs !== undefined ? { end_time: Math.ceil(endMs) } : {}),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      );
      events.push(...(data.events ?? []));
      if (!data.next_page_token || (data.events ?? []).length === 0) break;
      pageToken = data.next_page_token;
    }
    return events;
  }

  /**
   * Per-node utilisation from `system.compute.node_timeline`. Only runs on a
   * warehouse that is already RUNNING: the Metrics tab refreshes on its own,
   * and waking a stopped warehouse for every refresh would bill compute the
   * user never asked for. No running warehouse, or no grant on
   * `system.compute`, simply means no utilisation series.
   */
  private async nodeTimeline(
    clusterId: string,
    startMs: number,
    endMs: number,
  ): Promise<MetricSeries[]> {
    if (!CLUSTER_ID.test(clusterId)) return [];
    const data = await this.api<{ warehouses?: Array<{ id?: string; state?: string }> }>(
      "GET",
      "/api/2.0/sql/warehouses",
    );
    const warehouseId = (data.warehouses ?? []).find((w) => w.state === "RUNNING")?.id;
    if (!warehouseId) return [];
    const result = await this.api<{
      status?: { state?: string };
      manifest?: { schema?: { columns?: Array<{ name: string }> } };
      result?: { data_array?: unknown[][] };
    }>("POST", "/api/2.0/sql/statements", {
      warehouse_id: warehouseId,
      statement: nodeTimelineSql(clusterId, startMs, endMs, bucketSeconds(startMs, endMs)),
      wait_timeout: "30s",
      on_wait_timeout: "CANCEL",
      disposition: "INLINE",
      format: "JSON_ARRAY",
    });
    if (result.status?.state !== "SUCCEEDED") return [];
    return nodeTimelineSeries(
      (result.manifest?.schema?.columns ?? []).map((c) => c.name),
      result.result?.data_array ?? [],
    );
  }

  /** Query history for one warehouse; the API caps a filter window at 30 days. */
  private async queryHistory(
    warehouseId: string,
    startMs: number,
    endMs: number,
  ): Promise<QueryInfo[]> {
    const from = Math.max(Math.floor(startMs), Math.ceil(endMs) - 30 * 86_400_000);
    const base =
      `/api/2.0/sql/history/queries?max_results=1000&include_metrics=true` +
      `&filter_by.warehouse_ids=${encodeURIComponent(warehouseId)}` +
      `&filter_by.query_start_time_range.start_time_ms=${from}` +
      `&filter_by.query_start_time_range.end_time_ms=${Math.ceil(endMs)}`;
    const out: QueryInfo[] = [];
    let pageToken = "";
    // Five pages is 5,000 queries; a warehouse busier than that over the
    // window charts the most recent 5,000.
    for (let page = 0; page < 5; page++) {
      const data = await this.api<{
        res?: QueryInfo[];
        has_next_page?: boolean;
        next_page_token?: string;
      }>("GET", pageToken ? `${base}&page_token=${encodeURIComponent(pageToken)}` : base);
      out.push(...(data.res ?? []));
      if (!data.has_next_page || !data.next_page_token) break;
      pageToken = data.next_page_token;
    }
    return out;
  }

  /**
   * Logs tab: cluster activity events, served-model server and build logs
   * (one dropdown entry each), or the pipeline event log.
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const tail = Math.max(1, Math.min(params.tailLines ?? 200, 1000));
    const id = encodeURIComponent(externalId);
    switch (typeId) {
      case "databricks-cluster": {
        const events = await this.clusterEvents(externalId, undefined, undefined, tail);
        const text = clusterEventLines(events);
        return {
          text: text || "No events recorded for this cluster.\n",
          containers: ["events"],
          activeContainer: "events",
        };
      }
      case "databricks-serving-endpoint": {
        const config = await this.getServingEndpointConfig(externalId);
        const containers = servedEntityNames(config).flatMap((n) => [n, `${n} (build)`]);
        if (containers.length === 0) {
          return {
            text: "This endpoint has no served entities yet.\n",
            containers: [],
            activeContainer: "",
          };
        }
        const active =
          params.container && containers.includes(params.container)
            ? params.container
            : containers[0]!;
        const build = active.endsWith(" (build)");
        const entity = build ? active.slice(0, -" (build)".length) : active;
        try {
          const data = await this.api<{ logs?: string }>(
            "GET",
            `/api/2.0/serving-endpoints/${id}/served-models/${encodeURIComponent(entity)}/${build ? "build-logs" : "logs"}`,
          );
          const lines = (data.logs ?? "").split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          const text = lines.slice(-tail).join("\n");
          return {
            text: text ? `${text}\n` : "No log output yet.\n",
            containers,
            activeContainer: active,
          };
        } catch (err) {
          // Foundation-model and external-model entities have no container,
          // so there is nothing to read; say so instead of failing the tab.
          const message = err instanceof Error ? err.message : String(err);
          return {
            text: `Couldn't load logs for ${entity}: ${message}\n`,
            containers,
            activeContainer: active,
          };
        }
      }
      case "databricks-pipeline": {
        const events: PipelineEvent[] = [];
        let pageToken = "";
        while (events.length < tail) {
          const data = await this.api<{ events?: PipelineEvent[]; next_page_token?: string }>(
            "GET",
            pageToken
              ? `/api/2.0/pipelines/${id}/events?page_token=${encodeURIComponent(pageToken)}`
              : `/api/2.0/pipelines/${id}/events?max_results=${Math.min(tail, 100)}&order_by=${encodeURIComponent("timestamp desc")}`,
          );
          events.push(...(data.events ?? []));
          if (!data.next_page_token || (data.events ?? []).length === 0) break;
          pageToken = data.next_page_token;
        }
        const text = pipelineEventLines(events.slice(0, tail));
        return {
          text: text || "No events recorded for this pipeline.\n",
          containers: ["event log"],
          activeContainer: "event log",
        };
      }
      default:
        return { text: "", containers: [], activeContainer: "" };
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (!externalId) throw new Error("Databricks plugin: cannot determine the resource id");
    const id = encodeURIComponent(externalId);
    switch (`${typeId}:${actionId}`) {
      case "databricks-cluster:start":
        await this.api("POST", "/api/2.1/clusters/start", { cluster_id: externalId });
        return;
      case "databricks-cluster:restart":
        await this.api("POST", "/api/2.1/clusters/restart", { cluster_id: externalId });
        return;
      case "databricks-cluster:terminate":
        // /clusters/delete terminates; /clusters/permanent-delete removes it.
        await this.api("POST", "/api/2.1/clusters/delete", { cluster_id: externalId });
        return;
      case "databricks-sql-warehouse:start":
        await this.api("POST", `/api/2.0/sql/warehouses/${id}/start`);
        return;
      case "databricks-sql-warehouse:stop":
        await this.api("POST", `/api/2.0/sql/warehouses/${id}/stop`);
        return;
      case "databricks-job:run-now":
        await this.api("POST", "/api/2.2/jobs/run-now", { job_id: Number(externalId) });
        return;
      case "databricks-job:cancel-all-runs":
        await this.api("POST", "/api/2.2/jobs/runs/cancel-all", { job_id: Number(externalId) });
        return;
      case "databricks-pipeline:start-update":
        await this.api("POST", `/api/2.0/pipelines/${id}/updates`, { cause: "API_CALL" });
        return;
      case "databricks-pipeline:full-refresh":
        await this.api("POST", `/api/2.0/pipelines/${id}/updates`, {
          full_refresh: true,
          cause: "API_CALL",
        });
        return;
      case "databricks-pipeline:stop":
        await this.api("POST", `/api/2.0/pipelines/${id}/stop`);
        return;
      case "databricks-app:start":
        await this.api("POST", `/api/2.0/apps/${id}/start`);
        return;
      case "databricks-app:stop":
        await this.api("POST", `/api/2.0/apps/${id}/stop`);
        return;
      default:
        throw new Error(
          `Databricks plugin: invokeAction "${actionId}" not supported for type "${typeId}"`,
        );
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const has = (key: string) => fields[key] !== undefined && fields[key] !== "";
    switch (typeId) {
      case "databricks-cluster": {
        // Resize is the one cluster change that needs no full spec and no
        // restart; other settings go through /clusters/edit in the console.
        if (has("minWorkers") || has("maxWorkers")) {
          const current = await this.getResource(typeId, resourceId, accountId);
          const min = Number(
            has("minWorkers") ? fields["minWorkers"] : current.fields["minWorkers"],
          );
          const max = Number(
            has("maxWorkers") ? fields["maxWorkers"] : current.fields["maxWorkers"],
          );
          if (!(max >= min && min >= 0 && max > 0)) {
            throw new Error("Max workers must be at least min workers and greater than 0");
          }
          await this.api("POST", "/api/2.1/clusters/resize", {
            cluster_id: externalId,
            autoscale: { min_workers: min, max_workers: max },
          });
        } else if (has("numWorkers")) {
          await this.api("POST", "/api/2.1/clusters/resize", {
            cluster_id: externalId,
            num_workers: Number(fields["numWorkers"]),
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "databricks-sql-warehouse": {
        // /edit takes the warehouse's settings as a whole; start from the
        // current definition so untouched settings (tags, channel) survive.
        const current = await this.api<Record<string, unknown>>(
          "GET",
          `/api/2.0/sql/warehouses/${encodeURIComponent(externalId)}`,
        );
        const body: Record<string, unknown> = {};
        for (const key of [
          "name",
          "cluster_size",
          "min_num_clusters",
          "max_num_clusters",
          "auto_stop_mins",
          "enable_photon",
          "enable_serverless_compute",
          "warehouse_type",
          "spot_instance_policy",
          "channel",
          "tags",
        ]) {
          if (current[key] !== undefined) body[key] = current[key];
        }
        if (has("name")) body["name"] = fields["name"];
        if (has("clusterSize")) {
          if (!WAREHOUSE_SIZES.includes(fields["clusterSize"]!)) {
            throw new Error(`Unknown warehouse size "${fields["clusterSize"]}"`);
          }
          body["cluster_size"] = fields["clusterSize"];
        }
        if (has("minNumClusters")) body["min_num_clusters"] = Number(fields["minNumClusters"]);
        if (has("maxNumClusters")) body["max_num_clusters"] = Number(fields["maxNumClusters"]);
        if (has("autoStopMinutes")) body["auto_stop_mins"] = Number(fields["autoStopMinutes"]);
        if (has("enablePhoton")) body["enable_photon"] = fields["enablePhoton"] === "true";
        if (has("spotInstancePolicy")) body["spot_instance_policy"] = fields["spotInstancePolicy"];
        await this.api(
          "POST",
          `/api/2.0/sql/warehouses/${encodeURIComponent(externalId)}/edit`,
          body,
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      case "databricks-lakebase-project": {
        const spec: Record<string, unknown> = {};
        const mask: string[] = [];
        if (has("displayName")) {
          spec["display_name"] = fields["displayName"];
          mask.push("spec.display_name");
        }
        if (has("historyRetentionHours")) {
          const hours = Number(fields["historyRetentionHours"]);
          if (!(hours >= 48 && hours <= 840)) {
            throw new Error("The restore window must be between 48 and 840 hours");
          }
          spec["history_retention_duration"] = `${Math.round(hours * 3600)}s`;
          mask.push("spec.history_retention_duration");
        }
        if (has("minCu") || has("maxCu") || has("suspendTimeoutSeconds")) {
          const current = await this.getResource(typeId, resourceId, accountId);
          const pick = (key: string) => Number(has(key) ? fields[key] : (current.fields[key] ?? 0));
          const settings: Record<string, unknown> = {
            autoscaling_limit_min_cu: pick("minCu"),
            autoscaling_limit_max_cu: pick("maxCu"),
          };
          const suspend = pick("suspendTimeoutSeconds");
          if (suspend > 0) settings["suspend_timeout_duration"] = `${Math.round(suspend)}s`;
          else settings["no_suspension"] = true;
          spec["default_endpoint_settings"] = settings;
          mask.push("spec.default_endpoint_settings");
        }
        if (mask.length > 0) {
          await this.api(
            "PATCH",
            `/api/2.0/postgres/projects/${encodeURIComponent(externalId)}?update_mask=${mask.join(",")}`,
            { name: `projects/${externalId}`, spec },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Databricks plugin: update not supported for type "${typeId}"`);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const state = String(resource.fields["state"] ?? resource.fields["lastRunState"] ?? "");
    const statusMap: Record<string, ResourceStatus> = {
      RUNNING: "healthy",
      IDLE: "healthy",
      STOPPED: "degraded",
      TERMINATED: "error",
      ERROR: "error",
      FAILED: "error",
    };
    return {
      id: resource.id,
      label: resource.displayName,
      status: {
        kind: "status-dot",
        status: statusMap[state] ?? "info",
      },
    };
  }

  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    messages: ChatMessage[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (typeId !== "databricks-serving-endpoint") {
      yield {
        kind: "error",
        message: `Databricks plugin: streamChatMessage not supported for type "${typeId}".`,
      };
      return;
    }
    const name = resourceId.split(":").slice(2).join(":");
    if (!name) {
      yield { kind: "error", message: "Couldn't determine the serving endpoint name." };
      return;
    }

    const endpoint = `${this.host}/serving-endpoints/${encodeURIComponent(name)}/invocations`;
    const body = JSON.stringify({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body,
      });
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      yield {
        kind: "error",
        message: `Serving endpoint returned ${res.status}: ${errText || res.statusText}`,
      };
      return;
    }

    yield* streamOpenAiSseChat(res.body);
  }

  async executeQuery(
    resourceId: string,
    accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const resource = await this.getResource("databricks-sql-warehouse", resourceId, accountId);
    const warehouseId = String(resource.fields["warehouseId"]);
    const start = Date.now();

    const result = await this.api<{
      statement_id?: string;
      status?: { state?: string; error?: { message?: string } };
      manifest?: { schema?: { columns?: Array<{ name: string; type_name: string }> } };
      result?: {
        data_array?: unknown[][];
        chunk_index?: number;
        row_count?: number;
      };
    }>("POST", "/api/2.0/sql/statements", {
      warehouse_id: warehouseId,
      statement: sql,
      wait_timeout: "30s",
      disposition: "INLINE",
      format: "JSON_ARRAY",
    });

    const status = result.status?.state ?? "FAILED";
    if (status === "FAILED") {
      throw new Error(`SQL execution failed: ${result.status?.error?.message ?? "unknown error"}`);
    }

    // If still pending/running, poll until complete
    let finalResult = result;
    if (status === "PENDING" || status === "RUNNING") {
      const statementId = result.statement_id!;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        finalResult = await this.api<typeof result>(
          "GET",
          `/api/2.0/sql/statements/${statementId}`,
        );
        const s = finalResult.status?.state ?? "";
        if (s === "SUCCEEDED") break;
        if (s === "FAILED" || s === "CANCELED" || s === "CLOSED") {
          throw new Error(`SQL execution ${s}: ${finalResult.status?.error?.message ?? ""}`);
        }
      }
    }

    const durationMs = Date.now() - start;
    const columns = finalResult.manifest?.schema?.columns ?? [];
    const dataArray = finalResult.result?.data_array ?? [];

    const rows = dataArray.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]!.name] = row[i];
      }
      return obj;
    });

    return { rows, durationMs };
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchDatabricksCostData(
      <T>(method: string, path: string, body?: Record<string, unknown>) =>
        this.api<T>(method, path, body),
      range,
    );
  }

  async introspectResource(resourceId: string, accountId: string): Promise<SqlTableMeta[]> {
    try {
      const tablesResult = await this.executeQuery(
        resourceId,
        accountId,
        `SELECT table_catalog, table_schema, table_name, column_name, data_type, ordinal_position
         FROM system.information_schema.columns
         WHERE table_schema != 'information_schema'
         ORDER BY table_catalog, table_schema, table_name, ordinal_position
         LIMIT 5000`,
      );

      const tableMap = new Map<string, SqlTableMeta>();
      for (const row of tablesResult.rows) {
        const fullName = `${row["table_catalog"]}.${row["table_schema"]}.${row["table_name"]}`;
        if (!tableMap.has(fullName)) {
          tableMap.set(fullName, { name: fullName, columns: [] });
        }
        tableMap.get(fullName)!.columns.push({
          name: String(row["column_name"] ?? ""),
          type: String(row["data_type"] ?? ""),
        });
      }

      return [...tableMap.values()];
    } catch {
      // If INFORMATION_SCHEMA query fails, return empty
      return [];
    }
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "databricks-job" && targetTypeId === "databricks-cluster") {
      const [job, cluster] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const jobId = Number(DatabricksClient.resourceField(job, "jobId"));
      const clusterId = DatabricksClient.resourceField(cluster, "clusterId");
      if (!Number.isFinite(jobId) || !clusterId) {
        throw new Error("Databricks plugin: missing job ID or cluster ID.");
      }

      const settings = await this.getSingleTaskJobSettings(jobId);
      const task = (settings["tasks"] as Array<Record<string, unknown>>)[0]!;
      if (task["sql_task"] && typeof task["sql_task"] === "object") {
        throw new Error("Databricks plugin: SQL tasks use SQL warehouses, not clusters.");
      }
      delete task["new_cluster"];
      task["existing_cluster_id"] = clusterId;

      await this.api("POST", "/api/2.2/jobs/update", {
        job_id: jobId,
        new_settings: settings,
      });
      return;
    }

    if (sourceTypeId === "databricks-job" && targetTypeId === "databricks-sql-warehouse") {
      const [job, warehouse] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const jobId = Number(DatabricksClient.resourceField(job, "jobId"));
      const warehouseId = DatabricksClient.resourceField(warehouse, "warehouseId");
      if (!Number.isFinite(jobId) || !warehouseId) {
        throw new Error("Databricks plugin: missing job ID or SQL warehouse ID.");
      }

      const settings = await this.getSingleTaskJobSettings(jobId);
      const task = (settings["tasks"] as Array<Record<string, unknown>>)[0]!;
      const sqlTask = task["sql_task"];
      if (!sqlTask || typeof sqlTask !== "object" || Array.isArray(sqlTask)) {
        throw new Error(
          "Databricks plugin: only SQL job tasks can use a Databricks SQL warehouse.",
        );
      }
      delete task["new_cluster"];
      delete task["existing_cluster_id"];
      task["sql_task"] = { ...(sqlTask as Record<string, unknown>), warehouse_id: warehouseId };

      await this.api("POST", "/api/2.2/jobs/update", {
        job_id: jobId,
        new_settings: settings,
      });
      return;
    }

    if (sourceTypeId === "databricks-pipeline" && targetTypeId === "databricks-catalog") {
      const [pipeline, catalog] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const pipelineId = DatabricksClient.resourceField(pipeline, "pipelineId");
      const catalogName = DatabricksClient.resourceField(catalog, "name");
      if (!pipelineId || !catalogName) {
        throw new Error("Databricks plugin: missing pipeline ID or catalog name.");
      }

      const spec = await this.getPipelineSpec(pipelineId);
      await this.api("PUT", `/api/2.0/pipelines/${encodeURIComponent(pipelineId)}`, {
        ...spec,
        catalog: catalogName,
      });
      return;
    }

    if (sourceTypeId === "databricks-pipeline" && targetTypeId === "databricks-schema") {
      const [pipeline, schema] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const pipelineId = DatabricksClient.resourceField(pipeline, "pipelineId");
      const catalogName = DatabricksClient.resourceField(schema, "catalogName");
      const schemaName = DatabricksClient.resourceField(schema, "name");
      if (!pipelineId || !catalogName || !schemaName) {
        throw new Error("Databricks plugin: missing pipeline ID, catalog name, or schema name.");
      }

      const spec = await this.getPipelineSpec(pipelineId);
      delete spec["target"];
      await this.api("PUT", `/api/2.0/pipelines/${encodeURIComponent(pipelineId)}`, {
        ...spec,
        catalog: catalogName,
        schema: schemaName,
      });
      return;
    }

    if (
      sourceTypeId === "databricks-serving-endpoint" &&
      targetTypeId === "databricks-model-version"
    ) {
      const [endpoint, modelVersion] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const endpointName = DatabricksClient.resourceField(endpoint, "name");
      const modelFullName = DatabricksClient.resourceField(modelVersion, "fullName");
      const version = DatabricksClient.resourceField(modelVersion, "version");
      if (!endpointName || !modelFullName || !version) {
        throw new Error("Databricks plugin: missing serving endpoint, model name, or version.");
      }

      const config = await this.getServingEndpointConfig(endpointName);
      const servedEntities = config["served_entities"];
      if (!Array.isArray(servedEntities) || servedEntities.length === 0) {
        throw new Error(
          "Databricks plugin: serving endpoint has no existing served entity to update.",
        );
      }
      if (servedEntities.length > 1) {
        throw new Error(
          "Databricks plugin: serving endpoint has multiple served entities; select one before attaching a model version.",
        );
      }

      await this.api(
        "PUT",
        `/api/2.0/serving-endpoints/${encodeURIComponent(endpointName)}/config`,
        {
          ...config,
          served_entities: [
            {
              ...(servedEntities[0] as Record<string, unknown>),
              entity_name: modelFullName,
              entity_version: version,
            },
          ],
        },
      );
      return;
    }

    throw new Error(
      `Databricks plugin: attachResource not supported for ${sourceTypeId} \u2192 ${targetTypeId}`,
    );
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const resource = await this.getResource(typeId, resourceId, accountId);

    switch (typeId) {
      case "databricks-cluster": {
        const clusterId = String(resource.fields["clusterId"]);
        await this.api("POST", "/api/2.1/clusters/permanent-delete", {
          cluster_id: clusterId,
        });
        break;
      }
      case "databricks-sql-warehouse": {
        const warehouseId = String(resource.fields["warehouseId"]);
        await this.api("DELETE", `/api/2.0/sql/warehouses/${warehouseId}`);
        break;
      }
      case "databricks-job": {
        const jobId = Number(resource.fields["jobId"]);
        await this.api("POST", "/api/2.2/jobs/delete", { job_id: jobId });
        break;
      }
      case "databricks-pipeline": {
        const pipelineId = String(resource.fields["pipelineId"]);
        await this.api("DELETE", `/api/2.0/pipelines/${pipelineId}`);
        break;
      }
      case "databricks-catalog": {
        const catalogName = resource.externalId ?? "";
        if (!catalogName) throw new Error("Missing catalog name");
        await this.api(
          "DELETE",
          `/api/2.1/unity-catalog/catalogs/${encodeURIComponent(catalogName)}`,
        );
        break;
      }
      case "databricks-schema": {
        const fullName = resource.externalId ?? "";
        if (!fullName) throw new Error("Missing schema name");
        await this.api("DELETE", `/api/2.1/unity-catalog/schemas/${encodeURIComponent(fullName)}`);
        break;
      }
      case "databricks-table": {
        const fullName = resource.externalId ?? "";
        if (!fullName) throw new Error("Missing table name");
        await this.api("DELETE", `/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`);
        break;
      }
      case "databricks-lakebase-project": {
        const projectId = resource.externalId ?? "";
        if (!projectId) throw new Error("Missing Lakebase project id");
        await this.api("DELETE", `/api/2.0/postgres/projects/${encodeURIComponent(projectId)}`);
        break;
      }
      case "databricks-lakebase-branch": {
        if (resource.fields["isDefault"]) {
          throw new Error(
            "The default branch cannot be deleted; make another branch the default first",
          );
        }
        const projectId = String(resource.fields["projectId"] ?? "");
        const branchId = String(resource.fields["branchId"] ?? "");
        await this.api(
          "DELETE",
          `/api/2.0/postgres/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
        );
        break;
      }
      default:
        throw new Error(`Databricks plugin: delete not supported for type "${typeId}"`);
    }
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "databricks-lakebase-project") {
      return {
        fields: [
          { key: "displayName", label: "Project Name", kind: "text", required: true },
          {
            key: "projectId",
            label: "Project ID",
            kind: "text",
            required: true,
            description:
              "Permanent identifier: 1-63 lowercase letters, digits and hyphens, starting with a letter.",
            placeholder: "orders-db",
          },
          {
            key: "pgVersion",
            label: "Postgres Version",
            kind: "select",
            required: true,
            options: [
              { id: "18", label: "Postgres 18" },
              { id: "17", label: "Postgres 17", description: "Default" },
              { id: "16", label: "Postgres 16" },
            ],
            defaultValue: "17",
          },
          {
            key: "minCu",
            label: "Min Compute (CU)",
            kind: "number",
            required: false,
            minValue: 0.5,
            stepValue: 0.5,
            defaultValue: "0.5",
          },
          {
            key: "maxCu",
            label: "Max Compute (CU)",
            kind: "number",
            required: false,
            minValue: 0.5,
            stepValue: 0.5,
            defaultValue: "2",
          },
          {
            key: "suspendTimeoutSeconds",
            label: "Scale to zero after",
            kind: "select",
            required: false,
            options: [
              { id: "300", label: "5 minutes" },
              { id: "900", label: "15 minutes" },
              { id: "3600", label: "1 hour" },
              { id: "0", label: "Never (always on)" },
            ],
            defaultValue: "300",
          },
        ],
      };
    }
    if (typeId === "databricks-cluster") {
      const sparkVersionOptions = await this.api<{
        versions?: Array<{ key?: string; name?: string }>;
      }>("GET", "/api/2.1/clusters/spark-versions")
        .then((data) =>
          (data.versions ?? []).map((v) => ({
            id: String(v.key ?? ""),
            label: String(v.name ?? v.key ?? ""),
          })),
        )
        .catch(() => []);
      const nodeTypeOptions = await listNodeTypes(this.ctx, "")
        .then((nodes) =>
          nodes
            .filter((n) => !n.fields["isDeprecated"] && !n.fields["isHidden"])
            // Memory/core detail belongs on the option's second line: appended
            // to the label it just overruns the picker's column and truncates.
            .map((n) => ({
              id: String(n.fields["nodeTypeId"]),
              label: String(n.fields["nodeTypeId"]),
              ...(n.fields["description"] ? { description: String(n.fields["description"]) } : {}),
            })),
        )
        .catch(() => []);
      return {
        fields: [
          { key: "clusterName", label: "Cluster Name", kind: "text", required: true },
          sparkVersionOptions.length > 0
            ? {
                key: "sparkVersion",
                label: "Spark Version",
                kind: "select",
                required: true,
                options: sparkVersionOptions,
                defaultValue: sparkVersionOptions[0]!.id,
              }
            : {
                key: "sparkVersion",
                label: "Spark Version",
                kind: "text",
                required: true,
                defaultValue: "15.4.x-scala2.12",
                description: "e.g. 15.4.x-scala2.12",
              },
          nodeTypeOptions.length > 0
            ? {
                key: "nodeTypeId",
                label: "Node Type",
                kind: "select",
                required: true,
                options: nodeTypeOptions,
                defaultValue: nodeTypeOptions[0]!.id,
              }
            : {
                key: "nodeTypeId",
                label: "Node Type",
                kind: "text",
                required: true,
                defaultValue: "i3.xlarge",
              },
          {
            key: "numWorkers",
            label: "Workers",
            kind: "number",
            required: true,
            defaultValue: "1",
            minValue: 0,
            maxValue: 100,
          },
          {
            key: "autoterminationMinutes",
            label: "Auto-termination (minutes)",
            kind: "number",
            required: false,
            defaultValue: "120",
          },
        ],
      };
    }

    if (typeId === "databricks-sql-warehouse") {
      return {
        fields: [
          { key: "name", label: "Warehouse Name", kind: "text", required: true },
          {
            key: "clusterSize",
            label: "Cluster Size",
            kind: "select",
            required: true,
            options: WAREHOUSE_SIZES.map((size) => ({ id: size, label: size })),
            defaultValue: "Small",
          },
          {
            key: "maxNumClusters",
            label: "Max Clusters",
            kind: "number",
            required: false,
            defaultValue: "1",
            minValue: 1,
          },
          {
            key: "autoStopMinutes",
            label: "Auto-stop (minutes)",
            kind: "number",
            required: false,
            defaultValue: "15",
          },
          {
            key: "enablePhoton",
            label: "Photon",
            kind: "select",
            required: true,
            options: [
              { id: "true", label: "Enabled" },
              { id: "false", label: "Disabled" },
            ],
            defaultValue: "true",
          },
          {
            key: "warehouseType",
            label: "Type",
            kind: "select",
            required: true,
            options: [
              { id: "PRO", label: "Pro" },
              { id: "CLASSIC", label: "Classic" },
              { id: "SERVERLESS", label: "Serverless" },
            ],
            defaultValue: "PRO",
          },
        ],
      };
    }

    if (typeId === "databricks-job") {
      return {
        fields: [
          { key: "name", label: "Job Name", kind: "text", required: true },
          {
            key: "taskType",
            label: "Task Type",
            kind: "select",
            required: true,
            options: [
              { id: "notebook", label: "Notebook" },
              { id: "python", label: "Python Script" },
              { id: "spark_jar", label: "JAR" },
            ],
            defaultValue: "notebook",
          },
          {
            key: "taskPath",
            label: "Task Path / Main Class",
            kind: "text",
            required: true,
            description: "Notebook path, Python file URI, or JAR main class",
          },
          {
            key: "schedule",
            label: "Schedule (Quartz cron)",
            kind: "text",
            required: false,
            description: "e.g. 0 0 12 * * ? (daily at noon)",
          },
        ],
      };
    }

    if (typeId === "databricks-pipeline") {
      return {
        fields: [
          { key: "name", label: "Pipeline Name", kind: "text", required: true },
          { key: "target", label: "Target Schema", kind: "text", required: false },
          { key: "catalog", label: "Catalog", kind: "text", required: false },
          {
            key: "continuous",
            label: "Continuous",
            kind: "select",
            required: true,
            options: [
              { id: "false", label: "Triggered" },
              { id: "true", label: "Continuous" },
            ],
            defaultValue: "false",
          },
          {
            key: "photon",
            label: "Photon",
            kind: "select",
            required: true,
            options: [
              { id: "true", label: "Enabled" },
              { id: "false", label: "Disabled" },
            ],
            defaultValue: "true",
          },
        ],
      };
    }

    if (typeId === "databricks-catalog") {
      return {
        fields: [
          { key: "name", label: "Catalog Name", kind: "text", required: true },
          { key: "comment", label: "Comment", kind: "text", required: false },
        ],
      };
    }

    if (typeId === "databricks-schema") {
      const hasParent = !!parentResourceId;
      const fields: CreateResourceConfig["fields"] = [];
      if (!hasParent) {
        const catalogs = await listCatalogs(this.ctx, "");
        const catalogOptions = catalogs.map((c) => ({
          id: String(c.fields["name"]),
          label: String(c.fields["name"]),
        }));
        fields.push({
          key: "catalogName",
          label: "Catalog",
          kind: "select",
          required: true,
          options: catalogOptions,
          ...(catalogOptions[0] ? { defaultValue: catalogOptions[0].id } : {}),
        });
      }
      fields.push({ key: "name", label: "Schema Name", kind: "text", required: true });
      fields.push({ key: "comment", label: "Comment", kind: "text", required: false });
      return { fields };
    }

    if (typeId === "databricks-table") {
      const hasParent = !!parentResourceId;
      const fields: CreateResourceConfig["fields"] = [];
      if (!hasParent) {
        const catalogs = await listCatalogs(this.ctx, "");
        const catalogOptions = catalogs.map((c) => ({
          id: String(c.fields["name"]),
          label: String(c.fields["name"]),
        }));
        fields.push({
          key: "catalogName",
          label: "Catalog",
          kind: "select",
          required: true,
          options: catalogOptions,
          ...(catalogOptions[0] ? { defaultValue: catalogOptions[0].id } : {}),
        });
        fields.push({
          key: "schemaName",
          label: "Schema",
          kind: "text",
          required: true,
          defaultValue: "default",
        });
      }
      fields.push({ key: "name", label: "Table Name", kind: "text", required: true });
      fields.push({
        key: "tableType",
        label: "Table Type",
        kind: "select",
        required: true,
        options: [
          { id: "MANAGED", label: "Managed" },
          { id: "EXTERNAL", label: "External" },
        ],
        defaultValue: "MANAGED",
      });
      fields.push({
        key: "dataSourceFormat",
        label: "Format",
        kind: "select",
        required: true,
        options: [
          { id: "DELTA", label: "Delta" },
          { id: "PARQUET", label: "Parquet" },
          { id: "CSV", label: "CSV" },
          { id: "JSON", label: "JSON" },
          { id: "AVRO", label: "Avro" },
          { id: "ORC", label: "ORC" },
        ],
        defaultValue: "DELTA",
      });
      fields.push({
        key: "storageLocation",
        label: "Storage Location",
        kind: "text",
        required: false,
        description: "Required for EXTERNAL tables (e.g. s3://bucket/path)",
      });
      fields.push({ key: "comment", label: "Comment", kind: "text", required: false });
      return { fields };
    }

    throw new Error(`Databricks plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const now = new Date().toISOString();
    const host = this.host.replace(/^https?:\/\//, "");

    if (typeId === "databricks-lakebase-project") {
      const projectId = (fields["projectId"] ?? "").trim();
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(projectId)) {
        throw new Error(
          "Project ID must be 1-63 lowercase letters, digits and hyphens, starting with a letter",
        );
      }
      const minCu = Number(fields["minCu"] || 0.5);
      const maxCu = Number(fields["maxCu"] || 2);
      if (!(minCu >= 0.5 && maxCu >= minCu)) {
        throw new Error("Max compute must be at least min compute, and min at least 0.5 CU");
      }
      const suspend = Number(fields["suspendTimeoutSeconds"] ?? 300);
      const endpointSettings: Record<string, unknown> = {
        autoscaling_limit_min_cu: minCu,
        autoscaling_limit_max_cu: maxCu,
        ...(suspend > 0 ? { suspend_timeout_duration: `${suspend}s` } : { no_suspension: true }),
      };
      // Creation is a long-running operation; the project appears in the
      // listing once it finishes provisioning.
      await this.api(
        "POST",
        `/api/2.0/postgres/projects?project_id=${encodeURIComponent(projectId)}`,
        {
          spec: {
            display_name: fields["displayName"] || projectId,
            pg_version: Number(fields["pgVersion"] || 17),
            default_endpoint_settings: endpointSettings,
          },
        },
      );
      return lakebaseProjectToResource(this.ctx, accountId, {
        name: `projects/${projectId}`,
        project_id: projectId,
        create_time: now,
        status: {
          display_name: fields["displayName"] || projectId,
          pg_version: Number(fields["pgVersion"] || 17),
          default_endpoint_settings: endpointSettings,
        },
      });
    }

    if (typeId === "databricks-cluster") {
      const data = await this.api<{ cluster_id: string }>("POST", "/api/2.1/clusters/create", {
        cluster_name: fields["clusterName"] ?? "",
        spark_version: fields["sparkVersion"] ?? "15.4.x-scala2.12",
        node_type_id: fields["nodeTypeId"] ?? "i3.xlarge",
        num_workers: Number(fields["numWorkers"] ?? 1),
        autotermination_minutes: Number(fields["autoterminationMinutes"] ?? 120),
      });
      const clusterId = data.cluster_id;
      return {
        id: `${accountId}:databricks-cluster:${clusterId}`,
        pluginId: "databricks",
        resourceTypeId: "databricks-cluster",
        accountId,
        displayName: fields["clusterName"] ?? clusterId,
        fields: {
          clusterId,
          clusterName: fields["clusterName"] ?? "",
          state: "PENDING",
          sparkVersion: fields["sparkVersion"] ?? "",
          nodeTypeId: fields["nodeTypeId"] ?? "",
          driverNodeTypeId: fields["nodeTypeId"] ?? "",
          numWorkers: Number(fields["numWorkers"] ?? 1),
          autoterminationMinutes: Number(fields["autoterminationMinutes"] ?? 120),
          clusterSource: "API",
          creatorUserName: "",
        },
        resolvedOutputs: {
          clusterId,
          sparkContextId: "",
          jdbcUrl: `jdbc:databricks://${host}:443/default;transportMode=http;ssl=1;httpPath=sql/protocolv1/o/0/${clusterId}`,
        },
        secretStates: [],
        externalId: clusterId,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "databricks-sql-warehouse") {
      const serverless = fields["warehouseType"] === "SERVERLESS";
      const data = await this.api<{ id: string }>("POST", "/api/2.0/sql/warehouses", {
        name: fields["name"] ?? "",
        cluster_size: fields["clusterSize"] ?? "Small",
        max_num_clusters: Number(fields["maxNumClusters"] ?? 1),
        auto_stop_mins: Number(fields["autoStopMinutes"] ?? 15),
        enable_photon: fields["enablePhoton"] !== "false",
        // Serverless is a PRO warehouse with serverless compute switched on.
        warehouse_type: serverless ? "PRO" : (fields["warehouseType"] ?? "PRO"),
        ...(serverless ? { enable_serverless_compute: true } : {}),
      });
      const warehouseId = data.id;
      const httpPath = `/sql/1.0/warehouses/${warehouseId}`;
      return {
        id: `${accountId}:databricks-sql-warehouse:${warehouseId}`,
        pluginId: "databricks",
        resourceTypeId: "databricks-sql-warehouse",
        accountId,
        displayName: fields["name"] ?? warehouseId,
        fields: {
          warehouseId,
          name: fields["name"] ?? "",
          state: "STARTING",
          clusterSize: fields["clusterSize"] ?? "Small",
          minNumClusters: 1,
          maxNumClusters: Number(fields["maxNumClusters"] ?? 1),
          autoStopMinutes: Number(fields["autoStopMinutes"] ?? 15),
          warehouseType: serverless ? "PRO" : (fields["warehouseType"] ?? "PRO"),
          enableServerlessCompute: serverless,
          enablePhoton: fields["enablePhoton"] !== "false",
          numActiveSessions: 0,
          numClusters: 0,
          creatorName: "",
        },
        resolvedOutputs: {
          warehouseId,
          jdbcUrl: `jdbc:databricks://${host}:443/default;transportMode=http;ssl=1;httpPath=${httpPath}`,
          odbcUrl: `Driver=Simba Spark;Host=${host};Port=443;SSL=1;ThriftTransport=2;HTTPPath=${httpPath}`,
        },
        secretStates: [],
        externalId: warehouseId,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "databricks-job") {
      const taskType = fields["taskType"] ?? "notebook";
      const taskPath = fields["taskPath"] ?? "";
      const taskConfig: Record<string, unknown> =
        taskType === "notebook"
          ? { notebook_task: { notebook_path: taskPath } }
          : taskType === "python"
            ? { spark_python_task: { python_file: taskPath } }
            : { spark_jar_task: { main_class_name: taskPath } };

      const body: Record<string, unknown> = {
        name: fields["name"] ?? "",
        tasks: [{ task_key: "main", ...taskConfig }],
      };
      if (fields["schedule"]) {
        body["schedule"] = {
          quartz_cron_expression: fields["schedule"],
          timezone_id: "UTC",
        };
      }
      const data = await this.api<{ job_id: number }>("POST", "/api/2.2/jobs/create", body);
      const jobId = data.job_id;
      return {
        id: `${accountId}:databricks-job:${jobId}`,
        pluginId: "databricks",
        resourceTypeId: "databricks-job",
        accountId,
        displayName: fields["name"] ?? `Job ${jobId}`,
        fields: {
          jobId,
          name: fields["name"] ?? "",
          creatorUserName: "",
          format: "MULTI_TASK",
          lastRunState: "",
          lastRunResult: "",
          schedule: fields["schedule"] ?? "",
          taskCount: 1,
          maxConcurrentRuns: 1,
        },
        resolvedOutputs: {
          jobId: String(jobId),
          jobUrl: `https://${host}/jobs/${jobId}`,
        },
        secretStates: [],
        externalId: String(jobId),
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "databricks-pipeline") {
      const body: Record<string, unknown> = {
        name: fields["name"] ?? "",
        continuous: fields["continuous"] === "true",
        photon: fields["photon"] !== "false",
      };
      if (fields["target"]) body["target"] = fields["target"];
      if (fields["catalog"]) body["catalog"] = fields["catalog"];
      const data = await this.api<{ pipeline_id: string }>("POST", "/api/2.0/pipelines", body);
      const pipelineId = data.pipeline_id;
      return {
        id: `${accountId}:databricks-pipeline:${pipelineId}`,
        pluginId: "databricks",
        resourceTypeId: "databricks-pipeline",
        accountId,
        displayName: fields["name"] ?? pipelineId,
        fields: {
          pipelineId,
          name: fields["name"] ?? "",
          state: "IDLE",
          creatorUserName: "",
          target: fields["target"] ?? "",
          catalog: fields["catalog"] ?? "",
          channel: "CURRENT",
          continuous: fields["continuous"] === "true",
          photon: fields["photon"] !== "false",
          lastUpdateState: "",
        },
        resolvedOutputs: {
          pipelineId,
          pipelineUrl: `https://${host}/pipelines/${pipelineId}`,
        },
        secretStates: [],
        externalId: pipelineId,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "databricks-catalog") {
      const data = await this.api<{
        name: string;
        owner?: string;
        comment?: string;
        metastore_id?: string;
      }>("POST", "/api/2.1/unity-catalog/catalogs", {
        name: fields["name"] ?? "",
        ...(fields["comment"] ? { comment: fields["comment"] } : {}),
      });
      return {
        id: `${accountId}:databricks-catalog:${data.name}`,
        pluginId: "databricks",
        resourceTypeId: "databricks-catalog",
        accountId,
        displayName: data.name,
        fields: {
          name: data.name,
          owner: data.owner ?? "",
          comment: data.comment ?? "",
          catalogType: "MANAGED_CATALOG",
          isolationMode: "OPEN",
          securable_kind: "CATALOG_STANDARD",
          schemaCount: 0,
        },
        resolvedOutputs: {
          catalogName: data.name,
          metastoreId: data.metastore_id ?? "",
        },
        secretStates: [],
        externalId: data.name,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "databricks-schema") {
      const parentExternalId = parentResourceId
        ? parentResourceId.split(":").slice(2).join(":")
        : "";
      const catalogName = fields["catalogName"] || parentExternalId;
      const schemaName = fields["name"] ?? "";
      const data = await this.api<{
        name: string;
        catalog_name: string;
        owner?: string;
        comment?: string;
        full_name?: string;
      }>("POST", "/api/2.1/unity-catalog/schemas", {
        name: schemaName,
        catalog_name: catalogName,
        ...(fields["comment"] ? { comment: fields["comment"] } : {}),
      });
      const fullName = data.full_name ?? `${catalogName}.${schemaName}`;
      return {
        id: `${accountId}:databricks-schema:${fullName}`,
        pluginId: "databricks",
        resourceTypeId: "databricks-schema",
        accountId,
        displayName: schemaName,
        fields: {
          name: schemaName,
          catalogName,
          owner: data.owner ?? "",
          comment: data.comment ?? "",
          tableCount: 0,
        },
        resolvedOutputs: { fullName },
        secretStates: [],
        externalId: fullName,
        parentResourceId: `${accountId}:databricks-catalog:${catalogName}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "databricks-table") {
      const parentExternalId = parentResourceId
        ? parentResourceId.split(":").slice(2).join(":")
        : "";
      const [parentCatalog, parentSchema] = parentExternalId.split(".");
      const catalogName = fields["catalogName"] || parentCatalog || "";
      const schemaName = fields["schemaName"] || parentSchema || "default";
      const tableName = fields["name"] ?? "";
      const tableType = fields["tableType"] ?? "MANAGED";
      const dataSourceFormat = fields["dataSourceFormat"] ?? "DELTA";
      const body: Record<string, unknown> = {
        name: tableName,
        catalog_name: catalogName,
        schema_name: schemaName,
        table_type: tableType,
        data_source_format: dataSourceFormat,
        columns: [
          { name: "id", type_name: "LONG", position: 0 },
          { name: "value", type_name: "STRING", position: 1 },
        ],
      };
      if (fields["storageLocation"]) {
        body["storage_location"] = fields["storageLocation"];
      }
      if (fields["comment"]) {
        body["comment"] = fields["comment"];
      }
      const data = await this.api<{
        name: string;
        full_name?: string;
        owner?: string;
        comment?: string;
        storage_location?: string;
        columns?: Array<Record<string, unknown>>;
      }>("POST", "/api/2.1/unity-catalog/tables", body);
      const fullName = data.full_name ?? `${catalogName}.${schemaName}.${tableName}`;
      return {
        id: this.makeId(accountId, "databricks-table", fullName),
        pluginId: "databricks",
        resourceTypeId: "databricks-table",
        accountId,
        displayName: tableName,
        fields: {
          name: tableName,
          catalogName,
          schemaName,
          tableType,
          dataSourceFormat,
          owner: data.owner ?? "",
          comment: data.comment ?? "",
          storageLocation: data.storage_location ?? "",
          columnCount: data.columns?.length ?? 2,
        },
        resolvedOutputs: { fullName, storageLocation: data.storage_location ?? "" },
        secretStates: [],
        externalId: fullName,
        parentResourceId: `${accountId}:databricks-schema:${catalogName}.${schemaName}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    throw new Error(`Databricks plugin: createResource not supported for type "${typeId}"`);
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
