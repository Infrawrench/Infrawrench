import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SqlTableMeta,
  ResourceStatus,
  ResourceTypeDefinition,
  DashboardStat,
  CreateResourceConfig,
  HostServices,
} from "@infrawrench/plugin-base";
import { labeledFieldItems, labeledOutputItems } from "@infrawrench/plugin-base";
import type { ListerContext } from "./resource-listers.js";
import {
  listClusters,
  listSqlWarehouses,
  listJobs,
  listPipelines,
  listCatalogs,
  listSchemas,
  listTables,
} from "./resource-listers.js";

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
    // Separate path from query string if present
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
      if (!result.body) return {} as T;
      return JSON.parse(result.body) as T;
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

    // Some endpoints return 200 with empty body
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
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
    "databricks-job": listJobs,
    "databricks-pipeline": listPipelines,
    "databricks-catalog": listCatalogs,
  };

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
    };
    const dotStatus = statusMap[state] ?? "info";

    // Human-readable type label
    const typeLabels: Record<string, string> = {
      "databricks-cluster": "Cluster",
      "databricks-sql-warehouse": "SQL Warehouse",
      "databricks-job": "Job",
      "databricks-pipeline": "Pipeline",
      "databricks-catalog": "Catalog",
      "databricks-schema": "Schema",
      "databricks-table": "Table",
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
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };

    return detail;
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

  async executeQuery(
    resourceId: string,
    accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const resource = await this.getResource("databricks-sql-warehouse", resourceId, accountId);
    const warehouseId = String(resource.fields["warehouseId"]);
    const start = Date.now();

    // Submit statement
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
        obj[columns[i]!.name] = (row as unknown[])[i];
      }
      return obj;
    });

    return { rows, durationMs };
  }

  async introspectResource(resourceId: string, accountId: string): Promise<SqlTableMeta[]> {
    // Use INFORMATION_SCHEMA to list tables and columns
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

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const resource = await this.getResource(typeId, resourceId, accountId);

    switch (typeId) {
      case "databricks-cluster": {
        const clusterId = String(resource.fields["clusterId"]);
        await this.api("POST", "/api/2.0/clusters/permanent-delete", {
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
        await this.api("POST", "/api/2.1/jobs/delete", { job_id: jobId });
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
      default:
        throw new Error(`Databricks plugin: delete not supported for type "${typeId}"`);
    }
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "databricks-cluster") {
      return {
        fields: [
          { key: "clusterName", label: "Cluster Name", kind: "text", required: true },
          {
            key: "sparkVersion",
            label: "Spark Version",
            kind: "text",
            required: true,
            defaultValue: "15.4.x-scala2.12",
            description: "e.g. 15.4.x-scala2.12",
          },
          {
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
            options: [
              { id: "2X-Small", label: "2X-Small" },
              { id: "X-Small", label: "X-Small" },
              { id: "Small", label: "Small" },
              { id: "Medium", label: "Medium" },
              { id: "Large", label: "Large" },
              { id: "X-Large", label: "X-Large" },
              { id: "2X-Large", label: "2X-Large" },
            ],
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
              { id: "TYPE_UNSPECIFIED", label: "Serverless" },
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

    if (typeId === "databricks-cluster") {
      const data = await this.api<{ cluster_id: string }>("POST", "/api/2.0/clusters/create", {
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
      const data = await this.api<{ id: string }>("POST", "/api/2.0/sql/warehouses", {
        name: fields["name"] ?? "",
        cluster_size: fields["clusterSize"] ?? "Small",
        max_num_clusters: Number(fields["maxNumClusters"] ?? 1),
        auto_stop_mins: Number(fields["autoStopMinutes"] ?? 15),
        enable_photon: fields["enablePhoton"] !== "false",
        warehouse_type: fields["warehouseType"] ?? "PRO",
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
          warehouseType: fields["warehouseType"] ?? "PRO",
          enablePhoton: fields["enablePhoton"] !== "false",
          numActiveSessions: 0,
          numRunningQueries: 0,
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
      const data = await this.api<{ job_id: number }>("POST", "/api/2.1/jobs/create", body);
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
