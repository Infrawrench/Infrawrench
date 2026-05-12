import { createClient, type ClickHouseClient as ClickHouseSdkClient } from "@clickhouse/client-web";
import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SqlTableMeta,
  ResourceStatus,
  DashboardStat,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";
import type { ListerContext } from "./resource-listers.js";
import { listServices, listDatabases } from "./resource-listers.js";

const SQL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * ClickHouse Cloud plugin client.
 *
 * Two credential sets:
 * - Cloud API: `apiKeyId` + `apiKeySecret` for managing services via
 *   https://api.clickhouse.cloud/v1
 * - HTTP Interface: `chHost`, `chUser`, `chPassword` for running SQL queries
 *   against a specific service's HTTPS endpoint (port 8443)
 *
 * The Cloud API uses HTTP Basic Auth (keyId:keySecret).
 * The HTTP SQL interface uses X-ClickHouse-User / X-ClickHouse-Key headers.
 */
export class ClickHouseClient implements PluginClient {
  private readonly apiKeyId: string;
  private readonly apiKeySecret: string;
  private readonly organizationId: string;
  private readonly chHost: string;
  private readonly chUser: string;
  private readonly chPassword: string;

  constructor(credentials: Record<string, string>) {
    this.apiKeyId = credentials["apiKeyId"] ?? "";
    this.apiKeySecret = credentials["apiKeySecret"] ?? "";
    this.organizationId = credentials["organizationId"] ?? "";
    this.chHost = (credentials["chHost"] ?? "").replace(/\/+$/, "");
    this.chUser = credentials["chUser"] ?? "default";
    this.chPassword = credentials["chPassword"] ?? "";

    if (!this.apiKeyId || !this.apiKeySecret) {
      throw new Error("ClickHouse plugin: missing API key credentials");
    }
    if (!this.organizationId) {
      throw new Error("ClickHouse plugin: missing organization ID");
    }
  }

  private async cloudApi<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `https://api.clickhouse.cloud${path}`;
    const authHeader = `Basic ${btoa(`${this.apiKeyId}:${this.apiKeySecret}`)}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    };
    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ClickHouse Cloud ${method} ${path} failed: ${res.status} ${text}`);
    }

    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  private normalizeChUrl(rawHost: string): string {
    const trimmed = rawHost.replace(/\/+$/, "");
    if (!trimmed) return "";
    return trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`;
  }

  private makeSdkClient(rawHost: string): ClickHouseSdkClient | null {
    const url = this.normalizeChUrl(rawHost);
    if (!url) return null;
    return createClient({
      url,
      username: this.chUser,
      password: this.chPassword,
      request_timeout: SQL_REQUEST_TIMEOUT_MS,
    });
  }

  private async chQuery(sql: string): Promise<Record<string, unknown>[]> {
    return this.chQueryAt(this.chHost, sql);
  }

  private async chQueryAt(rawHost: string, sql: string): Promise<Record<string, unknown>[]> {
    const client = this.makeSdkClient(rawHost);
    if (!client) return [];

    try {
      const result = await client.query({
        query: sql,
        format: "JSONEachRow",
      });
      return await result.json<Record<string, unknown>>();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ClickHouse query failed: ${message}`);
    } finally {
      await client.close();
    }
  }

  private async chCommandAt(
    rawHost: string,
    sql: string,
    queryParams?: Record<string, unknown>,
  ): Promise<void> {
    const client = this.makeSdkClient(rawHost);
    if (!client) {
      throw new Error("ClickHouse query failed: no host configured");
    }

    try {
      await client.command({
        query: sql,
        ...(queryParams ? { query_params: queryParams } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ClickHouse query failed: ${message}`);
    } finally {
      await client.close();
    }
  }

  private makeId(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  private get ctx(): ListerContext {
    return {
      cloudApi: <T>(method: string, path: string, body?: Record<string, unknown>) =>
        this.cloudApi<T>(method, path, body),
      chQuery: (sql: string) => this.chQuery(sql),
      id: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      now: () => new Date().toISOString(),
      organizationId: this.organizationId,
    };
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "ch-service":
        return listServices(this.ctx, accountId);
      case "ch-database": {
        // List databases for all services
        const services = await listServices(this.ctx, accountId);
        const results: ResourceInstance[] = [];
        for (const svc of services) {
          if (svc.fields["state"] === "running" || svc.fields["state"] === "idle") {
            try {
              const dbs = await listDatabases(this.ctx, accountId, String(svc.fields["serviceId"]));
              results.push(...dbs);
            } catch {
              // Skip services we can't query
            }
          }
        }
        return results;
      }
      default:
        throw new Error(`ClickHouse plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) {
      throw new Error(`ClickHouse plugin: resource ${typeId}/${resourceId} not found`);
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
        `ClickHouse plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
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

    if (resourceTypeId === "ch-service") {
      const state = String(f["state"] ?? "unknown");
      const stats: DashboardStat[] = [
        {
          label: "State",
          value: state,
          variant:
            state === "running"
              ? "status-healthy"
              : state === "idle"
                ? "status-degraded"
                : state === "stopped" || state === "stopping"
                  ? "status-error"
                  : "status-degraded",
        },
      ];
      if (f["clickhouseVersion"]) {
        stats.push({ label: "Version", value: String(f["clickhouseVersion"]) });
      }
      stats.push({
        label: "Provider",
        value: `${String(f["provider"] ?? "").toUpperCase()} · ${String(f["region"] ?? "")}`,
      });
      if (f["numReplicas"]) {
        stats.push({ label: "Replicas", value: String(f["numReplicas"]) });
      }
      return stats;
    }

    return [];
  }

  private static readonly STATE_MAP: Record<string, ResourceStatus> = {
    running: "healthy",
    idle: "degraded",
    stopped: "error",
    starting: "provisioning",
    stopping: "degraded",
    provisioning: "provisioning",
  };

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const typeId = resource.resourceTypeId;

    if (typeId === "ch-service") {
      return this.renderServiceDetail(resource, fields);
    }

    // ch-database
    return {
      title: resource.displayName,
      subtitle: "Database · ClickHouse",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(fields["name"] ?? "") },
                { key: "Engine", value: String(fields["engine"] ?? "") },
                ...(fields["comment"]
                  ? [{ key: "Comment", value: String(fields["comment"]) }]
                  : []),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderServiceDetail(
    resource: ResourceInstance,
    fields: Record<string, unknown>,
  ): DetailViewSchema {
    const state = String(fields["state"] ?? "unknown");
    const dotStatus = ClickHouseClient.STATE_MAP[state] ?? "info";

    const memoryRange =
      fields["minReplicaMemoryGb"] && fields["maxReplicaMemoryGb"]
        ? `${fields["minReplicaMemoryGb"]} – ${fields["maxReplicaMemoryGb"]} GB`
        : "";

    const detail: DetailViewSchema = {
      title: resource.displayName,
      subtitle: `Service · ClickHouse Cloud`,
      status: { kind: "status-dot", status: dotStatus, label: state },
      sections: [
        {
          kind: "section",
          title: "Service",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Service ID", value: String(fields["serviceId"] ?? ""), copyable: true },
                {
                  key: "Provider",
                  value: `${String(fields["provider"] ?? "").toUpperCase()} · ${String(fields["region"] ?? "")}`,
                },
                { key: "Version", value: String(fields["clickhouseVersion"] ?? "—") },
                ...(fields["tier"] ? [{ key: "Tier", value: String(fields["tier"]) }] : []),
                { key: "State", value: state },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Scaling",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Replicas", value: String(fields["numReplicas"] ?? "—") },
                ...(memoryRange ? [{ key: "Memory / Replica", value: memoryRange }] : []),
                {
                  key: "Idle Scaling",
                  value: fields["idleScaling"] ? "Enabled" : "Disabled",
                },
                ...(fields["idleTimeoutMinutes"]
                  ? [
                      {
                        key: "Idle Timeout",
                        value: `${fields["idleTimeoutMinutes"]} min`,
                      },
                    ]
                  : []),
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
                  key: "HTTPS Endpoint",
                  value: String(resource.resolvedOutputs["httpUrl"] ?? "—"),
                  copyable: true,
                },
                {
                  key: "Host",
                  value: String(resource.resolvedOutputs["host"] ?? "—"),
                  copyable: true,
                },
                {
                  key: "HTTP Port",
                  value: String(resource.resolvedOutputs["port"] ?? "—"),
                },
                {
                  key: "Native Port",
                  value: String(resource.resolvedOutputs["nativePort"] ?? "—"),
                },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };

    // Add SQL editor if the service is running and we have connection info
    if ((state === "running" || state === "idle") && resource.resolvedOutputs["connectionString"]) {
      detail.sqlEditor = {
        connectionStringOutputKey: "connectionString",
        defaultQuery: "SELECT * FROM system.tables WHERE database = currentDatabase() LIMIT 20;",
      };
    }

    return detail;
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const state = String(resource.fields["state"] ?? "");
    return {
      id: resource.id,
      label: resource.displayName,
      status: {
        kind: "status-dot",
        status: ClickHouseClient.STATE_MAP[state] ?? "info",
      },
    };
  }

  async executeQuery(
    resourceId: string,
    accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const start = Date.now();
    const rows = await this.chQuery(sql);
    return { rows, durationMs: Date.now() - start };
  }

  async introspectResource(resourceId: string, accountId: string): Promise<SqlTableMeta[]> {
    try {
      const rows = await this.chQuery(
        `SELECT database, table, name AS column_name, type AS data_type
         FROM system.columns
         WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
         ORDER BY database, table, position
         LIMIT 5000`,
      );

      const tableMap = new Map<string, SqlTableMeta>();
      for (const row of rows) {
        const fullName = `${row["database"]}.${row["table"]}`;
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
      return [];
    }
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "ch-database") {
      const fields: CreateResourceConfig["fields"] = [
        {
          key: "name",
          label: "Database Name",
          kind: "text",
          required: true,
          description: "Name for the new ClickHouse database",
        },
        {
          key: "comment",
          label: "Comment",
          kind: "text",
          required: false,
        },
      ];
      if (!parentResourceId) {
        const services = await listServices(this.ctx, "");
        const options = services
          .filter((s) => s.fields["state"] === "running" || s.fields["state"] === "idle")
          .map((s) => ({
            id: String(s.fields["serviceId"] ?? ""),
            label: String(s.fields["name"] ?? s.fields["serviceId"] ?? ""),
          }));
        fields.unshift({
          key: "serviceId",
          label: "Service",
          kind: "select",
          required: true,
          options,
          ...(options[0] ? { defaultValue: options[0].id } : {}),
          description: "ClickHouse Cloud service to create the database in",
        });
      }
      return { fields };
    }
    if (typeId !== "ch-service") {
      throw new Error(`ClickHouse plugin: create not supported for type "${typeId}"`);
    }

    return {
      fields: [
        {
          key: "name",
          label: "Service Name",
          kind: "text",
          required: true,
          description: "A human-readable name for this ClickHouse Cloud service (max 50 chars).",
        },
        {
          key: "provider",
          label: "Cloud Provider",
          kind: "select",
          required: true,
          options: [
            { id: "aws", label: "AWS" },
            { id: "gcp", label: "Google Cloud" },
            { id: "azure", label: "Azure" },
          ],
          defaultValue: "aws",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: [
            // AWS regions
            {
              id: "us-east-1",
              label: "us-east-1",
              location: "N. Virginia, USA",
              flag: "\u{1F1FA}\u{1F1F8}",
            },
            {
              id: "us-east-2",
              label: "us-east-2",
              location: "Ohio, USA",
              flag: "\u{1F1FA}\u{1F1F8}",
            },
            {
              id: "us-west-2",
              label: "us-west-2",
              location: "Oregon, USA",
              flag: "\u{1F1FA}\u{1F1F8}",
            },
            {
              id: "eu-central-1",
              label: "eu-central-1",
              location: "Frankfurt, Germany",
              flag: "\u{1F1E9}\u{1F1EA}",
            },
            {
              id: "eu-west-1",
              label: "eu-west-1",
              location: "Ireland",
              flag: "\u{1F1EE}\u{1F1EA}",
            },
            {
              id: "eu-west-2",
              label: "eu-west-2",
              location: "London, UK",
              flag: "\u{1F1EC}\u{1F1E7}",
            },
            {
              id: "ap-south-1",
              label: "ap-south-1",
              location: "Mumbai, India",
              flag: "\u{1F1EE}\u{1F1F3}",
            },
            {
              id: "ap-southeast-1",
              label: "ap-southeast-1",
              location: "Singapore",
              flag: "\u{1F1F8}\u{1F1EC}",
            },
            {
              id: "ap-southeast-2",
              label: "ap-southeast-2",
              location: "Sydney, Australia",
              flag: "\u{1F1E6}\u{1F1FA}",
            },
            {
              id: "ap-northeast-1",
              label: "ap-northeast-1",
              location: "Tokyo, Japan",
              flag: "\u{1F1EF}\u{1F1F5}",
            },
            // GCP regions
            {
              id: "us-central1",
              label: "us-central1",
              location: "Iowa, USA",
              flag: "\u{1F1FA}\u{1F1F8}",
            },
            {
              id: "us-east1",
              label: "us-east1",
              location: "South Carolina, USA",
              flag: "\u{1F1FA}\u{1F1F8}",
            },
            {
              id: "europe-west4",
              label: "europe-west4",
              location: "Netherlands",
              flag: "\u{1F1F3}\u{1F1F1}",
            },
            // Azure regions
            {
              id: "eastus2",
              label: "eastus2",
              location: "Virginia, USA",
              flag: "\u{1F1FA}\u{1F1F8}",
            },
            {
              id: "westus3",
              label: "westus3",
              location: "Arizona, USA",
              flag: "\u{1F1FA}\u{1F1F8}",
            },
            {
              id: "germanywestcentral",
              label: "germanywestcentral",
              location: "Frankfurt, Germany",
              flag: "\u{1F1E9}\u{1F1EA}",
            },
          ],
        },
        {
          key: "minReplicaMemoryGb",
          label: "Min Replica Memory (GB)",
          kind: "number",
          required: false,
          description:
            "Minimum memory per replica in GB (multiples of 4, range 8-356). Leave blank for default.",
          minValue: 8,
          maxValue: 356,
          stepValue: 4,
          defaultValue: "24",
        },
        {
          key: "maxReplicaMemoryGb",
          label: "Max Replica Memory (GB)",
          kind: "number",
          required: false,
          description:
            "Maximum memory per replica in GB (multiples of 4, range 8-356). Leave blank for default.",
          minValue: 8,
          maxValue: 356,
          stepValue: 4,
          defaultValue: "24",
        },
        {
          key: "numReplicas",
          label: "Number of Replicas",
          kind: "number",
          required: false,
          description: "Number of replicas (1-20). Defaults to 3.",
          minValue: 1,
          maxValue: 20,
          stepValue: 1,
          defaultValue: "3",
        },
        {
          key: "idleScaling",
          label: "Idle Scaling",
          kind: "select",
          required: false,
          options: [
            { id: "true", label: "Enabled (scale to zero when idle)" },
            { id: "false", label: "Disabled (always running)" },
          ],
          defaultValue: "true",
          description: "When enabled, the service can scale to zero when there is no activity.",
        },
      ],
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    if (typeId === "ch-database") {
      const name = fields["name"] ?? "";
      const comment = fields["comment"] ?? "";
      const parentExternalId = parentResourceId
        ? parentResourceId.split(":").slice(2).join(":")
        : "";
      const serviceId = fields["serviceId"] || parentExternalId;
      if (!serviceId) {
        throw new Error("ClickHouse database creation requires a service");
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(
          "Database name must be alphanumeric with underscores, starting with a letter or underscore",
        );
      }

      const services = await listServices(this.ctx, accountId);
      const target = services.find((s) => String(s.fields["serviceId"]) === serviceId);
      if (!target) {
        throw new Error(`ClickHouse service "${serviceId}" not found`);
      }
      const targetHost = String(target.resolvedOutputs["host"] ?? "");
      if (!targetHost) {
        throw new Error(`ClickHouse service "${serviceId}" has no HTTPS endpoint available`);
      }

      const sql = comment
        ? `CREATE DATABASE {name:Identifier} COMMENT {comment:String}`
        : `CREATE DATABASE {name:Identifier}`;
      const params: Record<string, unknown> = comment ? { name, comment } : { name };
      await this.chCommandAt(targetHost, sql, params);
      const now = new Date().toISOString();
      const externalId = `${serviceId}/${name}`;
      return {
        id: this.makeId(accountId, "ch-database", externalId),
        pluginId: "clickhouse",
        resourceTypeId: "ch-database",
        accountId,
        displayName: name,
        parentResourceId: this.makeId(accountId, "ch-service", serviceId),
        fields: { name, engine: "Atomic", comment },
        resolvedOutputs: { databaseName: name },
        secretStates: [],
        externalId,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId !== "ch-service") {
      throw new Error(`ClickHouse plugin: create not supported for type "${typeId}"`);
    }

    const body: Record<string, unknown> = {
      name: fields["name"],
      provider: fields["provider"],
      region: fields["region"],
    };

    if (fields["minReplicaMemoryGb"]) {
      body["minReplicaMemoryGb"] = Number(fields["minReplicaMemoryGb"]);
    }
    if (fields["maxReplicaMemoryGb"]) {
      body["maxReplicaMemoryGb"] = Number(fields["maxReplicaMemoryGb"]);
    }
    if (fields["numReplicas"]) {
      body["numReplicas"] = Number(fields["numReplicas"]);
    }
    if (fields["idleScaling"] !== undefined) {
      body["idleScaling"] = fields["idleScaling"] === "true";
    }

    interface CreateResponse {
      result?: {
        service?: {
          id: string;
          name: string;
          state: string;
          provider: string;
          region: string;
          endpoints?: Array<{ protocol: string; host: string; port: number }>;
        };
        password?: string;
      };
    }

    const data = await this.cloudApi<CreateResponse>(
      "POST",
      `/v1/organizations/${this.organizationId}/services`,
      body,
    );

    const svc = data.result?.service;
    if (!svc) {
      throw new Error("ClickHouse Cloud: create service returned no result");
    }

    const httpsEndpoint = svc.endpoints?.find((e) => e.protocol === "https");
    const host = httpsEndpoint?.host ?? "";
    const port = String(httpsEndpoint?.port ?? 8443);
    const now = new Date().toISOString();

    return {
      id: this.makeId(accountId, "ch-service", svc.id),
      pluginId: "clickhouse",
      resourceTypeId: "ch-service",
      accountId,
      displayName: svc.name || svc.id,
      fields: {
        serviceId: svc.id,
        name: svc.name,
        state: svc.state,
        provider: svc.provider,
        region: svc.region,
      },
      resolvedOutputs: {
        serviceId: svc.id,
        host,
        port,
        httpUrl: host ? `https://${host}:${port}` : "",
        connectionString: host ? `clickhouse://${host}:9440` : "",
      },
      secretStates: [],
      externalId: svc.id,
      createdAt: now,
      updatedAt: now,
    };
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    if (typeId === "ch-database") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const externalId = String(resource.externalId);
      const slashIdx = externalId.indexOf("/");
      const serviceId = slashIdx >= 0 ? externalId.slice(0, slashIdx) : "";
      const name = slashIdx >= 0 ? externalId.slice(slashIdx + 1) : externalId;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error("Invalid database name");
      }
      let targetHost = this.chHost;
      if (serviceId) {
        const services = await listServices(this.ctx, accountId);
        const target = services.find((s) => String(s.fields["serviceId"]) === serviceId);
        if (target) {
          targetHost = String(target.resolvedOutputs["host"] ?? this.chHost);
        }
      }
      await this.chCommandAt(targetHost, `DROP DATABASE {name:Identifier}`, { name });
      return;
    }

    if (typeId !== "ch-service") {
      throw new Error(`ClickHouse plugin: delete not supported for type "${typeId}"`);
    }

    const resource = await this.getResource(typeId, resourceId, accountId);
    const serviceId = String(resource.fields["serviceId"]);

    // If the service is running or idle, stop it first (ClickHouse Cloud requires stopped state to delete)
    const state = String(resource.fields["state"]);
    if (state === "running" || state === "idle") {
      await this.cloudApi(
        "PATCH",
        `/v1/organizations/${this.organizationId}/services/${serviceId}/state`,
        { command: "stop" },
      );
      // Wait a bit for the stop to initiate
      await new Promise((r) => setTimeout(r, 2000));
    }

    await this.cloudApi("DELETE", `/v1/organizations/${this.organizationId}/services/${serviceId}`);
  }
}
