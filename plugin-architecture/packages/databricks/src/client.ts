import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SqlTableMeta,
  ResourceStatus,
} from "@infrawrench/plugin-base";
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

  constructor(credentials: Record<string, string>) {
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
  }

  private async api<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    // Separate path from query string if present
    const url = path.startsWith("http") ? path : `${this.host}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    };
    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      init.body = JSON.stringify(body);
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
    const dotStatus = statusMap[state] ?? "unknown";

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
        : { kind: "status-dot", status: "unknown" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(fields)
                .filter(([, v]) => v !== "" && v !== 0 && v !== false)
                .map(([key, value]) => ({
                  key,
                  value: String(value),
                })),
            },
          ],
        },
        ...(Object.keys(resource.resolvedOutputs).length > 0
          ? [
              {
                kind: "section" as const,
                title: "Outputs",
                children: [
                  {
                    kind: "key-value-list" as const,
                    items: Object.entries(resource.resolvedOutputs).map(([key, value]) => ({
                      key,
                      value: String(value),
                      copyable: true,
                    })),
                  },
                ],
              },
            ]
          : []),
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
        status: statusMap[state] ?? "unknown",
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
      default:
        throw new Error(`Databricks plugin: delete not supported for type "${typeId}"`);
    }
  }
}
