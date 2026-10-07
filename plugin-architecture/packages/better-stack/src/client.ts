import type {
  CreateFieldConfig,
  CreateResourceConfig,
  CostFetchRange,
  CostRow,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SecretHostServices,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { BetterStackContext, Host, JsonApiItem } from "./api.js";
import { bsFetch, bsPaged, mapPooled, statusOf } from "./api.js";
import { fetchBetterStackCost } from "./cost.js";
import {
  mapAlert,
  mapDashboard,
  mapGroup,
  mapHeartbeat,
  mapIncident,
  mapMember,
  mapMonitor,
  mapOnCall,
  mapPageResource,
  mapPolicy,
  mapReport,
  mapSection,
  mapSimple,
  mapSource,
  mapStatusPage,
  resourceIdFor,
} from "./mappers.js";
import { verifyBetterStackCredentials } from "./preflight.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  EVENTS_KEY,
  SQL_CONNECTED_KEY,
  renderBetterStackDetail,
  renderBetterStackSidebar,
} from "./render.js";
import type { SqlConnection } from "./sql.js";
import { eventsSql, logLine, logsSql, runSql, sqlHost, tablePrefix } from "./sql.js";

type Attrs = Record<string, unknown>;
const POOL = 4;
const INCIDENT_DAYS = 30;
const SQL_SECRET_FIELD = "sqlConnection";

const opt = (id: string, label = id) => ({ id, label });

function trimmed(fields: Record<string, string>, key: string): string {
  return (fields[key] ?? "").trim();
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function bool(value: string | undefined): boolean {
  return value === "true" || value === "yes" || value === "1";
}

function pickList(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through to comma-separated
  }
  return (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Where each simple type lives: host, collection path, and its mapper. */
const COLLECTIONS: Record<string, { host: Host; path: string }> = {
  monitor: { host: "uptime", path: "/api/v2/monitors" },
  "monitor-group": { host: "uptime", path: "/api/v2/monitor-groups" },
  heartbeat: { host: "uptime", path: "/api/v2/heartbeats" },
  "heartbeat-group": { host: "uptime", path: "/api/v2/heartbeat-groups" },
  "status-page": { host: "uptime", path: "/api/v2/status-pages" },
  "on-call-calendar": { host: "uptime", path: "/api/v2/on-calls" },
  incident: { host: "uptime", path: "/api/v3/incidents" },
  "escalation-policy": { host: "uptime", path: "/api/v3/policies" },
  source: { host: "telemetry", path: "/api/v2/sources" },
  "source-group": { host: "telemetry", path: "/api/v1/source-groups" },
  dashboard: { host: "telemetry", path: "/api/v2/dashboards" },
  "telemetry-alert": { host: "telemetry", path: "/api/v2/alerts" },
  "team-member": { host: "main", path: "/api/v2/team-members" },
};

const STATUS_PAGE_CHILDREN: Record<string, string> = {
  "status-page-section": "sections",
  "status-page-resource": "resources",
  "status-report": "status-reports",
};

export class BetterStackClient implements PluginClient {
  private readonly ctx: BetterStackContext;
  private readonly secrets: SecretHostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("Better Stack plugin: missing apiToken credential");
    const telemetryToken = (credentials["telemetryToken"] ?? "").trim();
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(telemetryToken ? { telemetryToken } : {}),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.secrets = services?.secrets;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * A 401/403 on one product means the token is scoped to the other one (a
   * team Uptime token cannot read Telemetry and vice versa) or is not global:
   * list that type empty. Other failures still throw.
   */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      const status = statusOf(err);
      if (status === 401 || status === 403) return [];
      throw err;
    }
  }

  private async collection(
    typeId: string,
    query: Record<string, string | number | undefined> = {},
  ) {
    const c = COLLECTIONS[typeId];
    if (!c) throw new Error(`Better Stack plugin: unknown resource type "${typeId}"`);
    return bsPaged<Attrs>(this.ctx, c.host, c.path, query);
  }

  private incidentWindow() {
    const to = new Date();
    const from = new Date(to.getTime() - INCIDENT_DAYS * 86400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId in STATUS_PAGE_CHILDREN)
      return this.scoped(() => this.listPageChildren(typeId, accountId));
    return this.scoped(async () => {
      switch (typeId) {
        case "monitor":
          return (await this.collection(typeId)).data.map((m) => mapMonitor(accountId, m));
        case "monitor-group":
        case "heartbeat-group":
          return (await this.collection(typeId)).data.map((g) => mapGroup(accountId, typeId, g));
        case "heartbeat":
          return (await this.collection(typeId)).data.map((h) => mapHeartbeat(accountId, h));
        case "status-page":
          return (await this.collection(typeId)).data.map((p) => mapStatusPage(accountId, p));
        case "on-call-calendar": {
          const { data, included } = await this.collection(typeId);
          return data.map((c) => mapOnCall(accountId, c, included));
        }
        case "incident":
          return (await this.collection(typeId, this.incidentWindow())).data.map((i) =>
            mapIncident(accountId, i),
          );
        case "escalation-policy":
          return (await this.collection(typeId)).data.map((p) => mapPolicy(accountId, p));
        case "source":
          return (await this.collection(typeId, { per_page: 50 })).data.map((x) =>
            mapSource(accountId, x),
          );
        case "source-group":
          return (await this.collection(typeId, { per_page: 50 })).data.map((x) =>
            mapSimple(accountId, "source-group", x),
          );
        case "dashboard":
          return (await this.collection(typeId, { per_page: 50 })).data.map((x) =>
            mapDashboard(accountId, x),
          );
        case "telemetry-alert":
          return (await this.collection(typeId, { per_page: 50 })).data.map((x) =>
            mapAlert(accountId, x),
          );
        case "team-member":
          return (await this.collection(typeId)).data.map((x) => mapMember(accountId, x));
        default:
          throw new Error(`Better Stack plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async listPageChildren(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const pages = (await this.collection("status-page")).data;
    const sub = STATUS_PAGE_CHILDREN[typeId] ?? "";
    const out = await mapPooled(pages, POOL, async (p) => {
      const items = await bsPaged<Attrs>(
        this.ctx,
        "uptime",
        `/api/v2/status-pages/${encodeURIComponent(p.id)}/${sub}`,
      ).catch(() => ({ data: [] as Array<JsonApiItem<Attrs>> }));
      return items.data.map((x) =>
        typeId === "status-page-section"
          ? mapSection(accountId, p.id, x)
          : typeId === "status-page-resource"
            ? mapPageResource(accountId, p.id, x)
            : mapReport(accountId, p.id, x),
      );
    });
    return out.flat();
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  private async one(
    typeId: string,
    id: string,
  ): Promise<{ item: JsonApiItem<Attrs>; included: JsonApiItem[] }> {
    const c = COLLECTIONS[typeId];
    if (!c) throw new Error(`Better Stack plugin: unknown resource type "${typeId}"`);
    const res = await bsFetch<
      { data?: JsonApiItem<Attrs>; included?: JsonApiItem[] } | JsonApiItem<Attrs>
    >(this.ctx, c.host, `${c.path}/${encodeURIComponent(id)}`);
    // Telemetry single reads return the resource without a `data` wrapper.
    const item = "data" in res && res.data ? res.data : (res as JsonApiItem<Attrs>);
    return { item, included: ("included" in res && res.included) || [] };
  }

  private mapOne(
    typeId: string,
    accountId: string,
    item: JsonApiItem<Attrs>,
    included: JsonApiItem[],
  ): ResourceInstance {
    switch (typeId) {
      case "monitor":
        return mapMonitor(accountId, item);
      case "monitor-group":
      case "heartbeat-group":
        return mapGroup(accountId, typeId, item);
      case "heartbeat":
        return mapHeartbeat(accountId, item);
      case "status-page":
        return mapStatusPage(accountId, item);
      case "on-call-calendar":
        return mapOnCall(accountId, item, included);
      case "incident":
        return mapIncident(accountId, item);
      case "escalation-policy":
        return mapPolicy(accountId, item);
      case "source":
        return mapSource(accountId, item);
      case "source-group":
        return mapSimple(accountId, typeId, item);
      case "dashboard":
        return mapDashboard(accountId, item);
      case "telemetry-alert":
        return mapAlert(accountId, item);
      case "team-member":
        return mapMember(accountId, item);
      default:
        throw new Error(`Better Stack plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    if (typeId in STATUS_PAGE_CHILDREN) {
      const found = (await this.listPageChildren(typeId, accountId)).find(
        (r) => r.externalId === id,
      );
      if (!found) throw new Error(`Better Stack plugin: resource ${typeId}/${id} not found`);
      return found;
    }
    const { item, included } = await this.one(typeId, id);
    return this.mapOne(typeId, accountId, item, included);
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "source" && outputKey === "sourceToken") {
      const { item } = await this.one("source", externalIdOf(resourceId));
      const token = item.attributes?.["token"];
      if (typeof token === "string" && token) return token;
      throw new Error("Better Stack did not return this source's token.");
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    const value = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (value === undefined)
      throw new Error(`Better Stack plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
    return String(value);
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = resource.externalId ?? "";
    const range = {
      from: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
    };
    switch (resource.resourceTypeId) {
      case "monitor":
      case "heartbeat": {
        const path =
          resource.resourceTypeId === "monitor"
            ? `/api/v2/monitors/${encodeURIComponent(id)}/sla`
            : `/api/v2/heartbeats/${encodeURIComponent(id)}/availability`;
        const res = await bsFetch<{ data?: { attributes?: { availability?: number } } }>(
          this.ctx,
          "uptime",
          path,
          { query: range },
        );
        const availability = res.data?.attributes?.availability;
        return typeof availability === "number"
          ? { ...resource, fields: { ...resource.fields, availability } }
          : resource;
      }
      case "on-call-calendar": {
        const res = await bsFetch<{ events?: unknown[] }>(
          this.ctx,
          "uptime",
          `/api/v2/on-calls/${encodeURIComponent(id)}/events`,
          {
            query: {
              starts_at: new Date().toISOString(),
              ends_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
            },
          },
        );
        return {
          ...resource,
          resolvedOutputs: {
            ...resource.resolvedOutputs,
            [EVENTS_KEY]: JSON.stringify(res.events ?? []),
          },
        };
      }
      case "source": {
        const conn = await this.sqlConnection(
          resource.accountId,
          String(resource.fields["teamId"] ?? ""),
        );
        return {
          ...resource,
          resolvedOutputs: {
            ...resource.resolvedOutputs,
            [SQL_CONNECTED_KEY]: conn ? "true" : "false",
          },
        };
      }
      default:
        return resource;
    }
  }

  // -------------------------------------------------------------------------
  // SQL API (logs, query editor, source metrics)
  // -------------------------------------------------------------------------

  private sqlSecretId(accountId: string, teamId: string): string {
    return resourceIdFor(accountId, "source", `__sql__/${teamId}`);
  }

  private async sqlConnection(accountId: string, teamId: string): Promise<SqlConnection | null> {
    if (!this.secrets || !teamId) return null;
    const raw = await this.secrets
      .getPlaintext(this.sqlSecretId(accountId, teamId), SQL_SECRET_FIELD)
      .catch(() => null);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SqlConnection;
      return parsed.username && parsed.password ? parsed : null;
    } catch {
      return null;
    }
  }

  private async connectSql(accountId: string, source: ResourceInstance): Promise<void> {
    const teamId = String(source.fields["teamId"] ?? "");
    if (!teamId) throw new Error("Better Stack did not say which team this source belongs to.");
    if (!this.secrets?.setPlaintext)
      throw new Error(
        "This Infrawrench host cannot store the connection. Update the app and try again.",
      );
    const res = await bsFetch<{
      data?: { attributes?: { username?: string; password?: string; host?: string } };
    }>(this.ctx, "telemetry", "/api/v1/connections", {
      method: "POST",
      body: JSON.stringify({
        client_type: "clickhouse",
        team_ids: [Number(teamId)],
        note: "Infrawrench (read-only SQL access)",
      }),
    });
    const a = res.data?.attributes;
    if (!a?.username || !a.password)
      throw new Error("Better Stack did not return the connection's credentials.");
    await this.secrets.setPlaintext(
      this.sqlSecretId(accountId, teamId),
      SQL_SECRET_FIELD,
      JSON.stringify({
        username: a.username,
        password: a.password,
        ...(a.host ? { host: a.host } : {}),
      }),
    );
  }

  private async sqlTarget(resourceId: string, accountId: string) {
    const source = await this.getResource("source", resourceId, accountId);
    const teamId = String(source.fields["teamId"] ?? "");
    const table = String(source.fields["tableName"] ?? "");
    const conn = await this.sqlConnection(accountId, teamId);
    if (!conn) return { source, conn: null, host: "", prefix: "" };
    return {
      source,
      conn,
      host: sqlHost(String(source.fields["dataRegion"] ?? "") || undefined, conn.host),
      prefix: tablePrefix(teamId, table),
    };
  }

  async executeQuery(resourceId: string, accountId: string, sql: string) {
    const t = await this.sqlTarget(resourceId, accountId);
    if (!t.conn)
      throw new Error(
        "Connect SQL access on this source first (the Connect SQL access button on its page).",
      );
    const started = Date.now();
    const rows = await runSql(this.ctx, t.host, t.conn, sql);
    return { rows, durationMs: Date.now() - started };
  }

  async introspectResource(resourceId: string, accountId: string): Promise<SqlTableMeta[]> {
    const t = await this.sqlTarget(resourceId, accountId);
    if (!t.prefix) return [];
    return [
      {
        name: `remote(${t.prefix}_logs)`,
        columns: [
          { name: "dt", type: "DateTime" },
          { name: "raw", type: "String" },
        ],
      },
      { name: `remote(${t.prefix}_metrics)`, columns: [{ name: "dt", type: "DateTime" }] },
    ];
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "source") return { text: "", containers: [], activeContainer: "" };
    const t = await this.sqlTarget(resourceId, accountId);
    if (!t.conn) {
      return {
        text: "SQL access is not connected for this source's team. Use Connect SQL access on the source to read its logs here.\n",
        containers: [],
        activeContainer: "",
      };
    }
    const limit = Math.min(Math.max(params.tailLines ?? 200, 1), 2000);
    const rows = await runSql(this.ctx, t.host, t.conn, logsSql(t.prefix, limit));
    const lines = rows.reverse().map(logLine);
    return {
      text: lines.length ? `${lines.join("\n")}\n` : "No logs yet.\n",
      containers: [],
      activeContainer: "",
    };
  }

  // -------------------------------------------------------------------------
  // Metrics, stats, cost
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
    if (typeId === "monitor") {
      // Response times over the last day, per checking region (seconds in the API).
      const res = await bsFetch<{
        data?: {
          attributes?: {
            regions?: Array<{
              region?: string;
              response_times?: Array<{ at?: string; response_time?: number }>;
            }>;
          };
        };
      }>(this.ctx, "uptime", `/api/v2/monitors/${encodeURIComponent(id)}/response-times`);
      return (res.data?.attributes?.regions ?? [])
        .map((r) => ({
          label: `Response time (${(r.region ?? "").toUpperCase()})`,
          unit: "ms",
          points: (r.response_times ?? [])
            .map((p) => ({
              timestamp: Date.parse(p.at ?? ""),
              value: (p.response_time ?? NaN) * 1000,
            }))
            .filter(
              (p) =>
                Number.isFinite(p.timestamp) &&
                Number.isFinite(p.value) &&
                p.timestamp >= startMs &&
                p.timestamp <= endMs,
            ),
        }))
        .filter((s) => s.points.length > 0);
    }
    if (typeId === "source") {
      const t = await this.sqlTarget(resourceId, accountId);
      if (!t.conn) return [];
      const bucket = Math.max(60, Math.round((endMs - startMs) / 1000 / 120 / 60) * 60);
      const rows = await runSql(
        this.ctx,
        t.host,
        t.conn,
        eventsSql(t.prefix, new Date(startMs).toISOString(), new Date(endMs).toISOString(), bucket),
      );
      return [
        {
          label: "Events",
          unit: "events",
          points: rows
            .map((r) => ({
              timestamp: Date.parse(`${String(r["time"] ?? "").replace(" ", "T")}Z`),
              value: Number(r["events"]),
            }))
            .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value)),
        },
      ].filter((s) => s.points.length > 0);
    }
    return [];
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.enrichDetail(await this.getResource(typeId, resourceId, accountId)).catch(
      () => this.getResource(typeId, resourceId, accountId),
    );
    if (typeId === "monitor" || typeId === "heartbeat") {
      const status = String(r.fields["status"] ?? "");
      return [
        {
          label: "Status",
          value: status || "—",
          variant:
            status === "up" ? "status-healthy" : status === "down" ? "status-error" : "default",
        },
        {
          label: "Availability (30d)",
          value:
            typeof r.fields["availability"] === "number"
              ? `${String(r.fields["availability"])}%`
              : "—",
        },
      ];
    }
    if (typeId === "status-page")
      return [{ label: "State", value: String(r.fields["aggregateState"] ?? "—") }];
    return [];
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchBetterStackCost(this.ctx, range);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyBetterStackCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /** Team names seen on the account, for the team picker global tokens need. */
  private async teams(): Promise<string[]> {
    const names = new Set<string>();
    for (const typeId of ["monitor", "heartbeat", "on-call-calendar", "source"]) {
      const res = await this.collection(typeId).catch(() => ({
        data: [] as Array<JsonApiItem<Attrs>>,
      }));
      for (const x of res.data) {
        const t = x.attributes?.["team_name"];
        if (typeof t === "string" && t) names.add(t);
      }
    }
    return [...names].sort();
  }

  private async teamField(): Promise<CreateFieldConfig[]> {
    const teams = await this.teams();
    if (teams.length <= 1) return [];
    return [
      {
        key: "team",
        label: "Team",
        kind: "select",
        required: false,
        defaultValue: "",
        options: [opt("", "The token's team"), ...teams.map((t) => opt(t))],
        description: "Needed with a global API token: the team that owns the new resource.",
      },
    ];
  }

  private async optionsOf(typeId: string, label: (a: Attrs, id: string) => string) {
    const res = await this.collection(typeId).catch(() => ({
      data: [] as Array<JsonApiItem<Attrs>>,
    }));
    return res.data.map((x) => opt(x.id, label(x.attributes ?? {}, x.id)));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "monitor":
        return {
          fields: [
            ...(await this.teamField()),
            {
              key: "monitorType",
              label: "Check",
              kind: "select",
              required: true,
              defaultValue: "status",
              options: [
                opt("status", "HTTP: page returns 2xx"),
                opt("keyword", "HTTP: page contains a keyword"),
                opt("keyword_absence", "HTTP: page does not contain a keyword"),
                opt("expected_status_code", "HTTP: page returns an expected status code"),
                opt("ping", "Ping"),
                opt("tcp", "TCP port"),
                opt("udp", "UDP port"),
                opt("dns", "DNS"),
                opt("smtp", "SMTP"),
                opt("pop", "POP3"),
                opt("imap", "IMAP"),
              ],
            },
            {
              key: "url",
              label: "URL or host",
              kind: "text",
              required: true,
              placeholder: "https://example.com",
            },
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: false,
              description: "How Better Stack refers to it when it calls you.",
            },
            {
              key: "requiredKeyword",
              label: "Keyword",
              kind: "text",
              required: false,
              showWhen: {
                fieldKey: "monitorType",
                fieldValues: ["keyword", "keyword_absence", "udp"],
              },
            },
            {
              key: "expectedStatusCodes",
              label: "Expected status codes",
              kind: "text",
              required: false,
              placeholder: "200, 301",
              showWhen: { fieldKey: "monitorType", fieldValue: "expected_status_code" },
            },
            {
              key: "port",
              label: "Port",
              kind: "number",
              required: false,
              showWhen: {
                fieldKey: "monitorType",
                fieldValues: ["tcp", "udp", "smtp", "pop", "imap"],
              },
            },
            {
              key: "checkFrequency",
              label: "Check every",
              kind: "select",
              required: true,
              defaultValue: "180",
              options: [
                opt("30", "30 seconds"),
                opt("60", "1 minute"),
                opt("180", "3 minutes"),
                opt("300", "5 minutes"),
                opt("600", "10 minutes"),
                opt("1800", "30 minutes"),
              ],
            },
            {
              key: "regions",
              label: "Regions",
              kind: "policy-picker",
              required: false,
              description: "Leave empty for all four.",
              policies: [
                { id: "us", label: "United States", category: "Regions" },
                { id: "eu", label: "Europe", category: "Regions" },
                { id: "as", label: "Asia", category: "Regions" },
                { id: "au", label: "Australia", category: "Regions" },
              ],
            },
            {
              key: "policyId",
              label: "Escalation policy",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                opt("", "Team defaults"),
                ...(await this.optionsOf("escalation-policy", (a, id) => String(a["name"] ?? id))),
              ],
            },
            {
              key: "monitorGroupId",
              label: "Group",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                opt("", "None"),
                ...(await this.optionsOf("monitor-group", (a, id) => String(a["name"] ?? id))),
              ],
            },
          ],
        };
      case "monitor-group":
      case "heartbeat-group":
      case "source-group":
        return {
          fields: [
            ...(await this.teamField()),
            { key: "name", label: "Name", kind: "text", required: true },
          ],
        };
      case "heartbeat":
        return {
          fields: [
            ...(await this.teamField()),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Nightly backup",
            },
            {
              key: "period",
              label: "Expected every (seconds)",
              kind: "number",
              required: true,
              defaultValue: "3600",
              minValue: 30,
            },
            {
              key: "grace",
              label: "Grace (seconds)",
              kind: "number",
              required: true,
              defaultValue: "720",
              minValue: 0,
              description: "About 20% of the period is a good start.",
            },
            {
              key: "heartbeatGroupId",
              label: "Group",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                opt("", "None"),
                ...(await this.optionsOf("heartbeat-group", (a, id) => String(a["name"] ?? id))),
              ],
            },
          ],
        };
      case "status-page":
        return {
          fields: [
            { key: "companyName", label: "Company name", kind: "text", required: true },
            {
              key: "subdomain",
              label: "Subdomain",
              kind: "text",
              required: true,
              description: "Your page will be at <subdomain>.betteruptime.com; it must be unique.",
            },
            { key: "companyUrl", label: "Company URL", kind: "text", required: false },
            {
              key: "timezone",
              label: "Time zone",
              kind: "text",
              required: false,
              defaultValue: "UTC",
              description: "A Rails time zone name, for example London.",
            },
          ],
        };
      case "status-page-section":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "position", label: "Position", kind: "number", required: false },
          ],
        };
      case "status-page-resource": {
        const [monitors, heartbeats, sections] = await Promise.all([
          this.optionsOf("monitor", (a, id) => String(a["pronounceable_name"] ?? a["url"] ?? id)),
          this.optionsOf("heartbeat", (a, id) => String(a["name"] ?? id)),
          parentResourceId
            ? bsPaged<Attrs>(
                this.ctx,
                "uptime",
                `/api/v2/status-pages/${encodeURIComponent(externalIdOf(parentResourceId))}/sections`,
              )
                .then((r) => r.data.map((s) => opt(s.id, String(s.attributes?.["name"] ?? s.id))))
                .catch(() => [])
            : Promise.resolve([] as Array<{ id: string; label: string }>),
        ]);
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "statusPage",
                    label: "Status page",
                    kind: "select" as const,
                    required: true,
                    options: await this.optionsOf("status-page", (a, id) =>
                      String(a["company_name"] ?? id),
                    ),
                  },
                ]),
            {
              key: "item",
              label: "Show",
              kind: "select",
              required: true,
              options: [
                ...monitors.map((m) => opt(`Monitor:${m.id}`, `Monitor: ${m.label}`)),
                ...heartbeats.map((h) => opt(`Heartbeat:${h.id}`, `Heartbeat: ${h.label}`)),
              ],
            },
            { key: "publicName", label: "Public name", kind: "text", required: true },
            ...(sections.length > 0
              ? [
                  {
                    key: "sectionId",
                    label: "Section",
                    kind: "select" as const,
                    required: false,
                    options: sections,
                  },
                ]
              : []),
            {
              key: "widgetType",
              label: "Widget",
              kind: "select",
              required: false,
              defaultValue: "history",
              options: [
                opt("plain", "Status only"),
                opt("history", "History"),
                opt("response_times", "Response times (monitors)"),
              ],
            },
          ],
        };
      }
      case "on-call-calendar":
        return {
          fields: [
            ...(await this.teamField()),
            { key: "name", label: "Name", kind: "text", required: true },
          ],
        };
      case "incident":
        return {
          fields: [
            ...(await this.teamField()),
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "summary", label: "Summary", kind: "text", required: false },
            {
              key: "description",
              label: "Description",
              kind: "text",
              multiline: true,
              required: false,
            },
            {
              key: "requesterEmail",
              label: "Your email",
              kind: "text",
              required: true,
              description: "Better Stack records who opened the incident.",
            },
            {
              key: "policyId",
              label: "Escalation policy",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                opt("", "Team defaults"),
                ...(await this.optionsOf("escalation-policy", (a, id) => String(a["name"] ?? id))),
              ],
            },
          ],
        };
      case "escalation-policy": {
        const urgencies = await bsPaged<Attrs>(this.ctx, "uptime", "/api/v2/urgencies").catch(
          () => ({ data: [] as Array<JsonApiItem<Attrs>> }),
        );
        return {
          fields: [
            ...(await this.teamField()),
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "urgencyId",
              label: "Severity",
              kind: "select",
              required: true,
              options: urgencies.data.map((u) => opt(u.id, String(u.attributes?.["name"] ?? u.id))),
              description: "How the person on call is alerted.",
            },
            {
              key: "repeatCount",
              label: "Repeat",
              kind: "number",
              required: false,
              defaultValue: "3",
            },
            {
              key: "repeatDelay",
              label: "Repeat delay (seconds)",
              kind: "number",
              required: false,
              defaultValue: "300",
            },
          ],
        };
      }
      case "source":
        return {
          fields: [
            ...(await this.teamField()),
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "platform",
              label: "Platform",
              kind: "select",
              required: true,
              defaultValue: "http",
              options: SOURCE_PLATFORMS.map((p) => opt(p, p.replace(/_/g, " "))),
            },
            {
              key: "dataRegion",
              label: "Data region",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                opt("", "Team default"),
                opt("us_west", "US West"),
                opt("germany", "Germany"),
                opt("singapore", "Singapore"),
              ],
            },
            {
              key: "logsRetention",
              label: "Log retention (days)",
              kind: "number",
              required: false,
            },
            {
              key: "sourceGroupId",
              label: "Group",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                opt("", "None"),
                ...(await this.optionsOf("source-group", (a, id) => String(a["name"] ?? id))),
              ],
            },
          ],
        };
      case "dashboard":
        return {
          fields: [
            ...(await this.teamField()),
            { key: "name", label: "Name", kind: "text", required: true },
          ],
        };
      default:
        throw new Error(`Better Stack plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const team = trimmed(fields, "team");
    const teamBody = team ? { team_name: team } : {};
    const post = async (host: Host, path: string, body: unknown) => {
      const res = await bsFetch<{ data?: JsonApiItem<Attrs> } | JsonApiItem<Attrs>>(
        this.ctx,
        host,
        path,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      return ("data" in res && res.data ? res.data : res) as JsonApiItem<Attrs>;
    };
    switch (typeId) {
      case "monitor": {
        const regions = pickList(fields["regions"]);
        const codes = pickList(fields["expectedStatusCodes"]).map(Number).filter(Number.isFinite);
        const port = num(fields["port"]);
        const m = await post("uptime", "/api/v2/monitors", {
          ...teamBody,
          monitor_type: trimmed(fields, "monitorType") || "status",
          url: trimmed(fields, "url"),
          ...(trimmed(fields, "name") ? { pronounceable_name: trimmed(fields, "name") } : {}),
          check_frequency: num(fields["checkFrequency"]) ?? 180,
          ...(regions.length ? { regions } : {}),
          ...(trimmed(fields, "requiredKeyword")
            ? { required_keyword: trimmed(fields, "requiredKeyword") }
            : {}),
          ...(codes.length ? { expected_status_codes: codes } : {}),
          ...(port !== undefined ? { port: String(port) } : {}),
          ...(trimmed(fields, "policyId") ? { policy_id: trimmed(fields, "policyId") } : {}),
          ...(trimmed(fields, "monitorGroupId")
            ? { monitor_group_id: trimmed(fields, "monitorGroupId") }
            : {}),
        });
        return mapMonitor(accountId, m);
      }
      case "monitor-group":
        return mapGroup(
          accountId,
          typeId,
          await post("uptime", "/api/v2/monitor-groups", {
            ...teamBody,
            name: trimmed(fields, "name"),
          }),
        );
      case "heartbeat-group":
        return mapGroup(
          accountId,
          typeId,
          await post("uptime", "/api/v2/heartbeat-groups", {
            ...teamBody,
            name: trimmed(fields, "name"),
          }),
        );
      case "heartbeat":
        return mapHeartbeat(
          accountId,
          await post("uptime", "/api/v2/heartbeats", {
            ...teamBody,
            name: trimmed(fields, "name"),
            period: num(fields["period"]) ?? 3600,
            grace: num(fields["grace"]) ?? 0,
            ...(trimmed(fields, "heartbeatGroupId")
              ? { heartbeat_group_id: trimmed(fields, "heartbeatGroupId") }
              : {}),
          }),
        );
      case "status-page":
        return mapStatusPage(
          accountId,
          await post("uptime", "/api/v2/status-pages", {
            company_name: trimmed(fields, "companyName"),
            subdomain: trimmed(fields, "subdomain"),
            ...(trimmed(fields, "companyUrl")
              ? { company_url: trimmed(fields, "companyUrl") }
              : {}),
            timezone: trimmed(fields, "timezone") || "UTC",
          }),
        );
      case "status-page-section": {
        const pageId = parentResourceId
          ? externalIdOf(parentResourceId)
          : trimmed(fields, "statusPage");
        const position = num(fields["position"]);
        return mapSection(
          accountId,
          pageId,
          await post("uptime", `/api/v2/status-pages/${encodeURIComponent(pageId)}/sections`, {
            name: trimmed(fields, "name"),
            ...(position !== undefined ? { position } : {}),
          }),
        );
      }
      case "status-page-resource": {
        const pageId = parentResourceId
          ? externalIdOf(parentResourceId)
          : trimmed(fields, "statusPage");
        const [resourceType = "", resourceId = ""] = trimmed(fields, "item").split(":");
        return mapPageResource(
          accountId,
          pageId,
          await post("uptime", `/api/v2/status-pages/${encodeURIComponent(pageId)}/resources`, {
            resource_type: resourceType,
            resource_id: resourceId,
            public_name: trimmed(fields, "publicName"),
            widget_type: trimmed(fields, "widgetType") || "history",
            ...(trimmed(fields, "sectionId")
              ? { status_page_section_id: trimmed(fields, "sectionId") }
              : {}),
          }),
        );
      }
      case "on-call-calendar": {
        const created = await post("uptime", "/api/v2/on-calls", {
          ...teamBody,
          name: trimmed(fields, "name"),
        });
        return mapOnCall(accountId, created, []);
      }
      case "incident":
        return mapIncident(
          accountId,
          await post("uptime", "/api/v3/incidents", {
            ...teamBody,
            name: trimmed(fields, "name"),
            requester_email: trimmed(fields, "requesterEmail"),
            ...(trimmed(fields, "summary") ? { summary: trimmed(fields, "summary") } : {}),
            ...(fields["description"] ? { description: fields["description"] } : {}),
            ...(trimmed(fields, "policyId") ? { policy_id: trimmed(fields, "policyId") } : {}),
          }),
        );
      case "escalation-policy":
        return mapPolicy(
          accountId,
          await post("uptime", "/api/v3/policies", {
            ...teamBody,
            name: trimmed(fields, "name"),
            repeat_count: num(fields["repeatCount"]) ?? 3,
            repeat_delay: num(fields["repeatDelay"]) ?? 300,
            steps: [
              {
                type: "escalation",
                wait_before: 0,
                urgency_id: Number(trimmed(fields, "urgencyId")),
                step_members: [{ type: "current_on_call" }],
              },
            ],
          }),
        );
      case "source": {
        const retention = num(fields["logsRetention"]);
        return mapSource(
          accountId,
          await post("telemetry", "/api/v2/sources", {
            ...teamBody,
            name: trimmed(fields, "name"),
            platform: trimmed(fields, "platform") || "http",
            ...(trimmed(fields, "dataRegion")
              ? { data_region: trimmed(fields, "dataRegion") }
              : {}),
            ...(retention !== undefined ? { logs_retention: retention } : {}),
            ...(trimmed(fields, "sourceGroupId")
              ? { source_group_id: Number(trimmed(fields, "sourceGroupId")) }
              : {}),
          }),
        );
      }
      case "source-group":
        return mapSimple(
          accountId,
          typeId,
          await post("telemetry", "/api/v1/source-groups", {
            ...teamBody,
            name: trimmed(fields, "name"),
          }),
        );
      case "dashboard":
        return mapDashboard(
          accountId,
          await post("telemetry", "/api/v2/dashboards", {
            ...teamBody,
            name: trimmed(fields, "name"),
          }),
        );
      default:
        throw new Error(`Better Stack plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const patch = (host: Host, path: string, body: Record<string, unknown>) =>
      bsFetch<unknown>(this.ctx, host, path, { method: "PATCH", body: JSON.stringify(body) });
    const pick = (map: Record<string, [string, "s" | "n" | "b"]>) => {
      const body: Record<string, unknown> = {};
      for (const [field, [attr, kind]] of Object.entries(map)) {
        if (!(field in fields)) continue;
        const raw = fields[field];
        body[attr] = kind === "n" ? (num(raw) ?? null) : kind === "b" ? bool(raw) : (raw ?? "");
      }
      return body;
    };
    switch (typeId) {
      case "monitor":
        await patch(
          "uptime",
          `/api/v2/monitors/${encodeURIComponent(id)}`,
          pick({
            name: ["pronounceable_name", "s"],
            url: ["url", "s"],
            monitorType: ["monitor_type", "s"],
            checkFrequency: ["check_frequency", "n"],
            requestTimeout: ["request_timeout", "n"],
            requiredKeyword: ["required_keyword", "s"],
            verifySsl: ["verify_ssl", "b"],
            confirmationPeriod: ["confirmation_period", "n"],
            recoveryPeriod: ["recovery_period", "n"],
          }),
        );
        break;
      case "monitor-group":
      case "heartbeat-group":
        await patch(
          "uptime",
          `/api/v2/${typeId === "monitor-group" ? "monitor-groups" : "heartbeat-groups"}/${encodeURIComponent(id)}`,
          pick({ name: ["name", "s"] }),
        );
        break;
      case "heartbeat":
        await patch(
          "uptime",
          `/api/v2/heartbeats/${encodeURIComponent(id)}`,
          pick({ name: ["name", "s"], period: ["period", "n"], grace: ["grace", "n"] }),
        );
        break;
      case "status-page":
        await patch(
          "uptime",
          `/api/v2/status-pages/${encodeURIComponent(id)}`,
          pick({
            companyName: ["company_name", "s"],
            subdomain: ["subdomain", "s"],
            customDomain: ["custom_domain", "s"],
            companyUrl: ["company_url", "s"],
            timezone: ["timezone", "s"],
            history: ["history", "n"],
            published: ["published", "b"],
          }),
        );
        break;
      case "status-page-section": {
        const [pageId = "", sectionId = ""] = id.split("/");
        await patch(
          "uptime",
          `/api/v2/status-pages/${encodeURIComponent(pageId)}/sections/${encodeURIComponent(sectionId)}`,
          pick({
            name: ["name", "s"],
            position: ["position", "n"],
          }),
        );
        break;
      }
      case "status-page-resource": {
        const [pageId = "", itemId = ""] = id.split("/");
        await patch(
          "uptime",
          `/api/v2/status-pages/${encodeURIComponent(pageId)}/resources/${encodeURIComponent(itemId)}`,
          pick({
            publicName: ["public_name", "s"],
            explanation: ["explanation", "s"],
            widgetType: ["widget_type", "s"],
          }),
        );
        break;
      }
      case "on-call-calendar":
        await patch("uptime", `/api/v2/on-calls/${encodeURIComponent(id)}`, {
          name: trimmed(fields, "name"),
        });
        break;
      case "escalation-policy":
        await patch(
          "uptime",
          `/api/v3/policies/${encodeURIComponent(id)}`,
          pick({
            name: ["name", "s"],
            repeatCount: ["repeat_count", "n"],
            repeatDelay: ["repeat_delay", "n"],
          }),
        );
        break;
      case "source":
        await patch(
          "telemetry",
          `/api/v2/sources/${encodeURIComponent(id)}`,
          pick({
            name: ["name", "s"],
            logsRetention: ["logs_retention", "n"],
            metricsRetention: ["metrics_retention", "n"],
          }),
        );
        break;
      case "source-group":
        await patch(
          "telemetry",
          `/api/v1/source-groups/${encodeURIComponent(id)}`,
          pick({ name: ["name", "s"] }),
        );
        break;
      case "dashboard":
        await patch(
          "telemetry",
          `/api/v2/dashboards/${encodeURIComponent(id)}`,
          pick({
            name: ["name", "s"],
            refreshInterval: ["refresh_interval", "n"],
            dateRangeFrom: ["date_range_from", "s"],
            dateRangeTo: ["date_range_to", "s"],
          }),
        );
        break;
      case "telemetry-alert":
        await patch(
          "telemetry",
          `/api/v2/alerts/${encodeURIComponent(id)}`,
          pick({
            name: ["name", "s"],
            operator: ["operator", "s"],
            value: ["value", "n"],
            checkPeriod: ["check_period", "n"],
          }),
        );
        break;
      default:
        throw new Error(`Better Stack plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const del = (host: Host, path: string) =>
      bsFetch<unknown>(this.ctx, host, path, { method: "DELETE" });
    if (typeId === "status-page-section" || typeId === "status-page-resource") {
      const [pageId = "", childId = ""] = id.split("/");
      const sub = typeId === "status-page-section" ? "sections" : "resources";
      await del(
        "uptime",
        `/api/v2/status-pages/${encodeURIComponent(pageId)}/${sub}/${encodeURIComponent(childId)}`,
      );
      return;
    }
    const c = COLLECTIONS[typeId];
    if (!c) throw new Error(`Better Stack plugin: "${typeId}" cannot be deleted from Infrawrench`);
    await del(c.host, `${c.path}/${encodeURIComponent(id)}`);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    const patch = (host: Host, path: string, body: unknown) =>
      bsFetch<unknown>(this.ctx, host, path, { method: "PATCH", body: JSON.stringify(body) });
    if (actionId === "pause" || actionId === "resume") {
      const paused = actionId === "pause";
      switch (typeId) {
        case "monitor":
          await patch("uptime", `/api/v2/monitors/${id}`, { paused });
          return;
        case "heartbeat":
          await patch("uptime", `/api/v2/heartbeats/${id}`, { paused });
          return;
        case "monitor-group":
          await patch("uptime", `/api/v2/monitor-groups/${id}`, { paused });
          return;
        case "heartbeat-group":
          await patch("uptime", `/api/v2/heartbeat-groups/${id}`, { paused });
          return;
        case "source":
          await patch("telemetry", `/api/v2/sources/${id}`, { ingesting_paused: paused });
          return;
        default:
          break;
      }
    }
    if (typeId === "incident" && (actionId === "acknowledge" || actionId === "resolve")) {
      await bsFetch<unknown>(this.ctx, "uptime", `/api/v3/incidents/${id}/${actionId}`, {
        method: "POST",
        body: "{}",
      });
      return;
    }
    if (typeId === "source" && actionId === "connect-sql") {
      await this.connectSql(accountId, await this.getResource("source", resourceId, accountId));
      return;
    }
    throw new Error(`Better Stack plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderBetterStackDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderBetterStackSidebar(resource);
  }
}

/** Platforms `POST /api/v2/sources` accepts (Better Stack docs, 2026-10). */
export const SOURCE_PLATFORMS = [
  "apache2",
  "aws",
  "aws_cloudwatch",
  "aws_ecs",
  "aws_elb",
  "aws_fargate",
  "azure",
  "azure_logs",
  "cloudflare_logpush",
  "cloudflare_prometheus_exporter",
  "cloudflare_worker",
  "datadog_agent",
  "digitalocean",
  "docker",
  "dokku",
  "dotnet",
  "elasticsearch",
  "erlang",
  "fastly",
  "filebeat",
  "flights",
  "fluentbit",
  "fluentd",
  "fly_io",
  "go",
  "gcp",
  "google_cloud_pubsub",
  "haproxy",
  "heroku",
  "http",
  "java",
  "javascript",
  "kubernetes",
  "logstash",
  "minio",
  "mongodb",
  "mysql",
  "nginx",
  "open_telemetry",
  "php",
  "postgresql",
  "prometheus",
  "prometheus_scrape",
  "python",
  "rabbitmq",
  "redis",
  "render",
  "rsyslog",
  "ruby",
  "traefik",
  "ubuntu",
  "vector",
  "vercel_integration",
  "winlogbeat",
];
