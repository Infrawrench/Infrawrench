import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightResult,
  QuotaUsage,
  ResourceInstance,
  SecretHostServices,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { QuotaAccessError, externalIdOf } from "@infrawrench/plugin-base";
import type { AxiomContext } from "./api.js";
import { EDGE_DEPLOYMENTS, axFetch, isPersonalToken, mapPooled, statusOf } from "./api.js";
import { aplDataset, firstRows, runApl } from "./apl.js";
import {
  datasetEdgeUrl,
  mapAnnotation,
  mapDashboard,
  mapDataset,
  mapField,
  mapMonitor,
  mapNotifier,
  mapOrganization,
  mapStarredQuery,
  mapToken,
  mapUser,
  mapView,
  mapVirtualField,
  notifierChannel,
  resourceIdFor,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  INGEST_TOTAL_APL,
  QUERY_TOTAL_APL,
  USAGE_METRICS_WINDOW_MS,
  aplSeries,
  auditTotal,
  datasetSeries,
  organizationSeries,
  rangeOrDefault,
} from "./metrics.js";
import { verifyAxiomCredentials } from "./preflight.js";
import { MONITOR_HISTORY_KEY, renderAxiomDetail, renderAxiomSidebar } from "./render.js";
import type {
  AxAnnotation,
  AxDashboard,
  AxDataset,
  AxField,
  AxMonitor,
  AxMonitorAlert,
  AxNotifier,
  AxNotifierProperties,
  AxOrg,
  AxStarredQuery,
  AxToken,
  AxUser,
  AxView,
  AxVirtualField,
} from "./types.js";

const TOKEN_SECRET_FIELD = "token";
const POOL = 4;
const MAX_ANNOTATION_DAYS = 90;

const opt = (id: string, label = id) => ({ id, label });

function trimmed(fields: Record<string, string>, key: string): string {
  return (fields[key] ?? "").trim();
}

function num(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined): boolean {
  return value === "true" || value === "yes" || value === "1";
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const ORG_CAPABILITIES = [
  "annotations",
  "apiTokens",
  "auditLog",
  "billing",
  "dashboards",
  "datasets",
  "endpoints",
  "flows",
  "integrations",
  "monitors",
  "notifiers",
  "rbac",
  "sharedAccessKeys",
  "users",
  "views",
];

/** Build notifier `properties` for a channel; blank secrets keep the current ones. */
export function notifierProperties(
  channel: string,
  fields: Record<string, string>,
  current?: AxNotifierProperties,
): AxNotifierProperties {
  const target = trimmed(fields, "target");
  const secret = trimmed(fields, "secret");
  switch (channel) {
    case "email":
      return { email: { emails: csv(target) } };
    case "slack":
      return { slack: { slackUrl: target || current?.slack?.slackUrl || "" } };
    case "webhook":
      return { webhook: { url: target || current?.webhook?.url || "" } };
    case "microsoftTeams":
      return {
        microsoftTeams: {
          microsoftTeamsUrl: target || current?.microsoftTeams?.microsoftTeamsUrl || "",
        },
      };
    case "discordWebhook":
      return {
        discordWebhook: {
          discordWebhookUrl: target || current?.discordWebhook?.discordWebhookUrl || "",
        },
      };
    case "pagerduty": {
      const routingKey = secret || current?.pagerduty?.routingKey || "";
      if (!routingKey) throw new Error("A PagerDuty notifier needs a routing key.");
      return { pagerduty: { routingKey } };
    }
    case "opsgenie": {
      const apiKey = secret || current?.opsgenie?.apiKey || "";
      if (!apiKey) throw new Error("An Opsgenie notifier needs an API key.");
      return {
        opsgenie: {
          apiKey,
          isEU: "isEU" in fields ? bool(fields["isEU"]) : (current?.opsgenie?.isEU ?? false),
        },
      };
    }
    case "customWebhook":
      return {
        customWebhook: {
          url: target || current?.customWebhook?.url || "",
          body: current?.customWebhook?.body ?? "{}",
          ...(current?.customWebhook?.headers ? { headers: current.customWebhook.headers } : {}),
          ...(current?.customWebhook?.secretHeaders
            ? { secretHeaders: current.customWebhook.secretHeaders }
            : {}),
        },
      };
    case "discord":
      return {
        discord: {
          discordChannel: target || current?.discord?.discordChannel || "",
          discordToken: secret || current?.discord?.discordToken || "",
        },
      };
    default:
      throw new Error(`Unsupported notifier channel "${channel}"`);
  }
}

/** The PUT body for a monitor: everything readable minus the read-only fields. */
export function monitorBody(m: AxMonitor): Record<string, unknown> {
  const { id: _id, createdAt: _c, createdBy: _b, updatedAt: _u, ...rest } = m;
  return rest;
}

/** Turn a row of a dataset query into one log line. */
export function logLine(row: Record<string, unknown>): string {
  const time = String(row["_time"] ?? "");
  const message = row["message"] ?? row["msg"] ?? row["body"] ?? row["log"];
  const level = row["level"] ?? row["severity"] ?? row["severity_text"];
  if (typeof message === "string" && message) {
    return `${time}  ${level ? `${String(level).toUpperCase()}  ` : ""}${message}`;
  }
  const { _time: _t, _sysTime: _s, ...rest } = row;
  const fields = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== null && v !== undefined && v !== ""),
  );
  return `${time}  ${JSON.stringify(fields)}`;
}

export class AxiomClient implements PluginClient {
  private readonly ctx: AxiomContext;
  private readonly secrets: SecretHostServices | undefined;
  private orgCache: Promise<AxOrg> | undefined;
  private datasetCache: { at: number; value: Promise<AxDataset[]> } | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("Axiom plugin: missing token credential");
    const orgId = (credentials["orgId"] ?? "").trim();
    if (isPersonalToken(token) && !orgId) {
      throw new Error("Axiom plugin: a personal access token needs the organization ID");
    }
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(orgId ? { orgId } : {}),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.secrets = services?.secrets;
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  /**
   * The token's organization. An API token belongs to exactly one, so
   * `GET /v2/orgs` returns it; a personal access token names it explicitly.
   */
  private org(): Promise<AxOrg> {
    this.orgCache ??= (async () => {
      if (this.ctx.orgId)
        return axFetch<AxOrg>(this.ctx, `/v2/orgs/${encodeURIComponent(this.ctx.orgId)}`);
      const orgs = await axFetch<AxOrg[]>(this.ctx, "/v2/orgs");
      const first = (orgs ?? [])[0];
      if (!first) throw new Error("Axiom plugin: the token sees no organization");
      return first;
    })();
    this.orgCache.catch(() => {
      this.orgCache = undefined;
    });
    return this.orgCache;
  }

  private datasets(): Promise<AxDataset[]> {
    if (this.datasetCache && Date.now() - this.datasetCache.at < 60_000)
      return this.datasetCache.value;
    const value = axFetch<AxDataset[]>(this.ctx, "/v2/datasets").then((d) => d ?? []);
    this.datasetCache = { at: Date.now(), value };
    value.catch(() => {
      this.datasetCache = undefined;
    });
    return value;
  }

  private async edgeUrlFor(dataset: string): Promise<string | undefined> {
    const [sets, org] = await Promise.all([
      this.datasets().catch(() => [] as AxDataset[]),
      this.org().catch(() => undefined),
    ]);
    const d = sets.find((s) => s.id === dataset || s.name === dataset);
    const url = d ? datasetEdgeUrl(d, org?.defaultEdgeDeployment) : "";
    return url || undefined;
  }

  /** A 403 on one list means the token lacks that capability: list it empty. */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403 && (await this.tokenWorks())) return [];
      throw err;
    }
  }

  /** Axiom answers a bad token with 403 too; tell the two apart with `/v2/user`. */
  private async tokenWorks(): Promise<boolean> {
    try {
      await this.org();
      return true;
    } catch {
      return false;
    }
  }

  private async notifierNames(): Promise<Map<string, string>> {
    const list = await axFetch<AxNotifier[]>(this.ctx, "/v2/notifiers").catch(
      () => [] as AxNotifier[],
    );
    return new Map(
      (list ?? []).filter((n) => n.id).map((n) => [n.id as string, n.name ?? (n.id as string)]),
    );
  }

  private async storedSecret(resourceId: string, field: string): Promise<string | null> {
    if (!this.secrets) return null;
    const v = await this.secrets.getPlaintext(resourceId, field).catch(() => null);
    return v && v.trim() ? v.trim() : null;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return [mapOrganization(accountId, await this.org())];
      case "dataset":
        return this.scoped(async () => {
          const org = await this.org().catch(() => undefined);
          return (await this.datasets()).map((d) =>
            mapDataset(accountId, d, org?.defaultEdgeDeployment),
          );
        });
      case "field":
        return this.scoped(async () => {
          const sets = await this.datasets();
          const out = await mapPooled(sets, POOL, async (d) => {
            const id = d.id ?? d.name ?? "";
            const fields = await axFetch<AxField[]>(
              this.ctx,
              `/v2/datasets/${encodeURIComponent(id)}/fields`,
            ).catch(() => [] as AxField[]);
            return (fields ?? []).map((f) => mapField(accountId, id, f));
          });
          return out.flat();
        });
      case "virtual-field":
        return this.scoped(async () => {
          const sets = await this.datasets();
          const out = await mapPooled(sets, POOL, async (d) => {
            const list = await axFetch<AxVirtualField[]>(this.ctx, "/v2/vfields", {
              query: { dataset: d.name ?? d.id ?? "" },
            }).catch(() => [] as AxVirtualField[]);
            return (list ?? []).map((v) =>
              mapVirtualField(accountId, { ...v, dataset: v.dataset ?? d.id ?? d.name ?? "" }),
            );
          });
          return out.flat();
        });
      case "monitor":
        return this.scoped(async () => {
          const [monitors, names] = await Promise.all([
            axFetch<AxMonitor[]>(this.ctx, "/v2/monitors"),
            this.notifierNames(),
          ]);
          return (monitors ?? []).map((m) => mapMonitor(accountId, m, names));
        });
      case "notifier":
        return this.scoped(async () =>
          ((await axFetch<AxNotifier[]>(this.ctx, "/v2/notifiers")) ?? []).map((n) =>
            mapNotifier(accountId, n),
          ),
        );
      case "dashboard":
        return this.scoped(async () => {
          const out: AxDashboard[] = [];
          for (let offset = 0; offset < 5000; offset += 100) {
            const page =
              (await axFetch<AxDashboard[]>(this.ctx, "/v2/dashboards", {
                query: { limit: 100, offset },
              })) ?? [];
            out.push(...page);
            if (page.length < 100) break;
          }
          return out.map((d) => mapDashboard(accountId, d));
        });
      case "view":
        return this.scoped(async () =>
          ((await axFetch<AxView[]>(this.ctx, "/v2/views")) ?? []).map((v) =>
            mapView(accountId, v),
          ),
        );
      case "starred-query":
        return this.scoped(async () => {
          const out: AxStarredQuery[] = [];
          for (let offset = 0; offset < 5000; offset += 100) {
            const page =
              (await axFetch<AxStarredQuery[]>(this.ctx, "/v2/apl-starred-queries", {
                query: { who: "all", limit: 100, offset },
              })) ?? [];
            out.push(...page);
            if (page.length < 100) break;
          }
          return out.map((q) => mapStarredQuery(accountId, q));
        });
      case "annotation":
        return this.scoped(async () => {
          const start = new Date(Date.now() - MAX_ANNOTATION_DAYS * 86400_000).toISOString();
          return (
            (await axFetch<AxAnnotation[]>(this.ctx, "/v2/annotations", { query: { start } })) ?? []
          ).map((a) => mapAnnotation(accountId, a));
        });
      case "api-token":
        return this.scoped(async () =>
          ((await axFetch<AxToken[]>(this.ctx, "/v2/tokens")) ?? []).map((t) =>
            mapToken(accountId, t),
          ),
        );
      case "user":
        return this.scoped(async () =>
          ((await axFetch<AxUser[]>(this.ctx, "/v2/users")) ?? []).map((u) =>
            mapUser(accountId, u),
          ),
        );
      default:
        throw new Error(`Axiom plugin: unknown resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const enc = encodeURIComponent(id);
    switch (typeId) {
      case "organization":
        return mapOrganization(accountId, await this.org());
      case "dataset": {
        const org = await this.org().catch(() => undefined);
        return mapDataset(
          accountId,
          await axFetch<AxDataset>(this.ctx, `/v2/datasets/${enc}`),
          org?.defaultEdgeDeployment,
        );
      }
      case "field": {
        const [dataset = "", ...rest] = id.split("/");
        const name = rest.join("/");
        const f = await axFetch<AxField>(
          this.ctx,
          `/v2/datasets/${encodeURIComponent(dataset)}/fields/${encodeURIComponent(name)}`,
        );
        return mapField(accountId, dataset, f);
      }
      case "virtual-field":
        return mapVirtualField(
          accountId,
          await axFetch<AxVirtualField>(this.ctx, `/v2/vfields/${enc}`),
        );
      case "monitor": {
        const [m, names] = await Promise.all([
          axFetch<AxMonitor>(this.ctx, `/v2/monitors/${enc}`),
          this.notifierNames(),
        ]);
        return mapMonitor(accountId, m, names);
      }
      case "notifier":
        return mapNotifier(accountId, await axFetch<AxNotifier>(this.ctx, `/v2/notifiers/${enc}`));
      case "dashboard":
        return mapDashboard(
          accountId,
          await axFetch<AxDashboard>(this.ctx, `/v2/dashboards/uid/${enc}`),
        );
      case "view":
        return mapView(accountId, await axFetch<AxView>(this.ctx, `/v2/views/${enc}`));
      case "starred-query":
        return mapStarredQuery(
          accountId,
          await axFetch<AxStarredQuery>(this.ctx, `/v2/apl-starred-queries/${enc}`),
        );
      case "annotation":
        return mapAnnotation(
          accountId,
          await axFetch<AxAnnotation>(this.ctx, `/v2/annotations/${enc}`),
        );
      case "api-token":
        return mapToken(accountId, await axFetch<AxToken>(this.ctx, `/v2/tokens/${enc}`));
      case "user":
        return mapUser(accountId, await axFetch<AxUser>(this.ctx, `/v2/users/${enc}`));
      default:
        throw new Error(`Axiom plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "api-token" && outputKey === "token") {
      const secret = await this.storedSecret(resourceId, TOKEN_SECRET_FIELD);
      if (secret) return secret;
      throw new Error(
        "Axiom shows a token only when it is created or regenerated. Regenerate it from Infrawrench to store a new value.",
      );
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    const value = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (value === undefined)
      throw new Error(`Axiom plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
    return String(value);
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "monitor" || !resource.externalId) return resource;
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400_000);
    const history = await axFetch<AxMonitorAlert[]>(
      this.ctx,
      `/v2/monitors/${encodeURIComponent(resource.externalId)}/history`,
      { query: { startTime: start.toISOString(), endTime: end.toISOString() } },
    );
    const sorted = [...(history ?? [])].sort((a, b) =>
      String(b.timestamp).localeCompare(String(a.timestamp)),
    );
    const latest = sorted[0]?.state;
    return {
      ...resource,
      fields: { ...resource.fields, ...(latest ? { state: latest } : {}) },
      resolvedOutputs: {
        ...resource.resolvedOutputs,
        [MONITOR_HISTORY_KEY]: JSON.stringify(sorted.slice(0, 50)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Query editor, logs, metrics, quotas
  // -------------------------------------------------------------------------

  async executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const dataset = externalIdOf(resourceId);
    const started = Date.now();
    const result = await runApl(this.ctx, sql, {
      endTime: new Date().toISOString(),
      startTime: new Date(Date.now() - 30 * 86400_000).toISOString(),
      ...(await this.edgeUrlFor(dataset).then((u) => (u ? { edgeUrl: u } : {}))),
    });
    return { rows: firstRows(result), durationMs: Date.now() - started };
  }

  async introspectResource(resourceId: string): Promise<SqlTableMeta[]> {
    const dataset = externalIdOf(resourceId);
    const fields = await axFetch<AxField[]>(
      this.ctx,
      `/v2/datasets/${encodeURIComponent(dataset)}/fields`,
    );
    return [
      {
        name: aplDataset(dataset),
        columns: [
          { name: "_time", type: "datetime" },
          ...(fields ?? []).map((f) => ({ name: f.name ?? "", type: f.type ?? "" })),
        ],
      },
    ];
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "dataset") return { text: "", containers: [], activeContainer: "" };
    const dataset = externalIdOf(resourceId);
    const limit = Math.min(Math.max(params.tailLines ?? 200, 1), 2000);
    const edgeUrl = await this.edgeUrlFor(dataset);
    const result = await runApl(
      this.ctx,
      `${aplDataset(dataset)} | sort by _time desc | take ${limit}`,
      {
        startTime: new Date(Date.now() - 7 * 86400_000).toISOString(),
        endTime: new Date().toISOString(),
        ...(edgeUrl ? { edgeUrl } : {}),
      },
    );
    const lines = firstRows(result).reverse().map(logLine);
    return {
      text: lines.length > 0 ? `${lines.join("\n")}\n` : "No events in the last 7 days.\n",
      containers: [],
      activeContainer: "",
    };
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(typeId, resourceId, accountId);
    if (typeId === "monitor") {
      return [
        { label: "State", value: r.fields["disabled"] === true ? "Disabled" : "Enabled" },
        {
          label: "Threshold",
          value:
            `${String(r.fields["operator"] ?? "")} ${String(r.fields["threshold"] ?? "")}`.trim() ||
            "—",
        },
      ];
    }
    if (typeId === "dataset") {
      return [
        { label: "Kind", value: String(r.fields["kind"] ?? "—") },
        {
          label: "Retention",
          value:
            r.fields["useRetentionPeriod"] === true
              ? `${String(r.fields["retentionDays"] ?? "?")} days`
              : "Plan default",
        },
      ];
    }
    return [];
  }

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "organization":
        return organizationSeries(this.ctx, rangeOrDefault(timeRange, USAGE_METRICS_WINDOW_MS));
      case "dataset":
        return datasetSeries(
          this.ctx,
          id,
          await this.edgeUrlFor(id),
          rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
        );
      case "monitor": {
        const m = await axFetch<AxMonitor>(this.ctx, `/v2/monitors/${encodeURIComponent(id)}`);
        if (!m.aplQuery) return [];
        return aplSeries(
          this.ctx,
          m.aplQuery,
          rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
          m.type === "Threshold" && typeof m.threshold === "number"
            ? { value: m.threshold, label: `Threshold (${m.operator ?? ""} ${m.threshold})` }
            : undefined,
        );
      }
      case "starred-query": {
        const r = await this.getResource(typeId, resourceId, accountId);
        const apl = String(r.fields["apl"] ?? "");
        return apl
          ? aplSeries(this.ctx, apl, rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS))
          : [];
      }
      default:
        return [];
    }
  }

  /**
   * License limits against current counts, and the month's ingest and query
   * compute against the plan allowances (from the audit log). Both halves
   * come from Axiom; a limit of 0 means "not limited" and is skipped.
   */
  async fetchQuotas(): Promise<QuotaUsage[]> {
    let org: AxOrg;
    try {
      org = await this.org();
    } catch (err) {
      if (statusOf(err) === 403)
        throw new QuotaAccessError("The Axiom token cannot read the organization.");
      throw err;
    }
    const l = org.license ?? {};
    const out: QuotaUsage[] = [];
    const count = async (path: string) => ((await axFetch<unknown[]>(this.ctx, path)) ?? []).length;
    const push = (
      id: string,
      name: string,
      limit: number | undefined,
      used: number | undefined,
      unit?: string,
    ) => {
      if (typeof limit === "number" && limit > 0 && typeof used === "number") {
        out.push({ id, service: "license", name, limit, used, ...(unit ? { unit } : {}) });
      }
    };
    const [datasets, monitors, users] = await Promise.all([
      count("/v2/datasets").catch(() => undefined),
      count("/v2/monitors").catch(() => undefined),
      count("/v2/users").catch(() => undefined),
    ]);
    push("datasets", "Datasets", l.maxDatasets, datasets, "datasets");
    push("monitors", "Monitors", l.maxMonitors, monitors, "monitors");
    push("users", "Users", l.maxUsers, users, "users");
    const since = l.billingPeriodStart;
    if (since) {
      const [ingest, query] = await Promise.all([
        auditTotal(this.ctx, INGEST_TOTAL_APL, since),
        auditTotal(this.ctx, QUERY_TOTAL_APL, since),
      ]);
      push("monthly-ingest", "Ingest this billing period", l.monthlyIngestGb, ingest, "GB");
      push(
        "monthly-query",
        "Query compute this billing period",
        l.monthlyQueryGbHours,
        query,
        "GB-hours",
      );
    }
    return out;
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyAxiomCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async datasetOptions() {
    return (await this.datasets().catch(() => [] as AxDataset[])).map((d) =>
      opt(d.name ?? d.id ?? "", d.name ?? d.id ?? ""),
    );
  }

  private async notifierOptions() {
    const names = await this.notifierNames();
    return [...names.entries()].map(([id, name]) => opt(id, name));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "dataset": {
        const org = await this.org().catch(() => undefined);
        const edges =
          org?.license?.edgeDeployments ??
          (org?.defaultEdgeDeployment ? [org.defaultEdgeDeployment] : []);
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "http-logs" },
            {
              key: "kind",
              label: "Kind",
              kind: "select",
              required: true,
              defaultValue: "axiom:events:v1",
              options: [
                opt("axiom:events:v1", "Events"),
                opt("otel:logs:v1", "OpenTelemetry logs"),
                opt("otel:traces:v1", "OpenTelemetry traces"),
                opt("otel:metrics:v1", "OpenTelemetry metrics"),
              ],
            },
            { key: "description", label: "Description", kind: "text", required: false },
            ...(edges.length > 1
              ? [
                  {
                    key: "edgeDeployment",
                    label: "Edge deployment",
                    kind: "select" as const,
                    required: false,
                    defaultValue: org?.defaultEdgeDeployment ?? "",
                    options: edges.map((e) => opt(e, EDGE_DEPLOYMENTS[e]?.label ?? e)),
                    description: "Where events are stored and queried. It cannot be changed later.",
                  },
                ]
              : []),
            {
              key: "retentionDays",
              label: "Retention (days)",
              kind: "number",
              required: false,
              minValue: 1,
              description: "Leave empty to keep events for the plan's default.",
            },
          ],
        };
      }
      case "virtual-field":
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "dataset",
                    label: "Dataset",
                    kind: "select" as const,
                    required: true,
                    options: await this.datasetOptions(),
                  },
                ]),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "is_error" },
            {
              key: "expression",
              label: "Expression",
              kind: "text",
              multiline: true,
              required: true,
              placeholder: "toint(status) >= 500",
              description: "An APL expression evaluated on every event.",
            },
            { key: "type", label: "Type", kind: "text", required: false, placeholder: "boolean" },
            { key: "unit", label: "Unit", kind: "text", required: false },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "monitor":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "Threshold",
              options: [
                opt("Threshold", "Threshold: compare a value with a threshold"),
                opt("MatchEvent", "Match event: alert on every matching event"),
                opt("AnomalyDetection", "Anomaly detection: compare with past days"),
              ],
            },
            {
              key: "dataset",
              label: "Dataset",
              kind: "select",
              required: false,
              options: [opt("", "Write the query myself"), ...(await this.datasetOptions())],
              description:
                "Pick a dataset to start from a count of its events, or write the APL below.",
            },
            {
              key: "aplQuery",
              label: "APL query",
              kind: "text",
              multiline: true,
              required: false,
              placeholder:
                "['http-logs'] | where status >= 500 | summarize count() by bin_auto(_time)",
            },
            {
              key: "operator",
              label: "Alert when the value is",
              kind: "select",
              required: false,
              defaultValue: "Above",
              options: ["Above", "AboveOrEqual", "Below", "BelowOrEqual", "AboveOrBelow"].map((o) =>
                opt(o),
              ),
              showWhen: { fieldKey: "type", fieldValues: ["Threshold", "AnomalyDetection"] },
            },
            {
              key: "threshold",
              label: "Threshold",
              kind: "number",
              required: false,
              showWhen: { fieldKey: "type", fieldValue: "Threshold" },
            },
            {
              key: "compareDays",
              label: "Compare with the last (days)",
              kind: "number",
              required: false,
              defaultValue: "7",
              showWhen: { fieldKey: "type", fieldValue: "AnomalyDetection" },
            },
            {
              key: "tolerance",
              label: "Tolerance (%)",
              kind: "number",
              required: false,
              defaultValue: "25",
              showWhen: { fieldKey: "type", fieldValue: "AnomalyDetection" },
            },
            {
              key: "intervalMinutes",
              label: "Run every (minutes)",
              kind: "number",
              required: true,
              defaultValue: "5",
              minValue: 1,
            },
            {
              key: "rangeMinutes",
              label: "Look back (minutes)",
              kind: "number",
              required: true,
              defaultValue: "5",
              minValue: 1,
            },
            {
              key: "notifierIds",
              label: "Notifiers",
              kind: "policy-picker",
              required: false,
              policies: (await this.notifierOptions()).map((n) => ({
                id: n.id,
                label: n.label,
                category: "Notifiers",
              })),
            },
          ],
        };
      case "notifier":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "channel",
              label: "Channel",
              kind: "select",
              required: true,
              defaultValue: "email",
              options: [
                opt("email", "Email"),
                opt("slack", "Slack (incoming webhook)"),
                opt("pagerduty", "PagerDuty"),
                opt("opsgenie", "Opsgenie"),
                opt("microsoftTeams", "Microsoft Teams"),
                opt("discordWebhook", "Discord webhook"),
                opt("webhook", "Webhook"),
              ],
            },
            {
              key: "target",
              label: "Addresses or URL",
              kind: "text",
              required: false,
              description:
                "Email: comma-separated addresses. Slack, Teams, Discord and webhook: the URL.",
              showWhen: { fieldKey: "channel", fieldValuesNot: ["pagerduty", "opsgenie"] },
            },
            {
              key: "secret",
              label: "Routing key or API key",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "channel", fieldValues: ["pagerduty", "opsgenie"] },
            },
            {
              key: "isEU",
              label: "Opsgenie region",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [opt("false", "US"), opt("true", "EU")],
              showWhen: { fieldKey: "channel", fieldValue: "opsgenie" },
            },
          ],
        };
      case "dashboard":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "view":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "aplQuery",
              label: "APL query",
              kind: "text",
              multiline: true,
              required: true,
              placeholder: "['http-logs'] | where team == \"payments\"",
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "starred-query":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "dataset",
              label: "Dataset",
              kind: "select",
              required: false,
              options: [opt("", "None"), ...(await this.datasetOptions())],
            },
            {
              key: "apl",
              label: "APL",
              kind: "text",
              multiline: true,
              required: true,
              placeholder: "['http-logs'] | summarize count() by bin_auto(_time), status",
            },
          ],
        };
      case "annotation":
        return {
          fields: [
            {
              key: "datasets",
              label: "Datasets",
              kind: "policy-picker",
              required: true,
              policies: (await this.datasetOptions()).map((d) => ({
                id: d.id,
                label: d.label,
                category: "Datasets",
              })),
            },
            { key: "type", label: "Type", kind: "text", required: true, placeholder: "deploy" },
            {
              key: "title",
              label: "Title",
              kind: "text",
              required: false,
              placeholder: "Deploy v1.42",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            { key: "url", label: "Link", kind: "text", required: false },
            {
              key: "time",
              label: "Time",
              kind: "datetime",
              required: false,
              description: "Leave empty for now.",
            },
            { key: "endTime", label: "End", kind: "datetime", required: false },
          ],
        };
      case "api-token":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "expiresAt",
              label: "Expires",
              kind: "datetime",
              required: false,
              description: "Leave empty for no expiry.",
            },
            {
              key: "datasets",
              label: "Datasets",
              kind: "policy-picker",
              required: false,
              policies: (await this.datasetOptions()).map((d) => ({
                id: d.id,
                label: d.label,
                category: "Datasets",
              })),
            },
            {
              key: "datasetAccess",
              label: "On those datasets",
              kind: "select",
              required: false,
              defaultValue: "ingest",
              options: [
                opt("ingest", "Ingest"),
                opt("query", "Query"),
                opt("ingest+query", "Ingest and query"),
              ],
            },
            {
              key: "orgRead",
              label: "Read access to",
              kind: "policy-picker",
              required: false,
              policies: ORG_CAPABILITIES.map((c) => ({
                id: c,
                label: c,
                category: "Organization (read)",
              })),
            },
          ],
        };
      default:
        throw new Error(`Axiom plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const post = <T>(path: string, body: unknown) =>
      axFetch<T>(this.ctx, path, { method: "POST", body: JSON.stringify(body) });
    switch (typeId) {
      case "dataset": {
        const retention = num(fields["retentionDays"]);
        const d = await post<AxDataset>("/v2/datasets", {
          name: trimmed(fields, "name"),
          kind: trimmed(fields, "kind") || "axiom:events:v1",
          ...(fields["description"] ? { description: fields["description"] } : {}),
          ...(trimmed(fields, "edgeDeployment")
            ? { edgeDeployment: trimmed(fields, "edgeDeployment") }
            : {}),
          ...(retention ? { retentionDays: retention, useRetentionPeriod: true } : {}),
        });
        this.datasetCache = undefined;
        const org = await this.org().catch(() => undefined);
        return mapDataset(accountId, d, org?.defaultEdgeDeployment);
      }
      case "virtual-field": {
        const dataset =
          trimmed(fields, "dataset") || (parentResourceId ? externalIdOf(parentResourceId) : "");
        const v = await post<AxVirtualField>("/v2/vfields", {
          dataset,
          name: trimmed(fields, "name"),
          expression: trimmed(fields, "expression"),
          ...(fields["type"] ? { type: trimmed(fields, "type") } : {}),
          ...(fields["unit"] ? { unit: trimmed(fields, "unit") } : {}),
          ...(fields["description"] ? { description: fields["description"] } : {}),
        });
        return mapVirtualField(accountId, { ...v, dataset: v.dataset ?? dataset });
      }
      case "monitor": {
        const type = trimmed(fields, "type") || "Threshold";
        const dataset = trimmed(fields, "dataset");
        const apl =
          trimmed(fields, "aplQuery") ||
          (dataset ? `${aplDataset(dataset)} | summarize count() by bin_auto(_time)` : "");
        if (!apl) throw new Error("Write an APL query or pick a dataset.");
        let notifierIds: string[] = [];
        try {
          notifierIds = JSON.parse(fields["notifierIds"] || "[]") as string[];
        } catch {
          notifierIds = [];
        }
        const m = await post<AxMonitor>("/v2/monitors", {
          name: trimmed(fields, "name"),
          ...(fields["description"] ? { description: fields["description"] } : {}),
          type,
          aplQuery: apl,
          intervalMinutes: num(fields["intervalMinutes"], 5),
          rangeMinutes: num(fields["rangeMinutes"], 5),
          notifierIds,
          ...(type !== "MatchEvent" ? { operator: trimmed(fields, "operator") || "Above" } : {}),
          ...(type === "Threshold" ? { threshold: num(fields["threshold"], 0) } : {}),
          ...(type === "AnomalyDetection"
            ? {
                compareDays: num(fields["compareDays"], 7),
                tolerance: num(fields["tolerance"], 25),
              }
            : {}),
        });
        return mapMonitor(accountId, m, await this.notifierNames());
      }
      case "notifier": {
        const channel = trimmed(fields, "channel") || "email";
        const n = await post<AxNotifier>("/v2/notifiers", {
          name: trimmed(fields, "name"),
          properties: notifierProperties(channel, fields),
        });
        return mapNotifier(accountId, n);
      }
      case "dashboard": {
        const owner = await axFetch<AxUser>(this.ctx, "/v2/user")
          .then((u) => u.id)
          .catch(() => undefined);
        const res = await post<{ dashboard?: AxDashboard }>("/v2/dashboards", {
          dashboard: {
            name: trimmed(fields, "name"),
            ...(fields["description"] ? { description: fields["description"] } : {}),
            owner: owner ?? "X-AXIOM-EVERYONE",
            charts: [],
            layout: [],
            refreshTime: 60,
            schemaVersion: 2,
            timeWindowStart: "qr-now-1h",
            timeWindowEnd: "qr-now",
          },
        });
        if (!res.dashboard) throw new Error("Axiom returned no dashboard");
        return mapDashboard(accountId, res.dashboard);
      }
      case "view":
        return mapView(
          accountId,
          await post<AxView>("/v2/views", {
            name: trimmed(fields, "name"),
            aplQuery: trimmed(fields, "aplQuery"),
            ...(fields["description"] ? { description: fields["description"] } : {}),
          }),
        );
      case "starred-query": {
        const me = await axFetch<AxUser>(this.ctx, "/v2/user")
          .then((u) => u.id)
          .catch(() => undefined);
        return mapStarredQuery(
          accountId,
          await post<AxStarredQuery>("/v2/apl-starred-queries", {
            name: trimmed(fields, "name"),
            kind: "apl",
            ...(trimmed(fields, "dataset") ? { dataset: trimmed(fields, "dataset") } : {}),
            query: { apl: trimmed(fields, "apl") },
            metadata: {},
            who: me ?? "",
          }),
        );
      }
      case "annotation": {
        let datasets: string[] = [];
        try {
          datasets = JSON.parse(fields["datasets"] || "[]") as string[];
        } catch {
          datasets = csv(fields["datasets"]);
        }
        return mapAnnotation(
          accountId,
          await post<AxAnnotation>("/v2/annotations", {
            datasets,
            type: trimmed(fields, "type") || "deploy",
            ...(fields["title"] ? { title: fields["title"] } : {}),
            ...(fields["description"] ? { description: fields["description"] } : {}),
            ...(fields["url"] ? { url: trimmed(fields, "url") } : {}),
            ...(fields["time"] ? { time: trimmed(fields, "time") } : {}),
            ...(fields["endTime"] ? { endTime: trimmed(fields, "endTime") } : {}),
          }),
        );
      }
      case "api-token":
        return this.createToken(accountId, fields);
      default:
        throw new Error(`Axiom plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private async createToken(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const parse = (raw: string | undefined) => {
      try {
        return JSON.parse(raw || "[]") as string[];
      } catch {
        return csv(raw);
      }
    };
    const access = trimmed(fields, "datasetAccess") || "ingest";
    const datasetCapabilities = Object.fromEntries(
      parse(fields["datasets"]).map((d) => [
        d,
        {
          ...(access.includes("ingest") ? { ingest: ["create"] } : {}),
          ...(access.includes("query") ? { query: ["read"] } : {}),
        },
      ]),
    );
    const orgCapabilities = Object.fromEntries(parse(fields["orgRead"]).map((c) => [c, ["read"]]));
    const t = await axFetch<AxToken>(this.ctx, "/v2/tokens", {
      method: "POST",
      body: JSON.stringify({
        name: trimmed(fields, "name"),
        ...(fields["description"] ? { description: fields["description"] } : {}),
        ...(fields["expiresAt"] ? { expiresAt: trimmed(fields, "expiresAt") } : {}),
        datasetCapabilities,
        orgCapabilities,
      }),
    });
    if (t.id && t.token && this.secrets?.setPlaintext) {
      await this.secrets
        .setPlaintext(resourceIdFor(accountId, "api-token", t.id), TOKEN_SECRET_FIELD, t.token)
        .catch(() => undefined);
    }
    return mapToken(accountId, t);
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
    const enc = encodeURIComponent(id);
    const put = <T>(path: string, body: unknown) =>
      axFetch<T>(this.ctx, path, { method: "PUT", body: JSON.stringify(body) });
    switch (typeId) {
      case "organization": {
        const org = await put<AxOrg>(`/v2/orgs/${enc}`, { name: trimmed(fields, "name") });
        this.orgCache = undefined;
        return mapOrganization(accountId, org);
      }
      case "dataset": {
        const current = await axFetch<AxDataset>(this.ctx, `/v2/datasets/${enc}`);
        const d = await put<AxDataset>(`/v2/datasets/${enc}`, {
          description:
            "description" in fields ? fields["description"] : (current.description ?? ""),
          useRetentionPeriod:
            "useRetentionPeriod" in fields
              ? bool(fields["useRetentionPeriod"])
              : (current.useRetentionPeriod ?? false),
          retentionDays:
            "retentionDays" in fields
              ? num(fields["retentionDays"], 0)
              : (current.retentionDays ?? 0),
        });
        this.datasetCache = undefined;
        const org = await this.org().catch(() => undefined);
        return mapDataset(accountId, d, org?.defaultEdgeDeployment);
      }
      case "field": {
        const [dataset = "", ...rest] = id.split("/");
        const name = rest.join("/");
        const path = `/v2/datasets/${encodeURIComponent(dataset)}/fields/${encodeURIComponent(name)}`;
        const current = await axFetch<AxField>(this.ctx, path);
        const f = await put<AxField>(path, {
          name: current.name ?? name,
          type: current.type ?? "string",
          unit: "unit" in fields ? fields["unit"] : (current.unit ?? ""),
          description:
            "description" in fields ? fields["description"] : (current.description ?? ""),
          hidden: "hidden" in fields ? bool(fields["hidden"]) : (current.hidden ?? false),
        });
        return mapField(accountId, dataset, f);
      }
      case "virtual-field": {
        const current = await axFetch<AxVirtualField>(this.ctx, `/v2/vfields/${enc}`);
        const { id: _id, ...rest } = current;
        const v = await put<AxVirtualField>(`/v2/vfields/${enc}`, {
          ...rest,
          ...Object.fromEntries(
            ["name", "expression", "type", "unit", "description"]
              .filter((k) => k in fields)
              .map((k) => [k, fields[k]]),
          ),
        });
        return mapVirtualField(accountId, { ...v, dataset: v.dataset ?? current.dataset ?? "" });
      }
      case "monitor":
        return this.updateMonitor(accountId, id, (m) => {
          for (const k of ["name", "description", "aplQuery", "operator"] as const) {
            if (k in fields) (m as Record<string, unknown>)[k] = fields[k] || undefined;
          }
          for (const k of ["threshold", "intervalMinutes", "rangeMinutes"] as const) {
            if (k in fields) {
              const n = num(fields[k]);
              if (n !== undefined) m[k] = n;
            }
          }
          for (const k of ["alertOnNoData", "notifyByGroup", "notifyEveryRun"] as const) {
            if (k in fields) m[k] = bool(fields[k]);
          }
        });
      case "notifier": {
        const current = await axFetch<AxNotifier>(this.ctx, `/v2/notifiers/${enc}`);
        const { channel } = notifierChannel(current.properties);
        const changesTarget = "target" in fields || "secret" in fields;
        const n = await put<AxNotifier>(`/v2/notifiers/${enc}`, {
          name: "name" in fields ? fields["name"] : current.name,
          properties: changesTarget
            ? notifierProperties(channel, fields, current.properties)
            : current.properties,
          ...(current.disabledUntil ? { disabledUntil: current.disabledUntil } : {}),
        });
        return mapNotifier(accountId, n);
      }
      case "dashboard": {
        const current = await axFetch<AxDashboard>(this.ctx, `/v2/dashboards/uid/${enc}`);
        const res = await put<{ dashboard?: AxDashboard }>(`/v2/dashboards/uid/${enc}`, {
          dashboard: {
            ...(current.dashboard ?? {}),
            ...("name" in fields ? { name: fields["name"] } : {}),
            ...("description" in fields ? { description: fields["description"] } : {}),
          },
          ...(current.version !== undefined ? { version: current.version } : {}),
          message: "Edited from Infrawrench",
        });
        return mapDashboard(accountId, res.dashboard ?? current);
      }
      case "view": {
        const current = await axFetch<AxView>(this.ctx, `/v2/views/${enc}`);
        return mapView(
          accountId,
          await put<AxView>(`/v2/views/${enc}`, {
            name: current.name,
            aplQuery: "aplQuery" in fields ? fields["aplQuery"] : current.aplQuery,
            description:
              "description" in fields ? fields["description"] : (current.description ?? ""),
            ...(current.datasets ? { datasets: current.datasets } : {}),
          }),
        );
      }
      case "starred-query": {
        const current = await axFetch<AxStarredQuery>(this.ctx, `/v2/apl-starred-queries/${enc}`);
        const { id: _id, ...rest } = current;
        return mapStarredQuery(
          accountId,
          await put<AxStarredQuery>(`/v2/apl-starred-queries/${enc}`, {
            ...rest,
            name: fields["name"] ?? current.name,
          }),
        );
      }
      case "annotation": {
        const current = await axFetch<AxAnnotation>(this.ctx, `/v2/annotations/${enc}`);
        const { id: _id, ...rest } = current;
        return mapAnnotation(
          accountId,
          await put<AxAnnotation>(`/v2/annotations/${enc}`, {
            ...rest,
            ...Object.fromEntries(
              ["title", "description", "url"].filter((k) => k in fields).map((k) => [k, fields[k]]),
            ),
          }),
        );
      }
      default:
        throw new Error(`Axiom plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  private async updateMonitor(
    accountId: string,
    id: string,
    mutate: (m: AxMonitor) => void,
  ): Promise<ResourceInstance> {
    const path = `/v2/monitors/${encodeURIComponent(id)}`;
    const current = await axFetch<AxMonitor>(this.ctx, path);
    mutate(current);
    const m = await axFetch<AxMonitor>(this.ctx, path, {
      method: "PUT",
      body: JSON.stringify(monitorBody(current)),
    });
    return mapMonitor(accountId, m, await this.notifierNames());
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const enc = encodeURIComponent(id);
    const del = (path: string) => axFetch<unknown>(this.ctx, path, { method: "DELETE" });
    switch (typeId) {
      case "dataset":
        await del(`/v2/datasets/${enc}`);
        this.datasetCache = undefined;
        return;
      case "field": {
        const [dataset = "", ...rest] = id.split("/");
        await del(
          `/v2/datasets/${encodeURIComponent(dataset)}/fields/${encodeURIComponent(rest.join("/"))}`,
        );
        return;
      }
      case "virtual-field":
        await del(`/v2/vfields/${enc}`);
        return;
      case "monitor":
        await del(`/v2/monitors/${enc}`);
        return;
      case "notifier":
        await del(`/v2/notifiers/${enc}`);
        return;
      case "dashboard":
        await del(`/v2/dashboards/uid/${enc}`);
        return;
      case "view":
        await del(`/v2/views/${enc}`);
        return;
      case "starred-query":
        await del(`/v2/apl-starred-queries/${enc}`);
        return;
      case "annotation":
        await del(`/v2/annotations/${enc}`);
        return;
      case "api-token":
        await del(`/v2/tokens/${enc}`);
        return;
      case "user":
        await del(`/v2/users/${enc}`);
        return;
      default:
        throw new Error(`Axiom plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
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
    const id = externalIdOf(resourceId);
    const enc = encodeURIComponent(id);
    const later = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
    if (typeId === "dataset") {
      if (actionId === "trim-30d" || actionId === "trim-7d") {
        await axFetch(this.ctx, `/v2/datasets/${enc}/trim`, {
          method: "POST",
          body: JSON.stringify({ maxDuration: actionId === "trim-30d" ? "720h" : "168h" }),
        });
        return;
      }
      if (actionId === "vacuum") {
        await axFetch(this.ctx, `/v2/datasets/${enc}/vacuum`, { method: "POST", body: "{}" });
        return;
      }
    }
    if (typeId === "monitor") {
      const changes: Record<string, (m: AxMonitor) => void> = {
        enable: (m) => {
          m.disabled = false;
        },
        disable: (m) => {
          m.disabled = true;
        },
        "snooze-1h": (m) => {
          m.disabledUntil = later(1);
        },
        "snooze-1d": (m) => {
          m.disabledUntil = later(24);
        },
        unsnooze: (m) => {
          delete m.disabledUntil;
        },
      };
      const change = changes[actionId];
      if (change) {
        await this.updateMonitor(accountId, id, change);
        return;
      }
    }
    if (typeId === "notifier" && ["snooze-1h", "snooze-1d", "unsnooze"].includes(actionId)) {
      const current = await axFetch<AxNotifier>(this.ctx, `/v2/notifiers/${enc}`);
      await axFetch(this.ctx, `/v2/notifiers/${enc}`, {
        method: "PUT",
        body: JSON.stringify({
          name: current.name,
          properties: current.properties,
          ...(actionId === "unsnooze"
            ? {}
            : { disabledUntil: later(actionId === "snooze-1h" ? 1 : 24) }),
        }),
      });
      return;
    }
    if (typeId === "api-token" && actionId === "regenerate") {
      const t = await axFetch<AxToken>(this.ctx, `/v2/tokens/${enc}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ existingTokenExpiresAt: later(1) }),
      });
      const newId = t.id ?? id;
      if (t.token && this.secrets?.setPlaintext) {
        await this.secrets.setPlaintext(
          resourceIdFor(accountId, "api-token", newId),
          TOKEN_SECRET_FIELD,
          t.token,
        );
      }
      return;
    }
    throw new Error(`Axiom plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderAxiomDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderAxiomSidebar(resource);
  }
}
