import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { DynatraceContext } from "./api.js";
import { DynatraceApiError, envFetch, pagedList, resolveUrls, statusOf } from "./api.js";
import type { DpsCredentials } from "./cost-data.js";
import { fetchDpsCostData, hasDpsCredentials, monthToDate } from "./cost-data.js";
import { DQL_TABLES, runDql } from "./dql.js";
import type {
  AlertingProfileValue,
  DtApiToken,
  DtComment,
  DtEntity,
  DtMonitor,
  DtMonitorStub,
  DtProblem,
  DtSettingsObject,
  DtSlo,
  MaintenanceWindowValue,
} from "./mappers.js";
import {
  SEVERITY_FIELDS,
  isoMs,
  mapAlertingProfile,
  mapApiToken,
  mapEntity,
  mapMaintenanceWindow,
  mapMonitor,
  mapProblem,
  mapSlo,
} from "./mappers.js";
import { METRICS, METRICS_WINDOW_MS, entitySeries, rangeOrDefault } from "./metrics.js";
import { verifyDynatraceCredentials } from "./preflight.js";
import {
  COMMENTS_KEY,
  COST_SUMMARY_KEY,
  renderDynatraceDetail,
  renderDynatraceSidebar,
} from "./render.js";
import { ENTITY_TYPES, SETTINGS_SCHEMAS } from "./resource-types.js";

const ENTITY_PAGE = 500;
const ENTITY_MAX_PAGES = 10;
/** Problems are listed for this far back; open ones are always included. */
const PROBLEM_WINDOW = "now-7d";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function parseForm(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, str(v)]));
  } catch {
    return {};
  }
}

function numberOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** `2026-10-06T09:30:00Z` (the datetime picker) → `2026-10-06T09:30:00` (what the schema wants). */
export function toLocalDateTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/.exec(iso.trim());
  if (!m) throw new Error(`"${iso}" is not a date and time.`);
  return `${m[1]}T${m[2]}:${m[3] ?? "00"}`;
}

/** `9:30` / `09:30` / `09:30:00` → `09:30:00`. */
export function toTime(raw: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) throw new Error(`"${raw}" is not a time of day (hh:mm).`);
  return `${m[1]!.padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
}

/** A Dynatrace metric key fragment from a display name. */
export function metricNameFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "slo";
}

export class DynatraceClient implements PluginClient {
  private readonly ctx: DynatraceContext;
  private readonly dps: DpsCredentials;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const urls = resolveUrls(credentials["environmentUrl"] ?? "");
    const apiToken = (credentials["apiToken"] ?? "").trim();
    if (!urls.envUrl) throw new Error("Dynatrace plugin: missing environmentUrl credential");
    if (!apiToken) throw new Error("Dynatrace plugin: missing apiToken credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      ...urls,
      apiToken,
      platformToken: (credentials["platformToken"] ?? "").trim(),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.dps = {
      accountUuid: (credentials["accountUuid"] ?? "").trim(),
      clientId: (credentials["oauthClientId"] ?? "").trim(),
      clientSecret: (credentials["oauthClientSecret"] ?? "").trim(),
      environmentId: urls.environmentId,
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  /** Exposed for tests. */
  get context(): DynatraceContext {
    return this.ctx;
  }

  private grail(): boolean {
    return Boolean(this.ctx.platformUrl && this.ctx.platformToken);
  }

  /** A 403 on one lister means the token lacks that one scope: that type lists empty. */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  private entityFields(typeId: string): string {
    const base = "+properties,+tags,+managementZones,+firstSeenTms,+lastSeenTms";
    return typeId === "service" || typeId === "process-group" ? `${base},+fromRelationships` : base;
  }

  private async entities(typeId: string): Promise<DtEntity[]> {
    const type = ENTITY_TYPES[typeId];
    if (!type) return [];
    return pagedList<DtEntity>(
      this.ctx,
      "/api/v2/entities",
      "entities",
      {
        entitySelector: `type("${type}")`,
        fields: this.entityFields(typeId),
        pageSize: ENTITY_PAGE,
        from: "now-72h",
      },
      ENTITY_MAX_PAGES,
    );
  }

  private async locationNames(): Promise<Map<string, string>> {
    const res = await envFetch<{
      locations?: Array<{
        entityId?: string;
        name?: string;
        status?: string;
        type?: string;
        cloudPlatform?: string;
      }>;
    }>(this.ctx, "/api/v1/synthetic/locations").catch(() => ({ locations: [] }));
    return new Map(
      (res.locations ?? [])
        .filter((l) => l.entityId)
        .map((l) => [l.entityId ?? "", l.name ?? l.entityId ?? ""]),
    );
  }

  private settings<V>(schemaId: string): Promise<DtSettingsObject<V>[]> {
    return pagedList<DtSettingsObject<V>>(this.ctx, "/api/v2/settings/objects", "items", {
      schemaIds: schemaId,
      scopes: "environment",
      fields: "objectId,value,schemaVersion,scope",
      pageSize: 500,
    });
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (ENTITY_TYPES[typeId]) {
      return this.scoped(async () =>
        (await this.entities(typeId))
          .filter((e) => e.entityId)
          .map((e) => mapEntity(accountId, typeId, e)),
      );
    }
    switch (typeId) {
      case "environment":
        return [await this.environment(accountId, false)];
      case "problem":
        return this.scoped(async () => {
          const problems = await pagedList<DtProblem>(this.ctx, "/api/v2/problems", "problems", {
            from: PROBLEM_WINDOW,
            pageSize: 500,
          });
          return problems.filter((p) => p.problemId).map((p) => mapProblem(accountId, p));
        });
      case "slo":
        return this.scoped(async () =>
          (await this.slos()).filter((s) => s.id).map((s) => mapSlo(accountId, s)),
        );
      case "synthetic-monitor":
        return this.scoped(async () => {
          const [list, names] = await Promise.all([
            envFetch<{ monitors?: DtMonitorStub[] }>(this.ctx, "/api/v1/synthetic/monitors"),
            this.locationNames(),
          ]);
          const stubs = (list.monitors ?? []).filter((m) => m.entityId);
          // The list carries name/type/enabled only; detail reads are bounded.
          const details = await Promise.all(
            stubs
              .slice(0, 200)
              .map((m) =>
                envFetch<DtMonitor>(
                  this.ctx,
                  `/api/v1/synthetic/monitors/${encodeURIComponent(m.entityId ?? "")}`,
                ).catch(() => m as DtMonitor),
              ),
          );
          const byId = new Map(details.map((d) => [d.entityId, d]));
          return stubs.map((m) => mapMonitor(accountId, byId.get(m.entityId) ?? m, names));
        });
      case "alerting-profile":
        return this.scoped(async () =>
          (await this.settings<AlertingProfileValue>(SETTINGS_SCHEMAS["alerting-profile"]!)).map(
            (o) => mapAlertingProfile(accountId, o),
          ),
        );
      case "maintenance-window":
        return this.scoped(async () =>
          (
            await this.settings<MaintenanceWindowValue>(SETTINGS_SCHEMAS["maintenance-window"]!)
          ).map((o) => mapMaintenanceWindow(accountId, o)),
        );
      case "api-token":
        return this.scoped(async () => {
          const tokens = await pagedList<DtApiToken>(this.ctx, "/api/v2/apiTokens", "apiTokens", {
            pageSize: 500,
            fields:
              "+lastUsedDate,+lastUsedIpAddress,+expirationDate,+scopes,+personalAccessToken,+creationDate,+owner,+enabled,+name",
          });
          return tokens.filter((t) => t.id).map((t) => mapApiToken(accountId, t));
        });
      default:
        throw new Error(`Dynatrace plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * Classic SLO list. With `evaluate=true` Dynatrace caps the page at 25, so
   * evaluated SLOs come 25 at a time.
   */
  private slos(): Promise<DtSlo[]> {
    return pagedList<DtSlo>(
      this.ctx,
      "/api/v2/slo",
      "slo",
      { pageSize: 25, evaluate: "true", enabledSlos: "all", timeFrame: "CURRENT", sort: "name" },
      40,
    );
  }

  private async count(
    path: string,
    query: Record<string, string | number>,
  ): Promise<number | undefined> {
    try {
      const res = await envFetch<{ totalCount?: number }>(this.ctx, path, {
        query: { ...query, pageSize: 1 },
      });
      return typeof res?.totalCount === "number" ? res.totalCount : undefined;
    } catch {
      return undefined;
    }
  }

  private async environment(accountId: string, withCost: boolean): Promise<ResourceInstance> {
    const [version, hostCount, serviceCount, applicationCount, openProblems, cost] =
      await Promise.all([
        envFetch<{ version?: string }>(this.ctx, "/api/v1/config/clusterversion").catch(
          () => undefined,
        ),
        this.count("/api/v2/entities", { entitySelector: 'type("HOST")', from: "now-72h" }),
        this.count("/api/v2/entities", { entitySelector: 'type("SERVICE")', from: "now-72h" }),
        this.count("/api/v2/entities", { entitySelector: 'type("APPLICATION")', from: "now-72h" }),
        this.count("/api/v2/problems", { problemSelector: 'status("open")', from: "now-30d" }),
        withCost && hasDpsCredentials(this.dps)
          ? monthToDate(this.dps).catch((err: unknown) => ({
              error: `Could not read platform subscription cost: ${err instanceof Error ? err.message : String(err)}`,
            }))
          : Promise.resolve(undefined),
      ]);
    const id = this.ctx.environmentId || "environment";
    const now = new Date().toISOString();
    const fields: Record<string, string | number | boolean> = {
      environmentId: id,
      url: this.ctx.envUrl,
      grail: this.grail(),
    };
    if (this.ctx.platformUrl) fields["platformUrl"] = this.ctx.platformUrl;
    if (version?.version) fields["version"] = version.version;
    if (hostCount !== undefined) fields["hostCount"] = hostCount;
    if (serviceCount !== undefined) fields["serviceCount"] = serviceCount;
    if (applicationCount !== undefined) fields["applicationCount"] = applicationCount;
    if (openProblems !== undefined) fields["openProblems"] = openProblems;
    const outputs: Record<string, string> = { url: this.ctx.envUrl, environmentId: id };
    if (this.ctx.platformUrl) outputs["platformUrl"] = this.ctx.platformUrl;
    if (cost) outputs[COST_SUMMARY_KEY] = JSON.stringify(cost);
    return {
      id: `${accountId}:environment:${id}`,
      pluginId: "dynatrace",
      resourceTypeId: "environment",
      accountId,
      displayName: id,
      fields,
      resolvedOutputs: outputs,
      secretStates: [],
      externalId: id,
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId) || resourceId;
    if (ENTITY_TYPES[typeId]) {
      const e = await envFetch<DtEntity>(this.ctx, `/api/v2/entities/${encodeURIComponent(id)}`, {
        query: { fields: this.entityFields(typeId) },
      });
      return mapEntity(accountId, typeId, e);
    }
    switch (typeId) {
      case "environment":
        return this.environment(accountId, false);
      case "problem":
        return mapProblem(
          accountId,
          await envFetch<DtProblem>(this.ctx, `/api/v2/problems/${encodeURIComponent(id)}`),
        );
      case "slo": {
        try {
          return mapSlo(
            accountId,
            await envFetch<DtSlo>(this.ctx, `/api/v2/slo/${encodeURIComponent(id)}`, {
              query: { timeFrame: "CURRENT" },
            }),
          );
        } catch (err) {
          // A disabled SLO cannot be read on its own; the list still has it.
          const found = (await this.slos()).find((s) => s.id === id);
          if (found) return mapSlo(accountId, found);
          throw err;
        }
      }
      case "synthetic-monitor": {
        const [m, names] = await Promise.all([
          envFetch<DtMonitor>(this.ctx, `/api/v1/synthetic/monitors/${encodeURIComponent(id)}`),
          this.locationNames(),
        ]);
        return mapMonitor(accountId, m, names);
      }
      case "alerting-profile":
        return mapAlertingProfile(accountId, await this.settingsObject<AlertingProfileValue>(id));
      case "maintenance-window":
        return mapMaintenanceWindow(
          accountId,
          await this.settingsObject<MaintenanceWindowValue>(id),
        );
      case "api-token":
        return mapApiToken(
          accountId,
          await envFetch<DtApiToken>(this.ctx, `/api/v2/apiTokens/${encodeURIComponent(id)}`),
        );
      default:
        throw new Error(`Dynatrace plugin: unknown resource type "${typeId}"`);
    }
  }

  private settingsObject<V>(objectId: string): Promise<DtSettingsObject<V>> {
    return envFetch<DtSettingsObject<V>>(
      this.ctx,
      `/api/v2/settings/objects/${encodeURIComponent(objectId)}`,
    );
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "environment") {
      const map: Record<string, string> = {
        url: this.ctx.envUrl,
        platformUrl: this.ctx.platformUrl,
        environmentId: this.ctx.environmentId,
      };
      if (map[outputKey] !== undefined) return map[outputKey] ?? "";
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (v === undefined) {
      throw new Error(`Dynatrace plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
    }
    return String(v);
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId === "environment") {
      return this.environment(resource.accountId, true);
    }
    if (resource.resourceTypeId === "problem" && resource.externalId) {
      const res = await envFetch<{ comments?: DtComment[] }>(
        this.ctx,
        `/api/v2/problems/${encodeURIComponent(resource.externalId)}/comments`,
        { query: { pageSize: 50 } },
      ).catch(() => ({ comments: [] as DtComment[] }));
      const comments = (res.comments ?? []).map((c) => ({
        author: c.authorName,
        at: isoMs(c.createdAtTimestamp),
        content: c.content,
      }));
      return {
        ...resource,
        resolvedOutputs: { ...resource.resolvedOutputs, [COMMENTS_KEY]: JSON.stringify(comments) },
      };
    }
    return resource;
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, logs, costs, query
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(typeId, resourceId, accountId);
    const f = r.fields;
    switch (typeId) {
      case "environment":
        return [
          { label: "Hosts", value: str(f["hostCount"]) || "-" },
          {
            label: "Open problems",
            value: str(f["openProblems"]) || "0",
            variant: Number(f["openProblems"] ?? 0) > 0 ? "status-degraded" : "status-healthy",
          },
        ];
      case "slo":
        return [
          {
            label: "Current",
            value:
              f["evaluatedPercentage"] !== undefined ? `${str(f["evaluatedPercentage"])}%` : "-",
          },
          { label: "Target", value: `${str(f["target"])}%` },
        ];
      case "problem":
        return [{ label: "Status", value: str(f["status"]) || "-" }];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const range = rangeOrDefault(timeRange, METRICS_WINDOW_MS);
    const id = externalIdOf(resourceId) || resourceId;
    if (typeId === "synthetic-monitor") {
      const m = await this.getResource(typeId, resourceId, accountId);
      const specs = METRICS[`synthetic-monitor-${str(m.fields["type"]) || "HTTP"}`] ?? [];
      return entitySeries(this.ctx, specs, id, range);
    }
    const specs = METRICS[typeId];
    if (!specs) return [];
    return entitySeries(this.ctx, specs, id, range);
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const id = (externalIdOf(resourceId) || resourceId).replace(/"/g, "");
    const limit = Math.min(Math.max(params.tailLines ?? 200, 1), 1000);
    const field = typeId === "service" ? "dt.entity.service" : "dt.entity.host";
    let lines: Array<{ timestamp: string; status: string; content: string }>;
    if (this.grail()) {
      const rows = await runDql(
        this.ctx,
        `fetch logs, from: now()-24h\n| filter ${field} == "${id}"\n| sort timestamp desc\n| limit ${limit}`,
        { maxResultRecords: limit },
      );
      lines = rows.map((r) => ({
        timestamp: str(r["timestamp"]),
        status: str(r["loglevel"] ?? r["status"]),
        content: str(r["content"]),
      }));
    } else {
      const res = await envFetch<{
        results?: Array<{ timestamp?: number; status?: string; content?: string }>;
      }>(this.ctx, "/api/v2/logs/search", {
        query: { query: `${field}="${id}"`, from: "now-24h", limit, sort: "-timestamp" },
      });
      lines = (res.results ?? []).map((r) => ({
        timestamp: isoMs(r.timestamp) ?? "",
        status: str(r.status),
        content: str(r.content),
      }));
    }
    const text = lines
      .reverse()
      .map((l) => `${l.timestamp} ${l.status ? `[${l.status}] ` : ""}${l.content}\n`)
      .join("");
    return { text, containers: [], activeContainer: "" };
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchDpsCostData(this.dps, range);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyDynatraceCredentials(this.ctx);
  }

  async executeQuery(
    _resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const started = Date.now();
    const rows = await runDql(this.ctx, sql);
    // Nested records and arrays read better as JSON than as [object Object].
    const flat = rows.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          v !== null && typeof v === "object" ? JSON.stringify(v) : v,
        ]),
      ),
    );
    return { rows: flat, durationMs: Date.now() - started };
  }

  async introspectResource(): Promise<SqlTableMeta[]> {
    return DQL_TABLES;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "slo":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Checkout availability",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "metricExpression",
              label: "Metric expression",
              kind: "text",
              required: true,
              multiline: true,
              defaultValue:
                "(100)*(builtin:service.errors.server.successCount:splitBy())/(builtin:service.requestCount.server:splitBy())",
              description:
                "Must evaluate to a percentage. The default is the share of successful service requests.",
            },
            {
              key: "filter",
              label: "Entity filter",
              kind: "text",
              required: false,
              placeholder: 'type("SERVICE"),tag("env:prod")',
              description: "An entity selector restricting which entities the expression covers.",
            },
            {
              key: "target",
              label: "Target (%)",
              kind: "number",
              required: true,
              defaultValue: "99",
              minValue: 0,
              maxValue: 100,
              stepValue: 0.01,
            },
            {
              key: "warning",
              label: "Warning (%)",
              kind: "number",
              required: true,
              defaultValue: "99.5",
              minValue: 0,
              maxValue: 100,
              stepValue: 0.01,
            },
            {
              key: "timeframe",
              label: "Timeframe",
              kind: "select",
              required: true,
              defaultValue: "-1w",
              options: [
                { id: "-1d", label: "Last day" },
                { id: "-1w", label: "Last week" },
                { id: "-30d", label: "Last 30 days" },
                { id: "-1M", label: "Last month" },
              ],
            },
          ],
        };
      case "synthetic-monitor": {
        const res = await envFetch<{
          locations?: Array<{
            entityId?: string;
            name?: string;
            type?: string;
            status?: string;
            cloudPlatform?: string;
          }>;
        }>(this.ctx, "/api/v1/synthetic/locations");
        const locations = (res.locations ?? []).filter(
          (l) => l.entityId && (!l.status || l.status === "ENABLED"),
        );
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "Homepage" },
            {
              key: "url",
              label: "URL",
              kind: "text",
              required: true,
              placeholder: "https://example.com/health",
            },
            {
              key: "method",
              label: "Method",
              kind: "select",
              required: true,
              defaultValue: "GET",
              options: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"].map((m) => ({
                id: m,
                label: m,
              })),
            },
            {
              key: "frequencyMin",
              label: "Frequency",
              kind: "select",
              required: true,
              defaultValue: "15",
              options: [1, 2, 5, 10, 15, 30, 60, 120, 240].map((n) => ({
                id: String(n),
                label: `Every ${n} min`,
              })),
            },
            {
              key: "locations",
              label: "Locations",
              kind: "policy-picker",
              required: true,
              description: "Where the monitor runs from.",
              policies: locations.map((l) => ({
                id: l.entityId ?? "",
                label: l.name ?? l.entityId ?? "",
                category: l.type === "PRIVATE" ? "Private" : "Public",
                ...(l.cloudPlatform ? { description: l.cloudPlatform } : {}),
              })),
            },
            {
              key: "failOnStatus",
              label: "Fail on HTTP status",
              kind: "text",
              required: false,
              defaultValue: ">=400",
              description:
                "Status codes that count as a failure, in Dynatrace's list syntax (>=400, 404, 500-599).",
            },
          ],
        };
      }
      case "alerting-profile":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Production on-call",
            },
            ...SEVERITY_FIELDS.map(([key, level]) => ({
              key,
              label: `${level
                .replace(/_/g, " ")
                .toLowerCase()
                .replace(/^./, (c) => c.toUpperCase())} delay (min)`,
              kind: "number" as const,
              required: false,
              minValue: 0,
              maxValue: 10000,
              ...(level === "AVAILABILITY" || level === "ERRORS" ? { defaultValue: "0" } : {}),
              description: "Blank leaves this severity out of the profile.",
            })),
            {
              key: "tagFilter",
              label: "Only entities tagged",
              kind: "string-list",
              required: false,
              description: "Tags such as env:prod. Applied to every severity rule.",
            },
            {
              key: "tagFilterIncludeMode",
              label: "Tag match",
              kind: "select",
              required: false,
              defaultValue: "INCLUDE_ANY",
              options: [
                { id: "INCLUDE_ANY", label: "Any of the tags" },
                { id: "INCLUDE_ALL", label: "All of the tags" },
              ],
              showWhen: { fieldKey: "tagFilter", fieldValuesNot: [""] },
            },
          ],
        };
      case "maintenance-window": {
        const recurring = { fieldKey: "scheduleType", fieldValues: ["DAILY", "WEEKLY", "MONTHLY"] };
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Database upgrade",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "maintenanceType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "PLANNED",
              options: [
                { id: "PLANNED", label: "Planned" },
                { id: "UNPLANNED", label: "Unplanned" },
              ],
            },
            {
              key: "suppression",
              label: "During the window",
              kind: "select",
              required: true,
              defaultValue: "DETECT_PROBLEMS_DONT_ALERT",
              options: [
                { id: "DETECT_PROBLEMS_DONT_ALERT", label: "Detect problems, do not alert" },
                { id: "DONT_DETECT_PROBLEMS", label: "Do not detect problems" },
                { id: "DETECT_PROBLEMS_AND_ALERT", label: "Detect problems and alert" },
              ],
            },
            {
              key: "disableSynthetic",
              label: "Pause synthetic monitors",
              kind: "select",
              required: true,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
            {
              key: "scheduleType",
              label: "Schedule",
              kind: "select",
              required: true,
              defaultValue: "ONCE",
              options: [
                { id: "ONCE", label: "Once" },
                { id: "DAILY", label: "Daily" },
                { id: "WEEKLY", label: "Weekly" },
                { id: "MONTHLY", label: "Monthly" },
              ],
            },
            {
              key: "start",
              label: "Starts",
              kind: "datetime",
              required: true,
              showWhen: { fieldKey: "scheduleType", fieldValue: "ONCE" },
            },
            {
              key: "end",
              label: "Ends",
              kind: "datetime",
              required: true,
              showWhen: { fieldKey: "scheduleType", fieldValue: "ONCE" },
            },
            {
              key: "dayOfWeek",
              label: "Day",
              kind: "select",
              required: true,
              defaultValue: "SUNDAY",
              showWhen: { fieldKey: "scheduleType", fieldValue: "WEEKLY" },
              options: [
                "MONDAY",
                "TUESDAY",
                "WEDNESDAY",
                "THURSDAY",
                "FRIDAY",
                "SATURDAY",
                "SUNDAY",
              ].map((d) => ({
                id: d,
                label: d.charAt(0) + d.slice(1).toLowerCase(),
              })),
            },
            {
              key: "dayOfMonth",
              label: "Day of month",
              kind: "number",
              required: true,
              defaultValue: "1",
              minValue: 1,
              maxValue: 31,
              showWhen: { fieldKey: "scheduleType", fieldValue: "MONTHLY" },
            },
            {
              key: "startTime",
              label: "From (hh:mm)",
              kind: "text",
              required: true,
              placeholder: "22:00",
              showWhen: recurring,
            },
            {
              key: "endTime",
              label: "Until (hh:mm)",
              kind: "text",
              required: true,
              placeholder: "23:30",
              showWhen: recurring,
            },
            {
              key: "scheduleStartDate",
              label: "First day",
              kind: "datetime",
              datetimeMode: "date",
              required: true,
              showWhen: recurring,
            },
            {
              key: "scheduleEndDate",
              label: "Last day",
              kind: "datetime",
              datetimeMode: "date",
              required: true,
              showWhen: recurring,
            },
            {
              key: "timeZone",
              label: "Time zone",
              kind: "text",
              required: true,
              defaultValue: "UTC",
              description:
                "UTC, an offset such as UTC+01:00, or an IANA zone such as Europe/Vienna.",
            },
            {
              key: "entityTags",
              label: "Only entities tagged",
              kind: "string-list",
              required: false,
              description: "Leave empty for the whole environment.",
            },
          ],
        };
      }
      default:
        throw new Error(`Dynatrace plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private async createSettings(schemaId: string, value: unknown): Promise<string> {
    const res = await envFetch<
      Array<{ code?: number; objectId?: string; error?: { message?: string } }>
    >(this.ctx, "/api/v2/settings/objects", {
      method: "POST",
      body: JSON.stringify([{ schemaId, scope: "environment", value }]),
    });
    const first = Array.isArray(res) ? res[0] : undefined;
    if (!first?.objectId) {
      throw new DynatraceApiError(
        first?.code ?? 400,
        first?.error?.message ?? "Dynatrace did not create the object.",
      );
    }
    return first.objectId;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "slo": {
        const name = (fields["name"] ?? "").trim();
        const body = {
          name,
          enabled: true,
          metricExpression: (fields["metricExpression"] ?? "").trim(),
          metricName: metricNameFor(name),
          evaluationType: "AGGREGATE",
          filter: (fields["filter"] ?? "").trim(),
          target: Number(fields["target"]),
          warning: Number(fields["warning"]),
          timeframe: fields["timeframe"] || "-1w",
          ...(fields["description"]?.trim() ? { description: fields["description"].trim() } : {}),
        };
        await envFetch(this.ctx, "/api/v2/slo", { method: "POST", body: JSON.stringify(body) });
        const created = (await this.slos()).find((s) => s.name === name);
        if (!created)
          throw new Error(
            "Dynatrace accepted the SLO but it is not listed yet. Refresh in a moment.",
          );
        return mapSlo(accountId, created);
      }
      case "synthetic-monitor": {
        let locations: string[] = [];
        try {
          locations = JSON.parse(fields["locations"] || "[]") as string[];
        } catch {
          locations = (fields["locations"] ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        if (locations.length === 0) throw new Error("Pick at least one location.");
        const name = (fields["name"] ?? "").trim();
        const failOn = (fields["failOnStatus"] ?? "").trim();
        const body = {
          name,
          type: "HTTP",
          frequencyMin: Number(fields["frequencyMin"] || 15),
          enabled: true,
          locations,
          tags: [],
          manuallyAssignedApps: [],
          anomalyDetection: {
            outageHandling: {
              globalOutage: true,
              globalOutagePolicy: { consecutiveRuns: 1 },
              localOutage: false,
              localOutagePolicy: { affectedLocations: 1, consecutiveRuns: 3 },
              retryOnError: false,
            },
            loadingTimeThresholds: { enabled: true, thresholds: [] },
          },
          script: {
            version: "1.0",
            requests: [
              {
                description: name,
                url: (fields["url"] ?? "").trim(),
                method: fields["method"] || "GET",
                ...(failOn
                  ? {
                      validation: {
                        rules: [{ type: "httpStatusesList", value: failOn, passIfFound: false }],
                      },
                    }
                  : {}),
                configuration: { acceptAnyCertificate: false, followRedirects: true },
              },
            ],
          },
        };
        const res = await envFetch<{ entityId?: string }>(this.ctx, "/api/v1/synthetic/monitors", {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res?.entityId) throw new Error("Dynatrace did not return the new monitor's id.");
        return this.getResource("synthetic-monitor", res.entityId, accountId);
      }
      case "alerting-profile": {
        const tags = (fields["tagFilter"] ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        const mode = tags.length ? fields["tagFilterIncludeMode"] || "INCLUDE_ANY" : "NONE";
        const severityRules = SEVERITY_FIELDS.flatMap(([key, level]) => {
          const delay = numberOrUndefined(fields[key]);
          return delay === undefined
            ? []
            : [
                {
                  severityLevel: level,
                  delayInMinutes: delay,
                  tagFilterIncludeMode: mode,
                  tagFilter: tags,
                },
              ];
        });
        const objectId = await this.createSettings(SETTINGS_SCHEMAS["alerting-profile"]!, {
          name: (fields["name"] ?? "").trim(),
          managementZone: null,
          severityRules,
          eventFilters: [],
        });
        return this.getResource("alerting-profile", objectId, accountId);
      }
      case "maintenance-window": {
        const objectId = await this.createSettings(
          SETTINGS_SCHEMAS["maintenance-window"]!,
          maintenanceValue(fields),
        );
        return this.getResource("maintenance-window", objectId, accountId);
      }
      default:
        throw new Error(`Dynatrace plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update / delete / actions
  // -------------------------------------------------------------------------

  private async putSettings<V>(objectId: string, mutate: (value: V) => V): Promise<void> {
    const current = await this.settingsObject<V>(objectId);
    const value = mutate(structuredClone(current.value ?? ({} as V)));
    await envFetch(this.ctx, `/api/v2/settings/objects/${encodeURIComponent(objectId)}`, {
      method: "PUT",
      body: JSON.stringify({
        value,
        ...(current.schemaVersion ? { schemaVersion: current.schemaVersion } : {}),
      }),
    });
  }

  private async putSlo(id: string, patch: Partial<DtSlo>): Promise<void> {
    let current: DtSlo | undefined;
    try {
      current = await envFetch<DtSlo>(this.ctx, `/api/v2/slo/${encodeURIComponent(id)}`);
    } catch {
      current = (await this.slos()).find((s) => s.id === id);
    }
    if (!current) throw new Error("Dynatrace plugin: SLO not found");
    const merged = { ...current, ...patch };
    const body = {
      name: merged.name,
      enabled: merged.enabled !== false,
      metricExpression: merged.metricExpression,
      metricName: merged.metricName,
      evaluationType: merged.evaluationType ?? "AGGREGATE",
      filter: merged.filter ?? "",
      target: merged.target,
      warning: merged.warning,
      timeframe: merged.timeframe,
      ...(merged.description ? { description: merged.description } : {}),
    };
    await envFetch(this.ctx, `/api/v2/slo/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  private async putMonitor(id: string, enabled: boolean): Promise<void> {
    const path = `/api/v1/synthetic/monitors/${encodeURIComponent(id)}`;
    const current = await envFetch<Record<string, unknown>>(this.ctx, path);
    // The read carries server-owned fields the write does not accept.
    const { entityId: _id, createdFrom: _from, ...rest } = current;
    await envFetch(this.ctx, path, { method: "PUT", body: JSON.stringify({ ...rest, enabled }) });
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId) || resourceId;
    switch (typeId) {
      case "slo": {
        const patch: Partial<DtSlo> = {};
        if ("name" in fields && fields["name"]?.trim()) patch.name = fields["name"].trim();
        if ("description" in fields) patch.description = fields["description"] ?? "";
        if ("metricExpression" in fields && fields["metricExpression"]?.trim())
          patch.metricExpression = fields["metricExpression"].trim();
        if ("filter" in fields) patch.filter = fields["filter"] ?? "";
        if ("target" in fields && numberOrUndefined(fields["target"]) !== undefined)
          patch.target = Number(fields["target"]);
        if ("warning" in fields && numberOrUndefined(fields["warning"]) !== undefined)
          patch.warning = Number(fields["warning"]);
        if ("timeframe" in fields && fields["timeframe"]?.trim())
          patch.timeframe = fields["timeframe"].trim();
        if ("enabled" in fields) patch.enabled = fields["enabled"] === "true";
        await this.putSlo(id, patch);
        return this.getResource("slo", resourceId, accountId);
      }
      case "alerting-profile": {
        await this.putSettings<AlertingProfileValue>(id, (v) => applyAlertingEdits(v, fields));
        return this.getResource("alerting-profile", resourceId, accountId);
      }
      case "maintenance-window": {
        await this.putSettings<MaintenanceWindowValue>(id, (v) => {
          const g = { ...(v.generalProperties ?? {}) };
          if (fields["name"]?.trim()) g.name = fields["name"].trim();
          if ("description" in fields) g.description = fields["description"] ?? "";
          if (fields["maintenanceType"]) g.maintenanceType = fields["maintenanceType"];
          if (fields["suppression"]) g.suppression = fields["suppression"];
          if ("disableSynthetic" in fields)
            g.disableSyntheticMonitorExecution = fields["disableSynthetic"] === "true";
          return {
            ...v,
            ...("enabled" in fields ? { enabled: fields["enabled"] === "true" } : {}),
            generalProperties: g,
          };
        });
        return this.getResource("maintenance-window", resourceId, accountId);
      }
      case "api-token": {
        const body: Record<string, unknown> = {};
        if (fields["name"]?.trim()) body["name"] = fields["name"].trim();
        if ("enabled" in fields) body["enabled"] = fields["enabled"] === "true";
        if (Object.keys(body).length > 0) {
          await envFetch(this.ctx, `/api/v2/apiTokens/${encodeURIComponent(id)}`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
        }
        return this.getResource("api-token", resourceId, accountId);
      }
      default:
        throw new Error(`Dynatrace plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId) || resourceId);
    const path: Record<string, string> = {
      slo: `/api/v2/slo/${id}`,
      "synthetic-monitor": `/api/v1/synthetic/monitors/${id}`,
      "alerting-profile": `/api/v2/settings/objects/${id}`,
      "maintenance-window": `/api/v2/settings/objects/${id}`,
      "api-token": `/api/v2/apiTokens/${id}`,
    };
    const target = path[typeId];
    if (!target)
      throw new Error(`Dynatrace plugin: "${typeId}" cannot be deleted from Infrawrench`);
    await envFetch(this.ctx, target, { method: "DELETE" });
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId) || resourceId;
    const on = actionId === "enable";
    if (actionId !== "enable" && actionId !== "disable") {
      throw new Error(`Dynatrace plugin: unknown action "${actionId}" for "${typeId}"`);
    }
    switch (typeId) {
      case "slo":
        return this.putSlo(id, { enabled: on });
      case "synthetic-monitor":
        return this.putMonitor(id, on);
      case "maintenance-window":
      case "api-token":
        await this.updateResource(typeId, resourceId, accountId, { enabled: String(on) });
        return;
      default:
        throw new Error(`Dynatrace plugin: unknown action "${actionId}" for "${typeId}"`);
    }
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId !== "problem") throw new Error(`Dynatrace plugin: unknown command "${command}"`);
    const id = encodeURIComponent(externalIdOf(resourceId) || resourceId);
    const message = (parseForm(args[0])["message"] ?? "").trim();
    if (!message) throw new Error("Write a comment first.");
    if (command === "comment") {
      await envFetch(this.ctx, `/api/v2/problems/${id}/comments`, {
        method: "POST",
        body: JSON.stringify({ message, context: "Infrawrench" }),
      });
      return { ok: true };
    }
    if (command === "close") {
      await envFetch(this.ctx, `/api/v2/problems/${id}/close`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      return { ok: true };
    }
    throw new Error(`Dynatrace plugin: unknown command "${command}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDynatraceDetail({
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, __envUrl__: this.ctx.envUrl },
    });
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderDynatraceSidebar(resource);
  }
}

/** Apply edits of the per-severity delay fields to an alerting profile value. */
export function applyAlertingEdits(
  v: AlertingProfileValue,
  fields: Record<string, string>,
): AlertingProfileValue {
  let rules = [...(v.severityRules ?? [])];
  for (const [key, level] of SEVERITY_FIELDS) {
    if (!(key in fields)) continue;
    const delay = numberOrUndefined(fields[key]);
    if (delay === undefined) {
      rules = rules.filter((r) => r.severityLevel !== level);
    } else if (rules.some((r) => r.severityLevel === level)) {
      rules = rules.map((r) => (r.severityLevel === level ? { ...r, delayInMinutes: delay } : r));
    } else {
      rules.push({
        severityLevel: level,
        delayInMinutes: delay,
        tagFilterIncludeMode: "NONE",
        tagFilter: [],
      });
    }
  }
  return {
    ...v,
    ...(fields["name"]?.trim() ? { name: fields["name"].trim() } : {}),
    severityRules: rules,
  };
}

/** Create-form values → a `builtin:alerting.maintenance-window` value. */
export function maintenanceValue(fields: Record<string, string>): MaintenanceWindowValue {
  const type = fields["scheduleType"] || "ONCE";
  const timeZone = (fields["timeZone"] ?? "").trim() || "UTC";
  const tags = (fields["entityTags"] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const recurrence = () => ({
    recurrenceRange: {
      scheduleStartDate: (fields["scheduleStartDate"] ?? "").slice(0, 10),
      scheduleEndDate: (fields["scheduleEndDate"] ?? "").slice(0, 10),
    },
    timeWindow: {
      startTime: toTime(fields["startTime"] ?? ""),
      endTime: toTime(fields["endTime"] ?? ""),
      timeZone,
    },
  });
  const schedule: NonNullable<MaintenanceWindowValue["schedule"]> = { scheduleType: type };
  if (type === "ONCE") {
    schedule.onceRecurrence = {
      startTime: toLocalDateTime(fields["start"] ?? ""),
      endTime: toLocalDateTime(fields["end"] ?? ""),
      timeZone,
    };
  } else if (type === "DAILY") {
    schedule.dailyRecurrence = recurrence();
  } else if (type === "WEEKLY") {
    schedule.weeklyRecurrence = { ...recurrence(), dayOfWeek: fields["dayOfWeek"] || "SUNDAY" };
  } else if (type === "MONTHLY") {
    schedule.monthlyRecurrence = { ...recurrence(), dayOfMonth: Number(fields["dayOfMonth"] || 1) };
  }
  return {
    enabled: true,
    generalProperties: {
      name: (fields["name"] ?? "").trim(),
      ...(fields["description"]?.trim() ? { description: fields["description"].trim() } : {}),
      maintenanceType: fields["maintenanceType"] || "PLANNED",
      suppression: fields["suppression"] || "DETECT_PROBLEMS_DONT_ALERT",
      disableSyntheticMonitorExecution: fields["disableSynthetic"] === "true",
    },
    schedule,
    filters: tags.length ? [{ entityTags: tags }] : [],
  };
}
