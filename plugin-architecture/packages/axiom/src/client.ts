import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import { QuotaAccessError, externalIdOf, pathEncode } from "@infrawrench/plugin-base";
import type { AxiomApi, AxiomContext } from "./api.js";
import { EDGE_DEPLOYMENTS, isPersonalToken, managementApi, mapPooled, statusOf } from "./api.js";
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
  AxDashboard,
  AxDataset,
  AxDatasetCapability,
  AxField,
  AxMonitor,
  AxNotifierProperties,
  AxNotifierRow,
  AxOrg,
  AxStarredQuery,
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

/** A monitor being edited: a field set to `undefined` is left out of the body. */
type EditableMonitor = { [K in keyof AxMonitor]: AxMonitor[K] | undefined };

/** The PUT body for a monitor: everything readable minus the read-only fields. */
export function monitorBody<
  M extends {
    id?: string | undefined;
    createdAt?: string | undefined;
    createdBy?: string | undefined;
    updatedAt?: string | undefined;
  },
>(m: M) {
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
  private readonly api: AxiomApi;
  private readonly secrets: SecretHostServices | undefined;
  private orgCache: Promise<AxOrg> | undefined;
  private datasetCache: { at: number; value: Promise<AxDataset[]> } | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
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
    this.api = managementApi(this.ctx);
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
      if (this.ctx.orgId) return this.api.get(`/orgs/${pathEncode(this.ctx.orgId)}`);
      const orgs = await this.api.get("/orgs");
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
    const value = this.api.get("/datasets").then((d) => d ?? []);
    this.datasetCache = { at: Date.now(), value };
    value.catch(() => {
      this.datasetCache = undefined;
    });
    return value;
  }

  private async edgeUrlFor(dataset: string): Promise<string | undefined> {
    const [sets, org] = await Promise.all([
      this.datasets().catch((): AxDataset[] => []),
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
    const list = await this.api.get("/notifiers").catch((): AxNotifierRow[] => []);
    return new Map(
      (list ?? [])
        .filter((n): n is AxNotifierRow & { id: string } => Boolean(n.id))
        .map((n) => [n.id, n.name ?? n.id]),
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
              const fields = await this.api
                .get(`/datasets/${pathEncode(id)}/fields`)
                .catch((): AxField[] => []);
              return (fields ?? []).map((f) => mapField(accountId, id, f));
            });
            return out.flat();
          });
        case "virtual-field":
          return this.scoped(async () => {
            const sets = await this.datasets();
            const out = await mapPooled(sets, POOL, async (d) => {
              const list = await this.api
                .get("/vfields", { query: { dataset: d.name ?? d.id ?? "" } })
                .catch((): AxVirtualField[] => []);
              return (list ?? []).map((v) =>
                mapVirtualField(accountId, { ...v, dataset: v.dataset ?? d.id ?? d.name ?? "" }),
              );
            });
            return out.flat();
          });
        case "monitor":
          return this.scoped(async () => {
            const [monitors, names] = await Promise.all([
              this.api.get("/monitors"),
              this.notifierNames(),
            ]);
            return (monitors ?? []).map((m) => mapMonitor(accountId, m, names));
          });
        case "notifier":
          return this.scoped(async () =>
            ((await this.api.get("/notifiers")) ?? []).map((n) => mapNotifier(accountId, n)),
          );
        case "dashboard":
          return this.scoped(async () => {
            const out: AxDashboard[] = [];
            for (let offset = 0; offset < 5000; offset += 100) {
              const page =
                (await this.api.get("/dashboards", { query: { limit: 100, offset } })) ?? [];
              out.push(...page);
              if (page.length < 100) break;
            }
            return out.map((d) => mapDashboard(accountId, d));
          });
        case "view":
          return this.scoped(async () =>
            ((await this.api.get("/views")) ?? []).map((v) => mapView(accountId, v)),
          );
        case "starred-query":
          return this.scoped(async () => {
            const out: AxStarredQuery[] = [];
            for (let offset = 0; offset < 5000; offset += 100) {
              const page =
                (await this.api.get("/apl-starred-queries", {
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
            return ((await this.api.get("/annotations", { query: { start } })) ?? []).map((a) =>
              mapAnnotation(accountId, a),
            );
          });
        case "api-token":
          return this.scoped(async () =>
            ((await this.api.get("/tokens")) ?? []).map((t) => mapToken(accountId, t)),
          );
        case "user":
          return this.scoped(async () =>
            ((await this.api.get("/users")) ?? []).map((u) => mapUser(accountId, u)),
          );
        default:
          throw new Error(`Axiom plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      switch (typeId) {
        case "organization":
          return mapOrganization(accountId, await this.org());
        case "dataset": {
          const org = await this.org().catch(() => undefined);
          return mapDataset(
            accountId,
            await this.api.get(`/datasets/${enc}`),
            org?.defaultEdgeDeployment,
          );
        }
        case "field": {
          const [dataset = "", ...rest] = id.split("/");
          const name = rest.join("/");
          const f = await this.api.get(
            `/datasets/${pathEncode(dataset)}/fields/${pathEncode(name)}`,
          );
          return mapField(accountId, dataset, f);
        }
        case "virtual-field":
          return mapVirtualField(accountId, await this.api.get(`/vfields/${enc}`));
        case "monitor": {
          const [m, names] = await Promise.all([
            this.api.get(`/monitors/${enc}`),
            this.notifierNames(),
          ]);
          return mapMonitor(accountId, m, names);
        }
        case "notifier":
          return mapNotifier(accountId, await this.api.get(`/notifiers/${enc}`));
        case "dashboard":
          return mapDashboard(accountId, await this.api.get(`/dashboards/uid/${enc}`));
        case "view":
          return mapView(accountId, await this.api.get(`/views/${enc}`));
        case "starred-query":
          return mapStarredQuery(accountId, await this.api.get(`/apl-starred-queries/${enc}`));
        case "annotation":
          return mapAnnotation(accountId, await this.api.get(`/annotations/${enc}`));
        case "api-token":
          return mapToken(accountId, await this.api.get(`/tokens/${enc}`));
        case "user":
          return mapUser(accountId, await this.api.get(`/users/${enc}`));
        default:
          throw new Error(`Axiom plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "api-token" && outputKey === "token") {
        const secret = await this.storedSecret(resourceId, TOKEN_SECRET_FIELD);
        if (secret) return secret;
        throw new Error(
          "Axiom shows a token only when it is created or regenerated. Regenerate it from Infrawrench to store a new value.",
        );
      }
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
      if (value === undefined)
        throw new Error(`Axiom plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
      return String(value);
    });
  }

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (resource.resourceTypeId !== "monitor" || !resource.externalId) return resource;
      const end = new Date();
      const start = new Date(end.getTime() - 7 * 86400_000);
      const history = await this.api.get(`/monitors/${pathEncode(resource.externalId)}/history`, {
        query: { startTime: start.toISOString(), endTime: end.toISOString() },
      });
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
    });
  }

  // -------------------------------------------------------------------------
  // Query editor, logs, metrics, quotas
  // -------------------------------------------------------------------------

  executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): PluginEffect<{ rows: Record<string, unknown>[]; durationMs: number }> {
    return attempt(async () => {
      const dataset = externalIdOf(resourceId);
      const started = Date.now();
      const result = await runApl(this.ctx, sql, {
        endTime: new Date().toISOString(),
        startTime: new Date(Date.now() - 30 * 86400_000).toISOString(),
        ...(await this.edgeUrlFor(dataset).then((u) => (u ? { edgeUrl: u } : {}))),
      });
      return { rows: firstRows(result), durationMs: Date.now() - started };
    });
  }

  introspectResource(resourceId: string): PluginEffect<SqlTableMeta[]> {
    return attempt(async () => {
      const dataset = externalIdOf(resourceId);
      const fields = await this.api.get(`/datasets/${pathEncode(dataset)}/fields`);
      return [
        {
          name: aplDataset(dataset),
          columns: [
            { name: "_time", type: "datetime" },
            ...(fields ?? []).map((f) => ({ name: f.name ?? "", type: f.type ?? "" })),
          ],
        },
      ];
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
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
    });
  }

  fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
    });
  }

  fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
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
          const m = await this.api.get(`/monitors/${pathEncode(id)}`);
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
          const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          const apl = String(r.fields["apl"] ?? "");
          return apl
            ? aplSeries(this.ctx, apl, rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS))
            : [];
        }
        default:
          return [];
      }
    });
  }

  /**
   * License limits against current counts, and the month's ingest and query
   * compute against the plan allowances (from the audit log). Both halves
   * come from Axiom; a limit of 0 means "not limited" and is skipped.
   */
  fetchQuotas(): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      let org: AxOrg;
      try {
        org = await this.org();
      } catch (err) {
        if (statusOf(err) === 403)
          throw new QuotaAccessError("The Axiom token cannot read the organization.");
        throw err;
      }
      const l: Partial<AxOrg["license"]> = org.license ?? {};
      const out: QuotaUsage[] = [];
      const count = async (rows: Promise<readonly object[]>) => ((await rows) ?? []).length;
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
        count(this.api.get("/datasets")).catch(() => undefined),
        count(this.api.get("/monitors")).catch(() => undefined),
        count(this.api.get("/users")).catch(() => undefined),
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
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyAxiomCredentials(this.ctx);
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async datasetOptions() {
    return (await this.datasets().catch((): AxDataset[] => [])).map((d) =>
      opt(d.name ?? d.id ?? "", d.name ?? d.id ?? ""),
    );
  }

  private async notifierOptions() {
    const names = await this.notifierNames();
    return [...names.entries()].map(([id, name]) => opt(id, name));
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case "dataset": {
          const org = await this.org().catch(() => undefined);
          const edges =
            org?.license?.edgeDeployments ??
            (org?.defaultEdgeDeployment ? [org.defaultEdgeDeployment] : []);
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "http-logs",
              },
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
                      description:
                        "Where events are stored and queried. It cannot be changed later.",
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
                options: ["Above", "AboveOrEqual", "Below", "BelowOrEqual", "AboveOrBelow"].map(
                  (o) => opt(o),
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      switch (typeId) {
        case "dataset": {
          const retention = num(fields["retentionDays"]);
          const d = await this.api.post("/datasets", {
            body: {
              name: trimmed(fields, "name"),
              kind: trimmed(fields, "kind") || "axiom:events:v1",
              ...(fields["description"] ? { description: fields["description"] } : {}),
              ...(trimmed(fields, "edgeDeployment")
                ? { edgeDeployment: trimmed(fields, "edgeDeployment") }
                : {}),
              ...(retention ? { retentionDays: retention, useRetentionPeriod: true } : {}),
            },
          });
          this.datasetCache = undefined;
          const org = await this.org().catch(() => undefined);
          return mapDataset(accountId, d, org?.defaultEdgeDeployment);
        }
        case "virtual-field": {
          const dataset =
            trimmed(fields, "dataset") || (parentResourceId ? externalIdOf(parentResourceId) : "");
          const v = await this.api.post("/vfields", {
            body: {
              dataset,
              name: trimmed(fields, "name"),
              expression: trimmed(fields, "expression"),
              ...(fields["type"] ? { type: trimmed(fields, "type") } : {}),
              ...(fields["unit"] ? { unit: trimmed(fields, "unit") } : {}),
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
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
            notifierIds = JSON.parse(fields["notifierIds"] || "[]");
          } catch {
            notifierIds = [];
          }
          const m = await this.api.post("/monitors", {
            body: {
              name: trimmed(fields, "name"),
              ...(fields["description"] ? { description: fields["description"] } : {}),
              type,
              aplQuery: apl,
              intervalMinutes: num(fields["intervalMinutes"], 5),
              rangeMinutes: num(fields["rangeMinutes"], 5),
              notifierIds,
              ...(type !== "MatchEvent"
                ? { operator: trimmed(fields, "operator") || "Above" }
                : {}),
              ...(type === "Threshold" ? { threshold: num(fields["threshold"], 0) } : {}),
              ...(type === "AnomalyDetection"
                ? {
                    compareDays: num(fields["compareDays"], 7),
                    tolerance: num(fields["tolerance"], 25),
                  }
                : {}),
            },
          });
          return mapMonitor(accountId, m, await this.notifierNames());
        }
        case "notifier": {
          const channel = trimmed(fields, "channel") || "email";
          const n = await this.api.post("/notifiers", {
            body: {
              name: trimmed(fields, "name"),
              properties: notifierProperties(channel, fields),
            },
          });
          return mapNotifier(accountId, n);
        }
        case "dashboard": {
          const owner = await this.api
            .get("/user")
            .then((u) => u.id)
            .catch(() => undefined);
          const res = await this.api.post("/dashboards", {
            body: {
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
            },
          });
          if (!res.dashboard) throw new Error("Axiom returned no dashboard");
          return mapDashboard(accountId, res.dashboard);
        }
        case "view":
          return mapView(
            accountId,
            await this.api.post("/views", {
              body: {
                name: trimmed(fields, "name"),
                aplQuery: trimmed(fields, "aplQuery"),
                ...(fields["description"] ? { description: fields["description"] } : {}),
              },
            }),
          );
        case "starred-query": {
          const me = await this.api
            .get("/user")
            .then((u) => u.id)
            .catch(() => undefined);
          return mapStarredQuery(
            accountId,
            await this.api.post("/apl-starred-queries", {
              body: {
                name: trimmed(fields, "name"),
                kind: "apl",
                ...(trimmed(fields, "dataset") ? { dataset: trimmed(fields, "dataset") } : {}),
                query: { apl: trimmed(fields, "apl") },
                metadata: {},
                who: me ?? "",
              },
            }),
          );
        }
        case "annotation": {
          let datasets: string[] = [];
          try {
            datasets = JSON.parse(fields["datasets"] || "[]");
          } catch {
            datasets = csv(fields["datasets"]);
          }
          return mapAnnotation(
            accountId,
            await this.api.post("/annotations", {
              body: {
                datasets,
                type: trimmed(fields, "type") || "deploy",
                ...(fields["title"] ? { title: fields["title"] } : {}),
                ...(fields["description"] ? { description: fields["description"] } : {}),
                ...(fields["url"] ? { url: trimmed(fields, "url") } : {}),
                ...(fields["time"] ? { time: trimmed(fields, "time") } : {}),
                ...(fields["endTime"] ? { endTime: trimmed(fields, "endTime") } : {}),
              },
            }),
          );
        }
        case "api-token":
          return this.createToken(accountId, fields);
        default:
          throw new Error(`Axiom plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  private async createToken(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const parse = (raw: string | undefined): string[] => {
      try {
        return JSON.parse(raw || "[]");
      } catch {
        return csv(raw);
      }
    };
    const access = trimmed(fields, "datasetAccess") || "ingest";
    const datasetCapabilities = Object.fromEntries(
      parse(fields["datasets"]).map((d): [string, AxDatasetCapability] => [
        d,
        {
          ...(access.includes("ingest") ? { ingest: ["create"] } : {}),
          ...(access.includes("query") ? { query: ["read"] } : {}),
        },
      ]),
    );
    const orgCapabilities = Object.fromEntries(parse(fields["orgRead"]).map((c) => [c, ["read"]]));
    const t = await this.api.post("/tokens", {
      body: {
        name: trimmed(fields, "name"),
        ...(fields["description"] ? { description: fields["description"] } : {}),
        ...(fields["expiresAt"] ? { expiresAt: trimmed(fields, "expiresAt") } : {}),
        datasetCapabilities,
        orgCapabilities,
      },
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

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      switch (typeId) {
        case "organization": {
          const org = await this.api.put(`/orgs/${enc}`, {
            body: { name: trimmed(fields, "name") },
          });
          this.orgCache = undefined;
          return mapOrganization(accountId, org);
        }
        case "dataset": {
          const current = await this.api.get(`/datasets/${enc}`);
          const d = await this.api.put(`/datasets/${enc}`, {
            body: {
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
            },
          });
          this.datasetCache = undefined;
          const org = await this.org().catch(() => undefined);
          return mapDataset(accountId, d, org?.defaultEdgeDeployment);
        }
        case "field": {
          const [dataset = "", ...rest] = id.split("/");
          const name = rest.join("/");
          const path = `/datasets/${pathEncode(dataset)}/fields/${pathEncode(name)}` as const;
          const current = await this.api.get(path);
          const f = await this.api.put(path, {
            body: {
              name: current.name ?? name,
              type: current.type ?? "string",
              unit: "unit" in fields ? fields["unit"] : (current.unit ?? ""),
              description:
                "description" in fields ? fields["description"] : (current.description ?? ""),
              hidden: "hidden" in fields ? bool(fields["hidden"]) : (current.hidden ?? false),
            },
          });
          return mapField(accountId, dataset, f);
        }
        case "virtual-field": {
          const current = await this.api.get(`/vfields/${enc}`);
          const { id: _id, ...rest } = current;
          const v = await this.api.put(`/vfields/${enc}`, {
            body: {
              ...rest,
              ...("name" in fields ? { name: fields["name"] } : {}),
              ...("expression" in fields ? { expression: fields["expression"] } : {}),
              ...("type" in fields ? { type: fields["type"] } : {}),
              ...("unit" in fields ? { unit: fields["unit"] } : {}),
              ...("description" in fields ? { description: fields["description"] } : {}),
            },
          });
          return mapVirtualField(accountId, { ...v, dataset: v.dataset ?? current.dataset ?? "" });
        }
        case "monitor":
          return this.updateMonitor(accountId, id, (m) => {
            for (const k of ["name", "description", "aplQuery", "operator"] as const) {
              if (k in fields) m[k] = fields[k] || undefined;
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
          const current = await this.api.get(`/notifiers/${enc}`);
          const { channel } = notifierChannel(current.properties);
          const changesTarget = "target" in fields || "secret" in fields;
          const n = await this.api.put(`/notifiers/${enc}`, {
            body: {
              name: "name" in fields ? fields["name"] : current.name,
              properties: changesTarget
                ? notifierProperties(channel, fields, current.properties)
                : current.properties,
              ...(current.disabledUntil ? { disabledUntil: current.disabledUntil } : {}),
            },
          });
          return mapNotifier(accountId, n);
        }
        case "dashboard": {
          const current = await this.api.get(`/dashboards/uid/${enc}`);
          const { name, description } = fields;
          const res = await this.api.put(`/dashboards/uid/${enc}`, {
            body: {
              dashboard: {
                ...(current.dashboard ?? {}),
                ...(name !== undefined ? { name } : {}),
                ...(description !== undefined ? { description } : {}),
              },
              ...(current.version !== undefined ? { version: current.version } : {}),
              message: "Edited from Infrawrench",
            },
          });
          return mapDashboard(accountId, res.dashboard ?? current);
        }
        case "view": {
          const current = await this.api.get(`/views/${enc}`);
          return mapView(
            accountId,
            await this.api.put(`/views/${enc}`, {
              body: {
                name: current.name,
                aplQuery: "aplQuery" in fields ? fields["aplQuery"] : current.aplQuery,
                description:
                  "description" in fields ? fields["description"] : (current.description ?? ""),
                ...(current.datasets ? { datasets: current.datasets } : {}),
              },
            }),
          );
        }
        case "starred-query": {
          const current = await this.api.get(`/apl-starred-queries/${enc}`);
          const { id: _id, ...rest } = current;
          return mapStarredQuery(
            accountId,
            await this.api.put(`/apl-starred-queries/${enc}`, {
              body: { ...rest, name: fields["name"] ?? current.name },
            }),
          );
        }
        case "annotation": {
          const current = await this.api.get(`/annotations/${enc}`);
          const { id: _id, ...rest } = current;
          return mapAnnotation(
            accountId,
            await this.api.put(`/annotations/${enc}`, {
              body: {
                ...rest,
                ...("title" in fields ? { title: fields["title"] } : {}),
                ...("description" in fields ? { description: fields["description"] } : {}),
                ...("url" in fields ? { url: fields["url"] } : {}),
              },
            }),
          );
        }
        default:
          throw new Error(`Axiom plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
    });
  }

  private async updateMonitor(
    accountId: string,
    id: string,
    mutate: (m: EditableMonitor) => void,
  ): Promise<ResourceInstance> {
    const enc = pathEncode(id);
    const current: EditableMonitor = await this.api.get(`/monitors/${enc}`);
    mutate(current);
    const m = await this.api.put(`/monitors/${enc}`, { body: monitorBody(current) });
    return mapMonitor(accountId, m, await this.notifierNames());
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      switch (typeId) {
        case "dataset":
          await this.api.delete(`/datasets/${enc}`);
          this.datasetCache = undefined;
          return;
        case "field": {
          const [dataset = "", ...rest] = id.split("/");
          await this.api.delete(
            `/datasets/${pathEncode(dataset)}/fields/${pathEncode(rest.join("/"))}`,
          );
          return;
        }
        case "virtual-field":
          await this.api.delete(`/vfields/${enc}`);
          return;
        case "monitor":
          await this.api.delete(`/monitors/${enc}`);
          return;
        case "notifier":
          await this.api.delete(`/notifiers/${enc}`);
          return;
        case "dashboard":
          await this.api.delete(`/dashboards/uid/${enc}`);
          return;
        case "view":
          await this.api.delete(`/views/${enc}`);
          return;
        case "starred-query":
          await this.api.delete(`/apl-starred-queries/${enc}`);
          return;
        case "annotation":
          await this.api.delete(`/annotations/${enc}`);
          return;
        case "api-token":
          await this.api.delete(`/tokens/${enc}`);
          return;
        case "user":
          await this.api.delete(`/users/${enc}`);
          return;
        default:
          throw new Error(`Axiom plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      const later = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
      if (typeId === "dataset") {
        if (actionId === "trim-30d" || actionId === "trim-7d") {
          await this.api.post(`/datasets/${enc}/trim`, {
            body: { maxDuration: actionId === "trim-30d" ? "720h" : "168h" },
          });
          return;
        }
        if (actionId === "vacuum") {
          await this.api.post(`/datasets/${enc}/vacuum`, { body: {} });
          return;
        }
      }
      if (typeId === "monitor") {
        const changes: Record<string, (m: EditableMonitor) => void> = {
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
        const current = await this.api.get(`/notifiers/${enc}`);
        await this.api.put(`/notifiers/${enc}`, {
          body: {
            name: current.name,
            properties: current.properties,
            ...(actionId === "unsnooze"
              ? {}
              : { disabledUntil: later(actionId === "snooze-1h" ? 1 : 24) }),
          },
        });
        return;
      }
      if (typeId === "api-token" && actionId === "regenerate") {
        const t = await this.api.post(`/tokens/${enc}/regenerate`, {
          body: { existingTokenExpiresAt: later(1) },
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
    });
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
