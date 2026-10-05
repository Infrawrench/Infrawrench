import { createClient, type ClickHouseClient as ClickHouseSdkClient } from "@clickhouse/client-web";
import type {
  ActionNode,
  BusinessMetricSourceOption,
  BusinessMetricSourceRange,
  BusinessMetricSourceResult,
  CostFetchRange,
  CostRow,
  CreditBalance,
  MetricSeries,
  QuotaUsage,
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SqlTableMeta,
  ResourceStatus,
  SectionNode,
  DashboardStat,
  CreateResourceConfig,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
} from "@infrawrench/plugin-base";
import { decodePromptArgs } from "@infrawrench/plugin-base";
import type {
  CloudApiKey,
  CloudClickPipe,
  CloudPostgres,
  ListerContext,
} from "./resource-listers.js";
import {
  apiKeyToResource,
  clickPipeToResource,
  listApiKeys,
  listBackups,
  listClickPipes,
  listDatabases,
  listMembers,
  listPostgres,
  listServices,
  postgresToResource,
} from "./resource-listers.js";
import { fetchClickHouseCostData } from "./cost-data.js";
import {
  listClickHouseBusinessMetricOptions,
  runClickHouseBusinessMetricSource,
  type ClickHouseMetricContext,
} from "./business-metric-source.js";
import { clickPipeMetricSeries, serviceMetricSeries } from "./prometheus.js";
import type { CloudActivity, PostgresLogEntry } from "./logs.js";
import { POSTGRES_LOG_FILTERS, postgresLogLines, serviceActivityLines } from "./logs.js";
import { CLOUD_REGIONS, postgresSizeOptions } from "./regions.js";

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
  private readonly chPort: string;
  private readonly chUser: string;
  private readonly chPassword: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.apiKeyId = credentials["apiKeyId"] ?? "";
    this.apiKeySecret = credentials["apiKeySecret"] ?? "";
    this.organizationId = credentials["organizationId"] ?? "";
    this.chHost = (credentials["chHost"] ?? "").replace(/\/+$/, "");
    this.chPort = credentials["chPort"] || "8443";
    this.chUser = credentials["chUser"] ?? "default";
    this.chPassword = credentials["chPassword"] ?? "";
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;

    if (!this.apiKeyId || !this.apiKeySecret) {
      throw new Error("ClickHouse plugin: missing API key credentials");
    }
    if (!this.organizationId) {
      throw new Error("ClickHouse plugin: missing organization ID");
    }
  }

  /** Raw Cloud API call: returns the response body text. */
  private async cloudRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<string> {
    const url = `https://api.clickhouse.cloud${path}`;
    const authHeader = `Basic ${btoa(`${this.apiKeyId}:${this.apiKeySecret}`)}`;
    const headers = {
      Authorization: authHeader,
      "Content-Type": "application/json",
    };
    const serializedBody =
      body && (method === "POST" || method === "PUT" || method === "PATCH")
        ? JSON.stringify(body)
        : undefined;

    if (this.services?.http) {
      const result = await this.services.http.request({
        url,
        method,
        headers,
        ...(serializedBody ? { body: serializedBody } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(
          `ClickHouse Cloud ${method} ${path} failed: ${result.status} ${result.body}`,
        );
      }
      return result.body ?? "";
    }

    const init: RequestInit = { method, headers };
    if (serializedBody) {
      init.body = serializedBody;
    }

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ClickHouse Cloud ${method} ${path} failed: ${res.status} ${text}`);
    }
    return res.text();
  }

  private async cloudApi<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const text = await this.cloudRequest(method, path, body);
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  private get orgPath(): string {
    return `/v1/organizations/${this.organizationId}`;
  }

  private normalizeChUrl(rawHost: string): string {
    const trimmed = rawHost.replace(/\/+$/, "");
    if (!trimmed) return "";
    const withScheme =
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`;
    try {
      const url = new URL(withScheme);
      if (!url.port && this.chPort) url.port = this.chPort;
      return url.toString().replace(/\/+$/, "");
    } catch {
      return withScheme;
    }
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

  /** The configured SQL service, for business-metric importers. */
  private get businessMetricCtx(): ClickHouseMetricContext {
    return {
      makeClient: ({ database, requestTimeoutMs }) => {
        const url = this.normalizeChUrl(this.chHost);
        if (!url) return null;
        return createClient({
          url,
          username: this.chUser,
          password: this.chPassword,
          request_timeout: requestTimeoutMs,
          ...(database ? { database } : {}),
        });
      },
    };
  }

  async listBusinessMetricSourceOptions(
    _accountId: string,
    fieldKey: string,
    params: Record<string, string>,
  ): Promise<BusinessMetricSourceOption[]> {
    return listClickHouseBusinessMetricOptions(this.businessMetricCtx, fieldKey, params);
  }

  async runBusinessMetricSource(
    _accountId: string,
    params: Record<string, string>,
    range: BusinessMetricSourceRange,
  ): Promise<BusinessMetricSourceResult> {
    return runClickHouseBusinessMetricSource(this.businessMetricCtx, params, range);
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
      throw new Error(`ClickHouse query failed: ${message}`, { cause: err });
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
      throw new Error(`ClickHouse query failed: ${message}`, { cause: err });
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
      case "ch-backup":
      case "ch-clickpipe": {
        // Per-service children. A service that refuses (no ClickPipes
        // permission on the key, a service mid-deletion) is skipped rather
        // than failing the whole listing.
        const services = await listServices(this.ctx, accountId);
        const lister = typeId === "ch-backup" ? listBackups : listClickPipes;
        const perService = await Promise.all(
          services.map(async (svc) => {
            try {
              return await lister(this.ctx, accountId, String(svc.fields["serviceId"]));
            } catch {
              return [];
            }
          }),
        );
        return perService.flat();
      }
      case "ch-api-key":
        return listApiKeys(this.ctx, accountId);
      case "ch-member":
        return listMembers(this.ctx, accountId);
      case "ch-postgres":
        return listPostgres(this.ctx, accountId);
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

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchClickHouseCostData(this.ctx, range);
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
      if (f["autoscalingMode"] === "horizontal" && f["maxReplicas"]) {
        stats.push({
          label: "Replicas",
          value: `${String(f["minReplicas"] ?? 0)}-${String(f["maxReplicas"])}`,
        });
      } else if (f["numReplicas"]) {
        stats.push({ label: "Replicas", value: String(f["numReplicas"]) });
      }
      if (f["releaseChannel"]) {
        stats.push({ label: "Channel", value: String(f["releaseChannel"]) });
      }
      return stats;
    }

    switch (resourceTypeId) {
      case "ch-postgres": {
        const state = String(f["state"] ?? "unknown");
        return [
          {
            label: "State",
            value: state,
            variant:
              state === "running"
                ? "status-healthy"
                : state === "stopped" || state === "unavailable"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Version", value: `Postgres ${String(f["postgresVersion"] ?? "")}` },
          { label: "Size", value: String(f["size"] ?? "") },
          { label: "HA", value: String(f["haType"] || "none") },
        ];
      }
      case "ch-clickpipe": {
        const state = String(f["state"] ?? "Unknown");
        return [
          {
            label: "State",
            value: state,
            variant:
              state === "Running" || state === "Completed"
                ? "status-healthy"
                : state === "Failed" || state === "InternalError"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Source", value: String(f["sourceType"] || "unknown") },
          ...(f["replicas"] ? [{ label: "Replicas", value: String(f["replicas"]) }] : []),
        ];
      }
      case "ch-backup":
        return [
          { label: "Status", value: String(f["status"] ?? "") },
          { label: "Type", value: String(f["type"] ?? "") },
          { label: "Size", value: formatBytes(Number(f["sizeInBytes"] ?? 0)) },
        ];
      case "ch-api-key":
        return [
          {
            label: "State",
            value: String(f["state"] ?? ""),
            variant: f["state"] === "enabled" ? "status-healthy" : "status-error",
          },
          { label: "Last Used", value: String(f["lastUsedAt"] || "never") },
        ];
      default:
        return [];
    }
  }

  /**
   * Service metrics come from the Prometheus scrape endpoint (current values
   * only); Managed Postgres has a real time-series endpoint bucketed over
   * the requested window.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (!externalId) return [];
    if (resourceTypeId === "ch-service") {
      try {
        const body = await this.cloudRequest(
          "GET",
          `${this.orgPath}/services/${externalId}/prometheus?filtered_metrics=true`,
        );
        return serviceMetricSeries(body, Date.now());
      } catch {
        return [];
      }
    }
    if (resourceTypeId === "ch-clickpipe") {
      const [serviceId, clickPipeId] = externalId.split("/");
      if (!serviceId || !clickPipeId) return [];
      // The filtered scrape is the server's curated set; ClickPipes counters
      // are documented on the full one.
      const body = await this.cloudRequest(
        "GET",
        `${this.orgPath}/services/${serviceId}/prometheus`,
      );
      return clickPipeMetricSeries(body, clickPipeId, Date.now());
    }
    if (resourceTypeId === "ch-postgres") {
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - 60 * 60 * 1000;
      const from = encodeURIComponent(new Date(startMs).toISOString());
      const to = encodeURIComponent(new Date(endMs).toISOString());
      const data = await this.cloudApi<{
        result?: {
          metrics?: Array<{
            key?: string;
            name?: string;
            unit?: string;
            series?: Array<{
              label?: string;
              dataPoints?: Array<{ timestamp: number; value: number }>;
            }>;
          }>;
        };
      }>("GET", `${this.orgPath}/postgres/${externalId}/metrics?from_date=${from}&to_date=${to}`);
      const out: MetricSeries[] = [];
      for (const metric of data.result?.metrics ?? []) {
        const seriesList = metric.series ?? [];
        for (const series of seriesList) {
          const name = metric.name || metric.key || "metric";
          out.push({
            label: seriesList.length > 1 && series.label ? `${name} (${series.label})` : name,
            ...(metric.unit ? { unit: metric.unit } : {}),
            points: (series.dataPoints ?? []).map((p) => ({
              timestamp: p.timestamp * 1000,
              value: p.value,
            })),
          });
        }
      }
      return out;
    }
    return [];
  }

  /**
   * Logs tab: a service's entries in the organization activity log (the
   * last 30 days), or a Managed Postgres service's server log (the last 24
   * hours, filterable by severity).
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const tail = Math.max(1, Math.min(params.tailLines ?? 200, 2000));
    const now = Date.now();
    if (typeId === "ch-service") {
      const from = encodeURIComponent(new Date(now - 30 * 86_400_000).toISOString());
      const to = encodeURIComponent(new Date(now).toISOString());
      const data = await this.cloudApi<{ result?: CloudActivity[] }>(
        "GET",
        `${this.orgPath}/activities?from_date=${from}&to_date=${to}`,
      );
      const text = serviceActivityLines(data.result ?? [], externalId, tail);
      return {
        text: text || "No activity recorded for this service in the last 30 days.\n",
        containers: ["activity"],
        activeContainer: "activity",
      };
    }
    if (typeId === "ch-postgres") {
      const containers = [...POSTGRES_LOG_FILTERS];
      const active =
        params.container && (containers as string[]).includes(params.container)
          ? params.container
          : "all";
      const from = encodeURIComponent(new Date(now - 86_400_000).toISOString());
      const to = encodeURIComponent(new Date(now).toISOString());
      const data = await this.cloudApi<{ result?: PostgresLogEntry[] }>(
        "GET",
        `${this.orgPath}/postgres/${encodeURIComponent(externalId)}/logs?from_date=${from}&to_date=${to}` +
          `&sort_order=desc&limit=${tail}` +
          (active === "all" ? "" : `&severity=${encodeURIComponent(active)}`),
      );
      const text = postgresLogLines(data.result ?? []);
      return {
        text: text || "No log entries in the last 24 hours.\n",
        containers,
        activeContainer: active,
      };
    }
    return { text: "", containers: [], activeContainer: "" };
  }

  /** Active prepaid and trial credit balances, in ClickHouse Credits. */
  async fetchCreditBalance(): Promise<CreditBalance[]> {
    const data = await this.cloudApi<{
      result?: {
        balances?: Array<{
          id?: string;
          type?: string;
          remainingCredits?: number;
          totalAmount?: number;
          expirationDate?: string;
        }>;
      };
    }>("GET", `${this.orgPath}/creditBalances`);
    return (data.result?.balances ?? []).map((b, i) => ({
      key: b.id || `balance-${i}`,
      label: b.type === "trial" ? "Trial credits" : "Prepaid credits",
      remaining: Number(b.remainingCredits ?? 0),
      // 1 CHC = $1 list price, the same conversion the cost collector uses.
      currency: "USD",
      ...(typeof b.totalAmount === "number" ? { granted: b.totalAmount } : {}),
      ...(b.expirationDate ? { expiresAt: b.expirationDate } : {}),
    }));
  }

  /** Organization quotas (services, Postgres services, replicas, API keys). */
  async fetchQuotas(): Promise<QuotaUsage[]> {
    const data = await this.cloudApi<{
      result?: Array<{
        quotaCode?: string;
        name?: string;
        scope?: string;
        value?: number;
        usage?: number;
        adjustable?: boolean;
      }>;
    }>("GET", `${this.orgPath}/quotas`);
    const out: QuotaUsage[] = [];
    for (const q of data.result ?? []) {
      if (!q.quotaCode || !q.value || q.value <= 0) continue;
      // Quotas that report no usage carry no used/limit pair to trend.
      if (typeof q.usage !== "number") continue;
      out.push({
        id: q.quotaCode,
        service: q.scope ?? "organization",
        name: q.name || q.quotaCode,
        limit: q.value,
        used: q.usage,
        ...(typeof q.adjustable === "boolean" ? { adjustable: q.adjustable } : {}),
      });
    }
    return out;
  }

  private static readonly STATE_MAP: Record<string, ResourceStatus> = {
    // Services
    running: "healthy",
    idle: "degraded",
    stopped: "error",
    starting: "provisioning",
    stopping: "degraded",
    provisioning: "provisioning",
    awaking: "provisioning",
    partially_running: "degraded",
    degraded: "degraded",
    failed: "error",
    terminating: "degraded",
    terminated: "error",
    softdeleting: "degraded",
    softdeleted: "error",
    // Managed Postgres
    creating: "provisioning",
    restarting: "provisioning",
    replaying_wal: "provisioning",
    restoring_backup: "provisioning",
    finalizing_restore: "provisioning",
    unavailable: "error",
    deleting: "degraded",
    // Backups
    done: "healthy",
    error: "error",
    in_progress: "provisioning",
    // API keys
    enabled: "healthy",
    disabled: "error",
    // ClickPipes
    Running: "healthy",
    Completed: "healthy",
    Provisioning: "provisioning",
    Setup: "provisioning",
    Snapshot: "provisioning",
    Resync: "provisioning",
    Modifying: "provisioning",
    Degraded: "degraded",
    Stopping: "degraded",
    Pausing: "degraded",
    Stopped: "error",
    Paused: "error",
    Failed: "error",
    InternalError: "error",
  };

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const typeId = resource.resourceTypeId;

    if (typeId === "ch-service") {
      return this.renderServiceDetail(resource, fields);
    }
    if (
      typeId === "ch-backup" ||
      typeId === "ch-clickpipe" ||
      typeId === "ch-api-key" ||
      typeId === "ch-member" ||
      typeId === "ch-postgres"
    ) {
      return this.renderManagementDetail(resource);
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
                ...(fields["releaseChannel"]
                  ? [{ key: "Release Channel", value: String(fields["releaseChannel"]) }]
                  : []),
                ...(fields["tier"] ? [{ key: "Tier", value: String(fields["tier"]) }] : []),
                { key: "State", value: state },
                ...(fields["dataWarehouseId"]
                  ? [
                      {
                        key: "Warehouse",
                        value: `${String(fields["dataWarehouseId"])}${fields["isPrimary"] ? " (primary)" : ""}${fields["isReadonly"] ? " (read-only)" : ""}`,
                      },
                    ]
                  : []),
                ...(fields["complianceType"]
                  ? [{ key: "Compliance", value: String(fields["complianceType"]).toUpperCase() }]
                  : []),
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
                ...(fields["autoscalingMode"]
                  ? [{ key: "Autoscaling", value: String(fields["autoscalingMode"]) }]
                  : []),
                fields["autoscalingMode"] === "horizontal"
                  ? {
                      key: "Replicas",
                      value: `${String(fields["minReplicas"] ?? "?")} - ${String(fields["maxReplicas"] ?? "?")}`,
                    }
                  : { key: "Replicas", value: String(fields["numReplicas"] ?? "—") },
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
                ...(resource.resolvedOutputs["mysqlHost"]
                  ? [
                      {
                        key: "MySQL Interface",
                        value: String(resource.resolvedOutputs["mysqlHost"]),
                        copyable: true,
                      },
                    ]
                  : []),
                {
                  key: "IP Access List",
                  value: String(fields["ipAccessList"] || "No addresses allowed"),
                },
              ],
            },
          ],
        },
        ...this.serviceOperationsSections(fields),
      ],
      headerActions: [
        ...this.serviceOperationsActions(fields),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };

    // Stop/Start header actions for the lifecycle pair (see the type's
    // `lifecycle` declaration). "idle" still counts as running: the service
    // is auto-idled and wakes on demand.
    if (state === "running" || state === "idle") {
      detail.headerActions = [
        {
          kind: "action",
          label: "Stop",
          action: {
            type: "plugin-action",
            actionId: "stop",
            confirmMessage:
              "Stop this service? Open connections drop and compute billing stops while it is stopped; storage keeps billing.",
            successMessage: "Stop requested.",
          },
          variant: "danger",
        },
        ...(detail.headerActions ?? []),
      ];
    } else if (state === "stopped") {
      detail.headerActions = [
        {
          kind: "action",
          label: "Start",
          action: {
            type: "plugin-action",
            actionId: "start",
            successMessage: "Start requested.",
          },
        },
        ...(detail.headerActions ?? []),
      ];
    }

    // Add SQL editor if the service is running and we have connection info
    if ((state === "running" || state === "idle") && resource.resolvedOutputs["connectionString"]) {
      detail.sqlEditor = {
        connectionStringOutputKey: "connectionString",
        defaultQuery: "SELECT * FROM system.tables WHERE database = currentDatabase() LIMIT 20;",
      };
    }
    detail.metricsCapability = { defaultTimeRangeMs: 60 * 60 * 1000 };
    detail.logs = { defaultTailLines: 200 };

    return detail;
  }

  /**
   * The service's backup schedule and upgrade window live on their own
   * endpoints; read them only when a service's detail page opens rather than
   * on every listing. Stashed as JSON in `__`-prefixed fields for the
   * synchronous renderDetail.
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "ch-service") return resource;
    const serviceId = String(resource.fields["serviceId"] ?? resource.externalId ?? "");
    if (!serviceId) return resource;
    const base = `${this.orgPath}/services/${serviceId}`;
    const [backupR, windowR] = await Promise.allSettled([
      this.cloudApi<{ result?: BackupConfig }>("GET", `${base}/backupConfiguration`),
      this.cloudApi<{ result?: UpgradeWindow }>("GET", `${base}/upgradeWindow`),
    ]);
    return {
      ...resource,
      fields: {
        ...resource.fields,
        __backupConfig:
          backupR.status === "fulfilled" && backupR.value.result
            ? JSON.stringify(backupR.value.result)
            : "",
        __upgradeWindow:
          windowR.status === "fulfilled" && windowR.value.result
            ? JSON.stringify(windowR.value.result)
            : "",
      },
    };
  }

  private serviceOperationsSections(fields: Record<string, unknown>): SectionNode[] {
    const backup = parseJson<BackupConfig>(fields["__backupConfig"]);
    const window = parseJson<UpgradeWindow>(fields["__upgradeWindow"]);
    const sections: SectionNode[] = [];
    if (backup) {
      sections.push({
        kind: "section",
        title: "Backups",
        children: [
          {
            kind: "key-value-list",
            items: [
              {
                key: "Schedule",
                value: backup.backupStartTime
                  ? `Daily at ${backup.backupStartTime} UTC`
                  : backup.backupPeriodInHours
                    ? `Every ${backup.backupPeriodInHours} h`
                    : "Not set",
              },
              {
                key: "Retention",
                value: backup.backupRetentionPeriodInHours
                  ? `${Math.round(backup.backupRetentionPeriodInHours / 24)} days`
                  : "Not set",
              },
            ],
          },
        ],
      });
    }
    if (fields["__upgradeWindow"] !== undefined) {
      sections.push({
        kind: "section",
        title: "Maintenance",
        children: [
          {
            kind: "key-value-list",
            items: [
              {
                key: "Upgrade Window",
                value: window
                  ? `${WEEKDAYS[window.weekday] ?? window.weekday} ${String(window.startHourUtc).padStart(2, "0")}:00 UTC, ${window.duration ?? 6} h`
                  : "Not set (ClickHouse picks the time)",
              },
            ],
          },
        ],
      });
    }
    return sections;
  }

  private serviceOperationsActions(fields: Record<string, unknown>): ActionNode[] {
    const backup = parseJson<BackupConfig>(fields["__backupConfig"]);
    const window = parseJson<UpgradeWindow>(fields["__upgradeWindow"]);
    const actions: ActionNode[] = [
      {
        kind: "action",
        label: "Backup schedule",
        action: {
          type: "prompt-nosql-command",
          command: "set-backup-config",
          title: "Backup schedule",
          description:
            "How often ClickHouse Cloud backs this service up and how long backups are kept. Custom schedules depend on the organization's plan.",
          fields: [
            {
              key: "backupPeriodInHours",
              label: "Backup every (hours)",
              kind: "select",
              required: false,
              options: [6, 8, 12, 16, 20, 24, 48].map((h) => ({
                id: String(h),
                label: `${h} hours`,
              })),
              ...(backup?.backupPeriodInHours
                ? { defaultValue: String(backup.backupPeriodInHours) }
                : {}),
              description: "Ignored when a daily start time is set.",
            },
            {
              key: "backupStartTime",
              label: "Daily start time (UTC)",
              kind: "select",
              required: false,
              options: [
                { id: "", label: "No fixed time" },
                ...Array.from({ length: 24 }, (_, h) => {
                  const hh = `${String(h).padStart(2, "0")}:00`;
                  return { id: hh, label: hh };
                }),
              ],
              defaultValue: backup?.backupStartTime ?? "",
            },
            {
              key: "retentionDays",
              label: "Retention (days)",
              kind: "number",
              required: false,
              minValue: 1,
              maxValue: 45,
              stepValue: 1,
              ...(backup?.backupRetentionPeriodInHours
                ? { defaultValue: String(Math.round(backup.backupRetentionPeriodInHours / 24)) }
                : {}),
            },
          ],
          submitLabel: "Save",
        },
      },
      {
        kind: "action",
        label: "Upgrade window",
        action: {
          type: "prompt-nosql-command",
          command: "set-upgrade-window",
          title: "Upgrade window",
          description:
            "A weekly 6-hour window in which ClickHouse Cloud may upgrade this service. Requires an Enterprise organization.",
          fields: [
            {
              key: "weekday",
              label: "Day",
              kind: "select",
              required: true,
              options: WEEKDAYS.map((d, i) => ({ id: String(i), label: d })),
              defaultValue: String(window?.weekday ?? 6),
            },
            {
              key: "startHourUtc",
              label: "Starts at (UTC)",
              kind: "select",
              required: true,
              options: [0, 6, 12, 18].map((h) => ({
                id: String(h),
                label: `${String(h).padStart(2, "0")}:00`,
              })),
              defaultValue: String(window?.startHourUtc ?? 0),
            },
          ],
          submitLabel: "Save",
        },
      },
    ];
    if (window) {
      actions.push({
        kind: "action",
        label: "Clear upgrade window",
        action: {
          type: "plugin-action",
          actionId: "clear-upgrade-window",
          confirmMessage:
            "Remove the upgrade window? ClickHouse Cloud will schedule upgrades itself.",
          successMessage: "Upgrade window removed.",
        },
      });
    }
    return actions;
  }

  private renderManagementDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const typeId = resource.resourceTypeId;
    const state = String(f["state"] ?? f["status"] ?? "");
    const kv = (items: Array<[string, unknown]>) =>
      items
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([key, v]) => ({ key, value: String(v) }));
    const refresh: ActionNode = {
      kind: "action",
      label: "Refresh",
      action: { type: "refresh-resource" },
    };
    const headerActions: ActionNode[] = [];
    let subtitle = "ClickHouse Cloud";
    let items: Array<{ key: string; value: string }> = [];

    switch (typeId) {
      case "ch-backup":
        subtitle = "Backup · ClickHouse Cloud";
        items = kv([
          ["Backup ID", f["backupId"]],
          ["Service ID", f["serviceId"]],
          ["Status", f["status"]],
          ["Type", f["type"]],
          ["Started", f["startedAt"]],
          ["Finished", f["finishedAt"]],
          ["Size", formatBytes(Number(f["sizeInBytes"] ?? 0))],
          ["Duration", f["durationInSeconds"] ? `${String(f["durationInSeconds"])} s` : ""],
          ["Backup Name", f["backupName"]],
        ]);
        break;
      case "ch-clickpipe": {
        subtitle = `ClickPipe · ${String(f["sourceType"] || "ClickHouse Cloud")}`;
        items = kv([
          ["ClickPipe ID", f["clickPipeId"]],
          ["Service ID", f["serviceId"]],
          ["State", f["state"]],
          ["Source", f["sourceType"]],
          [
            "Destination",
            f["destinationDatabase"]
              ? `${String(f["destinationDatabase"])}${f["destinationTable"] ? `.${String(f["destinationTable"])}` : ""}`
              : "",
          ],
          ["Replicas", f["replicas"] || ""],
          ["Concurrency", f["concurrency"] || ""],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
        ]);
        const running = ["Running", "Provisioning", "Setup", "Snapshot", "Degraded", "Resync"];
        if (running.includes(state)) {
          headerActions.push({
            kind: "action",
            label: "Stop",
            variant: "danger",
            action: {
              type: "plugin-action",
              actionId: "stop",
              confirmMessage: "Stop this ClickPipe? Ingestion pauses until it is started again.",
              successMessage: "Stop requested.",
            },
          });
        } else {
          headerActions.push({
            kind: "action",
            label: "Start",
            action: {
              type: "plugin-action",
              actionId: "start",
              successMessage: "Start requested.",
            },
          });
        }
        if (["postgres", "mysql", "mongodb", "bigquery"].includes(String(f["sourceType"]))) {
          headerActions.push({
            kind: "action",
            label: "Resync",
            action: {
              type: "plugin-action",
              actionId: "resync",
              confirmMessage:
                "Resync this pipe? ClickPipes re-snapshots every table from the source, which re-reads all source data.",
              successMessage: "Resync requested.",
            },
          });
        }
        break;
      }
      case "ch-api-key":
        subtitle = "API Key · ClickHouse Cloud";
        items = kv([
          ["Key ID", f["keyId"]],
          ["State", f["state"]],
          ["Key Suffix", f["keySuffix"] ? `...${String(f["keySuffix"])}` : ""],
          ["Roles", f["roles"]],
          ["Created", f["createdAt"]],
          ["Expires", f["expireAt"] || "Never"],
          ["Last Used", f["lastUsedAt"] || "Never"],
          ["IP Access List", f["ipAccessList"] || "Any"],
        ]);
        headerActions.push(
          f["state"] === "enabled"
            ? {
                kind: "action",
                label: "Disable",
                variant: "danger",
                action: {
                  type: "plugin-action",
                  actionId: "disable",
                  confirmMessage: "Disable this API key? Requests made with it start failing.",
                  successMessage: "API key disabled.",
                },
              }
            : {
                kind: "action",
                label: "Enable",
                action: {
                  type: "plugin-action",
                  actionId: "enable",
                  successMessage: "API key enabled.",
                },
              },
        );
        break;
      case "ch-member":
        subtitle = "Member · ClickHouse Cloud";
        items = kv([
          ["User ID", f["userId"]],
          ["Name", f["name"]],
          ["Email", f["email"]],
          ["Roles", f["roles"]],
          ["Joined", f["joinedAt"]],
        ]);
        break;
      case "ch-postgres":
        subtitle = "Managed Postgres · ClickHouse Cloud";
        items = kv([
          ["Postgres ID", f["postgresId"]],
          ["State", f["state"]],
          [
            "Provider",
            `${String(f["provider"] ?? "").toUpperCase()} · ${String(f["region"] ?? "")}`,
          ],
          ["Postgres Version", f["postgresVersion"]],
          ["Instance Size", f["size"]],
          ["Storage", f["storageSize"] ? `${String(f["storageSize"])} GiB` : ""],
          ["High Availability", f["haType"]],
          ["Role", f["isPrimary"] === false ? "Read replica" : "Primary"],
          ["Hostname", f["hostname"]],
          ["Username", f["username"]],
          ["Created", f["createdAt"]],
        ]);
        if (state === "running") {
          headerActions.push({
            kind: "action",
            label: "Restart",
            action: {
              type: "plugin-action",
              actionId: "restart",
              confirmMessage: "Restart this Postgres service? Connections drop while it restarts.",
              successMessage: "Restart requested.",
            },
          });
        }
        break;
    }

    const detail: DetailViewSchema = {
      title: resource.displayName,
      subtitle,
      status: state
        ? {
            kind: "status-dot",
            status: ClickHouseClient.STATE_MAP[state] ?? "info",
            label: state,
          }
        : { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: items.map((i) =>
                i.key.endsWith("ID") || i.key === "Hostname" ? { ...i, copyable: true } : i,
              ),
            },
          ],
        },
      ],
      headerActions: [...headerActions, refresh],
    };
    if (typeId === "ch-postgres") {
      detail.metricsCapability = { defaultTimeRangeMs: 6 * 60 * 60 * 1000 };
      detail.logs = { defaultTailLines: 200 };
    }
    if (typeId === "ch-clickpipe") {
      // Lifetime counters sampled by the host: no window of its own.
      detail.metricsCapability = {};
    }
    return detail;
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const state = String(resource.fields["state"] ?? resource.fields["status"] ?? "");
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
    if (typeId === "ch-postgres") {
      return {
        fields: [
          {
            key: "name",
            label: "Service Name",
            kind: "text",
            required: true,
            description: "Up to 50 characters.",
          },
          {
            key: "provider",
            label: "Cloud Provider",
            kind: "select",
            required: true,
            options: [
              { id: "aws", label: "AWS" },
              { id: "gcp", label: "Google Cloud" },
            ],
            defaultValue: "aws",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: CLOUD_REGIONS.filter(
              (r) => r.availableFor?.includes("aws") || r.availableFor?.includes("gcp"),
            ),
            filterByFieldKey: "provider",
            description: "Managed Postgres is not offered in every ClickHouse Cloud region yet.",
          },
          {
            key: "postgresVersion",
            label: "Postgres Version",
            kind: "select",
            required: false,
            options: [
              { id: "18", label: "Postgres 18" },
              { id: "17", label: "Postgres 17" },
            ],
            defaultValue: "18",
          },
          {
            key: "awsSize",
            label: "Instance Size",
            kind: "select",
            required: true,
            options: postgresSizeOptions("aws"),
            defaultValue: "r8gd.large",
            showWhen: { fieldKey: "provider", fieldValue: "aws" },
            description: "EC2 instance type with local NVMe storage.",
          },
          {
            key: "gcpSize",
            label: "Instance Size",
            kind: "select",
            required: true,
            options: postgresSizeOptions("gcp"),
            defaultValue: "c4a-highmem-4",
            showWhen: { fieldKey: "provider", fieldValue: "gcp" },
            description: "Compute Engine machine type.",
          },
          {
            key: "haType",
            label: "High Availability",
            kind: "select",
            required: false,
            options: [
              { id: "none", label: "None", description: "Single instance" },
              { id: "async", label: "Async", description: "One standby, asynchronous" },
              { id: "sync", label: "Sync", description: "Two standbys, synchronous" },
            ],
            defaultValue: "none",
          },
        ],
      };
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
          regions: CLOUD_REGIONS,
          filterByFieldKey: "provider",
        },
        {
          key: "releaseChannel",
          label: "Release Channel",
          kind: "select",
          required: false,
          options: [
            { id: "default", label: "Default", description: "Regular release cadence" },
            { id: "fast", label: "Fast", description: "New releases first, higher risk" },
            { id: "slow", label: "Slow", description: "Upgrades later (plan-dependent)" },
          ],
          defaultValue: "default",
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

    if (typeId === "ch-postgres") {
      const provider = fields["provider"] === "gcp" ? "gcp" : "aws";
      const size = provider === "gcp" ? fields["gcpSize"] : fields["awsSize"];
      if (!fields["name"] || !fields["region"] || !size) {
        throw new Error("Managed Postgres needs a name, region and instance size");
      }
      const body: Record<string, unknown> = {
        name: fields["name"],
        provider,
        region: fields["region"],
        size,
      };
      if (fields["postgresVersion"]) body["postgresVersion"] = fields["postgresVersion"];
      if (fields["haType"]) body["haType"] = fields["haType"];
      const data = await this.cloudApi<{ result?: CloudPostgres }>(
        "POST",
        `${this.orgPath}/postgres`,
        body,
      );
      if (!data.result?.id) {
        throw new Error("ClickHouse Cloud: create Postgres service returned no result");
      }
      return postgresToResource(this.ctx, accountId, data.result);
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
    if (fields["releaseChannel"]) {
      body["releaseChannel"] = fields["releaseChannel"];
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
    const nativeEndpoint = svc.endpoints?.find(
      (e) => e.protocol === "native" || e.protocol === "nativesecure",
    );
    const host = httpsEndpoint?.host ?? "";
    const port = String(httpsEndpoint?.port ?? 8443);
    const nativePort = String(nativeEndpoint?.port ?? 9440);
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
        nativePort,
        httpUrl: host ? `https://${host}:${port}` : "",
        connectionString: host ? `clickhouse://${host}:${nativePort}` : "",
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

    const externalId = resourceId.split(":").slice(2).join(":");
    switch (typeId) {
      case "ch-clickpipe": {
        const [serviceId, pipeId] = splitPipeId(externalId);
        await this.cloudApi("DELETE", `${this.orgPath}/services/${serviceId}/clickpipes/${pipeId}`);
        return;
      }
      case "ch-api-key":
        await this.cloudApi("DELETE", `${this.orgPath}/keys/${externalId}`);
        return;
      case "ch-member":
        await this.cloudApi("DELETE", `${this.orgPath}/members/${externalId}`);
        return;
      case "ch-postgres":
        await this.cloudApi("DELETE", `${this.orgPath}/postgres/${externalId}`);
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
      await this.setServiceState(serviceId, "stop");
      // Wait a bit for the stop to initiate
      await new Promise((r) => setTimeout(r, 2000));
    }

    await this.cloudApi("DELETE", `/v1/organizations/${this.organizationId}/services/${serviceId}`);
  }

  /** Start or stop a ClickHouse Cloud service via the state PATCH endpoint. */
  private async setServiceState(serviceId: string, command: "start" | "stop"): Promise<void> {
    await this.cloudApi(
      "PATCH",
      `/v1/organizations/${this.organizationId}/services/${serviceId}/state`,
      { command },
    );
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const has = (key: string) => fields[key] !== undefined;
    const num = (key: string) => Number(fields[key]);

    switch (typeId) {
      case "ch-service": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const base = `${this.orgPath}/services/${externalId}`;

        const basic: Record<string, unknown> = {};
        if (has("name")) basic["name"] = fields["name"];
        if (has("releaseChannel") && fields["releaseChannel"]) {
          basic["releaseChannel"] = fields["releaseChannel"];
        }
        if (has("ipAccessList")) {
          const patch = ipAccessListPatch(
            String(current.fields["ipAccessList"] ?? ""),
            fields["ipAccessList"] ?? "",
          );
          if (patch.add.length > 0 || patch.remove.length > 0) basic["ipAccessList"] = patch;
        }
        if (Object.keys(basic).length > 0) await this.cloudApi("PATCH", base, basic);

        // numReplicas is the vertical-mode count and min/maxReplicas the
        // horizontal band; the API rejects both in one request, so only the
        // keys the user actually changed are sent.
        const scaling: Record<string, unknown> = {};
        for (const key of [
          "minReplicaMemoryGb",
          "maxReplicaMemoryGb",
          "numReplicas",
          "minReplicas",
          "maxReplicas",
          "idleTimeoutMinutes",
        ]) {
          if (has(key) && fields[key] !== "" && Number.isFinite(num(key))) scaling[key] = num(key);
        }
        if (has("idleScaling")) scaling["idleScaling"] = fields["idleScaling"] === "true";
        if (has("autoscalingMode") && fields["autoscalingMode"]) {
          scaling["autoscalingMode"] = fields["autoscalingMode"];
        }
        if (Object.keys(scaling).length > 0) {
          await this.cloudApi("PATCH", `${base}/replicaScaling`, scaling);
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "ch-clickpipe": {
        const [serviceId, pipeId] = splitPipeId(externalId);
        const base = `${this.orgPath}/services/${serviceId}/clickpipes/${pipeId}`;
        let latest: CloudClickPipe | undefined;
        if (has("name")) {
          const r = await this.cloudApi<{ result?: CloudClickPipe }>("PATCH", base, {
            name: fields["name"],
          });
          latest = r.result;
        }
        const scaling: Record<string, unknown> = {};
        if (has("replicas") && fields["replicas"] !== "") scaling["replicas"] = num("replicas");
        if (has("concurrency") && fields["concurrency"] !== "") {
          scaling["concurrency"] = num("concurrency");
        }
        if (Object.keys(scaling).length > 0) {
          const r = await this.cloudApi<{ result?: CloudClickPipe }>(
            "PATCH",
            `${base}/scaling`,
            scaling,
          );
          latest = r.result ?? latest;
        }
        if (latest?.id) return clickPipeToResource(this.ctx, accountId, serviceId, latest);
        return this.getResource(typeId, resourceId, accountId);
      }
      case "ch-api-key": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (has("state")) body["state"] = fields["state"];
        const r = await this.cloudApi<{ result?: CloudApiKey }>(
          "PATCH",
          `${this.orgPath}/keys/${externalId}`,
          body,
        );
        if (r.result?.id) return apiKeyToResource(this.ctx, accountId, r.result);
        return this.getResource(typeId, resourceId, accountId);
      }
      case "ch-postgres": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (has("size") && fields["size"]) body["size"] = fields["size"];
        if (has("haType") && fields["haType"]) body["haType"] = fields["haType"];
        const r = await this.cloudApi<{ result?: CloudPostgres }>(
          "PATCH",
          `${this.orgPath}/postgres/${externalId}`,
          body,
        );
        if (r.result?.id) return postgresToResource(this.ctx, accountId, r.result);
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`ClickHouse plugin: update not supported for type "${typeId}"`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "ch-service" && (actionId === "start" || actionId === "stop")) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const serviceId = String(resource.fields["serviceId"] ?? resource.externalId ?? "");
      if (!serviceId) throw new Error("Cannot determine ClickHouse Cloud service ID");
      await this.setServiceState(serviceId, actionId);
      return;
    }
    if (typeId === "ch-service" && actionId === "clear-upgrade-window") {
      await this.cloudApi("DELETE", `${this.orgPath}/services/${externalId}/upgradeWindow`);
      return;
    }
    if (
      typeId === "ch-clickpipe" &&
      (actionId === "start" || actionId === "stop" || actionId === "resync")
    ) {
      const [serviceId, pipeId] = splitPipeId(externalId);
      await this.cloudApi(
        "PATCH",
        `${this.orgPath}/services/${serviceId}/clickpipes/${pipeId}/state`,
        { command: actionId },
      );
      return;
    }
    if (typeId === "ch-api-key" && (actionId === "enable" || actionId === "disable")) {
      await this.cloudApi("PATCH", `${this.orgPath}/keys/${externalId}`, {
        state: actionId === "enable" ? "enabled" : "disabled",
      });
      return;
    }
    if (typeId === "ch-postgres" && actionId === "restart") {
      await this.cloudApi("PATCH", `${this.orgPath}/postgres/${externalId}/state`, {
        command: "restart",
      });
      return;
    }
    throw new Error(
      `ClickHouse plugin: invokeAction "${actionId}" not supported for type "${typeId}"`,
    );
  }

  /** Prompt-form commands from the service detail page (backup schedule, upgrade window). */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId !== "ch-service") {
      throw new Error(`ClickHouse plugin: command "${command}" not supported for "${typeId}"`);
    }
    const serviceId = resourceId.split(":").slice(2).join(":");
    const base = `${this.orgPath}/services/${serviceId}`;
    const form = decodePromptArgs(args);
    switch (command) {
      case "set-backup-config": {
        const body: Record<string, unknown> = {};
        if (form["backupStartTime"]) {
          body["backupStartTime"] = form["backupStartTime"];
        } else if (form["backupPeriodInHours"]) {
          body["backupPeriodInHours"] = Number(form["backupPeriodInHours"]);
        }
        if (form["retentionDays"]) {
          const days = Number(form["retentionDays"]);
          if (!Number.isInteger(days) || days < 1 || days > 45) {
            throw new Error("Retention must be a whole number of days between 1 and 45");
          }
          body["backupRetentionPeriodInHours"] = days * 24;
        }
        if (Object.keys(body).length === 0) return { ok: true };
        await this.cloudApi("PATCH", `${base}/backupConfiguration`, body);
        return { ok: true };
      }
      case "set-upgrade-window": {
        const weekday = Number(form["weekday"]);
        const startHourUtc = Number(form["startHourUtc"]);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
          throw new Error("Pick a day for the upgrade window");
        }
        if (![0, 6, 12, 18].includes(startHourUtc)) {
          throw new Error("The upgrade window starts at 00:00, 06:00, 12:00 or 18:00 UTC");
        }
        await this.cloudApi("PUT", `${base}/upgradeWindow`, { weekday, startHourUtc });
        return { ok: true };
      }
      default:
        throw new Error(`ClickHouse plugin: unknown command "${command}"`);
    }
  }
}

/** ClickPipe external ids are `{serviceId}/{clickPipeId}`. */
function splitPipeId(externalId: string): [string, string] {
  const slash = externalId.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid ClickPipe id "${externalId}"`);
  return [externalId.slice(0, slash), externalId.slice(slash + 1)];
}

/** Split a comma/whitespace-separated address list into unique entries. */
function parseAddressList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),
  ];
}

/** The Cloud API edits the IP access list as an add/remove diff. */
export function ipAccessListPatch(
  current: string,
  next: string,
): { add: Array<{ source: string }>; remove: Array<{ source: string }> } {
  const before = parseAddressList(current);
  const after = parseAddressList(next);
  return {
    remove: before.filter((v) => !after.includes(v)).map((source) => ({ source })),
    add: after.filter((v) => !before.includes(v)).map((source) => ({ source })),
  };
}

interface BackupConfig {
  backupPeriodInHours?: number;
  backupRetentionPeriodInHours?: number;
  backupStartTime?: string;
}

interface UpgradeWindow {
  weekday: number;
  startHourUtc: number;
  duration?: number;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
